
// src/scripts/chat/core-controller.ts
// LiveAPI対応版: Socket.IO → LiveAPI WebSocket に移行
import { i18n } from '../../constants/i18n';
import { AudioManager } from './audio-manager';
import { LiveWebSocket, OUTPUT_SAMPLE_RATE } from './live-websocket';

export class CoreController {
  protected container: HTMLElement;
  protected apiBase: string;
  protected audioManager: AudioManager;
  protected liveWs: LiveWebSocket | null = null;

  protected currentLanguage: 'ja' | 'en' | 'zh' | 'ko' = 'ja';
  protected sessionId: string | null = null;
  protected isProcessing = false;
  protected isRecording = false;
  protected waitOverlayTimer: number | null = null;
  protected waitAnnouncementTimer: number | null = null;
  protected isTTSEnabled = true;
  protected isUserInteracted = false;
  protected currentShops: any[] = [];
  protected isFromVoiceInput = false;
  protected lastAISpeech = '';
  protected preGeneratedAcks: Map<string, string> = new Map();
  protected isAISpeaking = false;
  protected currentAISpeech = "";
  protected currentMode: 'chat' | 'concierge' = 'chat';
  protected suppressNextLiveAudio = false;

  // LiveAPI初回挨拶フラグ: REST表示済みテキストをLiveAPI挨拶で上書き
  protected isInitialGreetingPending = false;

  // LiveAPI応答蓄積用
  protected pendingResponseText = '';
  protected pendingAudioChunks: string[] = [];
  protected liveReady = false;

  // ユーザー発話トランスクリプション蓄積用
  protected pendingUserTranscript = '';

  // AI応答ストリーミング表示用
  protected streamingMsgEl: HTMLElement | null = null;

  // バックグラウンド状態の追跡
  protected isInBackground = false;
  protected backgroundStartTime = 0;
  protected readonly BACKGROUND_RESET_THRESHOLD = 120000;

  protected isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  protected isAndroid = /Android/i.test(navigator.userAgent);

  protected els: any = {};
  protected ttsPlayer: HTMLAudioElement;

  protected readonly LANGUAGE_CODE_MAP = {
    ja: { tts: 'ja-JP', stt: 'ja-JP', voice: 'ja-JP-Chirp3-HD-Leda' },
    en: { tts: 'en-US', stt: 'en-US', voice: 'en-US-Studio-O' },
    zh: { tts: 'cmn-CN', stt: 'cmn-CN', voice: 'cmn-CN-Wavenet-A' },
    ko: { tts: 'ko-KR', stt: 'ko-KR', voice: 'ko-KR-Wavenet-A' }
  };

  constructor(container: HTMLElement, apiBase: string) {
    this.container = container;
    this.apiBase = apiBase;
    this.audioManager = new AudioManager();
    this.ttsPlayer = new Audio();

    const query = (sel: string) => container.querySelector(sel) as HTMLElement;
    this.els = {
      chatArea: query('#chatArea'),
      userInput: query('#userInput') as HTMLInputElement,
      sendBtn: query('#sendBtn'),
      micBtn: query('#micBtnFloat'),
      speakerBtn: query('#speakerBtnFloat'),
      voiceStatus: query('#voiceStatus'),
      waitOverlay: query('#waitOverlay'),
      waitVideo: query('#waitVideo') as HTMLVideoElement,
      splashOverlay: query('#splashOverlay'),
      splashVideo: query('#splashVideo') as HTMLVideoElement,
      reservationBtn: query('#reservationBtnFloat'),
      stopBtn: query('#stopBtn'),
      languageSelect: query('#languageSelect') as HTMLSelectElement
    };
  }

  protected async init() {
    console.log('[Core] Starting initialization...');

    this.bindEvents();

    setTimeout(() => {
        if (this.els.splashVideo) this.els.splashVideo.loop = false;
        if (this.els.splashOverlay) {
             this.els.splashOverlay.classList.add('fade-out');
             setTimeout(() => this.els.splashOverlay.classList.add('hidden'), 800);
        }
    }, 10000);

    await this.initializeSession();
    this.updateUILanguage();

    setTimeout(() => {
      if (this.els.splashOverlay) {
        this.els.splashOverlay.classList.add('fade-out');
        setTimeout(() => this.els.splashOverlay.classList.add('hidden'), 800);
      }
    }, 2000);

    console.log('[Core] Initialization completed');
  }

  protected getUserId(): string {
    const STORAGE_KEY = 'gourmet_support_user_id';
    let userId = localStorage.getItem(STORAGE_KEY);
    if (!userId) {
      userId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem(STORAGE_KEY, userId);
      console.log('[Core] 新規 user_id を生成:', userId);
    }
    return userId;
  }

