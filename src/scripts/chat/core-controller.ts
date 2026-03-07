
// src/scripts/chat/core-controller.ts
import { i18n } from '../../constants/i18n'; 
import { AudioManager } from './audio-manager';

declare const io: any;

export class CoreController {
  protected container: HTMLElement;
  protected apiBase: string;
  protected audioManager: AudioManager;
  protected socket: any = null;

  // LiveAPI WebSocket
  protected liveWs: WebSocket | null = null;
  protected responseBuffer: string = "";
  protected isLiveConnected = false;

  protected currentLanguage: 'ja' | 'en' | 'zh' | 'ko' = 'ja';
  protected sessionId: string | null = null;
  protected isProcessing = false;
  protected currentStage = 'conversation';
  protected isRecording = false;
  protected waitOverlayTimer: number | null = null;
  protected isTTSEnabled = true;
  protected isUserInteracted = false;
  protected currentShops: any[] = [];
  protected isFromVoiceInput = false;
  protected lastAISpeech = '';
  protected preGeneratedAcks: Map<string, string> = new Map();
  protected isAISpeaking = false;
  protected currentAISpeech = "";
  protected currentMode: 'chat' | 'concierge' = 'chat';

  // バックグラウンド状態の追跡
  protected isInBackground = false;
  protected backgroundStartTime = 0;
  protected readonly BACKGROUND_RESET_THRESHOLD = 120000; // 120秒

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
    this.initSocket();

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
    this.closeLiveAPI();

