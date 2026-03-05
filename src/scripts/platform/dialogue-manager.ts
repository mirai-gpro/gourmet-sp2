/**
 * DialogueManager — Live API + REST 対話管理
 *
 * 基本は Live API（WebSocket）でリアルタイム会話。
 * お店紹介など長文テキストのみ REST API を使用。
 *
 * Live API（メイン）:
 *   POST /api/v2/session/start → { session_id, ws_url }
 *   WebSocket /api/v2/live/{session_id} → 音声ストリーミング
 *
 * REST API（お店紹介・TTS等）:
 *   POST /api/v2/rest/chat → { response, audio, expression, shops }
 *   POST /api/v2/rest/tts/synthesize → { audio, expression }
 */

import { LiveWSClient, type LiveWSMessage } from './live-ws-client';
import { LiveAudioIO } from './live-audio-io';

export type DialogueType = 'rest' | 'live';

export interface SessionStartParams {
  mode?: string;
  language?: string;
  dialogueType?: DialogueType;
  userId?: string;
  userInfo?: any;
}

export interface SessionInfo {
  sessionId: string;
  mode: string;
  language: string;
  dialogueType: DialogueType;
  greeting: string;
  initialMessage?: string;
  wsUrl?: string;
}

export interface ChatResponse {
  response: string;
  summary?: string;
  shops?: any[];
  shouldConfirm?: boolean;
  isFollowup?: boolean;
}

export interface TTSResponse {
  success: boolean;
  audio?: string;
  expression?: {
    names: string[];
    frames: any[];
    frame_rate: number;
  };
  expression_status?: string;  // "ok" | "error" | "timeout" etc.
}

export interface ExpressionData {
  names: string[];
  frames: any[];
  frame_rate: number;
}

type EventHandler<T = any> = (data: T) => void;

export class DialogueManager {
  private apiBase: string;
  private backendUrl: string;
  private sessionId: string | null = null;
  private mode: string = 'gourmet';
  private language: string = 'ja';
  private dialogueType: DialogueType = 'live';

  // Live API
  private wsClient: LiveWSClient | null = null;
  private audioIO: LiveAudioIO | null = null;

  // Live API 音声再生開始時刻（expression 同期用）
  private _liveAudioStartTime: number | null = null;

  // イベントハンドラ
  private eventHandlers: Map<string, EventHandler[]> = new Map();

  constructor(apiBase: string, backendUrl: string = '') {
    this.apiBase = apiBase;
    this.backendUrl = backendUrl;
  }

  // ========================================
  // セッション管理
  // ========================================

