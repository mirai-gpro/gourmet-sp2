

// src/scripts/chat/concierge-controller.ts
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

    // LAMAvatar との統合: 外部TTSプレーヤーをリンク
    const linkTtsPlayer = () => {
      const lam = (window as any).lamAvatarController;
      if (lam && typeof lam.setExternalTtsPlayer === 'function') {
        lam.setExternalTtsPlayer(this.ttsPlayer);
        console.log('[Concierge] Linked external TTS player with LAMAvatar');
        return true;
      }
      return false;
    };
    if (!linkTtsPlayer()) {
      setTimeout(() => linkTtsPlayer(), 2000);
    }
  }

  // ========================================
  // セッション初期化をオーバーライド（LiveAPI対応）
  // ========================================
  protected async initializeSession() {
    try {
      // 旧セッション終了
      if (this.sessionId) {
        try {
          await fetch(`${this.apiBase}/api/v2/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId })
          });
        } catch (e) {}
      }

      // 🚨 既存 LiveAPI WebSocket を閉じる
      if (this.liveWs) {
        try { this.liveWs.close(); } catch (_e) {}
        this.liveWs = null;
      }

      const userId = this.getUserId();

      // session/start リクエスト
      const res = await fetch(`${this.apiBase}/api/v2/session/start`, {
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

      // 🚨 LiveAPI WebSocket 接続（session_id から URL を構築）
      this.connectLiveAPI();

      // バックエンドからの初回メッセージを使用
      const greetingText = data.initial_message || this.t('initialGreetingConcierge');
      this.addMessage('assistant', greetingText, null, true);

      // UI 有効化
      this.els.userInput.disabled = false;
      this.els.sendBtn.disabled = false;
      this.els.micBtn.disabled = false;
      this.els.speakerBtn.disabled = false;
      this.els.speakerBtn.classList.remove('disabled');
      this.els.reservationBtn.classList.remove('visible');

      // 挨拶音声（REST TTS）
      if (this.isTTSEnabled) {
        await this.speakTextGCP(greetingText);
      }

    } catch (e) {
      console.error('[Session] Initialization error:', e);
    }
  }

  // ========================================
  // handleLiveMessage をオーバーライド（アバターアニメーション）
  // ========================================
  protected handleLiveMessage(msg: any) {
    switch (msg.type) {
      case 'connected':
        console.log('[LiveAPI] Gemini session ready (concierge)');
        break;

      case 'text':
        // 親クラスと同じ処理
        this.hideWaitOverlay();
        this.responseBuffer += msg.text;
        this.updateStreamingMessage('assistant', this.responseBuffer);
        break;

      case 'turn_complete':
        // 親クラスと同じ + アバターアニメーション停止
        if (this.responseBuffer) {
          this.finalizeStreamingMessage('assistant', this.responseBuffer);
          if (this.isTTSEnabled) {
            this.speakTextGCP(this.responseBuffer);
          }
          this.responseBuffer = "";
        }
        this.isAISpeaking = false;
        this.stopAvatarAnimation();
        this.resetInputState();
        break;

      case 'shop_data':
        // 親クラス処理 + avatarContainer に 'presenting' クラス追加
        this.hideWaitOverlay();
        if (msg.shops && msg.shops.length > 0) {
          this.currentShops = msg.shops;
          this.els.reservationBtn.classList.add('visible');
          document.dispatchEvent(new CustomEvent('displayShops', {
            detail: { shops: msg.shops, language: this.currentLanguage }
          }));
          const section = document.getElementById('shopListSection');
          if (section) section.classList.add('has-shops');
          if (window.innerWidth < 1024) {
            setTimeout(() => {
              const shopSection = document.getElementById('shopListSection');
              if (shopSection) shopSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 300);
          }
          // コンシェルジュ固有: presenting クラス
          if (this.els.avatarContainer) {
            this.els.avatarContainer.classList.add('presenting');
          }
        }
        break;

      case 'error':
        this.addMessage('system', msg.message || 'エラーが発生しました');
        this.hideWaitOverlay();
        this.stopAvatarAnimation();
        this.resetInputState();
        break;
    }
  }

  // コンシェルジュモード固有: アバターアニメーション制御 + TTS
  protected async speakTextGCP(text: string, stopPrevious: boolean = true, autoRestartMic: boolean = false, skipAudio: boolean = false) {
    if (skipAudio || !this.isTTSEnabled || !text) return Promise.resolve();

    if (stopPrevious) {
      this.ttsPlayer.pause();
    }

    // アバターアニメーションを開始
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.add('speaking');
    }

    const cleanText = this.stripMarkdown(text);
    try {
      this.isAISpeaking = true;
      if (this.isRecording && (this.isIOS || this.isAndroid)) {
        this.stopStreamingSTT();
      }

      this.els.voiceStatus.innerHTML = this.t('voiceStatusSynthesizing');
      this.els.voiceStatus.className = 'voice-status speaking';
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];

      // 🚨 REST TTS エンドポイント（/api/v2/rest/tts/synthesize）
      const response = await fetch(`${this.apiBase}/api/v2/rest/tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: cleanText, language_code: langConfig.tts, voice_name: langConfig.voice,
          session_id: this.sessionId
        })
      });
      const data = await response.json();

      if (data.success && data.audio) {
        // TTS応答に同梱されたExpressionを即バッファ投入（フェーズ2用）
        if (data.expression) this.applyExpressionFromTts(data.expression);
        this.ttsPlayer.src = `data:audio/mp3;base64,${data.audio}`;
        const playPromise = new Promise<void>((resolve) => {
          this.ttsPlayer.onended = async () => {
            this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
            this.els.voiceStatus.className = 'voice-status stopped';
            this.isAISpeaking = false;
            this.stopAvatarAnimation();
            if (autoRestartMic) {
              if (!this.isRecording) {
                try { await this.toggleRecording(); } catch (_error) { this.showMicPrompt(); }
              }
            }
            resolve();
          };
          this.ttsPlayer.onerror = () => {
            this.isAISpeaking = false;
            this.stopAvatarAnimation();
            resolve();
          };
        });

        if (this.isUserInteracted) {
          this.lastAISpeech = this.normalizeText(cleanText);
          await this.ttsPlayer.play();
          await playPromise;
        } else {
          this.showClickPrompt();
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
        }
      } else {
        this.isAISpeaking = false;
        this.stopAvatarAnimation();
      }
    } catch (_error) {
      this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
      this.els.voiceStatus.className = 'voice-status stopped';
      this.isAISpeaking = false;
      this.stopAvatarAnimation();
    }
  }

  // TTS応答に同梱されたExpressionデータをバッファに即投入（フェーズ2用）
  private applyExpressionFromTts(expression: any): void {
    const lamController = (window as any).lamAvatarController;
    if (!lamController) return;

    if (typeof lamController.clearFrameBuffer === 'function') {
      lamController.clearFrameBuffer();
    }

    if (expression?.names && expression?.frames?.length > 0) {
      const frames = expression.frames.map((f: { weights: number[] }) => {
        const frame: { [key: string]: number } = {};
        expression.names.forEach((name: string, i: number) => { frame[name] = f.weights[i]; });
        return frame;
      });
      lamController.queueExpressionFrames(frames, expression.frame_rate || 30);
      console.log(`[Concierge] Expression sync: ${frames.length} frames queued`);
    }
  }

  // アバターアニメーション停止
  private stopAvatarAnimation() {
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.remove('speaking');
      this.els.avatarContainer.classList.remove('presenting');
    }
  }

  // 🚨 sendMessage をオーバーライド（待機アニメーションタイムアウトを 6500ms に変更）
  protected async sendMessage() {
    this.enableAudioPlayback();
    const message = this.els.userInput.value.trim();
    if (!message || this.isProcessing) return;

    // 1. ユーザーメッセージ表示
    this.addMessage('user', message);
    this.els.userInput.value = '';

    // 2. 入力無効化
    this.isProcessing = true;
    this.els.sendBtn.disabled = true;
    this.els.micBtn.disabled = true;
    this.els.userInput.disabled = true;

    // 3. 待機アニメーション（コンシェルジュは6500ms）
    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 6500);

    // 4. 🚨 WebSocket でテキスト送信
    this.sendToLive({ type: 'text', text: message });

    this.els.userInput.blur();
  }

  // UI言語更新をオーバーライド（コンシェルジュ用挨拶を保持）
  protected updateUILanguage() {
    // バックエンドからの長期記憶対応済み挨拶を保持
    const initialMessage = this.els.chatArea.querySelector('.message.assistant[data-initial="true"] .message-text');
    const savedGreeting = initialMessage?.textContent;

    // 親クラスのupdateUILanguageを実行
    super.updateUILanguage();

    // 長期記憶対応済み挨拶を復元
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
