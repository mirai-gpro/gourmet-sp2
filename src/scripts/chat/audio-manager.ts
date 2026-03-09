// src/scripts/chat/audio-manager.ts
//
// マイク音声キャプチャ + AI 音声再生（LiveAPI 専用）
//
// 設計方針（audio-manager-liveapi-change-spec.md 準拠）:
//   §2.4 AudioContext / MediaStream / WorkletNode をシングルトン再利用（iOS/PC 統合）
//   §2.7 AI 音声再生: playPcmAudio（キュー方式ギャップレス）/ playMp3Audio（単発）
//   §2.8 resumeAudioContext: iOS バックグラウンド復帰対応
//   §7.1 getUserMedia は1回のみ（iOS トラックミュート問題回避）
//   §7.2 AudioContext は1つのみ（Safari 上限4つ制限回避）

const TARGET_SAMPLE_RATE = 16000;
const MAX_RECORDING_TIME = 60000;

const IOS_BUFFER_SIZE = 8192;
const DEFAULT_BUFFER_SIZE = 1600;

const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

// --- base64 エンコード（高速版）---
// §2.6: b === undefined チェック修正済み（Number.isNaN では undefined を検知できない）
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
  // §2.4 シングルトンリソース（iOS/PC 共通）
  private audioCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private mediaStream: MediaStream | null = null;
  private isModuleRegistered = false;
  private workletProcName = '';

  // §2.4 canSendAudio フラグ方式
  private canSendAudio = false;
  private onAudioChunkCallback: ((base64: string) => void) | null = null;
  private recordingTimer: number | null = null;

  // §2.7 AI 音声再生
  private scheduledSources: AudioBufferSourceNode[] = [];
  private nextPlayTime = 0;
  private _isPlaying = false;
  private playbackGeneration = 0;
  private readonly MAX_SCHEDULE_AHEAD = 0.5; // 秒


  // ============================================================
  // LiveAPI ストリーミング（メイン機能）
  //
  // §2.4 シングルトン: AudioContext / MediaStream / WorkletNode を再利用
  // §2.3 クライアント VAD なし。Gemini の automatic_activity_detection に委任。
  // ============================================================

  async startStreaming(
    onAudioChunk: (base64: string) => void,
    onStopCallback: () => void,
    _onSpeechStart?: () => void
  ) {
    // 既に送信中なら何もしない
    if (this.canSendAudio) return;

    this.onAudioChunkCallback = onAudioChunk;
    const t0 = performance.now();

    // --- AudioContext 確保（シングルトン）---
    await this.ensureAudioContext();
    const t1 = performance.now();

    // --- MediaStream 確保（§7.1 再利用で getUserMedia 呼び出し最小化）---
    await this.ensureMediaStream();
    const t2 = performance.now();

    // --- AudioWorklet 確保（addModule は1回のみ）---
    await this.ensureWorkletNode();
    const t3 = performance.now();

    // 送信開始
    this.canSendAudio = true;
    console.log(`[AudioManager] startStreaming: ctx=${(t1-t0).toFixed(0)}ms, stream=${(t2-t1).toFixed(0)}ms, worklet=${(t3-t2).toFixed(0)}ms, total=${(t3-t0).toFixed(0)}ms`);

    // MAX_RECORDING_TIME 安全弁
    this.recordingTimer = window.setTimeout(() => {
      this.stopStreaming();
      onStopCallback();
    }, MAX_RECORDING_TIME);
  }

  stopStreaming() {
    // §2.4: canSendAudio = false のみ。ノード破棄しない。
    this.canSendAudio = false;
    this.onAudioChunkCallback = null;
    if (this.recordingTimer) {
      clearTimeout(this.recordingTimer);
      this.recordingTimer = null;
    }
  }

  // ============================================================
  // §2.7 AI 音声再生
  // ============================================================

  /** 複数 base64 PCM チャンクを結合して一括再生 */
  async playPcmChunks(base64Chunks: string[], sampleRate: number = 24000): Promise<void> {
    this.stopAll();
    await this.ensureAudioContext();

    const ctx = this.audioCtx!;

    // 全チャンクを結合: base64 → バイト列
    const allBytes: number[] = [];
    for (const chunk of base64Chunks) {
      const binary = atob(chunk);
      for (let i = 0; i < binary.length; i++) {
        allBytes.push(binary.charCodeAt(i));
      }
    }
    const bytes = new Uint8Array(allBytes);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);

    return new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const gen = this.playbackGeneration;
      source.onended = () => {
        source.disconnect();
        const idx = this.scheduledSources.indexOf(source);
        if (idx >= 0) this.scheduledSources.splice(idx, 1);
        if (gen === this.playbackGeneration) {
          this._isPlaying = false;
        }
        resolve();
      };

      this.scheduledSources.push(source);
      source.start();
      this._isPlaying = true;
    });
  }

  /** 単発再生（ack 音声、GCP TTS 等の MP3） */
  async playMp3Audio(base64Data: string): Promise<void> {
    this.stopAll();
    await this.ensureAudioContext();

    const ctx = this.audioCtx!;
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

    return new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const gen = this.playbackGeneration;
      source.onended = () => {
        source.disconnect();
        const idx = this.scheduledSources.indexOf(source);
        if (idx >= 0) this.scheduledSources.splice(idx, 1);
        if (gen === this.playbackGeneration) {
          this._isPlaying = false;
        }
        resolve();
      };

      this.scheduledSources.push(source);
      source.start();
      this._isPlaying = true;
    });
  }

  /** 全再生停止 */
  stopAll() {
    this.playbackGeneration++;
    for (const src of this.scheduledSources) {
      src.onended = null;
      try { src.stop(); } catch {}
      try { src.disconnect(); } catch {}
    }
    this.scheduledSources = [];
    this.nextPlayTime = 0;
    this._isPlaying = false;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  // ============================================================
  // §2.8 resumeAudioContext（iOS バックグラウンド復帰対応）
  // ============================================================

  async resumeAudioContext(): Promise<void> {
    if (!this.audioCtx || this.audioCtx.state === 'closed') return;

    try {
      await this.audioCtx.resume();
      if (this.audioCtx.state === 'running') return;
    } catch {}

    // resume 失敗 → AudioContext を再生成
    console.log('[AudioManager] resumeAudioContext: recreating AudioContext');
    try { this.audioCtx.close(); } catch {}
    this.audioCtx = null;
    this.workletNode = null;
    this.sourceNode = null;
    this.isModuleRegistered = false;

    // 再生キューもクリア
    this.nextPlayTime = 0;
    this.scheduledSources = [];
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

  /** 全リソース解放（セッション終了用） */
  fullResetAudioResources() {
    this.stopStreaming();
    this.stopAll();

    // WorkletNode
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      try { this.workletNode.disconnect(); } catch {}
      this.workletNode = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch {}
      this.sourceNode = null;
    }

    // MediaStream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    // AudioContext
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
    }
    this.audioCtx = null;
    this.isModuleRegistered = false;
  }

  // --- private: シングルトン確保 ---

  /** AudioContext をシングルトンで確保（§2.4 + §7.2） */
  private async ensureAudioContext() {
    // @ts-ignore
    const ACClass = window.AudioContext || window.webkitAudioContext;
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new ACClass({ latencyHint: 'interactive', sampleRate: 48000 });
      this.isModuleRegistered = false;
      this.workletNode = null;
      this.sourceNode = null;
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  /** MediaStream をシングルトンで確保（§2.4 + §7.1） */
  private async ensureMediaStream() {
    let needNewStream = true;
    if (this.mediaStream) {
      const tracks = this.mediaStream.getAudioTracks();
      if (tracks.length > 0 && tracks[0].readyState === 'live' && tracks[0].enabled && !tracks[0].muted) {
        needNewStream = false;
      }
    }
    if (needNewStream) {
      // 古いストリームを解放
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(t => t.stop());
      }
      // sourceNode は古い stream に紐づいているのでリセット
      if (this.sourceNode) {
        try { this.sourceNode.disconnect(); } catch {}
        this.sourceNode = null;
      }
      this.mediaStream = await this.getUserMediaSafe({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    }
  }

  /** AudioWorkletNode をシングルトンで確保（§2.4） */
  private async ensureWorkletNode() {
    const ctx = this.audioCtx!;
    const bufSize = IS_IOS ? IOS_BUFFER_SIZE : DEFAULT_BUFFER_SIZE;
    const nativeRate = ctx.sampleRate;
    const ratio = nativeRate / TARGET_SAMPLE_RATE;

    // addModule は AudioContext ごとに1回のみ
    if (!this.isModuleRegistered) {
      // Safari は同名プロセッサの再登録でエラーになるためユニーク名を使用
      this.workletProcName = IS_IOS ? `audio-proc-ios-${Date.now()}` : `audio-proc-${Date.now()}`;
      const code = buildWorkletCode(this.workletProcName, bufSize, ratio);
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.isModuleRegistered = true;
      // addModule 後は既存の workletNode は無効
      this.workletNode = null;
    }

    // WorkletNode が無ければ作成
    if (!this.workletNode) {
      this.workletNode = new AudioWorkletNode(ctx, this.workletProcName);
      this.workletNode.port.onmessage = (ev) => {
        if (!this.canSendAudio || !this.onAudioChunkCallback) return;
        const { audioChunk } = ev.data;
        if (audioChunk) {
          try { this.onAudioChunkCallback(arrayBufferToBase64(audioChunk.buffer)); } catch {}
        }
      };
    }

    // sourceNode が無ければ作成して接続
    if (!this.sourceNode && this.mediaStream) {
      this.sourceNode = ctx.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(ctx.destination);
    }
  }

  /** getUserMedia の安全なラッパー（§7.7 HTTPS チェック含む） */
  private async getUserMediaSafe(constraints: MediaStreamConstraints): Promise<MediaStream> {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    // @ts-ignore
    const legacyGetUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
    if (legacyGetUserMedia) {
      return new Promise((resolve, reject) => {
        legacyGetUserMedia.call(navigator, constraints, resolve, reject);
      });
    }
    throw new Error('マイク機能が見つかりません。HTTPS(鍵マーク)のURLでアクセスしているか確認してください。');
  }

}
