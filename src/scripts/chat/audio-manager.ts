
// src/scripts/chat/audio-manager.ts
// ★ Gemini Live API推奨パターンで全面書き直し
// 設計原則:
//   1. AudioContext / MediaStream / AudioWorkletNode はセッション中シングルトン維持
//   2. 半二重制御はフラグ (canSendAudio) で実現（Node破棄しない）
//   3. AI音声再生は HTMLAudioElement ではなく Web Audio API（iOS受話口問題の解消）
//   4. VADのターン検知は Gemini サーバー側に委任（クライアントは帯域節約のみ）

const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fastArrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 3) {
    const c1 = bytes[i];
    const c2 = bytes[i + 1];
    const c3 = bytes[i + 2];
    const enc1 = c1 >> 2;
    const enc2 = ((c1 & 3) << 4) | (c2 >> 4);
    const enc3 = ((c2 & 15) << 2) | (c3 >> 6);
    const enc4 = c3 & 63;
    binary += b64chars[enc1] + b64chars[enc2];
    if (Number.isNaN(c2)) { binary += '=='; }
    else if (Number.isNaN(c3)) { binary += b64chars[enc3] + '='; }
    else { binary += b64chars[enc3] + b64chars[enc4]; }
  }
  return binary;
}

export class AudioManager {
  // ===== シングルトンリソース（セッションライフサイクル） =====
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioWorkletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private isModuleRegistered = false;

  // ===== ストリーミング制御 =====
  private canSendAudio = false;
  private ws: WebSocket | null = null;
  private recordingTimer: number | null = null;
  private readonly MAX_RECORDING_TIME = 60000;

  // ===== 再生（Web Audio API） =====
  private currentSource: AudioBufferSourceNode | null = null;
  private _isPlaying = false;
  private playbackGeneration = 0;

  // ===== レガシー録音（WS不使用時のフォールバック） =====
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private legacyAnalyser: AnalyserNode | null = null;
  private legacyVadInterval: number | null = null;
  private legacySilenceTimer: number | null = null;
  private legacyHasSpoken = false;
  private legacyRecordingStart = 0;
  private legacyConsecutiveSilence = 0;

  // ===== 設定 =====
  private SILENCE_DURATION: number;
  private readonly SILENCE_THRESHOLD = 35;
  private readonly MIN_RECORDING_TIME = 3000;
  private readonly REQUIRED_SILENCE_CHECKS = 5;

  get isPlaying() { return this._isPlaying; }

  constructor(silenceDuration: number = 3500) {
    this.SILENCE_DURATION = silenceDuration;
  }

  // ========================================
  // シングルトン初期化（遅延生成・再利用）
  // ========================================

  /** AudioContext を確保（存在すれば再利用、なければ生成） */
  public async ensureAudioContext(): Promise<AudioContext> {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      // @ts-ignore
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioContext = new AC({ latencyHint: 'interactive', sampleRate: 48000 });
      this.isModuleRegistered = false;
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    return this.audioContext;
  }