    if (oldSessionId) {
      try {
        await fetch(`${this.apiBase}/api/v2/session/end`, {
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
    this.responseBuffer = "";

    await new Promise(resolve => setTimeout(resolve, 300));
    await this.initializeSession();

    // ★追加: スクロール位置をリセット（ヘッダーが隠れないように）
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

    // ★追加: バックグラウンド復帰時の復旧処理
    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        this.isInBackground = true;
        this.backgroundStartTime = Date.now();
      } else if (this.isInBackground) {
        this.isInBackground = false;
        const backgroundDuration = Date.now() - this.backgroundStartTime;
        console.log(`[Foreground] Resuming from background (${Math.round(backgroundDuration / 1000)}s)`);

        // ★120秒以上バックグラウンドにいた場合はソフトリセット
        if (backgroundDuration > this.BACKGROUND_RESET_THRESHOLD) {
          console.log('[Foreground] Long background duration - triggering soft reset...');
          await this.resetAppContent();
          return;
        }

        // 1. LiveAPI WebSocket 再接続
        if (this.liveWs && this.liveWs.readyState !== WebSocket.OPEN) {
          console.log('[Foreground] Reconnecting LiveAPI WebSocket...');
          this.connectLiveAPI();
        }

        // 2. Socket.IO再接続（STT用）
        if (this.socket && !this.socket.connected) {
          console.log('[Foreground] Reconnecting socket...');
          this.socket.connect();
        }

        // 2. UI状態をリセット（操作可能にする）
        this.isProcessing = false;
        this.isAISpeaking = false;
        this.hideWaitOverlay();

        // 3. 要素が存在する場合のみ更新
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

  // ★修正: Socket.IO接続設定に再接続オプションを追加（transportsは削除）
  protected initSocket() {
    // @ts-ignore
    this.socket = io(this.apiBase || window.location.origin, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
      timeout: 10000
    });
    
    this.socket.on('connect', () => { });
    
    this.socket.on('transcript', (data: any) => {
      const { text, is_final } = data;
      if (this.isAISpeaking) return;
      if (is_final) {
        this.handleStreamingSTTComplete(text);
        this.currentAISpeech = "";
      } else {
        this.els.userInput.value = text;
      }
    });

    this.socket.on('error', (data: any) => {
      this.addMessage('system', `${this.t('sttError')} ${data.message}`);
      if (this.isRecording) this.stopStreamingSTT();
    });
  }

  // ========================================
  // LiveAPI WebSocket 接続
  // ========================================

  protected connectLiveAPI() {
    if (!this.sessionId) return;

    const apiUrl = new URL(this.apiBase || window.location.origin);
    const wsProtocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${apiUrl.host}/api/v2/live/${this.sessionId}`;

    console.log('[LiveAPI] Connecting:', wsUrl);
    this.liveWs = new WebSocket(wsUrl);
    this.responseBuffer = "";

    this.liveWs.onopen = () => {
      console.log('[LiveAPI] WebSocket opened');
    };

    this.liveWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleLiveAPIMessage(data);
      } catch (e) {
        console.error('[LiveAPI] Parse error:', e);
      }
    };

    this.liveWs.onclose = (event) => {
      console.log(`[LiveAPI] WebSocket closed: code=${event.code}`);
      this.isLiveConnected = false;
    };

    this.liveWs.onerror = (error) => {
      console.error('[LiveAPI] WebSocket error:', error);
      this.isLiveConnected = false;
    };
  }

  protected handleLiveAPIMessage(data: any) {
    switch (data.type) {
      case 'connected':
        this.isLiveConnected = true;
        console.log('[LiveAPI] Connected to Gemini Live session');
        break;

      case 'text':
        // ストリーミングテキスト応答を蓄積
        this.responseBuffer += data.text;
        this.updateStreamingMessage(this.responseBuffer);
        break;

      case 'turn_complete':
        // ターン完了: 蓄積したテキストを確定表示
        if (this.responseBuffer) {
          this.finalizeStreamingMessage(this.responseBuffer);
          // 音声入力時はTTS再生
          if (this.isTTSEnabled && this.isUserInteracted) {
            this.speakTextGCP(this.responseBuffer, true);
          }
        }
        this.responseBuffer = "";
        this.hideWaitOverlay();
        this.resetInputState();
        this.isProcessing = false;
        break;

      case 'shop_data':
        // ショップデータ受信（カード表示）
        if (data.shops && data.shops.length > 0) {
          this.currentShops = data.shops;
          this.els.reservationBtn.classList.add('visible');
          document.dispatchEvent(new CustomEvent('displayShops', {
            detail: { shops: data.shops, language: this.currentLanguage }
          }));
          const section = document.getElementById('shopListSection');
          if (section) section.classList.add('has-shops');
          if (window.innerWidth < 1024) {
            setTimeout(() => {
              const shopSection = document.getElementById('shopListSection');
              if (shopSection) shopSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 300);
          }
        }
        break;

      case 'error':
        console.error('[LiveAPI] Error:', data.message);
        this.addMessage('system', `エラー: ${data.message}`);
        this.hideWaitOverlay();
        this.resetInputState();
        this.isProcessing = false;
        break;
    }
  }

  // ストリーミング表示: 最後のアシスタントメッセージをリアルタイム更新
  protected updateStreamingMessage(text: string) {
    const messages = this.els.chatArea.querySelectorAll('.message.assistant');
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.getAttribute('data-streaming') === 'true') {
      const msgText = lastMsg.querySelector('.message-text');
      if (msgText) msgText.textContent = text;
    } else {
      const div = document.createElement('div');
      div.className = 'message assistant';
      div.setAttribute('data-streaming', 'true');
      div.innerHTML = `<div class="message-avatar">🍽</div><div class="message-content"><span class="message-text">${text}</span></div>`;
      this.els.chatArea.appendChild(div);
    }
    this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
  }

  // ストリーミング完了: メッセージを確定
  protected finalizeStreamingMessage(text: string) {
    const messages = this.els.chatArea.querySelectorAll('.message.assistant[data-streaming="true"]');
    const lastMsg = messages[messages.length - 1];
    if (lastMsg) {
      lastMsg.removeAttribute('data-streaming');
      const msgText = lastMsg.querySelector('.message-text');
      if (msgText) msgText.textContent = text;
    } else {
      this.addMessage('assistant', text);
    }
    this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
  }

  protected closeLiveAPI() {
    if (this.liveWs) {
      try {
        this.liveWs.send(JSON.stringify({ type: 'close' }));
        this.liveWs.close();
      } catch (e) { }
      this.liveWs = null;
      this.isLiveConnected = false;
    }
  }

  protected async initializeSession() {
    try {
      // 既存セッション終了
      if (this.sessionId) {
        this.closeLiveAPI();
        try {
          await fetch(`${this.apiBase}/api/v2/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId })
          });
        } catch (e) {}
      }

      const res = await fetch(`${this.apiBase}/api/v2/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_info: {}, language: this.currentLanguage, mode: this.currentMode })
      });
      const data = await res.json();
      this.sessionId = data.session_id;

      // 初回挨拶（バックエンドから取得）
      const greeting = data.initial_message || this.t('initialGreeting');
      this.addMessage('assistant', greeting, null, true);

      // LiveAPI WebSocket 接続
      this.connectLiveAPI();

      // 初回挨拶 TTS + ACK事前生成（並行実行）
      const ackTexts = [
        this.t('ackConfirm'), this.t('ackSearch'), this.t('ackUnderstood'),
        this.t('ackYes'), this.t('ttsIntro')
      ];
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];

      const ackPromises = ackTexts.map(async (text) => {
        try {
          const ackResponse = await fetch(`${this.apiBase}/api/v2/rest/tts/synthesize`, {
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

      await Promise.all([
        this.speakTextGCP(greeting),
        ...ackPromises
      ]);

      this.els.userInput.disabled = false;
      this.els.sendBtn.disabled = false;
      this.els.micBtn.disabled = false;
      this.els.speakerBtn.disabled = false;
      this.els.speakerBtn.classList.remove('disabled');
      this.els.reservationBtn.classList.remove('visible');

    } catch (e) {
      console.error('[Session] Initialization error:', e);
    }
  }

  protected async toggleRecording() {
    this.enableAudioPlayback();
    this.els.userInput.value = '';
    
    if (this.isRecording) { 
      this.stopStreamingSTT();
      return;
    }
    
    if (this.isProcessing || this.isAISpeaking || !this.ttsPlayer.paused) {
      if (this.isProcessing) {
        fetch(`${this.apiBase}/api/v2/rest/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: this.sessionId })
        }).catch(err => console.error('中止リクエスト失敗:', err));
      }
      
      this.stopCurrentAudio();
      this.hideWaitOverlay();
      this.isProcessing = false;
      this.isAISpeaking = false;
      this.resetInputState();
    }
    
    if (this.socket && this.socket.connected) {
      this.isRecording = true;
      this.els.micBtn.classList.add('recording');
      this.els.voiceStatus.innerHTML = this.t('voiceStatusListening');
      this.els.voiceStatus.className = 'voice-status listening';

      try {
        const langCode = this.LANGUAGE_CODE_MAP[this.currentLanguage].stt;
        await this.audioManager.startStreaming(
          this.socket, langCode, 
          () => { this.stopStreamingSTT(); },
          () => { this.els.voiceStatus.innerHTML = this.t('voiceStatusRecording'); }
        );
      } catch (error: any) {
        this.stopStreamingSTT();
        if (!error.message?.includes('マイク')) {
          this.showError(this.t('micAccessError'));
        }
      }
    } else {
      await this.startLegacyRecording();
    }
  }
  
  protected async startLegacyRecording() {
      try {
          this.isRecording = true;
          this.els.micBtn.classList.add('recording');
          this.els.voiceStatus.innerHTML = this.t('voiceStatusListening');
          
          await this.audioManager.startLegacyRecording(
              async (audioBlob) => {
                  await this.transcribeAudio(audioBlob);
                  this.stopStreamingSTT(); 
              },
              () => { this.els.voiceStatus.innerHTML = this.t('voiceStatusRecording'); }
          );
      } catch (error: any) {
          this.addMessage('system', `${this.t('micAccessError')} ${error.message}`);
          this.stopStreamingSTT();
      }
  }
  
  protected async transcribeAudio(audioBlob: Blob) {
      console.log('Legacy audio blob size:', audioBlob.size);
  }

  protected stopStreamingSTT() {
    this.audioManager.stopStreaming();
    if (this.socket && this.socket.connected) {
        this.socket.emit('stop_stream');
    }
    this.isRecording = false;
    this.els.micBtn.classList.remove('recording');
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

  protected async handleStreamingSTTComplete(transcript: string) {
    this.stopStreamingSTT();
    
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
    }
    
    this.els.voiceStatus.innerHTML = this.t('voiceStatusComplete');
    this.els.voiceStatus.className = 'voice-status';

    const normTranscript = this.normalizeText(transcript);
    if (this.isSemanticEcho(normTranscript, this.lastAISpeech)) {
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        this.lastAISpeech = '';
        return;
    }

    this.els.userInput.value = transcript;
    this.addMessage('user', transcript);

    const textLength = transcript.trim().replace(/\s+/g, '').length;
    if (textLength < 2) {
        const msg = this.t('shortMsgWarning');
        this.addMessage('assistant', msg);
        if (this.isTTSEnabled && this.isUserInteracted) {
          await this.speakTextGCP(msg, true);
        }
        this.els.userInput.value = '';
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        return;
    }

    // LiveAPI に直接送信（ACKやフォールバック応答は不要 — Geminiがリアルタイムで応答）
    this.isFromVoiceInput = true;
    this.sendMessage();

    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

// Part 1からの続き...

  protected async sendMessage() {
    this.unlockAudioParams();
    const message = this.els.userInput.value.trim();
    if (!message || this.isProcessing) return;

    this.isProcessing = true;
    this.els.sendBtn.disabled = true;
    this.els.micBtn.disabled = true;
    this.els.userInput.disabled = true;

    // ユーザーメッセージ表示
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
    }

    this.els.userInput.value = '';
    this.isFromVoiceInput = false;

    // 待機アニメーション（4秒後）
    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 4000);

    // LiveAPI WebSocket 経由で送信
    if (this.liveWs && this.liveWs.readyState === WebSocket.OPEN) {
      this.responseBuffer = "";
      this.liveWs.send(JSON.stringify({ type: 'text', text: message }));
      console.log('[LiveAPI] Sent:', message.substring(0, 50));
      // 応答は handleLiveAPIMessage() で非同期に処理される
    } else {
      // WebSocket未接続時はREST APIフォールバック
      console.warn('[LiveAPI] WebSocket not connected, using REST fallback');
      try {
        const response = await fetch(`${this.apiBase}/api/v2/rest/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: this.sessionId,
            message: message,
            stage: this.currentStage,
            language: this.currentLanguage,
            mode: this.currentMode
          })
        });
        const data = await response.json();

        this.hideWaitOverlay();
        this.addMessage('assistant', data.response);

        if (data.shops && data.shops.length > 0) {
          this.currentShops = data.shops;
          this.els.reservationBtn.classList.add('visible');
          document.dispatchEvent(new CustomEvent('displayShops', {
            detail: { shops: data.shops, language: this.currentLanguage }
          }));
          const section = document.getElementById('shopListSection');
          if (section) section.classList.add('has-shops');
        }

        if (data.response && this.isTTSEnabled) {
          this.speakTextGCP(data.response, true);
        }
      } catch (error) {
        console.error('送信エラー:', error);
        this.hideWaitOverlay();
        this.showError('メッセージの送信に失敗しました。');
      } finally {
        this.resetInputState();
      }
    }
  }

  protected async speakTextGCP(text: string, stopPrevious: boolean = true, autoRestartMic: boolean = false, skipAudio: boolean = false) {
    if (skipAudio) return Promise.resolve();
    if (!this.isTTSEnabled || !text) return Promise.resolve();
    
    if (stopPrevious && this.isTTSEnabled) {
      this.ttsPlayer.pause();
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
      
      const response = await fetch(`${this.apiBase}/api/v2/rest/tts/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          text: cleanText, language_code: langConfig.tts, voice_name: langConfig.voice 
        })
      });
      const data = await response.json();
      if (data.success && data.audio) {
        this.ttsPlayer.src = `data:audio/mp3;base64,${data.audio}`;
        const playPromise = new Promise<void>((resolve) => {
          this.ttsPlayer.onended = async () => {
            this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
            this.els.voiceStatus.className = 'voice-status stopped';
            this.isAISpeaking = false;
            if (autoRestartMic) {
              if (!this.isRecording) {
                try { await this.toggleRecording(); } catch (_error) { this.showMicPrompt(); }
              }
            }
            resolve();
          };
          this.ttsPlayer.onerror = () => { 
            this.isAISpeaking = false;
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
    this.audioManager.fullResetAudioResources();
    this.isRecording = false; 
    this.els.micBtn.classList.remove('recording');
    if (this.socket && this.socket.connected) { this.socket.emit('stop_stream'); }
    this.stopCurrentAudio();
    this.hideWaitOverlay();
    this.isProcessing = false;
    this.isAISpeaking = false;
    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
    this.els.userInput.value = '';

    // ★修正: containerにスクロール（chat-header-controlsが隠れないように）
    if (window.innerWidth < 1024) {
      setTimeout(() => { this.container.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
    }
  }

  protected addMessage(role: string, text: string, summary: string | null = null, isInitial: boolean = false) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (isInitial) div.setAttribute('data-initial', 'true');
    
    let contentHtml = `<div class="message-content"><span class="message-text">${text}</span></div>`;
    div.innerHTML = `<div class="message-avatar">${role === 'assistant' ? '🍽' : '👤'}</div>${contentHtml}`;
    this.els.chatArea.appendChild(div);
    this.els.chatArea.scrollTop = this.els.chatArea.scrollHeight;
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

    const initialMessage = this.els.chatArea.querySelector('.message.assistant[data-initial="true"] .message-text');
    if (initialMessage) {
      initialMessage.textContent = this.t('initialGreeting');
    }
    
    const waitText = document.querySelector('.wait-text');
    if (waitText) waitText.textContent = this.t('waitMessage');

    document.dispatchEvent(new CustomEvent('languageChange', { detail: { language: this.currentLanguage } }));
  }
}
