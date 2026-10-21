import { FRAME, toAnalysisRate } from './lipsync';
import type { Utterance, Viseme } from './voice';

export type Source = 'none' | 'voice' | 'file' | 'mic';

/**
 * Web Audio plumbing: whatever is playing (the synthesized voice, a dropped file, the microphone) goes through
 * an AnalyserNode, and `frame()` returns its latest 32 ms at 16 kHz for the same analysis the tests run.
 * Played audio reaches the speakers `OUTPUT_DELAY` later than the analyser sees it, which cancels the analysis
 * window's lag (measured best at 25–35 ms; see the write-up). The microphone is not delayed: you hear yourself.
 * The AudioContext is created on the first click, as browsers require.
 */
export const OUTPUT_DELAY = 0.03;

export class AudioIn {
  source: Source = 'none';
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private delay: DelayNode | null = null;
  private buf = new Float32Array(4096);
  private readonly out = new Float32Array(FRAME);
  private node: AudioScheduledSourceNode | null = null;
  private stream: MediaStream | null = null;
  private mic: MediaStreamAudioSourceNode | null = null;
  private utterance: Utterance | null = null;
  private startedAt = 0;
  onEnded: () => void = () => {};

  private ensure(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.delay = this.ctx.createDelay(0.2);
      this.delay.delayTime.value = OUTPUT_DELAY;
      this.delay.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  stop(): void {
    this.node?.stop();
    this.node?.disconnect();
    this.node = null;
    this.mic?.disconnect();
    this.mic = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.utterance = null;
    this.source = 'none';
  }

  private play(buffer: AudioBuffer, source: Source): void {
    const ctx = this.ensure();
    this.stop();
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.analyser!);
    node.connect(this.delay!);
    node.onended = () => {
      if (this.node === node) {
        this.node = null;
        this.source = 'none';
        this.utterance = null;
        this.onEnded();
      }
    };
    node.start();
    this.node = node;
    this.source = source;
    this.startedAt = ctx.currentTime;
  }

  speak(u: Utterance): void {
    const ctx = this.ensure();
    const buffer = ctx.createBuffer(1, u.samples.length, u.sampleRate);
    buffer.copyToChannel(u.samples as Float32Array<ArrayBuffer>, 0);
    this.play(buffer, 'voice');
    this.utterance = u;
  }

  async playFile(file: File): Promise<void> {
    const ctx = this.ensure();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    this.play(buffer, 'file');
  }

  async useMic(): Promise<void> {
    const ctx = this.ensure();
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.mic = ctx.createMediaStreamSource(this.stream);
    // Not connected to the speakers: no feedback.
    this.mic.connect(this.analyser!);
    this.source = 'mic';
  }

  /** Seconds since the current clip started (voice/file). */
  get time(): number {
    return this.ctx ? this.ctx.currentTime - this.startedAt : 0;
  }

  /** Ground-truth viseme of the synthesized voice being heard right now, if it is the source. */
  truth(): Viseme | null {
    if (this.source !== 'voice' || !this.utterance) return null;
    return this.utterance.visemeAt(this.time - OUTPUT_DELAY);
  }

  /** The latest frame at the analysis rate, or null when nothing is playing. */
  frame(): Float32Array | null {
    if (this.source === 'none' || !this.analyser || !this.ctx) return null;
    this.analyser.getFloatTimeDomainData(this.buf as Float32Array<ArrayBuffer>);
    return toAnalysisRate(this.buf, this.ctx.sampleRate, this.out);
  }
}
