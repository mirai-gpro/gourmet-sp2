

// src/scripts/chat/concierge-controller.ts
import { CoreController } from './core-controller';
import { AudioManager } from './audio-manager';

declare const io: any;

export class ConciergeController extends CoreController {
  // Audio2Expression はバックエンドTTSエンドポイント経由で統合済み
  private pendingAckPromise: Promise<void> | null = null;

  constructor(container: HTMLElement, apiBase: string) {
    super(container, apiBase);

    // ★コンシェルジュモード用のAudioManagerを6.5秒設定で再初期化２
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

    // ★ LAMAvatar との統合: 外部TTSプレーヤーをリンク
    // LAMAvatar が後から初期化される可能性があるため、即時 + 遅延でリンク
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
  // 🎯 セッション初期化をオーバーライド(挨拶文を変更)
  // ========================================
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

      // ★ user_id を取得（親クラスのメソッドを使用）
      const userId = this.getUserId();

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

      // リップシンク: バックエンドTTSエンドポイント経由で表情データ取得（追加接続不要）

      // ✅ バックエンドからの初回メッセージを使用（長期記憶対応）
      const greetingText = data.initial_message || this.t('initialGreetingConcierge');
      this.addMessage('assistant', greetingText, null, true);
      
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
              text: text, language_code: langConfig.tts, voice_name: langConfig.voice,
              session_id: this.sessionId
            })
          });
          const ackData = await ackResponse.json();
          if (ackData.success && ackData.audio) {
            this.preGeneratedAcks.set(text, ackData.audio);
          }
        } catch (_e) { }
      });

      await Promise.all([
        this.speakTextGCP(greetingText), 
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

  // ========================================
  // 🔧 Socket.IOの初期化をオーバーライド
  // ========================================
  protected initSocket() {
    // @ts-ignore
    this.socket = io(this.apiBase || window.location.origin);
    
    this.socket.on('connect', () => { });
    
    // ✅ コンシェルジュ版のhandleStreamingSTTCompleteを呼ぶように再登録
    this.socket.on('transcript', (data: any) => {
      const { text, is_final } = data;
      if (this.isAISpeaking) return;
      if (is_final) {
        this.handleStreamingSTTComplete(text); // ← オーバーライド版が呼ばれる
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

  // コンシェルジュモード固有: アバターアニメーション制御 + 公式リップシンク
  protected async speakTextGCP(text: string, stopPrevious: boolean = true, autoRestartMic: boolean = false, skipAudio: boolean = false) {
    if (skipAudio || !this.isTTSEnabled || !text) return Promise.resolve();

    if (stopPrevious) {
      this.ttsPlayer.pause();
    }

    // アバターアニメーションを開始
    if (this.els.avatarContainer) {
      this.els.avatarContainer.classList.add('speaking');
    }

    // ★ 公式同期: TTS音声をaudio2exp-serviceに送信して表情を生成
    const cleanText = this.stripMarkdown(text);
    try {
      this.isAISpeaking = true;
      if (this.isRecording && (this.isIOS || this.isAndroid)) {
        this.stopStreamingSTT();
      }

      this.els.voiceStatus.innerHTML = this.t('voiceStatusSynthesizing');
      this.els.voiceStatus.className = 'voice-status speaking';
      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];

      // TTS音声を取得
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
        // ★ TTS応答に同梱されたExpressionを即バッファ投入（遅延ゼロ）
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

  /**
   * TTS応答に同梱されたExpressionデータをバッファに即投入（遅延ゼロ）
   * 同期方式: バックエンドがTTS+audio2expを同期実行し、結果を同梱して返す
   */
  private applyExpressionFromTts(expression: any): void {
    const lamController = (window as any).lamAvatarController;
    if (!lamController) return;

    // 新セグメント開始時は必ずバッファクリア（前セグメントのフレーム混入防止）
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
    }
    // ※ LAMAvatar の状態は ttsPlayer イベント（ended/pause）で管理
  }


  // ========================================
  // 🎯 UI言語更新をオーバーライド(挨拶文をコンシェルジュ用に)
  // ========================================
  protected updateUILanguage() {
    // ✅ バックエンドからの長期記憶対応済み挨拶を保持
    const initialMessage = this.els.chatArea.querySelector('.message.assistant[data-initial="true"] .message-text');
    const savedGreeting = initialMessage?.textContent;

    // 親クラスのupdateUILanguageを実行（UIラベル等を更新）
    super.updateUILanguage();

    // ✅ 長期記憶対応済み挨拶を復元（親が上書きしたものを戻す）
    if (initialMessage && savedGreeting) {
      initialMessage.textContent = savedGreeting;
    }

    // ✅ ページタイトルをコンシェルジュ用に設定
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
    // コンシェルジュモードは既に現在のページなので何もしない
  }

  // すべての活動を停止(アバターアニメーションも含む)
  protected stopAllActivities() {
    super.stopAllActivities();
    this.stopAvatarAnimation();
  }

  // ========================================
  // 🎯 並行処理フロー: 応答を分割してTTS処理
  // ========================================

  /**
   * センテンス単位でテキストを分割
   * 日本語: 。で分割
   * 英語・韓国語: . で分割
   * 中国語: 。で分割
   */
  private splitIntoSentences(text: string, language: string): string[] {
    let separator: RegExp;

    if (language === 'ja' || language === 'zh') {
      // 日本語・中国語: 。で分割
      separator = /。/;
    } else {
      // 英語・韓国語: . で分割
      separator = /\.\s+/;
    }

    const sentences = text.split(separator).filter(s => s.trim().length > 0);

    // 分割したセンテンスに句点を戻す
    return sentences.map((s, idx) => {
      if (idx < sentences.length - 1 || text.endsWith('。') || text.endsWith('. ')) {
        return language === 'ja' || language === 'zh' ? s + '。' : s + '. ';
      }
      return s;
    });
  }

  /**
   * 応答を分割して並行処理でTTS生成・再生
   * チャットモードのお店紹介フローを参考に実装
   */
  private async speakResponseInChunks(response: string, isTextInput: boolean = false) {
    // テキスト入力またはTTS無効の場合は従来通り
    if (isTextInput || !this.isTTSEnabled) {
      return this.speakTextGCP(response, true, false, isTextInput);
    }

    try {
      // ★ ack再生中ならttsPlayer解放を待つ（並行処理の同期ポイント）
      if (this.pendingAckPromise) {
        await this.pendingAckPromise;
        this.pendingAckPromise = null;
      }
      this.stopCurrentAudio(); // ttsPlayer確実解放

      this.isAISpeaking = true;
      if (this.isRecording) {
        this.stopStreamingSTT();
      }

      // センテンス分割
      const sentences = this.splitIntoSentences(response, this.currentLanguage);

      // 1センテンスしかない場合は従来通り
      if (sentences.length <= 1) {
        await this.speakTextGCP(response, true, false, isTextInput);
        this.isAISpeaking = false;
        return;
      }

      // 最初のセンテンスと残りのセンテンスに分割
      const firstSentence = sentences[0];
      const remainingSentences = sentences.slice(1).join('');

      const langConfig = this.LANGUAGE_CODE_MAP[this.currentLanguage];

      // ★並行処理: TTS生成と表情生成を同時に実行して遅延を最小化
      if (this.isUserInteracted) {
        const cleanFirst = this.stripMarkdown(firstSentence);
        const cleanRemaining = remainingSentences.trim().length > 0
          ? this.stripMarkdown(remainingSentences) : null;

        // ★ 4つのAPIコールを可能な限り並行で開始
        // 1. 最初のセンテンスTTS
        const firstTtsPromise = fetch(`${this.apiBase}/api/v2/rest/tts/synthesize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: cleanFirst, language_code: langConfig.tts,
            voice_name: langConfig.voice, session_id: this.sessionId
          })
        }).then(r => r.json());

        // 2. 残りのセンテンスTTS（あれば）
        const remainingTtsPromise = cleanRemaining
          ? fetch(`${this.apiBase}/api/v2/rest/tts/synthesize`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: cleanRemaining, language_code: langConfig.tts,
                voice_name: langConfig.voice, session_id: this.sessionId
              })
            }).then(r => r.json())
          : null;

        // ★ 最初のTTSが返ったら即再生（Expression同梱済み）
        const firstTtsResult = await firstTtsPromise;
        if (firstTtsResult.success && firstTtsResult.audio) {
          // ★ TTS応答に同梱されたExpressionを即バッファ投入（遅延ゼロ）
          if (firstTtsResult.expression) this.applyExpressionFromTts(firstTtsResult.expression);

          this.lastAISpeech = this.normalizeText(cleanFirst);
          this.stopCurrentAudio();
          this.ttsPlayer.src = `data:audio/mp3;base64,${firstTtsResult.audio}`;

          // 残りのTTS結果を先に取得（TTS応答にExpression同梱済み）
          let remainingTtsResult: any = null;
          if (remainingTtsPromise) {
            remainingTtsResult = await remainingTtsPromise;
          }

          // 最初のセンテンス再生
          await new Promise<void>((resolve) => {
            this.ttsPlayer.onended = () => {
              this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
              this.els.voiceStatus.className = 'voice-status stopped';
              resolve();
            };
            this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
            this.els.voiceStatus.className = 'voice-status speaking';
            this.ttsPlayer.play();
          });

          // ★ 残りのセンテンスを続けて再生（Expression同梱済み）
          if (remainingTtsResult?.success && remainingTtsResult?.audio) {
            this.lastAISpeech = this.normalizeText(cleanRemaining || '');

            // ★ TTS応答に同梱されたExpressionを即バッファ投入
            if (remainingTtsResult.expression) this.applyExpressionFromTts(remainingTtsResult.expression);

            this.stopCurrentAudio();
            this.ttsPlayer.src = `data:audio/mp3;base64,${remainingTtsResult.audio}`;

            await new Promise<void>((resolve) => {
              this.ttsPlayer.onended = () => {
                this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
                this.els.voiceStatus.className = 'voice-status stopped';
                resolve();
              };
              this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
              this.els.voiceStatus.className = 'voice-status speaking';
              this.ttsPlayer.play();
            });
          }
        }
      }

      this.isAISpeaking = false;
    } catch (error) {
      console.error('[TTS並行処理エラー]', error);
      this.isAISpeaking = false;
      // エラー時はフォールバック
      await this.speakTextGCP(response, true, false, isTextInput);
    }
  }

  // ========================================
  // 🎯 コンシェルジュモード専用: 音声入力完了時の即答処理
  // ========================================
  protected async handleStreamingSTTComplete(transcript: string) {
    this.stopStreamingSTT();
    
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = 'playing'; } catch (e) {}
    }
    
    this.els.voiceStatus.innerHTML = this.t('voiceStatusComplete');
    this.els.voiceStatus.className = 'voice-status';

    // オウム返し判定(エコーバック防止)
    const normTranscript = this.normalizeText(transcript);
    if (this.isSemanticEcho(normTranscript, this.lastAISpeech)) {
        this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
        this.els.voiceStatus.className = 'voice-status stopped';
        this.lastAISpeech = '';
        return;
    }

    this.els.userInput.value = transcript;
    this.addMessage('user', transcript);
    
    // 短すぎる入力チェック
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

    // ✅ 修正: 即答を「はい」だけに簡略化
    const ackText = this.t('ackYes'); // 「はい」のみ
    const preGeneratedAudio = this.preGeneratedAcks.get(ackText);

    // 即答を再生（ttsPlayerで）
    if (preGeneratedAudio && this.isTTSEnabled && this.isUserInteracted) {
      this.pendingAckPromise = new Promise<void>((resolve) => {
        this.lastAISpeech = this.normalizeText(ackText);
        this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        this.ttsPlayer.onended = done;
        this.ttsPlayer.onpause = done; // ★ pause時もresolve（src変更やstop時のデッドロック防止）
        this.ttsPlayer.play().catch(_e => done());
      });
    } else if (this.isTTSEnabled) {
      this.pendingAckPromise = this.speakTextGCP(ackText, false);
    }

    this.addMessage('assistant', ackText);

    // ★ 並行処理: ack再生完了を待たず、即LLMリクエスト開始（~700ms短縮）
    //   pendingAckPromiseはsendMessage内でTTS再生前にawaitされる
    if (this.els.userInput.value.trim()) {
      this.isFromVoiceInput = true;
      this.sendMessage();
    }

    this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
    this.els.voiceStatus.className = 'voice-status stopped';
  }

  // ========================================
  // 🎯 LiveAPI メッセージハンドラのオーバーライド
  // コンシェルジュ固有: turn_complete時にチャンクTTS + Expression適用
  // ========================================
  protected handleLiveAPIMessage(data: any) {
    switch (data.type) {
      case 'connected':
        this.isLiveConnected = true;
        console.log('[Concierge LiveAPI] Connected to Gemini Live session');
        break;

      case 'text':
        // ストリーミングテキスト応答を蓄積（親と同じ）
        this.responseBuffer += data.text;
        this.updateStreamingMessage(this.responseBuffer);
        break;

      case 'turn_complete':
        // ターン完了: コンシェルジュ固有のTTS処理
        if (this.responseBuffer) {
          this.finalizeStreamingMessage(this.responseBuffer);
          // ★ コンシェルジュモード: チャンクTTS + Expression同梱で応答を読み上げ
          this.speakResponseInChunks(this.responseBuffer);
        }
        this.responseBuffer = "";
        this.hideWaitOverlay();
        this.resetInputState();
        this.isProcessing = false;
        break;

      case 'shop_data':
        // ショップデータ受信: カード表示 + TTS紹介
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
        console.error('[Concierge LiveAPI] Error:', data.message);
        this.addMessage('system', `エラー: ${data.message}`);
        this.hideWaitOverlay();
        this.resetInputState();
        this.isProcessing = false;
        break;
    }
  }

}
