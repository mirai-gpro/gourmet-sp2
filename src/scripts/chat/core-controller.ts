
// src/scripts/chat/core-controller.ts
import { i18n } from '../../constants/i18n';
import { AudioManager } from './audio-manager';

export class CoreController {
  protected container: HTMLElement;
  protected apiBase: string;
  protected audioManager: AudioManager;
  protected ws: WebSocket | null = null;
  protected wsUrl: string = '';

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

  // ★追加: バックグラウンド状態の追跡
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
        await fetch(`${this.apiBase}/api/v2/rest/cancel`, {
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

        // 1. WebSocket再接続（切断されていた場合）
        if (this.ws && this.ws.readyState !== WebSocket.OPEN && this.wsUrl) {
          console.log('[Foreground] Reconnecting WebSocket...');
          this.initWebSocket(this.wsUrl);
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

  // ★ WebSocket接続（Socket.IOから移行）
  protected initWebSocket(wsUrl: string) {
    // 既存のWebSocket接続を閉じる
    if (this.ws) {
      try { this.ws.close(); } catch (_e) {}
    }

    const backendUrl = this.container.dataset.backendUrl || window.location.origin;
    this.wsUrl = wsUrl;
    const wsProtocol = backendUrl.startsWith('https') ? 'wss' : 'ws';
    const wsHost = backendUrl.replace(/^https?:\/\//, '');
    this.ws = new WebSocket(`${wsProtocol}://${wsHost}${wsUrl}`);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleWsMessage(msg);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  // ★ WebSocketメッセージ受信ハンドラ
  protected handleWsMessage(msg: any) {
    switch (msg.type) {
      case 'transcription':
        if (msg.role === 'user') {
          if (this.isAISpeaking) return;
          if (msg.is_partial) {
            this.els.userInput.value = msg.text;
          } else {
            this.handleStreamingSTTComplete(msg.text);
            this.currentAISpeech = "";
          }
        } else if (msg.role === 'ai') {
          if (!msg.is_partial) {
            this.hideWaitOverlay();
            this.currentAISpeech = msg.text;
            this.addMessage('assistant', msg.text);
            this.resetInputState();
          }
        }
        break;
      case 'shop_cards':
        this.hideWaitOverlay();
        if (msg.shops && msg.shops.length > 0) {
          this.currentShops = msg.shops;
          this.els.reservationBtn.classList.add('visible');
          this.els.userInput.value = '';
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
        }
        if (msg.response) {
          this.currentAISpeech = msg.response;
          this.addMessage('assistant', msg.response);
        }
        this.resetInputState();
        break;
      case 'audio':
        // AI音声（PCM 24kHz base64）
        this.isAISpeaking = true;
        this.playPcmAudio(msg.data);
        break;
      case 'rest_audio':
        // TTS音声（MP3 base64）
        this.isAISpeaking = true;
        if (this.isRecording) this.stopStreamingSTT();
        if (msg.text) this.lastAISpeech = this.normalizeText(msg.text);
        this.stopCurrentAudio();
        this.ttsPlayer.src = `data:audio/mp3;base64,${msg.data}`;
        this.ttsPlayer.onended = () => {
          this.isAISpeaking = false;
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
        };
        this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
        this.els.voiceStatus.className = 'voice-status speaking';
        if (this.isUserInteracted) {
          this.ttsPlayer.play().catch(() => { this.isAISpeaking = false; });
        } else {
          this.isAISpeaking = false;
        }
        break;
      case 'interrupted':
        this.stopCurrentAudio();
        this.isAISpeaking = false;
        break;
      case 'error':
        this.addMessage('system', `${this.t('sttError')} ${msg.message}`);
        if (this.isRecording) this.stopStreamingSTT();
        this.hideWaitOverlay();
        this.resetInputState();
        break;
      case 'reconnecting':
        console.log('[WS] Reconnecting:', msg.reason);
        break;
      case 'reconnected':
        console.log('[WS] Reconnected, session count:', msg.session_count);
        break;
    }
  }

  // ★ WebSocket送信ヘルパー
  protected wsSend(msg: object) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ★ PCM 24kHz音声をWAV形式で再生
  protected playPcmAudio(base64Data: string) {
    const pcmBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    // WAVヘッダー生成（PCM 16-bit mono 24kHz）
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const sr = 24000, ch = 1, bps = 16;
    v.setUint32(0, 0x52494646, false); // RIFF
    v.setUint32(4, 36 + pcmBytes.length, true);
    v.setUint32(8, 0x57415645, false); // WAVE
    v.setUint32(12, 0x666D7420, false); // fmt
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, ch, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * bps / 8, true);
    v.setUint16(32, ch * bps / 8, true);
    v.setUint16(34, bps, true);
    v.setUint32(36, 0x64617461, false); // data
    v.setUint32(40, pcmBytes.length, true);

    const wav = new Blob([header, pcmBytes], { type: 'audio/wav' });
    const url = URL.createObjectURL(wav);

    this.stopCurrentAudio();
    this.ttsPlayer.src = url;
    this.ttsPlayer.onended = () => {
      URL.revokeObjectURL(url);
      this.isAISpeaking = false;
      this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
      this.els.voiceStatus.className = 'voice-status stopped';
    };
    this.ttsPlayer.onerror = () => {
      URL.revokeObjectURL(url);
      this.isAISpeaking = false;
    };
    this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
    this.els.voiceStatus.className = 'voice-status speaking';
    if (this.isUserInteracted) {
      this.ttsPlayer.play().catch(() => {
        this.isAISpeaking = false;
        URL.revokeObjectURL(url);
      });
    } else {
      this.isAISpeaking = false;
      URL.revokeObjectURL(url);
    }
  }

  protected async initializeSession() {
    try {
      if (this.sessionId) {
        try {
          await fetch(`${this.apiBase}/api/v2/session/end`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: this.sessionId })
          });
        } catch (e) {}
      }

      // ★ 既存WebSocket接続を閉じる
      if (this.ws) {
        try { this.ws.close(); } catch (_e) {}
        this.ws = null;
      }

      const res = await fetch(`${this.apiBase}/api/v2/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_info: {}, language: this.currentLanguage })
      });
      const data = await res.json();
      this.sessionId = data.session_id;

      // ★ WebSocket接続（session_id取得後）
      if (data.ws_url) {
        this.initWebSocket(data.ws_url);
      }

      this.addMessage('assistant', this.t('initialGreeting'), null, true);

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
        this.speakTextGCP(this.t('initialGreeting')),
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

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.isRecording = true;
      this.els.micBtn.classList.add('recording');
      this.els.voiceStatus.innerHTML = this.t('voiceStatusListening');
      this.els.voiceStatus.className = 'voice-status listening';

      try {
        const langCode = this.LANGUAGE_CODE_MAP[this.currentLanguage].stt;
        await this.audioManager.startStreaming(
          this.ws, langCode,
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
        } else {
          await new Promise(r => setTimeout(r, 2000));
        }
        this.els.userInput.value = '';
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        return;
    }

    const ack = this.selectSmartAcknowledgment(transcript);
    const preGeneratedAudio = this.preGeneratedAcks.get(ack.text);

    let firstAckPromise: Promise<void> | null = null;
    if (preGeneratedAudio && this.isTTSEnabled && this.isUserInteracted) {
      firstAckPromise = new Promise<void>((resolve) => {
        this.lastAISpeech = this.normalizeText(ack.text);
        this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
        this.ttsPlayer.onended = () => resolve();
        this.ttsPlayer.play().catch(_e => resolve());
      });
    } else if (this.isTTSEnabled) {
      firstAckPromise = this.speakTextGCP(ack.text, false);
    }

    this.addMessage('assistant', ack.text);

    (async () => {
      try {
        if (firstAckPromise) await firstAckPromise;
        const cleanText = this.removeFillers(transcript);
        const fallbackResponse = this.generateFallbackResponse(cleanText);

        if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(fallbackResponse, false);
        this.addMessage('assistant', fallbackResponse);

        setTimeout(async () => {
          const additionalResponse = this.t('additionalResponse');
          if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(additionalResponse, false);
          this.addMessage('assistant', additionalResponse);
        }, 3000);

        if (this.els.userInput.value.trim()) {
          this.isFromVoiceInput = true;
          this.sendMessage();
        }
      } catch (_error) {
        if (this.els.userInput.value.trim()) {
          this.isFromVoiceInput = true;
          this.sendMessage();
        }
      }
    })();

    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

// Part 1からの続き...

  protected async sendMessage() {
    let firstAckPromise: Promise<void> | null = null;
    this.unlockAudioParams();
    const message = this.els.userInput.value.trim();
    if (!message || this.isProcessing) return;

    const isTextInput = !this.isFromVoiceInput;

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

      const ack = this.selectSmartAcknowledgment(message);
      this.currentAISpeech = ack.text;
      this.addMessage('assistant', ack.text);

      if (this.isTTSEnabled && !isTextInput) {
        try {
          const preGeneratedAudio = this.preGeneratedAcks.get(ack.text);
          if (preGeneratedAudio && this.isUserInteracted) {
            firstAckPromise = new Promise<void>((resolve) => {
              this.lastAISpeech = this.normalizeText(ack.text);
              this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
              this.ttsPlayer.onended = () => resolve();
              this.ttsPlayer.play().catch(_e => resolve());
            });
          } else {
            firstAckPromise = this.speakTextGCP(ack.text, false);
          }
        } catch (_e) {}
      }
      if (firstAckPromise) await firstAckPromise;

      const cleanText = this.removeFillers(message);
      const fallbackResponse = this.generateFallbackResponse(cleanText);

      if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(fallbackResponse, false, false, isTextInput);
      this.addMessage('assistant', fallbackResponse);

      setTimeout(async () => {
        const additionalResponse = this.t('additionalResponse');
        if (this.isTTSEnabled && this.isUserInteracted) await this.speakTextGCP(additionalResponse, false, false, isTextInput);
        this.addMessage('assistant', additionalResponse);
      }, 3000);
    }

    this.isFromVoiceInput = false;

    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 4000);

    // ★ WebSocket経由でテキスト送信（REST POST → WS）
    this.wsSend({ type: 'text', data: message });
    this.els.userInput.blur();
    // レスポンスは handleWsMessage() で処理
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
    if (this.isProcessing) {
      fetch(`${this.apiBase}/api/v2/rest/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.sessionId })
      }).catch(err => console.error('中止リクエスト失敗:', err));
    }

    this.audioManager.fullResetAudioResources();
    this.isRecording = false;
    this.els.micBtn.classList.remove('recording');
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
