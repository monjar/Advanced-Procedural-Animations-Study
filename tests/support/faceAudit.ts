import { MOUTH_SHAPES } from '../../demos/15-procedural-face/face';
import { analyze, createMapper, dominant, emptyWeights, FRAME, mapToVisemes, VisemeSmoother } from '../../demos/15-procedural-face/lipsync';
import { synthesize, VISEMES, type Viseme } from '../../demos/15-procedural-face/voice';

export const SENTENCES = [
  'Hello there. I am a face made of code, and I can say almost anything you type.',
  'She sells sea shells by the sea shore.',
  'Peter Piper picked a peck of pickled peppers.',
  'How are you doing today? I hope the weather is good.',
  'Moving my mouth to match my voice is harder than it looks.',
];

const VOWELS: Viseme[] = ['aa', 'E', 'I', 'O', 'U'];
const openOf = (w: Record<Viseme, number>) => VISEMES.reduce((a, v) => a + w[v] * MOUTH_SHAPES[v].open, 0);

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

/**
 * Speak each sentence with the formant synthesizer, lip-sync it from the audio alone (10 ms hops, the same
 * smoothing as the page) and compare with the phoneme timeline the synthesizer used, as heard `latency` seconds
 * after the analysis sees it.
 */
export function auditLipSync(f0: number, latency = 0) {
  let vowelFrames = 0;
  let vowelHits = 0;
  let fricFrames = 0;
  let fricHits = 0;
  let closureFrames = 0;
  let closureShut = 0;
  const predOpen: number[] = [];
  const truthOpen: number[] = [];
  for (const text of SENTENCES) {
    const u = synthesize(text, { f0 });
    const mapper = createMapper();
    const pred = new VisemeSmoother();
    const truth = new VisemeSmoother();
    pred.reset();
    truth.reset();
    const hop = u.sampleRate / 100;
    for (let end = FRAME; end <= u.samples.length; end += hop) {
      // As live: the frame ends now. `latency` is how long the audio output is delayed behind the analysis, so the
      // listener hears — and the truth is — what was said that long ago.
      const t = end / u.sampleRate - latency;
      const label = u.visemeAt(t);
      const target = mapToVisemes(analyze(u.samples.subarray(end - FRAME, end)), mapper, 0.01);
      const truthTarget = emptyWeights();
      truthTarget[label] = 1;
      const p = pred.update(target, 0.01);
      const q = truth.update(truthTarget, 0.01);
      predOpen.push(openOf(p));
      truthOpen.push(openOf(q));
      const guess = dominant(target);
      if (VOWELS.includes(label)) {
        vowelFrames++;
        if (guess === label) vowelHits++;
      } else if (label === 'SS' || label === 'CH') {
        fricFrames++;
        if (guess === label) fricHits++;
      } else if (label === 'PP' && u.segments.some((s) => s.viseme === 'PP' && t > s.start + 0.02 && t < s.start + (s.end - s.start) * 0.6)) {
        // Inside a p/b/m closure (not its release burst): the mouth should be shut.
        closureFrames++;
        if (openOf(p) < 0.15) closureShut++;
      }
    }
  }
  return {
    vowelAccuracy: vowelHits / vowelFrames,
    fricativeAccuracy: fricHits / fricFrames,
    closureShut: closureShut / closureFrames,
    openCorrelation: pearson(predOpen, truthOpen),
  };
}
