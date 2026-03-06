

// src/scripts/chat/concierge-controller.ts
import { CoreController } from './core-controller';
import { AudioManager } from './audio-manager';

export class ConciergeController extends CoreController {
  // Audio2Expression はバックエンドTTSエンドポイント経由で統合済み
  private pendingAckPromise: Promise<void> | null = null;
  // B5: audio + expression 同期再生用バッファ
  private pendingLiveAudio: string | null = null;
  private pendingExpression: any = null;
  private expressionWaitTimer: ReturnType<typeof setTimeout> | null = null;

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

      // ★ 既存WebSocket接続を閉じる
      if (this.ws) {
        try { this.ws.close(); } catch (_e) {}
        this.ws = null;
      }

      // ★ user_id を取得（親クラスのメソッドを使用）
      const userId = this.getUserId();

      const res = await fetch(`${this.apiBase}/api/v2/session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // BUG2修正: バックエンドは user_id, mode, language, dialogue_type をトップレベルで期待
        body: JSON.stringify({
          mode: 'concierge',
          language: this.currentLanguage,
          dialogue_type: 'live',
          user_id: userId
        })
      });
      const data = await res.json();
      this.sessionId = data.session_id;

      // ★ WebSocket接続（session_id取得後）
      if (data.ws_url) {
        this.initWebSocket(data.ws_url);
      }

      // リップシンク: バックエンドTTSエンドポイント経由で表情データ取得（追加接続不要）

      // ✅ バックエンドからの初回メッセージを使用（長期記憶対応）
      // BUG3修正: バックエンドは greeting フィールドを返す（initial_message ではない）
      const greetingText = data.greeting || this.t('initialGreetingConcierge');
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
  // 🎯 WebSocketメッセージ受信ハンドラをオーバーライド
  // ========================================
  protected handleWsMessage(msg: any) {
    switch (msg.type) {
      case 'audio':
        // B5: AI音声（PCM 24kHz）— expressionと同期再生するためバッファリング
        this.isAISpeaking = true;
        if (this.els.avatarContainer) this.els.avatarContainer.classList.add('speaking');
        this.pendingLiveAudio = msg.data;
        this._tryStartSyncedPlayback();
        // expressionが来ない場合のフォールバック（200ms待ち）
        this.expressionWaitTimer = setTimeout(() => {
          if (this.pendingLiveAudio) {
            this.playPcmAudioWithAvatar(this.pendingLiveAudio);
            this.pendingLiveAudio = null;
          }
        }, 200);
        break;
      case 'expression':
        // B5: アバター表情データ — audioと同期再生するためバッファリング
        this.pendingExpression = msg.data;
        if (this.expressionWaitTimer) {
          clearTimeout(this.expressionWaitTimer);
          this.expressionWaitTimer = null;
        }
        this._tryStartSyncedPlayback();
        break;
      case 'rest_audio':
        // TTS音声（MP3）with アバターアニメーション（expressionを伴わない）
        this.isAISpeaking = true;
        if (this.isRecording) this.stopStreamingSTT();
        if (this.els.avatarContainer) this.els.avatarContainer.classList.add('speaking');
        if (msg.text) this.lastAISpeech = this.normalizeText(msg.text);
        this.stopCurrentAudio();
        this.ttsPlayer.src = `data:audio/mp3;base64,${msg.data}`;
        this.ttsPlayer.onended = () => {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
          this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
          this.els.voiceStatus.className = 'voice-status stopped';
        };
        this.ttsPlayer.onerror = () => {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
        };
        this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
        this.els.voiceStatus.className = 'voice-status speaking';
        if (this.isUserInteracted) {
          this.ttsPlayer.play().catch(() => {
            this.isAISpeaking = false;
            this.stopAvatarAnimation();
          });
        } else {
          this.isAISpeaking = false;
          this.stopAvatarAnimation();
        }
        break;
      case 'shop_cards':
        // 親クラスでカード表示 + テキスト表示
        super.handleWsMessage(msg);
        // アバター側: 店舗紹介モードに遷移
        if (this.els.avatarContainer) this.els.avatarContainer.classList.add('presenting');
        break;
      case 'interrupted':
        // barge-in: 再生停止 + アバター停止 + 表情リセット
        this.stopCurrentAudio();
        this.isAISpeaking = false;
        this.stopAvatarAnimation();
        // 表情を中立にリセット
        if ((window as any).lamAvatarController?.clearFrameBuffer) {
          (window as any).lamAvatarController.clearFrameBuffer();
        }
        // ペンディングデータもクリア
        this.pendingLiveAudio = null;
        this.pendingExpression = null;
        if (this.expressionWaitTimer) {
          clearTimeout(this.expressionWaitTimer);
          this.expressionWaitTimer = null;
        }
        break;
      default:
        // transcription, error, reconnecting, reconnected は親クラスで処理
        super.handleWsMessage(msg);
        break;
    }
  }

  // B5: audio + expression が両方揃ったら同時再生開始
  private _tryStartSyncedPlayback() {
    if (this.pendingLiveAudio && this.pendingExpression) {
      // 表情フレームをアバターにキューイング（音声と同時スタートで自動同期）
      this.applyExpressionFromTts(this.pendingExpression);
      // 音声再生開始
      this.playPcmAudioWithAvatar(this.pendingLiveAudio);
      this.pendingLiveAudio = null;
      this.pendingExpression = null;
    }
  }

  // ★ PCM音声再生（アバターアニメーション付き）
  private playPcmAudioWithAvatar(base64Data: string) {
    const pcmBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

    // WAVヘッダー生成（PCM 16-bit mono 24kHz）
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const sr = 24000, ch = 1, bps = 16;
    v.setUint32(0, 0x52494646, false);
    v.setUint32(4, 36 + pcmBytes.length, true);
    v.setUint32(8, 0x57415645, false);
    v.setUint32(12, 0x666D7420, false);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, ch, true);
    v.setUint32(24, sr, true);
    v.setUint32(28, sr * ch * bps / 8, true);
    v.setUint16(32, ch * bps / 8, true);
    v.setUint16(34, bps, true);
    v.setUint32(36, 0x64617461, false);
    v.setUint32(40, pcmBytes.length, true);

    const wav = new Blob([header, pcmBytes], { type: 'audio/wav' });
    const url = URL.createObjectURL(wav);

    this.stopCurrentAudio();
    this.ttsPlayer.src = url;
    this.ttsPlayer.onended = () => {
      URL.revokeObjectURL(url);
      this.isAISpeaking = false;
      this.stopAvatarAnimation();
      this.els.voiceStatus.innerHTML = this.t('voiceStatusStopped');
      this.els.voiceStatus.className = 'voice-status stopped';
    };
    this.ttsPlayer.onerror = () => {
      URL.revokeObjectURL(url);
      this.isAISpeaking = false;
      this.stopAvatarAnimation();
    };
    this.els.voiceStatus.innerHTML = this.t('voiceStatusSpeaking');
    this.els.voiceStatus.className = 'voice-status speaking';
    if (this.isUserInteracted) {
      this.ttsPlayer.play().catch(() => {
        this.isAISpeaking = false;
        this.stopAvatarAnimation();
        URL.revokeObjectURL(url);
      });
    } else {
      this.isAISpeaking = false;
      this.stopAvatarAnimation();
      URL.revokeObjectURL(url);
    }
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
      // BUG1修正: バックエンドのframesは number[][] (2D配列)
      // 各フレームは [0.0, 0.0, ..., 0.15, ...] の52要素配列
      // f.weights[i] ではなく f[i] でアクセスする
      const frames = expression.frames.map((f: number[]) => {
        const frame: { [key: string]: number } = {};
        expression.names.forEach((name: string, i: number) => { frame[name] = f[i]; });
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
  // 🎯 コンシェルジュモード専用: メッセージ送信処理
  // ========================================
  protected async sendMessage() {
    let firstAckPromise: Promise<void> | null = null;
    // ★ voice入力時はunlockAudioParamsスキップ（ack再生中のttsPlayerを中断させない）
    if (!this.pendingAckPromise) {
      this.unlockAudioParams();
    }
    const message = this.els.userInput.value.trim();
    if (!message || this.isProcessing) return;

    const isTextInput = !this.isFromVoiceInput;

    this.isProcessing = true;
    this.els.sendBtn.disabled = true;
    this.els.micBtn.disabled = true;
    this.els.userInput.disabled = true;

    // ✅ テキスト入力時も「はい」だけに簡略化
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

      // ✅ 修正: 即答を「はい」だけに
      const ackText = this.t('ackYes');
      this.currentAISpeech = ackText;
      this.addMessage('assistant', ackText);

      if (this.isTTSEnabled && !isTextInput) {
        try {
          const preGeneratedAudio = this.preGeneratedAcks.get(ackText);
          if (preGeneratedAudio && this.isUserInteracted) {
            firstAckPromise = new Promise<void>((resolve) => {
              this.lastAISpeech = this.normalizeText(ackText);
              this.ttsPlayer.src = `data:audio/mp3;base64,${preGeneratedAudio}`;
              this.ttsPlayer.onended = () => resolve();
              this.ttsPlayer.play().catch(_e => resolve());
            });
          } else {
            firstAckPromise = this.speakTextGCP(ackText, false);
          }
        } catch (_e) {}
      }
      if (firstAckPromise) await firstAckPromise;

      // ✅ 修正: オウム返しパターンを削除
      // (generateFallbackResponse, additionalResponse の呼び出しを削除)
    }

    this.isFromVoiceInput = false;

    // ✅ 待機アニメーションは6.5秒後に表示
    if (this.waitOverlayTimer) clearTimeout(this.waitOverlayTimer);
    this.waitOverlayTimer = window.setTimeout(() => { this.showWaitOverlay(); }, 6500);

    // ★ WebSocket経由でテキスト送信（REST不要）
    this.wsSend({ type: 'text', data: message });
    this.els.userInput.blur();
    // レスポンスは handleWsMessage() で処理（transcription, audio, expression, shop_cards, rest_audio）
  }


}