  /**
   * セッション開始（Live API）
   * POST /api/v2/session/start → { session_id, ws_url }
   */
  async startSession(params: SessionStartParams = {}): Promise<SessionInfo> {
    this.mode = params.mode ?? 'gourmet';
    this.language = params.language ?? 'ja';
    this.dialogueType = params.dialogueType ?? 'live';

    const url = `${this.apiBase}/api/v2/session/start`;

    // Live API は 'gourmet' のみ対応。concierge はフロントエンド側の区別。
    const payload = {
      mode: 'gourmet',
      language: this.language,
      dialogue_type: this.dialogueType,
      user_id: params.userId || null,
      user_info: params.userInfo || {},
    };

    console.log(`[DialogueManager] POST ${url}`, JSON.stringify(payload));

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '(no body)');
      console.error(`[DialogueManager] Session start ${res.status}: ${errBody}`);
      throw new Error(`Session start failed: ${res.status}`);
    }

    const data = await res.json();
    this.sessionId = data.session_id;

    const info: SessionInfo = {
      sessionId: data.session_id,
      mode: data.mode || this.mode,
      language: data.language || this.language,
      dialogueType: data.dialogue_type || this.dialogueType,
      greeting: data.greeting || data.initial_message || '',
      initialMessage: data.initial_message,
      wsUrl: data.ws_url,
    };

    // Live API モードの場合、WebSocket 接続を確立（フォールバックなし）
    if (this.dialogueType === 'live' && info.wsUrl) {
      const wsUrl = this.resolveWsUrl(info.wsUrl);
      await this.connectLive(wsUrl);
    }

    return info;
  }

  /**
   * セッション終了
   */
  async endSession(): Promise<void> {
    this.disconnectLive();

    if (this.sessionId) {
      try {
        await fetch(`${this.apiBase}/api/v2/session/end`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: this.sessionId }),
        });
      } catch (e) {
        console.warn('[DialogueManager] Session end failed:', e);
      }
      this.sessionId = null;
    }
  }

  // ========================================
  // REST 対話（既存 gourmet-support 互換）
  // ========================================

  /**
   * REST チャット送信
   * rest/router.py: POST /api/v2/rest/chat
   */
  async sendChat(
    message: string,
    stage: string = 'conversation',
    mode?: string
  ): Promise<ChatResponse> {
    if (!this.sessionId) throw new Error('No active session');

    const res = await fetch(`${this.apiBase}/api/v2/rest/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: this.sessionId,
        message,
        stage,
        language: this.language,
        mode: mode || this.mode,
      }),
    });

    if (!res.ok) throw new Error(`Chat failed: ${res.status}`);
    return await res.json();
  }

  /**
   * REST TTS 合成（Expression 同梱返却）
   * rest/router.py: POST /api/v2/rest/tts/synthesize
   */
  async synthesizeTTS(
    text: string,
    langCode: string = 'ja-JP',
    voiceName: string = 'ja-JP-Chirp3-HD-Leda',
    sessionId?: string
  ): Promise<TTSResponse> {
    const sid = sessionId || this.sessionId;

    const res = await fetch(`${this.apiBase}/api/v2/rest/tts/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language_code: langCode,
        voice_name: voiceName,
        session_id: sid,
      }),
    });

    if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
    return await res.json();
  }

  /**
   * REST キャンセル
   */
  async cancel(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(`${this.apiBase}/api/v2/rest/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.sessionId }),
      });
    } catch (e) {
      console.warn('[DialogueManager] Cancel failed:', e);
    }
  }

  // ========================================
  // Live API 対話
  // ========================================

  /**
   * 相対パスの ws_url をバックエンド直接接続の絶対URLに変換
   * Vercel proxy は WebSocket 非対応のため、backendUrl に直接接続する
   */
  private resolveWsUrl(wsUrl: string): string {
    if (wsUrl.startsWith('ws://') || wsUrl.startsWith('wss://')) {
      return wsUrl; // already absolute
    }
    if (this.backendUrl) {
      const base = this.backendUrl.replace(/^http/, 'ws');
      return `${base}${wsUrl}`;
    }
    return wsUrl; // relative — LiveWSClient will use window.location.host
  }

  private async connectLive(wsUrl: string): Promise<void> {
    this.wsClient = new LiveWSClient({ wsUrl });

    this.wsClient.on('audio', (msg: LiveWSMessage) => {
      if (msg.data && this.audioIO) {
        // 音声をキューに追加（AudioContext 内部で正確な再生タイミングが管理される）
        this.audioIO.queuePlayback(msg.data);
        // 最初の音声チャンク到着を記録（ログ用）
        if (this._liveAudioStartTime === null) {
          this._liveAudioStartTime = performance.now();
          console.log(`[DialogueManager] First audio chunk received at ${this._liveAudioStartTime.toFixed(0)}ms`);
        }
      }
      this.emit('ai_audio', msg.data);
    });

    this.wsClient.on('transcription', (msg: LiveWSMessage) => {
      if (msg.role === 'user') {
        // ユーザーが話し始めた → 次のAIターンに備えてリセット
        this._liveAudioStartTime = null;
        if (this.audioIO) this.audioIO.resetTurn();
        this.emit('user_text', { text: msg.text, isPartial: msg.is_partial });
      } else if (msg.role === 'ai') {
        this.emit('ai_text', { text: msg.text, isPartial: msg.is_partial });
      }
    });

    this.wsClient.on('expression', (msg: LiveWSMessage) => {
      // AudioContext の実再生時間を付与して expression を送出
      // audioIO.playbackCurrentTime は AudioContext.currentTime ベースで
      // 音声チャンク受信→デコード→スケジュール の遅延を含む正確な値
      if (msg.data && this.audioIO) {
        msg.data._audioPlaybackTime = this.audioIO.playbackCurrentTime;
      }
      this.emit('expression', msg.data);
    });

    this.wsClient.on('interrupted', () => {
      if (this.audioIO) {
        this.audioIO.stopPlayback();  // stopPlayback() 内で resetTurn() も呼ばれる
      }
      this._liveAudioStartTime = null;
      this.emit('interrupted', null);
    });

    this.wsClient.on('reconnecting', (msg: LiveWSMessage) => {
      this.emit('reconnecting', msg.reason);
    });

    this.wsClient.on('reconnected', (msg: LiveWSMessage) => {
      this.emit('reconnected', msg.session_count);
    });

    this.wsClient.on('error', (msg: LiveWSMessage) => {
      console.error('[DialogueManager] Live error:', msg.message);
      this.emit('error', msg.message);
    });

    this.wsClient.on('connection', (connected: boolean) => {
      this.emit('connection', connected);
    });

    await this.wsClient.connect();
  }

  private disconnectLive(): void {
    if (this.audioIO) {
      this.audioIO.destroy();
      this.audioIO = null;
    }
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
  }

  /**
   * Live API: マイク音声ストリーミング開始
   * ★ 必ずユーザーインタラクション（tap/click）のイベントハンドラ内から呼ぶこと
   */
  async startLiveStream(): Promise<void> {
    if (!this.wsClient || !this.wsClient.isConnected) {
      throw new Error('Live API not connected');
    }

    this.audioIO = new LiveAudioIO({
      wsClient: this.wsClient,
      sendSampleRate: 16000,
      receiveSampleRate: 24000,
    });

    await this.audioIO.startMic();
    console.log('[DialogueManager] Live stream started');
  }

  stopLiveStream(): void {
    if (this.audioIO) {
      this.audioIO.stopMic();
    }
    console.log('[DialogueManager] Live stream stopped');
  }

  sendLiveText(text: string): void {
    if (this.wsClient && this.wsClient.isConnected) {
      this.wsClient.sendText(text);
    }
  }

  /** Live API 再生停止（barge-in） */
  stopLivePlayback(): void {
    if (this.audioIO) {
      this.audioIO.stopPlayback();
    }
  }

  // ========================================
  // イベント管理
  // ========================================

  on(event: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  off(event: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event) || [];
    this.eventHandlers.set(event, handlers.filter((h) => h !== handler));
  }

  private emit(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach((h) => h(data));
  }

  // ========================================
  // アクセサ
  // ========================================

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  set currentSessionId(id: string | null) {
    this.sessionId = id;
  }

  get currentMode(): string {
    return this.mode;
  }

  get currentLanguage(): string {
    return this.language;
  }

  get currentDialogueType(): DialogueType {
    return this.dialogueType;
  }

  get isLiveConnected(): boolean {
    return this.wsClient?.isConnected ?? false;
  }

  get isMicActive(): boolean {
    return this.audioIO?.micActive ?? false;
  }

  get liveAudioIO(): LiveAudioIO | null {
    return this.audioIO;
  }

  /** Live API 音声再生開始時刻をリセット（ターン終了時に呼ぶ） */
  resetLiveAudioStartTime(): void {
    this._liveAudioStartTime = null;
  }
}