  /** MediaStream を確保（存在＆liveなら再利用） */
  private async ensureMediaStream(): Promise<MediaStream> {
    if (this.mediaStream) {
      const tracks = this.mediaStream.getAudioTracks();
      if (tracks.length > 0 && tracks[0].readyState === 'live' && tracks[0].enabled) {
        return this.mediaStream;
      }
      // トラックが dead なら解放して再取得
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    this.mediaStream = await this.getUserMediaSafe({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });
    return this.mediaStream;
  }

  /** AudioWorkletNode を確保（存在すれば再利用） */
  private async ensureWorkletNode(ctx: AudioContext, stream: MediaStream): Promise<AudioWorkletNode> {
    if (this.audioWorkletNode) return this.audioWorkletNode;

    const downsampleRatio = ctx.sampleRate / 16000;

    // AudioWorkletProcessor の登録（AudioContext あたり1回のみ）
    if (!this.isModuleRegistered) {
      const processorCode = `
        class AudioStreamProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this.bufferSize = 8192;
            this.buffer = new Int16Array(this.bufferSize);
            this.writeIndex = 0;
            this.ratio = ${downsampleRatio};
            this.inputSampleCount = 0;
            this.lastFlushTime = Date.now();
          }
          process(inputs) {
            const channelData = inputs[0]?.[0];
            if (!channelData) return true;
            for (let i = 0; i < channelData.length; i++) {
              this.inputSampleCount++;
              if (this.inputSampleCount >= this.ratio) {
                this.inputSampleCount -= this.ratio;
                if (this.writeIndex < this.bufferSize) {
                  const s = Math.max(-1, Math.min(1, channelData[i]));
                  this.buffer[this.writeIndex++] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                if (this.writeIndex >= this.bufferSize ||
                    (this.writeIndex > 0 && Date.now() - this.lastFlushTime > 500)) {
                  this.flush();
                }
              }
            }
            return true;
          }
          flush() {
            if (this.writeIndex === 0) return;
            const chunk = this.buffer.slice(0, this.writeIndex);
            this.port.postMessage({ audioChunk: chunk }, [chunk.buffer]);
            this.writeIndex = 0;
            this.lastFlushTime = Date.now();
          }
        }
        registerProcessor('audio-stream-proc', AudioStreamProcessor);
      `;
      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.isModuleRegistered = true;
    }

    // ソース → WorkletNode → destination（destination接続でprocess()が動作）
    this.sourceNode = ctx.createMediaStreamSource(stream);
    this.audioWorkletNode = new AudioWorkletNode(ctx, 'audio-stream-proc');
    this.sourceNode.connect(this.audioWorkletNode);
    this.audioWorkletNode.connect(ctx.destination);
    // ※ processor は outputs に書き込まないため、destination にはゼロ（無音）が出力される

    // フラグ制御による送信ゲート
    this.audioWorkletNode.port.onmessage = (event) => {
      if (!this.canSendAudio || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        const base64 = fastArrayBufferToBase64(event.data.audioChunk.buffer);
        this.ws.send(JSON.stringify({ type: 'audio', data: base64 }));
      } catch (_e) { /* 送信失敗は無視 */ }
    };

    return this.audioWorkletNode;
  }

  private async getUserMediaSafe(constraints: MediaStreamConstraints): Promise<MediaStream> {
    if (navigator.mediaDevices?.getUserMedia) {
      return navigator.mediaDevices.getUserMedia(constraints);
    }
    // @ts-ignore
    const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
    if (legacy) {
      return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
    }
    throw new Error('マイク機能が見つかりません。HTTPS(鍵マーク)のURLでアクセスしているか確認してください。');
  }

  // ========================================
  // Public API — ストリーミング（マイク→WebSocket）
  // ========================================

  /** iOS Safari 等のオーディオアンロック */
  public unlockAudioParams(element?: HTMLAudioElement) {
    if (this.audioContext?.state === 'suspended') {
      this.audioContext.resume();
    }
    // HTMLAudioElement のアンロック（LAM avatar 連携等で必要な場合）
    if (element) {
      element.muted = true;
      element.play().then(() => {
        element.pause();
        element.currentTime = 0;
        element.muted = false;
      }).catch(() => {});
    }
  }

  /**
   * 音声ストリーミング開始（初回はシングルトン初期化、2回目以降はフラグONのみ）
   * ★ Node/Stream の破棄・再作成は行わない
   */
  public async startStreaming(
    ws: WebSocket,
    languageCode: string,
    onStopCallback: () => void,
    onSpeechStart?: () => void
  ) {
    this.ws = ws;

    // シングルトン初期化（既に初期化済みならスキップ）
    const ctx = await this.ensureAudioContext();
    const stream = await this.ensureMediaStream();
    await this.ensureWorkletNode(ctx, stream);

    // ★ フラグON → 送信開始（これだけ）
    this.canSendAudio = true;
    console.log('[AudioManager] Streaming started (flag ON)');

    // 安全弁: MAX_RECORDING_TIME で自動停止
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    this.recordingTimer = window.setTimeout(() => {
      if (this.canSendAudio) {
        this.stopStreaming();
        onStopCallback();
      }
    }, this.MAX_RECORDING_TIME);
  }

  /**
   * 音声ストリーミング停止（フラグOFFのみ、Node/Streamは維持）
   */
  public stopStreaming() {
    this.canSendAudio = false;
    if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }
    console.log('[AudioManager] Streaming stopped (flag OFF)');
  }

  // ========================================
  // Public API — 再生（Web Audio API）
  // ========================================

  /**
   * PCM 16-bit LE 音声を Web Audio API で再生
   * ★ HTMLAudioElement を使わないため、iOS の受話口問題が発生しない
   */
  public async playPcmAudio(base64Data: string, sampleRate: number = 24000): Promise<void> {
    if (!base64Data) return;
    const ctx = await this.ensureAudioContext();
    this.stopPlayback();
    const gen = ++this.playbackGeneration;

    // Base64 → Int16 PCM → Float32
    const raw = atob(base64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    if (gen !== this.playbackGeneration) return; // キャンセル済み

    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.copyToChannel(float32, 0);
    return this._playBuffer(audioBuffer);
  }

  /**
   * MP3 音声を Web Audio API で再生
   * （挨拶TTS、ack、rest_audio 用）
   */
  public async playMp3Audio(base64Data: string): Promise<void> {
    if (!base64Data) return;
    const ctx = await this.ensureAudioContext();
    this.stopPlayback();
    const gen = ++this.playbackGeneration;

    // Base64 → ArrayBuffer → decodeAudioData
    const raw = atob(base64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const audioBuffer = await new Promise<AudioBuffer>((resolve, reject) => {
      ctx.decodeAudioData(bytes.buffer.slice(0), resolve, reject);
    });

    if (gen !== this.playbackGeneration) return; // キャンセル済み
    return this._playBuffer(audioBuffer);
  }

  /** AudioBuffer を再生（内部共通） */
  private _playBuffer(buffer: AudioBuffer): Promise<void> {
    return new Promise<void>((resolve) => {
      const source = this.audioContext!.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext!.destination);
      this._isPlaying = true;
      this.currentSource = source;
      source.onended = () => {
        if (this.currentSource === source) {
          this.currentSource = null;
          this._isPlaying = false;
        }
        resolve();
      };
      source.start();
    });
  }

  /** 再生停止 */
  public stopPlayback() {
    this.playbackGeneration++;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      this.currentSource = null;
    }
    this._isPlaying = false;
  }

