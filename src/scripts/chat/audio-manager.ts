// src/scripts/chat/audio-manager.ts
//
// マイク音声キャプチャ（LiveAPI 専用）
//
// 設計方針:
//   - クライアント側 VAD は使用しない
//   - ターン検知は Gemini LLM ベース VAD に委任（automatic_activity_detection: disabled）
//   - AudioWorklet で Float32 → Int16 PCM (16kHz mono) に変換
//   - base64 エンコードしてコールバック経由で送信
//
// 参考: audio-streaming-code-review.md
//   - stopAll: onended = null してから stop()（配列 mutation 防止）
//   - resumeAudioContext: 依存ノード全リセット
//   - iOS: AudioContext 再利用（Safari 制約）

const TARGET_SAMPLE_RATE = 16000;
const MAX_RECORDING_TIME = 60000;

// iOS: AudioContext をセッション跨ぎで再利用（Safari の AudioContext 制限対策）
const IOS_BUFFER_SIZE = 8192;
// PC/Android: 200ms分のバッファ（リアルタイム送信優先）
const DEFAULT_BUFFER_SIZE = 3200;

const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

// --- base64 エンコード（高速版）---
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const len = bytes.byteLength;
  let out = '';
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    if (b === undefined) { out += '=='; }
    else if (c === undefined) { out += B64[((b & 15) << 2)] + '='; }
    else { out += B64[((b & 15) << 2) | (c >> 6)] + B64[c & 63]; }
  }
  return out;
}

// --- AudioWorklet ソースコード生成 ---
function buildWorkletCode(processorName: string, bufferSize: number, downsampleRatio: number): string {
  return `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(${bufferSize});
    this.idx = 0;
    this.ratio = ${downsampleRatio};
    this.acc = 0;
    this.lastFlush = Date.now();
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc++;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        if (this.idx < ${bufferSize}) {
          const s = Math.max(-1, Math.min(1, ch[i]));
          this.buf[this.idx++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        if (this.idx >= ${bufferSize} ||
            (this.idx > 0 && Date.now() - this.lastFlush > 100)) {
          this.flush();
        }
      }
    }
    return true;
  }
  flush() {
    if (this.idx === 0) return;
    const chunk = this.buf.slice(0, this.idx);
    this.port.postMessage({ audioChunk: chunk }, [chunk.buffer]);
    this.buf = new Int16Array(${bufferSize});
    this.idx = 0;
    this.lastFlush = Date.now();
  }
}
registerProcessor('${processorName}', AudioProcessor);
`;
}


export class AudioManager {
  // AudioContext（iOS: セッション跨ぎで再利用、PC: 毎回生成）
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private recordingTimer: number | null = null;

