// src/scripts/chat/live-websocket.ts
//
// Gemini LiveAPI WebSocket クライアント
//
// バックエンド live_session.py との通信を担当。
// メッセージ形式は live_session.py の _ws_send / _receive と対応。

// サンプルレート（live_session.py: SEND_SAMPLE_RATE / RECEIVE_SAMPLE_RATE と同値）
export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

// ============================================================
// メッセージ型定義（バックエンド live_session.py との契約）
// ============================================================

// サーバー → クライアント
interface ServerMessage {
  type:
    | 'live_ready'           // Gemini セッション接続完了
    | 'text'                 // output_audio_transcription（AI発話テキスト）
    | 'input_transcription'  // input_audio_transcription（ユーザー発話テキスト）
    | 'audio'                // model_turn.parts[].inline_data（PCM音声 base64）
    | 'turn_complete'        // server_content.turn_complete
    | 'interrupted'          // server_content.interrupted（Gemini VAD 割り込み）
    | 'shops'                // search_restaurants ツール結果
    | 'error';               // エラー
  data: any;
}

// クライアント → サーバー
interface ClientMessage {
  type: 'audio_chunk' | 'text_input' | 'cancel';
  data: any;
}

// ============================================================
// コールバック定義
// ============================================================

export interface LiveCallbacks {
  onReady: () => void;
  onText: (text: string) => void;
  onInputTranscription: (text: string) => void;
  onAudio: (base64Pcm: string) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  onShops: (data: { response: string; shops: any[]; ttsAudio?: string }) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

// ============================================================
// LiveWebSocket クラス
// ============================================================

export class LiveWebSocket {
  private ws: WebSocket | null = null;
  private apiHost: string;
  private sessionId: string;
  private cb: LiveCallbacks;

  constructor(apiHost: string, sessionId: string, callbacks: LiveCallbacks) {
    this.apiHost = apiHost;
    this.sessionId = sessionId;
    this.cb = callbacks;
  }

  connect() {
    const protocol = this.apiHost.startsWith('http:') ? 'ws' : 'wss';
    const host = this.apiHost.replace(/^https?:\/\//, '');
    const url = `${protocol}://${host}/ws/live/${this.sessionId}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[LiveWS] Connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg: ServerMessage = JSON.parse(event.data);
        switch (msg.type) {
          case 'live_ready':          this.cb.onReady(); break;
          case 'text':                this.cb.onText(msg.data); break;
          case 'input_transcription': this.cb.onInputTranscription(msg.data); break;
          case 'audio':               this.cb.onAudio(msg.data); break;
          case 'turn_complete':       this.cb.onTurnComplete(); break;
          case 'interrupted':         this.cb.onInterrupted(); break;
          case 'shops':               this.cb.onShops(msg.data); break;
          case 'error':               this.cb.onError(msg.data); break;
        }
      } catch (e) {
        console.error('[LiveWS] Parse error:', e);
      }
    };

    this.ws.onclose = () => {
      this.cb.onClose();
    };

    this.ws.onerror = (e) => {
      console.error('[LiveWS] Error:', e);
    };
  }

  // --- 送信メソッド ---

  sendAudio(base64Pcm: string) {
    this.send({ type: 'audio_chunk', data: base64Pcm });
  }

  sendText(text: string) {
    this.send({ type: 'text_input', data: text });
  }

  sendCancel() {
    this.send({ type: 'cancel', data: null });
  }

  // --- 状態 ---

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
