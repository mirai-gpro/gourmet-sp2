// src/scripts/chat/live-websocket.ts
// 🚨 改変禁止: WebSocket URL形式・メッセージ形式

// 🚨 具体値を書く
const INPUT_SAMPLE_RATE = 16000;   // 🚨 固定値
const OUTPUT_SAMPLE_RATE = 24000;  // 🚨 Gemini LiveAPI出力のデフォルト

console.assert(INPUT_SAMPLE_RATE === 16000, "入力サンプルレートが改変されています");
console.assert(OUTPUT_SAMPLE_RATE === 24000, "出力サンプルレートが改変されています");

// 🚨 改変禁止: メッセージ形式（バックエンドとの契約）
export interface LiveMessage {
  type: 'audio' | 'text' | 'tool_result' | 'shops' | 'error' | 'session_end' | 'live_ready' | 'turn_complete';
  data: any;
}

export interface ClientMessage {
  type: 'audio_chunk' | 'text_input' | 'cancel';
  data: any;
}

export interface LiveMessageHandler {
  onReady: () => void;
  onText: (text: string) => void;
  onAudio: (base64Pcm: string) => void;
  onTurnComplete: () => void;
  onShops: (data: { response: string; shops: any[]; ttsAudio?: string }) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export { OUTPUT_SAMPLE_RATE };

export class LiveWebSocket {
  private ws: WebSocket | null = null;
  private apiHost: string;
  private sessionId: string;
  private handler: LiveMessageHandler;

  constructor(apiHost: string, sessionId: string, handler: LiveMessageHandler) {
    this.apiHost = apiHost;
    this.sessionId = sessionId;
    this.handler = handler;
  }

  connect() {
    // 🚨 改変禁止: WebSocket URL形式
    const protocol = this.apiHost.startsWith('http:') ? 'ws' : 'wss';
    const host = this.apiHost.replace(/^https?:\/\//, '');
    const url = `${protocol}://${host}/ws/live/${this.sessionId}`;

    console.log('[LiveWS] Connecting:', url);
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[LiveWS] Connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: LiveMessage = JSON.parse(event.data);
        switch (msg.type) {
          case 'live_ready':
            this.handler.onReady();
            break;
          case 'text':
            this.handler.onText(msg.data);
            break;
          case 'audio':
            this.handler.onAudio(msg.data);
            break;
          case 'turn_complete':
            this.handler.onTurnComplete();
            break;
          case 'shops':
            this.handler.onShops(msg.data);
            break;
          case 'error':
            this.handler.onError(msg.data);
            break;
        }
      } catch (e) {
        console.error('[LiveWS] Message parse error:', e);
      }
    };

    this.ws.onclose = (event) => {
      console.log('[LiveWS] Disconnected:', event.code, event.reason);
      this.handler.onClose();
    };

    this.ws.onerror = (error) => {
      console.error('[LiveWS] Error:', error);
    };
  }

  sendAudio(base64Pcm: string) {
    this.send({ type: 'audio_chunk', data: base64Pcm });
  }

  sendText(text: string) {
    this.send({ type: 'text_input', data: text });
  }

  sendCancel() {
    this.send({ type: 'cancel', data: null });
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private send(msg: ClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