  // レガシー録音用（REST API フォールバック）
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];

  // レガシー録音用 VAD（REST API 時のみ使用）
  private analyser: AnalyserNode | null = null;
  private vadInterval: number | null = null;
  private silenceTimer: number | null = null;
  private hasSpoken = false;
  private silenceCount = 0;
  private readonly SILENCE_THRESHOLD = 35;
  private readonly SILENCE_CHECKS = 5;
  private readonly MIN_RECORDING = 3000;
  private SILENCE_DURATION: number;
  private recordingStartTime = 0;

  constructor(silenceDuration: number = 3500) {
    this.SILENCE_DURATION = silenceDuration;
  }

  // ============================================================
  // LiveAPI ストリーミング（メイン機能）
  //
  // クライアント側 VAD なし。Gemini LLM ベース VAD に委任。
  // stopStreaming() が呼ばれるまで連続送信。
  // ============================================================

  async startStreaming(
    onAudioChunk: (base64: string) => void,
    onStopCallback: () => void,
    _onSpeechStart?: () => void
  ) {
    this.cleanup();

    // AudioContext 取得（iOS: 再利用、PC: 新規）
    // @ts-ignore
    const ACClass = window.AudioContext || window.webkitAudioContext;
    if (IS_IOS) {
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        this.audioCtx = new ACClass({ latencyHint: 'interactive', sampleRate: 48000 });
      }
    } else {
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        this.audioCtx.close();
      }
      this.audioCtx = new ACClass({ latencyHint: 'interactive', sampleRate: 48000 });
    }

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    // マイク取得
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });

    const nativeRate = this.audioCtx.sampleRate;
    const ratio = nativeRate / TARGET_SAMPLE_RATE;
    const bufSize = IS_IOS ? IOS_BUFFER_SIZE : DEFAULT_BUFFER_SIZE;
    const procName = IS_IOS ? `audio-proc-ios-${Date.now()}` : 'audio-proc';

    // AudioWorklet 登録
    const code = buildWorkletCode(procName, bufSize, ratio);
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    // 音声グラフ構築
    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, procName);

    this.workletNode.port.onmessage = (ev) => {
      const { audioChunk } = ev.data;
      if (audioChunk) {
        try { onAudioChunk(arrayBufferToBase64(audioChunk.buffer)); } catch {}
      }
    };

    source.connect(this.workletNode);
    this.workletNode.connect(this.audioCtx.destination);

    // MAX_RECORDING_TIME 安全弁のみ
    this.recordingTimer = window.setTimeout(() => {
      this.stopStreaming();
      onStopCallback();
    }, MAX_RECORDING_TIME);
  }

  stopStreaming() {
    if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }
    this.disconnectWorklet();
    this.releaseMediaStream();

    // PC: AudioContext を閉じる（iOS: 再利用のため残す）
    if (!IS_IOS && this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }

  // ============================================================
  // レガシー録音（REST API フォールバック）
  //
  // LiveAPI 接続不可時の録音。クライアント側 VAD で無音停止。
  // ============================================================

  async startLegacyRecording(
    onStopCallback: (audioBlob: Blob) => void,
    onSpeechStart?: () => void
  ) {
    if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true }
    });
    this.mediaStream = stream;

    // @ts-ignore
    const ACClass = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new ACClass();
    const source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.hasSpoken = false;
    this.silenceCount = 0;
    this.recordingStartTime = Date.now();

    // クライアント側 VAD（レガシー録音時のみ）
    this.vadInterval = window.setInterval(() => {
      if (!this.analyser) return;
      if (Date.now() - this.recordingStartTime < this.MIN_RECORDING) return;
      this.analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

      if (avg > this.SILENCE_THRESHOLD) {
        this.hasSpoken = true;
        this.silenceCount = 0;
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
        if (onSpeechStart) onSpeechStart();
      } else if (this.hasSpoken) {
        this.silenceCount++;
        if (this.silenceCount >= this.SILENCE_CHECKS && !this.silenceTimer) {
          this.silenceTimer = window.setTimeout(() => {
            if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop();
          }, this.SILENCE_DURATION);
        }
      }
    }, 100);

    // MediaRecorder
    // @ts-ignore
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    this.audioChunks = [];

    this.mediaRecorder.ondataavailable = (ev: any) => {
      if (ev.data.size > 0) this.audioChunks.push(ev.data);
    };

    this.mediaRecorder.onstop = () => {
      this.stopVAD();
      stream.getTracks().forEach(t => t.stop());
      if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }
      if (this.audioChunks.length > 0) {
        onStopCallback(new Blob(this.audioChunks, { type: 'audio/webm' }));
      }
    };

    this.mediaRecorder.start();

    this.recordingTimer = window.setTimeout(() => {
      if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop();
    }, MAX_RECORDING_TIME);
  }

  // ============================================================
  // ユーティリティ
  // ============================================================

  /** iOS Safari のオーディオ自動再生制限を解除 */
  unlockAudioParams(el: HTMLAudioElement) {
    if (this.audioCtx?.state === 'suspended') this.audioCtx.resume();
    if (el) {
      el.muted = true;
      el.play().then(() => { el.pause(); el.currentTime = 0; el.muted = false; }).catch(() => {});
    }
  }

  /** 全リソース解放（audio-streaming-code-review.md: resumeAudioContext 全リセット準拠） */
  fullResetAudioResources() {
    this.stopStreaming();
    if (this.mediaRecorder?.state !== 'inactive') {
      try { this.mediaRecorder?.stop(); } catch {}
    }
    this.mediaRecorder = null;
    // iOS の再利用 AudioContext も含めて完全リセット
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
    }
    this.audioCtx = null;
    this.workletNode = null;
    this.releaseMediaStream();
  }

  // stub（core-controller から参照される）
  async playTTS(_audioBase64: string): Promise<void> {}
  stopTTS() {}

  // --- private ---

  private cleanup() {
    if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }
    this.disconnectWorklet();
  }

  /** audio-streaming-code-review.md: onended = null → disconnect 順序 */
  private disconnectWorklet() {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try { this.workletNode.disconnect(); } catch {}
      this.workletNode = null;
    }
  }

  private releaseMediaStream() {
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
  }

  private stopVAD() {
    if (this.vadInterval) { clearInterval(this.vadInterval); this.vadInterval = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    this.analyser = null;
    this.silenceCount = 0;
    this.hasSpoken = false;
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}
