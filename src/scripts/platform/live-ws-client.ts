/**
 * LiveRelay WebSocket クライアント
 *
 * support_base/live/relay.py の LiveRelay に接続する。
 * ブラウザ ↔ サーバー 間のプロトコルを実装。
 *
 * プロトコル (relay.py):
 *   クライアント → サーバー:
 *     { "type": "audio", "data": "<base64 PCM 16kHz>" }
 *     { "type": "text",  "data": "テキスト入力" }
 *     { "type": "stop" }
 *
 *   サーバー → クライアント:
 *     { "type": "audio",         "data": "<base64 PCM 24kHz>" }
 *     { "type": "transcription", "role": "user"|"ai", "text": "...", "is_partial": bool }
 *     { "type": "expression",    "data": { names, frames, frame_rate } }
 *     { "type": "interrupted" }
 *     { "type": "reconnecting",  "reason": "..." }
 *     { "type": "reconnected",   "session_count": N }
 *     { "type": "error",         "message": "..." }
 */

export interface LiveWSClientOptions {
  wsUrl: string;
  connectTimeout?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
}

export type LiveWSMessageType =
  | 'audio'
  | 'transcription'
  | 'expression'
  | 'interrupted'
  | 'reconnecting'
  | 'reconnected'
  | 'error';

export interface LiveWSMessage {
  type: LiveWSMessageType;
  data?: any;
  role?: 'user' | 'ai';
  text?: string;
  is_partial?: boolean;
  reason?: string;
  session_count?: number;
  message?: string;
}

type LiveWSEventHandler = (msg: LiveWSMessage) => void;
type LiveWSConnectionHandler = (connected: boolean) => void;

export class LiveWSClient {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private resolvedUrl: string = '';
  private connectTimeout: number;
  private handlers: Map<string, LiveWSEventHandler[]> = new Map();
  private connectionHandlers: LiveWSConnectionHandler[] = [];
  private _isConnected = false;

  // Auto-reconnect
  private autoReconnect: boolean;
  private maxReconnectAttempts: number;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  constructor(options: LiveWSClientOptions) {
    this.wsUrl = options.wsUrl;
    this.connectTimeout = options.connectTimeout ?? 10000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, this.connectTimeout);

      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const url = this.wsUrl.startsWith('ws')
          ? this.wsUrl
          : `${protocol}//${host}${this.wsUrl}`;

        this.resolvedUrl = url;
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
          clearTimeout(timer);
          this._isConnected = true;
          this.reconnectAttempts = 0;
          this.notifyConnection(true);
          console.log('[LiveWSClient] Connected:', url);
          resolve();
        };

        this.ws.onclose = (event) => {
          clearTimeout(timer);
          const wasConnected = this._isConnected;
          this._isConnected = false;
          this.notifyConnection(false);
          console.log(`[LiveWSClient] Closed: code=${event.code}, reason=${event.reason}`);

          // 異常切断時に自動再接続を試行
          if (wasConnected && !this.intentionalClose && this.autoReconnect) {
            this.scheduleReconnect();
          }
        };

        this.ws.onerror = (event) => {
          clearTimeout(timer);
          console.error('[LiveWSClient] Error:', event);
          // If we haven't connected yet, reject the promise
          if (!this._isConnected) {
            reject(new Error('WebSocket connection error'));
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn(`[LiveWSClient] Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up`);
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 16000);
    this.reconnectAttempts++;
    console.log(`[LiveWSClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.reconnectInternal();
      } catch (e) {
        console.warn(`[LiveWSClient] Reconnect attempt ${this.reconnectAttempts} failed:`, e);
        // Try again
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private async reconnectInternal(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('WebSocket reconnect timeout'));
      }, this.connectTimeout);

      try {
        this.ws = new WebSocket(this.resolvedUrl);

        this.ws.onopen = () => {
          clearTimeout(timer);
          this._isConnected = true;
          this.reconnectAttempts = 0;
          this.notifyConnection(true);
          console.log('[LiveWSClient] Reconnected:', this.resolvedUrl);
          resolve();
        };

        this.ws.onclose = (event) => {
          clearTimeout(timer);
          const wasConnected = this._isConnected;
          this._isConnected = false;
          this.notifyConnection(false);
          console.log(`[LiveWSClient] Closed after reconnect: code=${event.code}, reason=${event.reason}`);

          if (wasConnected && !this.intentionalClose && this.autoReconnect) {
            this.scheduleReconnect();
          } else if (!wasConnected) {
            reject(new Error('WebSocket closed during reconnect'));
          }
        };

        this.ws.onerror = (event) => {
          clearTimeout(timer);
          console.error('[LiveWSClient] Reconnect error:', event);
          if (!this._isConnected) {
            reject(new Error('WebSocket reconnect error'));
          }
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.sendJson({ type: 'stop' });
      this.ws.close();
      this.ws = null;
    }
    this._isConnected = false;
  }

  sendAudio(base64Pcm: string): void {
    this.sendJson({ type: 'audio', data: base64Pcm });
  }

  sendText(text: string): void {
    this.sendJson({ type: 'text', data: text });
  }

  on(event: LiveWSMessageType | 'connection', handler: any): void {
    if (event === 'connection') {
      this.connectionHandlers.push(handler as LiveWSConnectionHandler);
      return;
    }
    const existing = this.handlers.get(event) || [];
    existing.push(handler as LiveWSEventHandler);
    this.handlers.set(event, existing);
  }

  off(event: LiveWSMessageType | 'connection', handler: any): void {
    if (event === 'connection') {
      this.connectionHandlers = this.connectionHandlers.filter(h => h !== handler);
      return;
    }
    const existing = this.handlers.get(event) || [];
    this.handlers.set(event, existing.filter(h => h !== handler));
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  private sendJson(obj: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private handleMessage(raw: string): void {
    try {
      const msg: LiveWSMessage = JSON.parse(raw);
      const handlers = this.handlers.get(msg.type);
      if (handlers) {
        handlers.forEach(h => h(msg));
      }
    } catch (e) {
      console.warn('[LiveWSClient] Failed to parse message:', raw);
    }
  }

  private notifyConnection(connected: boolean): void {
    this.connectionHandlers.forEach(h => h(connected));
  }
}
