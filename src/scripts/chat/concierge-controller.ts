

// src/scripts/chat/concierge-controller.ts
// LiveAPI対応版: Socket.IO → LiveAPI WebSocket に移行
import { CoreController } from './core-controller';
import { AudioManager } from './audio-manager';

export class ConciergeController extends CoreController {

  constructor(container: HTMLElement, apiBase: string) {
    super(container, apiBase);

    // コンシェルジュモード用のAudioManagerを8秒設定で再初期化
    this.audioManager = new AudioManager(8000);

    // コンシェルジュモードに設定
    this.currentMode = 'concierge';
    this.init();
  }

  // 初期化プロセスをオーバーライド
  protected async init() {
    // 親クラスの初期化を実行
    await super.init();

    // コンシェルジュ固有の要素とイベントを追加
    const query = (sel: string) => this.container.querySelector(sel) as HTMLElement;
    this.els.avatarContainer = query('.avatar-container');
    this.els.avatarImage = query('#avatarImage') as HTMLImageElement;
    this.els.modeSwitch = query('#modeSwitch') as HTMLInputElement;

    // モードスイッチのイベントリスナー追加
    if (this.els.modeSwitch) {
      this.els.modeSwitch.addEventListener('change', () => {
        this.toggleMode();
      });
    }
  }

  // ========================================
  // セッション初期化をオーバーライド(コンシェルジュ用: user_id送信)
  // ========================================
  protected async initializeSession() {
    try {
      if (this.sessionId) {
        try {
          await fetch(`${this.apiBase}/api/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId })
          });
        } catch (e) {}
      }

      // user_id を取得（親クラスのメソッドを使用）
      const userId = this.getUserId();

      const res = await fetch(`${this.apiBase}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_info: { user_id: userId },
          language: this.currentLanguage,
          mode: 'concierge'
        })
      });
      const data = await res.json();
      this.sessionId = data.session_id;

      // バックエンドからの初回メッセージを画面表示（音声はLiveAPIが喋る）
      const greetingText = data.initial_message || this.t('initialGreetingConcierge');
      this.addMessage('assistant', greetingText, null, true);

      // ショップカード紹介用のTTSを事前生成（LiveAPI接続と並行）
      const ackTexts = [
        this.t('ackConfirm'), this.t('ackSearch'), this.t('ackUnderstood'),
        this.t('ackYes'), this.t('ttsIntro')
      ];
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];

      const ackPromises = ackTexts.map(async (text) => {
        try {
          const ackResponse = await fetch(`${this.apiBase}/api/tts/synthesize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: text, language_code: langConfig.tts, voice_name: langConfig.voice
            })
          });
          const ackData = await ackResponse.json();
          if (ackData.success && ackData.audio) {
            this.preGeneratedAcks.set(text, ackData.audio);
          }
        } catch (_e) { }
      });

      // ack事前生成はバックグラウンドで実行（ブロックしない）
      Promise.all(ackPromises).catch(() => {});

      this.els.userInput.disabled = false;
      this.els.sendBtn.disabled = false;
      this.els.micBtn.disabled = false;
      this.els.speakerBtn.disabled = false;
      this.els.speakerBtn.classList.remove('disabled');
      this.els.reservationBtn.classList.remove('visible');

      // LiveAPI WebSocket接続
      this.initLiveConnection();

    } catch (e) {
      console.error('[Session] Initialization error:', e);
    }
  }

  // ========================================
  // LiveAPI応答ハンドラー: アバターアニメーション対応
  // ========================================

  protected handleLiveAudio(base64: string) {
    // アバターアニメーションを開始
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.add('speaking');
    }
    super.handleLiveAudio(base64);
  }

  protected handleLiveTurnComplete() {
    super.handleLiveTurnComplete();
    // アバターアニメーションを停止
    this.stopAvatarAnimation();
  }

  protected handleLiveShops(data: { response: string; shops: any[]; ttsAudio?: string }) {
    // ショップカード表示時もアバターアニメーション
    if (this.els.avatarContainer && data.ttsAudio) {
      this.els.avatarContainer.classList.add('speaking');
    }
    super.handleLiveShops(data);
    // TTS再生完了後にアニメーション停止（ttsPlayerのonendedで処理）
    const originalOnEnded = this.ttsPlayer.onended;
    this.ttsPlayer.onended = (event) => {
      this.stopAvatarAnimation();
      if (originalOnEnded && typeof originalOnEnded === 'function') {
        originalOnEnded.call(this.ttsPlayer, event);
      }
    };
  }

  // コンシェルジュモード固有: 事前生成TTS再生にアバターアニメーション追加
  protected async playPreGeneratedTts(audioBase64: string): Promise<void> {
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.add('speaking');
    }
    await super.playPreGeneratedTts(audioBase64);
    this.stopAvatarAnimation();
  }

  // コンシェルジュモード固有: アバターアニメーション制御
  protected async speakTextGCP(text: string, stopPrevious: boolean = true, autoRestartMic: boolean = false, skipAudio: boolean = false) {
    if (skipAudio || !this.isTTSEnabled || !text) return Promise.resolve();

    if (stopPrevious) {
      this.ttsPlayer.pause();
    }

    // アバターアニメーションを開始
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.add('speaking');
    }

    // 親クラスのTTS処理を実行
    await super.speakTextGCP(text, stopPrevious, autoRestartMic, skipAudio);

    // アバターアニメーションを停止
    this.stopAvatarAnimation();
  }

  // アバターアニメーション停止
  private stopAvatarAnimation() {
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.remove('speaking');
    }
  }

  // ========================================
  // LiveAPI PCM音声再生: アバターアニメーション対応
  // ========================================
  protected async playLiveAudioChunks(chunks: string[]) {
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.add('speaking');
    }

    await super.playLiveAudioChunks(chunks);

    this.stopAvatarAnimation();
  }

  // ========================================
  // UI言語更新をオーバーライド(挨拶文をコンシェルジュ用に)
  // ========================================
  protected updateUILanguage() {
    // バックエンドからの長期記憶対応済み挨拶を保持
    const initialMessage = this.els.chatArea.querySelector('.message.assistant[data-initial="true"] .message-text');
    const savedGreeting = initialMessage?.textContent;

    // 親クラスのupdateUILanguageを実行（UIラベル等を更新）
    super.updateUILanguage();

    // 長期記憶対応済み挨拶を復元（親が上書きしたものを戻す）
    if (initialMessage && savedGreeting) {
      initialMessage.textContent = savedGreeting;
    }

    // ページタイトルをコンシェルジュ用に設定
    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) {
      pageTitle.innerHTML = `<img src="/pwa-152x152.png" alt="Logo" class="app-logo" /> ${this.t('pageTitleConcierge')}`;
    }
  }

  // モード切り替え処理 - ページ遷移
  private toggleMode() {
    const isChecked = this.els.modeSwitch?.checked;
    if (!isChecked) {
      // チャットモードへページ遷移
      console.log('[ConciergeController] Switching to Chat mode...');
      window.location.href = '/';
    }
  }

  // すべての活動を停止(アバターアニメーションも含む)
  protected stopAllActivities() {
    super.stopAllActivities();
    this.stopAvatarAnimation();
  }
}