  protected async resetAppContent() {
    console.log('[Reset] Starting soft reset...');
    const oldSessionId = this.sessionId;
    this.stopAllActivities();

    if (oldSessionId) {
      try {
        await fetch(`${this.apiBase}/api/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: oldSessionId })
        });
      } catch (e) { console.log('[Reset] Cancel error:', e); }
    }

    if (this.els.chatArea) this.els.chatArea.innerHTML = '';
    const shopCardList = document.getElementById('shopCardList');
    if (shopCardList) shopCardList.innerHTML = '';
    const shopListSection = document.getElementById('shopListSection');
    if (shopListSection) shopListSection.classList.remove('has-shops');
    const floatingButtons = document.querySelector('.floating-buttons');
    if (floatingButtons) floatingButtons.classList.remove('shop-card-active');

    this.els.userInput.value = '';
    this.els.userInput.disabled = true;
    this.els.sendBtn.disabled = true;
    this.els.micBtn.disabled = true;
    this.els.speakerBtn.disabled = true;
    this.els.reservationBtn.classList.remove('visible');

    this.currentShops = [];
    this.sessionId = null;
    this.lastAISpeech = '';
    this.preGeneratedAcks.clear();
    this.isProcessing = false;
    this.isAISpeaking = false;
    this.isFromVoiceInput = false;
    this.pendingResponseText = '';
    this.pendingAudioChunks = [];
    this.liveReady = false;
    this.suppressNextLiveAudio = false;
    this.pendingUserTranscript = '';
    this.streamingMsgEl = null;

    await new Promise(resolve => setTimeout(resolve, 300));
    await this.initializeSession();

    this.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.scrollTo({ top: 0, behavior: 'smooth' });

    console.log('[Reset] Completed');
  }

  protected bindEvents() {
    this.els.sendBtn?.addEventListener('click', () => this.sendMessage());

    this.els.micBtn?.addEventListener('click', () => {
      this.toggleRecording();
    });

    this.els.speakerBtn?.addEventListener('click', () => this.toggleTTS());
    this.els.reservationBtn?.addEventListener('click', () => this.openReservationModal());
    this.els.stopBtn?.addEventListener('click', () => this.stopAllActivities());

    this.els.userInput?.addEventListener('keypress', (e: KeyboardEvent) => {
      if (e.key === 'Enter') this.sendMessage();
    });

    this.els.languageSelect?.addEventListener('change', () => {
      this.currentLanguage = this.els.languageSelect.value as any;
      this.updateUILanguage();
    });

    const floatingButtons = this.container.querySelector('.floating-buttons');
    this.els.userInput?.addEventListener('focus', () => {
      setTimeout(() => { if (floatingButtons) floatingButtons.classList.add('keyboard-active'); }, 300);
    });
    this.els.userInput?.addEventListener('blur', () => {
      if (floatingButtons) floatingButtons.classList.remove('keyboard-active');
    });

    const resetHandler = async () => { await this.resetAppContent(); };
    const resetWrapper = async () => {
      await resetHandler();
      document.addEventListener('gourmet-app:reset', resetWrapper, { once: true });
    };
    document.addEventListener('gourmet-app:reset', resetWrapper, { once: true });

    // バックグラウンド復帰時の復旧処理
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        this.isInBackground = true;
        this.backgroundStartTime = Date.now();
      } else if (this.isInBackground) {
        this.isInBackground = false;
        const backgroundDuration = Date.now() - this.backgroundStartTime;
        console.log(`[Foreground] Resuming from background (${Math.round(backgroundDuration / 1000)}s)`);

        if (backgroundDuration > this.BACKGROUND_RESET_THRESHOLD) {
          console.log('[Foreground] Long background duration - triggering soft reset...');
          await this.resetAppContent();
          return;
        }

        // AudioContext 復帰（§2.8: iOS バックグラウンド復帰対応）
        this.audioManager.resumeAudioContext();

        // LiveAPI WebSocket再接続
        if (this.liveWs && !this.liveWs.isConnected() && this.sessionId) {
          console.log('[Foreground] Reconnecting LiveAPI WebSocket...');
          this.initLiveConnection();
        }

        // UI状態をリセット
        this.isProcessing = false;
        this.isAISpeaking = false;
        this.hideWaitOverlay();

        if (this.els.sendBtn) this.els.sendBtn.disabled = false;
        if (this.els.micBtn) this.els.micBtn.disabled = false;
        if (this.els.userInput) this.els.userInput.disabled = false;
        if (this.els.voiceStatus) {
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
        }
      }
    });
  }

  // LiveAPI WebSocket接続を初期化
  protected initLiveConnection() {
    if (!this.sessionId) return;

    // 既存接続を切断
    if (this.liveWs) {
      this.liveWs.disconnect();
    }

    this.liveReady = false;

    this.liveWs = new LiveWebSocket(this.apiBase, this.sessionId, {
      onReady: () => {
        console.log('[LiveAPI] Ready');
        this.liveReady = true;
      },
      onText: (text: string) => {
        this.handleLiveText(text);
      },
      onInputTranscription: (text: string) => {
        this.handleLiveInputTranscription(text);
      },
      onAudio: (base64: string) => {
        this.handleLiveAudio(base64);
      },
      onTurnComplete: () => {
        this.handleLiveTurnComplete();
      },
      onInterrupted: () => {
        this.handleLiveInterrupted();
      },
      onShops: (data: { response: string; shops: any[]; ttsAudio?: string }) => {
        this.handleLiveShops(data);
      },
      onShopsUpdate: (data: { response: string; shops: any[] }) => {
        this.handleLiveShopsUpdate(data);
      },
      onSearching: () => {
        this.handleLiveSearching();
      },
      onError: (msg: string) => {
        console.error('[LiveAPI] Error:', msg);
        this.hideWaitOverlay();
        this.resetInputState();
      },
      onClose: () => {
        console.log('[LiveAPI] Connection closed (reconnection exhausted)');
        this.liveReady = false;
        // 再接続が全て失敗した場合、セッションごとリセット
        console.log('[LiveAPI] Triggering full session reset...');
        this.resetAppContent();
      }
    });

    this.liveWs.connect();
  }

  // 後方互換性のためinitSocketをinitLiveConnectionにリダイレクト
  protected initSocket() {
    this.initLiveConnection();
  }

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

      const res = await fetch(`${this.apiBase}/api/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_info: {}, language: this.currentLanguage, mode: this.currentMode })
      });
      const data = await res.json();
      this.sessionId = data.session_id;

