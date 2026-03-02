import { GuavaRenderer } from './guava-renderer';

/**
 * 音声入力を解析し、アバターのリップシンクを駆動するインターフェース
 */
export class ConciergeInterface {
  private renderer: GuavaRenderer;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array | null = null;

  constructor(renderer: GuavaRenderer) {
    this.renderer = renderer;
  }

  /**
   * 音声ソースをバインドし、解析ループを開始
   */
  public bindAudioSource(stream: MediaStream | HTMLAudioElement) {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const source = stream instanceof MediaStream 
      ? audioContext.createMediaStreamSource(stream)
      : audioContext.createMediaElementSource(stream);
    
    this.analyser = audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);
    
    if (!(stream instanceof MediaStream)) {
      this.analyser.connect(audioContext.destination);
    }

    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.startAudioLoop();
  }

  private startAudioLoop() {
    const update = () => {
      if (this.analyser && this.dataArray) {
        this.analyser.getByteFrequencyData(this.dataArray);
        const average = this.dataArray.reduce((a, b) => a + b, 0) / this.dataArray.length;
        // 0.0 ~ 1.0 に正規化してレンダラーに送る
        this.renderer.update(Math.min(1.0, average / 128));
      }
      requestAnimationFrame(update);
    };
    update();
  }

  public async initialize(assetUrl: string) {
    return await this.renderer.loadGaussianAvatar(assetUrl);
  }
}