  // ========================================
  // ライフサイクル
  // ========================================

  /** 全リソースを完全に解放（セッション終了時のみ） */
  public fullResetAudioResources() {
    this.canSendAudio = false;
    this.stopPlayback();
    if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }

    if (this.audioWorkletNode) {
      try { this.audioWorkletNode.port.onmessage = null; this.audioWorkletNode.disconnect(); } catch (_) {}
      this.audioWorkletNode = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (_) {}
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    this.audioContext = null;
    this.isModuleRegistered = false;
    this.ws = null;

    // レガシー録音のクリーンアップ
    this.cleanupLegacyVad();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch (_) {}
    }
    this.mediaRecorder = null;
  }

  // ========================================
  // レガシー録音（WebSocket 不使用時のフォールバック）
  // ========================================

  public async startLegacyRecording(
    onStopCallback: (audioBlob: Blob) => void,
    onSpeechStart?: () => void
  ) {
    try {
      if (this.recordingTimer) { clearTimeout(this.recordingTimer); this.recordingTimer = null; }

      const ctx = await this.ensureAudioContext();
      const stream = await this.ensureMediaStream();

      // @ts-ignore
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      this.audioChunks = [];
      this.legacyHasSpoken = false;
      this.legacyRecordingStart = Date.now();
      this.legacyConsecutiveSilence = 0;

      // VAD（レガシー録音時のみ使用 — ストリーミング時は Gemini に委任）
      const source = ctx.createMediaStreamSource(stream);
      this.legacyAnalyser = ctx.createAnalyser();
      this.legacyAnalyser.fftSize = 512;
      source.connect(this.legacyAnalyser);
      const dataArray = new Uint8Array(this.legacyAnalyser.frequencyBinCount);

      this.legacyVadInterval = window.setInterval(() => {
        if (!this.legacyAnalyser) return;
        if (Date.now() - this.legacyRecordingStart < this.MIN_RECORDING_TIME) return;

        this.legacyAnalyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

        if (average > this.SILENCE_THRESHOLD) {
          this.legacyHasSpoken = true;
          this.legacyConsecutiveSilence = 0;
          if (this.legacySilenceTimer) { clearTimeout(this.legacySilenceTimer); this.legacySilenceTimer = null; }
          if (onSpeechStart) onSpeechStart();
        } else if (this.legacyHasSpoken) {
          this.legacyConsecutiveSilence++;
          if (this.legacyConsecutiveSilence >= this.REQUIRED_SILENCE_CHECKS && !this.legacySilenceTimer) {
            this.legacySilenceTimer = window.setTimeout(() => {
              if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                this.mediaRecorder.stop();
              }
            }, this.SILENCE_DURATION);
          }
        }
      }, 100);

      // @ts-ignore
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.audioChunks.push(event.data);
      };

      // @ts-ignore
      this.mediaRecorder.onstop = async () => {
        this.cleanupLegacyVad();
        // ★ MediaStream は停止しない（シングルトン維持）
        if (this.audioChunks.length > 0) {
          const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
          onStopCallback(audioBlob);
        }
      };

      // @ts-ignore
      this.mediaRecorder.start();

      this.recordingTimer = window.setTimeout(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.stop();
        }
      }, this.MAX_RECORDING_TIME);
    } catch (error) {
      throw error;
    }
  }

  private cleanupLegacyVad() {
    if (this.legacyVadInterval) { clearInterval(this.legacyVadInterval); this.legacyVadInterval = null; }
    if (this.legacySilenceTimer) { clearTimeout(this.legacySilenceTimer); this.legacySilenceTimer = null; }
    this.legacyAnalyser = null;
    this.legacyConsecutiveSilence = 0;
  }

  // 後方互換（no-op）
  public async playTTS(_audioBase64: string): Promise<void> { return Promise.resolve(); }
  public stopTTS() {}
}