      // LiveAPI挨拶が本線 → プレースホルダー不要
      // handleLiveTurnComplete で初回挨拶テキスト + 音声を表示・再生
      this.isInitialGreetingPending = true;

      // LiveAPI WebSocket接続を即座に開始
      this.initLiveConnection();

      // LiveAPI挨拶到着まで待機アニメーション表示
      // handleLiveTurnComplete の hideWaitOverlay() で自動的に非表示になる
      this.showWaitOverlay();

      // ショップカード紹介用のTTSを事前生成（バックグラウンド）
      const ackTexts = [
        this.t('ackConfirm'), this.t('ackSearch'), this.t('ackUnderstood'),
        this.t('ackYes'), this.t('ttsIntro'), this.t('additionalResponse')
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

      // UI有効化
      this.els.userInput.disabled = false;
      this.els.sendBtn.disabled = false;
      this.els.micBtn.disabled = false;
      this.els.speakerBtn.disabled = false;
      this.els.speakerBtn.classList.remove('disabled');
      this.els.reservationBtn.classList.remove('visible');

      // ack事前生成はバックグラウンドで完了を待つ
      Promise.all(ackPromises).catch(e => console.warn('[Core] TTS background error:', e));

    } catch (e) {
      console.error('[Session] Initialization error:', e);
    }
  }

  // ========================================
  // LiveAPI 応答ハンドラー
  // ========================================

  protected handleLiveSearching() {
    // 即座にウエイティングアニメーション表示
    this.showWaitOverlay();

    // 事前生成済みの相槌TTS（"お調べします。"）を即座に再生
    const ackText = this.t('ackSearch');
    const ackAudio = this.preGeneratedAcks.get(ackText);
    if (ackAudio && this.isTTSEnabled && this.isUserInteracted) {
      console.log('[LiveAPI] Playing pre-generated ack:', ackText);
      this.isAISpeaking = true;
      this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
      this.els.voiceStatus.className = 'voice-status speaking';
      this.audioManager.playMp3Audio(ackAudio).then(() => {
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        this.isAISpeaking = false;
      }).catch(() => { this.isAISpeaking = false; });
    }

    // 5秒後に「只今、お店の情報を確認中です...」アナウンス（UX対策）
    if (this.waitAnnouncementTimer) clearTimeout(this.waitAnnouncementTimer);
    this.waitAnnouncementTimer = window.setTimeout(() => {
      this.waitAnnouncementTimer = null;
      const addText = this.t('additionalResponse');
      const addAudio = this.preGeneratedAcks.get(addText);
      if (addAudio && this.isTTSEnabled && this.isUserInteracted && !this.isAISpeaking) {
        console.log('[LiveAPI] Playing wait announcement:', addText);
        this.isAISpeaking = true;
        this.audioManager.playMp3Audio(addAudio).then(() => {
          this.isAISpeaking = false;
        }).catch(() => { this.isAISpeaking = false; });
      }
    }, 5000);
  }

  protected handleLiveText(text: string) {
    // AIテキスト到着 = ユーザー発話確定（ユーザーバブルをAI回答より先に表示）
    this.finalizeUserTranscript();
    // output_audio_transcription からのテキスト（AI発話のテキスト版）
    if (!this.suppressNextLiveAudio) {
      this.pendingResponseText += text;

      // ストリーミング表示: テキスト到着時にリアルタイムでバブルに反映
      if (this.streamingMsgEl) {
        const span = this.streamingMsgEl.querySelector('.message-text');
        if (span) span.textContent = this.pendingResponseText;
      } else if (!this.isInitialGreetingPending) {
        // 初回挨拶以外: ストリーミングバブルを作成
        this.hideWaitOverlay();
        this.streamingMsgEl = this.addMessageElement('assistant', this.pendingResponseText);
      }
      this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
    }
  }

  protected handleLiveInputTranscription(_text: string) {
    // input_audio_transcription 廃止: 何もしない
  }

  protected handleLiveAudio(base64: string) {
    // AI音声受信 = ユーザー発話確定

    // ショップ表示後のLiveAPI音声は抑制（Cloud TTSで代替済み）
    if (this.suppressNextLiveAudio) return;
    this.pendingAudioChunks.push(base64);
    this.isAISpeaking = true;
  }

  protected handleLiveInterrupted() {
    // Gemini VAD が割り込みを検知 → 現在の再生を停止
    console.log(`[LiveAPI] INTERRUPTED: pendingText="${this.pendingResponseText.slice(0, 50)}", audioChunks=${this.pendingAudioChunks.length}, isRecording=${this.isRecording}, isAISpeaking=${this.isAISpeaking}`);
    this.stopCurrentAudio();
    this.pendingAudioChunks = [];
    this.pendingResponseText = '';
    this.isAISpeaking = false;
    this.suppressNextLiveAudio = false;
    // 進行中のストリーミングテキストバブルもクリア
    if (this.streamingMsgEl) {
      this.streamingMsgEl = null;
    }
  }

  protected handleLiveTurnComplete() {
    console.log(`[LiveAPI] TurnComplete: textLen=${this.pendingResponseText.length}, audioChunks=${this.pendingAudioChunks.length}, suppress=${this.suppressNextLiveAudio}, initialPending=${this.isInitialGreetingPending}`);
    this.hideWaitOverlay();


    // ショップ表示後のLiveAPI音声ターンは完全スキップ
    if (this.suppressNextLiveAudio) {
      this.suppressNextLiveAudio = false;
      this.pendingResponseText = '';
      this.pendingAudioChunks = [];
      this.streamingMsgEl = null;
      this.isProcessing = false;
      this.resetInputState();
      return;
    }

    if (this.pendingResponseText) {
      if (this.streamingMsgEl) {
        // ストリーミング表示済み → 最終テキストで確定（バブル追加不要）
        const span = this.streamingMsgEl.querySelector('.message-text');
        if (span) span.textContent = this.pendingResponseText;
        this.streamingMsgEl = null;
      } else if (this.isInitialGreetingPending) {
        // LiveAPI挨拶が到着 → 初回メッセージとして表示
        this.addMessage('assistant', this.pendingResponseText);
      } else {
        this.addMessage('assistant', this.pendingResponseText);
      }
      this.isInitialGreetingPending = false;
      this.currentAISpeech = this.pendingResponseText;
      this.lastAISpeech = this.normalizeText(this.pendingResponseText);

      // テキストからショップ情報を抽出
      const extractedShops = this.extractShopsFromResponse(this.pendingResponseText);
      if (extractedShops.length > 0) {
        this.currentShops = extractedShops;
        this.els.reservationBtn.classList.add('visible');
        document.dispatchEvent(new CustomEvent('displayShops', {
          detail: { shops: extractedShops, language: this.currentLanguage }
        }));
        const section = document.getElementById('shopListSection');
        if (section) section.classList.add('has-shops');
      }
    }
    this.pendingResponseText = '';

    // LiveAPIからのPCM音声を再生
    if (this.pendingAudioChunks.length > 0 && this.isTTSEnabled && this.isUserInteracted) {
      this.playLiveAudioChunks(this.pendingAudioChunks);
    } else {
      this.isAISpeaking = false;
    }
    this.pendingAudioChunks = [];

    this.isProcessing = false;
    this.resetInputState();
  }

  protected handleLiveShops(data: { response: string; shops: any[]; ttsAudio?: string }) {
    this.hideWaitOverlay();


    const { response, shops, ttsAudio } = data;

    if (response) {
      this.addMessage('assistant', response);
      this.currentAISpeech = response;
    }

    if (shops && shops.length > 0) {
      this.currentShops = shops;
      this.els.reservationBtn.classList.add('visible');
      this.els.userInput.value = '';

      document.dispatchEvent(new CustomEvent('displayShops', {
        detail: { shops, language: this.currentLanguage }
      }));

      const section = document.getElementById('shopListSection');
      if (section) section.classList.add('has-shops');
      if (window.innerWidth < 1024) {
        setTimeout(() => {
          const shopSection = document.getElementById('shopListSection');
          if (shopSection) shopSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 300);
      }

      // ショップカード紹介はCloud TTS（REST維持）→ audioManager.playMp3Audio
      if (ttsAudio && this.isTTSEnabled && this.isUserInteracted) {
        this.isAISpeaking = true;
        this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
        this.els.voiceStatus.className = 'voice-status speaking';
        this.audioManager.playMp3Audio(ttsAudio).then(() => {
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
          this.isAISpeaking = false;
        }).catch(() => { this.isAISpeaking = false; });
      }
    }

    // LiveAPI音声チャンクをクリア（ショップ時はCloud TTSを使うため）
    this.pendingResponseText = '';
    this.pendingAudioChunks = [];

    // ショップ表示後にGeminiが生成する遅延音声応答を抑制
    // （Cloud TTSで既にお店紹介済みのため不要）
    this.suppressNextLiveAudio = true;

    this.isProcessing = false;
    this.resetInputState();
  }

  protected handleLiveShopsUpdate(data: { response: string; shops: any[] }) {
    // 全軒完了 → ショップカードを差し替え表示（TTS は1軒目先行時に再生済み）
    const { response, shops } = data;

    if (shops && shops.length > 0) {
      this.currentShops = shops;

      // チャットバブルの応答テキストを全軒版に差し替え
      if (response) {
        // 既存のassistantバブルの最後のものを更新
        const bubbles = this.els.chatArea.querySelectorAll('.message.assistant .message-text');
        if (bubbles.length > 0) {
          bubbles[bubbles.length - 1].textContent = response;
        }
        this.currentAISpeech = response;
      }

      // ショップカードを全軒で差し替え
      document.dispatchEvent(new CustomEvent('displayShops', {
        detail: { shops, language: this.currentLanguage }
      }));
    }

    console.log(`[LiveAPI] Shops updated: ${shops?.length || 0} shops`);
  }

  // ========================================
  // PCM音声再生（LiveAPI出力: 24kHz 16bit mono）
  // ========================================

  protected async playLiveAudioChunks(chunks: string[]) {
    this.isAISpeaking = true;
    this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
    this.els.voiceStatus.className = 'voice-status speaking';

    try {
      // 全チャンクを結合して一括再生（旧 WAV 方式と同等の即時再生）
      await this.audioManager.playPcmChunks(chunks, OUTPUT_SAMPLE_RATE);
    } catch {}

    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
    this.isAISpeaking = false;
  }

  // ========================================
  // 音声入力（LiveAPI: AudioWorklet → WebSocket直接送信）
  // ========================================

  protected async toggleRecording() {
    this.enableAudioPlayback();
    this.els.userInput.value = '';

    if (this.isRecording) {
      this.stopRecording();
      return;
    }

    if (this.isProcessing || this.isAISpeaking || this.audioManager.isPlaying) {
      if (this.isProcessing && this.liveWs) {
        this.liveWs.sendCancel();
      }

      this.stopCurrentAudio();
      this.hideWaitOverlay();
      this.isProcessing = false;
      this.isAISpeaking = false;
      this.resetInputState();
    }

    if (this.liveWs && this.liveWs.isConnected()) {
      this.isRecording = true;
      this.isProcessing = true;
      this.els.micBtn.classList.add('recording');
      this.els.voiceStatus.innerHTML = this.t('voiceStatusListening');
      this.els.voiceStatus.className = 'voice-status listening';

      try {
        await this.audioManager.startStreaming(
          (base64Chunk: string) => {
            // 音声チャンクをLiveAPI WebSocketに直接送信
            if (this.liveWs) this.liveWs.sendAudio(base64Chunk);
          },
          () => {
            // MAX_RECORDING_TIME 到達 → 録音停止
            this.stopRecording();
          },
          () => {
            this.els.voiceStatus.innerHTML = this.t('voiceStatusRecording');
          }
        );
      } catch (error: any) {
        this.stopRecording();
        if (!error.message?.includes('マイク')) {
          this.showError(this.t('micAccessError'));
        }
      }
    }
  }

  protected stopRecording() {
    this.audioManager.stopStreaming();
    this.isRecording = false;
    this.els.micBtn.classList.remove('recording');
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

  // ========================================
  // メッセージ送信（LiveAPI WebSocket経由）
  // ========================================

  protected async sendMessage() {
    this.unlockAudioParams();
    const message = this.els.userInput.value.trim();
    if (!message || this.isProcessing) return;

    this.isProcessing = true;
    this.els.sendBtn.disabled = true;
    this.els.micBtn.disabled = true;
    this.els.userInput.disabled = true;

    if (!this.isFromVoiceInput) {
      this.addMessage('user', message);
      const textLength = message.trim().replace(/\s+/g, '').length;
      if (textLength < 2) {
           const msg = this.t('shortMsgWarning');
           this.addMessage('assistant', msg);
           if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(msg, true);
           this.resetInputState();
           return;
      }
      this.els.userInput.value = '';
    }

    this.isFromVoiceInput = false;

    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 4000);

    // LiveAPI WebSocket経由でテキスト送信
    if (this.liveWs && this.liveWs.isConnected()) {
      this.liveWs.sendText(message);
      // 応答はLiveAPIコールバック(handleLiveText/handleLiveTurnComplete/handleLiveShops)で処理
    } else {
      this.hideWaitOverlay();
      this.showError(this.t('connectionError') || 'LiveAPI接続が切れています。ページを再読み込みしてください。');
      this.resetInputState();
    }
  }

  // ========================================
  // 事前生成済みTTS再生（サーバー側で生成済みの base64 MP3 を即時再生）
  // ========================================

  protected async playPreGeneratedTts(audioBase64: string): Promise<void> {
    if (!this.isTTSEnabled || !audioBase64) return;
    if (!this.isUserInteracted) return;

    this.isAISpeaking = true;
    this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
    this.els.voiceStatus.className = 'voice-status speaking';

    try {
      await this.audioManager.playMp3Audio(audioBase64);
    } catch {}

    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
    this.isAISpeaking = false;
  }

  // ========================================
  // Cloud TTS（ショップカード紹介用に維持）
  // ========================================

  protected async speakTextGCP(text: string, stopPrevious: boolean = true, autoRestartMic: boolean = false, skipAudio: boolean = false) {
    if (skipAudio) return Promise.resolve();
    if (!this.isTTSEnabled || !text) return Promise.resolve();

    if (stopPrevious && this.isTTSEnabled) {
      this.audioManager.stopAll();
    }

    const cleanText = this.stripMarkdown(text);
    try {
      this.isAISpeaking = true;
      if (this.isRecording && (this.isIOS || this.isAndroid)) {
        this.stopRecording();
      }

      this.els.voiceStatus.innerHTML = this.t('voiceStatusSynthesizing');
      this.els.voiceStatus.className = 'voice-status speaking';
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];

      const response = await fetch(`${this.apiBase}/api/tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: cleanText, language_code: langConfig.tts, voice_name: langConfig.voice
        })
      });
      const data = await response.json();
      if (data.success && data.audio) {
        if (this.isUserInteracted) {
          this.lastAISpeech = this.normalizeText(cleanText);
          await this.audioManager.playMp3Audio(data.audio);
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
          this.isAISpeaking = false;
          if (autoRestartMic) {
            if (!this.isRecording) {
              try { await this.toggleRecording(); } catch (_error) { this.showMicPrompt(); }
            }
          }
        } else {
          this.showClickPrompt();
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
          this.isAISpeaking = false;
        }
      } else {
        this.isAISpeaking = false;
      }
    } catch (_error) {
      this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
      this.els.voiceStatus.className = 'voice-status stopped';
      this.isAISpeaking = false;
    }
  }

  protected showWaitOverlay() {
    this.els.waitOverlay.classList.remove('hidden');
    this.els.waitVideo.currentTime = 0;
    this.els.waitVideo.play().catch((e: any) => console.log('Video err', e));
  }

  protected hideWaitOverlay() {
    if (this.waitOverlayTimer) { clearTimeout(this.waitOverlayTimer); this.waitOverlayTimer = null; }
    if (this.waitAnnouncementTimer) { clearTimeout(this.waitAnnouncementTimer); this.waitAnnouncementTimer = null; }
    this.els.waitOverlay.classList.add('hidden');
    setTimeout(() => this.els.waitVideo.pause(), 500);
  }

  protected unlockAudioParams() {
    this.audioManager.unlockAudioParams(this.ttsPlayer);
  }

  protected enableAudioPlayback() {
    if (!this.isUserInteracted) {
      this.isUserInteracted = true;
      const clickPrompt = this.container.querySelector('.click-prompt');
      if (clickPrompt) clickPrompt.remove();
      this.unlockAudioParams();
    }
  }

  protected stopCurrentAudio() {
    this.audioManager.stopAll();
    this.ttsPlayer.pause();
    this.ttsPlayer.currentTime = 0;
  }

  protected showClickPrompt() {
    const prompt = document.createElement('div');
    prompt.className = 'click-prompt';
    prompt.innerHTML = `<p>🔊</p><p>${this.t('clickPrompt')}</p><p>🔊</p>`;
    prompt.addEventListener('click', () => this.enableAudioPlayback());
    this.container.style.position = 'relative';
    this.container.appendChild(prompt);
  }

  protected showMicPrompt() {
    const modal = document.createElement('div');
    modal.id = 'mic-prompt-modal';
    modal.style.cssText = `position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000; animation: fadeIn 0.3s ease;`;
    modal.innerHTML = `
      <div style="background: white; border-radius: 16px; padding: 24px; max-width: 90%; width: 350px; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.3);">
        <div style="font-size: 48px; margin-bottom: 16px;">🎤</div>
        <div style="font-size: 18px; font-weight: 700; margin-bottom: 8px; color: #333;">マイクをONにしてください</div>
        <div style="font-size: 14px; color: #666; margin-bottom: 20px;">AIの回答が終わりました。<br>続けて話すにはマイクボタンをタップしてください。</div>
        <button id="mic-prompt-btn" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; padding: 14px 32px; border-radius: 24px; font-size: 16px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);">🎤 マイクON</button>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }`;
    document.head.appendChild(style);
    document.body.appendChild(modal);

    const btn = document.getElementById('mic-prompt-btn');
    btn?.addEventListener('click', async () => {
      modal.remove();
      await this.toggleRecording();
    });
    setTimeout(() => { if (document.getElementById('mic-prompt-modal')) { modal.remove(); } }, 3000);
  }

  protected stripMarkdown(text: string): string {
    return text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1').replace(/^#+\s*/gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^(\d+)\.\s+/gm, '$1番目、').replace(/\s+/g, ' ').trim();
  }

  protected normalizeText(text: string): string {
    return text.replace(/\s+/g, '').replace(/[、。！？,.!?]/g, '').toLowerCase();
  }

  protected removeFillers(text: string): string {
    // @ts-ignore
    const pattern = i18n[this.currentLanguage].patterns.fillers;
    return text.replace(pattern, '');
  }

  protected generateFallbackResponse(text: string): string {
    return this.t('fallbackResponse', text);
  }

  protected selectSmartAcknowledgment(userMessage: string) {
    const messageLower = userMessage.trim();
    // @ts-ignore
    const p = i18n[this.currentLanguage].patterns;
    if (p.ackQuestions.test(messageLower)) return { text: this.t('ackConfirm'), logText: `質問形式` };
    if (p.ackLocation.test(messageLower)) return { text: this.t('ackSearch'), logText: `場所` };
    if (p.ackSearch.test(messageLower)) return { text: this.t('ackUnderstood'), logText: `検索` };
    return { text: this.t('ackYes'), logText: `デフォルト` };
  }

  protected isSemanticEcho(transcript: string, aiText: string): boolean {
    if (!aiText || !transcript) return false;
    const normTranscript = this.normalizeText(transcript);
    const normAI = this.normalizeText(aiText);
    if (normAI === normTranscript) return true;
    if (normAI.includes(normTranscript) && normTranscript.length > 5) return true;
    return false;
  }

  protected extractShopsFromResponse(text: string): any[] {
    const shops: any[] = [];
    const pattern = /(\d+)\.\s*\*\*([^*]+)\*\*[::\s]*([^\n]+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const fullName = match[2].trim();
      const description = match[3].trim();
      let name = fullName;
      const nameMatch = fullName.match(/^([^(]+)[(]([^)]+)[)]/);
      if (nameMatch) name = nameMatch[1].trim();
      const encodedName = encodeURIComponent(name);
      shops.push({ name: name, description: description, category: 'イタリアン', hotpepper_url: `https://www.hotpepper.jp/SA11/srchRS/?keyword=${encodedName}`, maps_url: `https://www.google.com/maps/search/${encodedName}`, tabelog_url: `https://tabelog.com/rstLst/?vs=1&sa=&sk=${encodedName}` });
    }
    return shops;
  }

  protected openReservationModal() {
    if (this.currentShops.length === 0) { this.showError(this.t('searchError')); return; }
    document.dispatchEvent(new CustomEvent('openReservationModal', { detail: { shops: this.currentShops } }));
  }

  protected toggleTTS() {
    if (!this.isUserInteracted) { this.enableAudioPlayback(); return; }
    this.enableAudioPlayback();
    this.isTTSEnabled = !this.isTTSEnabled;

    this.els.speakerBtn.title = this.isTTSEnabled ? this.t('btnTTSOn') : this.t('btnTTSOff');
    if (this.isTTSEnabled) {
      this.els.speakerBtn.classList.remove('disabled');
    } else {
      this.els.speakerBtn.classList.add('disabled');
    }

    if (!this.isTTSEnabled) this.stopCurrentAudio();
  }

  protected stopAllActivities() {
    if (this.isProcessing && this.liveWs) {
      this.liveWs.sendCancel();
    }

    this.audioManager.fullResetAudioResources();
    this.isRecording = false;
    this.els.micBtn.classList.remove('recording');
    this.stopCurrentAudio();
    this.hideWaitOverlay();
    this.isProcessing = false;
    this.isAISpeaking = false;
    this.pendingResponseText = '';
    this.pendingAudioChunks = [];
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
    this.els.userInput.value = '';

    if (window.innerWidth < 1024) {
      setTimeout(() => { this.container.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
    }
  }

  protected addMessage(role: string, text: string, summary: string | null = null, isInitial: boolean = false) {
    this.addMessageElement(role, text, isInitial);
  }

  protected addMessageElement(role: string, text: string, isInitial: boolean = false): HTMLElement {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (isInitial) div.setAttribute('data-initial', 'true');

    let contentHtml = `<div class="message-content"><span class="message-text">${text}</span></div>`;
    div.innerHTML = `<div class="message-avatar">${role === 'assistant' ? '🍽' : '👤'}</div>${contentHtml}`;
    this.els.chatArea.appendChild(div);
    this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
    return div;
  }

  protected resetInputState() {
    this.isProcessing = false;
    this.els.sendBtn.disabled = false;
    this.els.micBtn.disabled = false;
    this.els.userInput.disabled = false;
  }

  protected showError(msg: string) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.innerText = msg;
    this.els.chatArea.appendChild(div);
    this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
  }

  protected t(key: string, ...args: any[]): string {
    // @ts-ignore
    const translation = i18n[this.currentLanguage][key];
    if (typeof translation === 'function') return translation(...args);
    return translation || key;
  }

  protected updateUILanguage() {
    console.log('[Core] Updating UI language to:', this.currentLanguage);

    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.userInput.placeholder = this.t('inputPlaceholder');
    this.els.micBtn.title = this.t('btnVoiceInput');
    this.els.speakerBtn.title = this.isTTSEnabled ? this.t('btnTTSOn') : this.t('btnTTSOff');
    this.els.sendBtn.textContent = this.t('btnSend');
    this.els.reservationBtn.innerHTML = this.t('btnReservation');

    const pageTitle = document.getElementById('pageTitle');
    if (pageTitle) pageTitle.innerHTML = `<img src="/pwa-152x152.png" alt="Logo" class="app-logo" /> ${this.t('pageTitle')}`;
    const pageSubtitle = document.getElementById('pageSubtitle');
    if (pageSubtitle) pageSubtitle.textContent = this.t('pageSubtitle');
    const shopListTitle = document.getElementById('shopListTitle');
    if (shopListTitle) shopListTitle.innerHTML = `🍽 ${this.t('shopListTitle')}`;
    const shopListEmpty = document.getElementById('shopListEmpty');
    if (shopListEmpty) shopListEmpty.textContent = this.t('shopListEmpty');
    const pageFooter = document.getElementById('pageFooter');
    if (pageFooter) pageFooter.innerHTML = `${this.t('footerMessage')} ✨`;

    const waitText = document.querySelector('.wait-text');
    if (waitText) waitText.textContent = this.t('waitMessage');

    document.dispatchEvent(new CustomEvent('languageChange', { detail: { language: this.currentLanguage } }));
  }
}
