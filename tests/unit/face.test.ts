import { describe, expect, it } from 'vitest';
import { analyze, createMapper, dominant, FRAME, levinson, mapToVisemes, polyRoots } from '../../demos/15-procedural-face/lipsync';
import { formantScale, PHONES, synthesizePhones, toPhones } from '../../demos/15-procedural-face/voice';
import { EYE_RANGE, GazeModel, saccadeDuration } from '../../demos/15-procedural-face/gaze';
import { OUTPUT_DELAY } from '../../demos/15-procedural-face/audio';
import { auditLipSync } from '../support/faceAudit';

describe('LPC building blocks', () => {
  it('Levinson–Durbin recovers a known all-pole filter and its roots', () => {
    // x[n] = 1.3 x[n-1] − 0.8 x[n-2] + e[n]: poles at r = √0.8, θ = acos(1.3 / (2 √0.8)).
    let x1 = 0;
    let x2 = 0;
    let s = 1;
    const xs: number[] = [];
    for (let i = 0; i < 20000; i++) {
      s = (s * 16807) % 2147483647;
      const x = 1.3 * x1 - 0.8 * x2 + (s / 2147483647 - 0.5);
      xs.push(x);
      x2 = x1;
      x1 = x;
    }
    const r = new Float64Array(3);
    for (let lag = 0; lag < 3; lag++) for (let i = 0; i + lag < xs.length; i++) r[lag] += xs[i] * xs[i + lag];
    const a = levinson(r, 2);
    expect(a[1]).toBeCloseTo(-1.3, 1);
    expect(a[2]).toBeCloseTo(0.8, 1);
    const [re, im] = polyRoots(Float64Array.from([1, -1.3, 0.8])).find(([, i]) => i > 0)!;
    expect(Math.hypot(re, im)).toBeCloseTo(Math.sqrt(0.8), 6);
    expect(Math.atan2(im, re)).toBeCloseTo(Math.acos(1.3 / (2 * Math.sqrt(0.8))), 6);
  });
});

describe('Formant analysis of the synthesized voice', () => {
  it.each([110, 160, 220])('recovers F1/F2 and the vowel of steady vowels at f0 = %s Hz', (f0) => {
    const k = formantScale(f0);
    for (const v of ['a', 'e', 'i', 'o', 'u']) {
      const u = synthesizePhones([v, v, v], { f0 });
      const mapper = createMapper();
      const f1s: number[] = [];
      const f2s: number[] = [];
      let hits = 0;
      let frames = 0;
      for (let end = FRAME; end <= u.samples.length; end += 160) {
        const t = (end - FRAME / 2) / u.sampleRate;
        if (u.visemeAt(t) !== PHONES[v].viseme || t < 0.33 || t > u.duration - 0.33) continue;
        const f = analyze(u.samples.subarray(end - FRAME, end));
        frames++;
        if (dominant(mapToVisemes(f, mapper, 0.01)) === PHONES[v].viseme) hits++;
        f1s.push(f.f1);
        f2s.push(f.f2);
      }
      const median = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
      expect(Math.abs(median(f1s) / (PHONES[v].f[0] * k) - 1)).toBeLessThan(0.2);
      expect(Math.abs(median(f2s) / (PHONES[v].f[1] * k) - 1)).toBeLessThan(0.08);
      expect(hits / frames).toBeGreaterThan(0.8);
    }
  });

  it('turns text into phones', () => {
    expect(toPhones('she sells')).toEqual(['sh', 'i', '_', 's', 'e', 'l', 's']);
    expect(toPhones('moon, map')).toEqual(['m', 'u', 'n', 'pause', '_', 'm', 'ae', 'p']);
  });
});

describe('Lip-sync from audio against the phoneme timeline', () => {
  // Measured on five sentences. The audio is heard OUTPUT_DELAY after the analysis sees it (as on the page);
  // without that delay the 32 ms analysis window lags and vowel accuracy falls from 87 % to 68 %.
  it.each([120, 210])('follows a %s Hz voice: vowels, fricatives, closures and jaw opening', (f0) => {
    const r = auditLipSync(f0, OUTPUT_DELAY);
    expect(r.vowelAccuracy).toBeGreaterThan(0.8);
    expect(r.fricativeAccuracy).toBeGreaterThan(0.9);
    expect(r.closureShut).toBeGreaterThan(0.6);
    expect(r.openCorrelation).toBeGreaterThan(0.85);
  }, 30000);

  it('is worse without the output delay (the lag is real)', () => {
    expect(auditLipSync(120, 0).vowelAccuracy).toBeLessThan(auditLipSync(120, OUTPUT_DELAY).vowelAccuracy - 0.1);
  }, 30000);
});

describe('Gaze model', () => {
  const simulate = (mode: 'idle' | 'talking' | 'listening', minutes: number, seed = 3) => {
    const g = new GazeModel(seed);
    g.mode = mode;
    let mutual = 0;
    let frames = 0;
    let maxEye = 0;
    for (let i = 0; i < minutes * 60 * 60; i++) {
      g.update(1 / 60);
      frames++;
      if (g.mutual) mutual++;
      maxEye = Math.max(maxEye, Math.abs(g.eye.yaw) / EYE_RANGE.yaw, Math.abs(g.eye.pitch) / EYE_RANGE.pitch);
    }
    const saccades = g.events.filter((e) => e.kind !== 'micro');
    return {
      g,
      small: saccades.filter((e) => e.amplitude <= 15).length / saccades.length,
      blinksPerMinute: g.blinks.length / minutes,
      mutual: mutual / frames,
      maxEye,
      microPerSecond: g.events.filter((e) => e.kind === 'micro').length / (minutes * 60),
    };
  };

  it('saccades follow the main sequence and are mostly small', () => {
    const r = simulate('idle', 10);
    for (const e of r.g.events) expect(e.duration).toBeCloseTo(saccadeDuration(e.amplitude), 9);
    expect(saccadeDuration(10)).toBeCloseTo(0.043, 6);
    expect(r.small).toBeGreaterThan(0.8);
    expect(r.small).toBeLessThan(0.97);
    expect(r.microPerSecond).toBeGreaterThan(0.8);
    expect(r.microPerSecond).toBeLessThan(2.5);
    expect(r.maxEye).toBeLessThanOrEqual(1);
  });

  it('blinks at resting and conversational rates', () => {
    const idle = simulate('idle', 10).blinksPerMinute;
    const talking = simulate('talking', 10).blinksPerMinute;
    expect(Math.abs(idle - 17)).toBeLessThan(3);
    expect(Math.abs(talking - 26)).toBeLessThan(4);
  });

  it('listeners hold mutual gaze longer than speakers', () => {
    const listening = simulate('listening', 10).mutual;
    const talking = simulate('talking', 10).mutual;
    expect(listening).toBeGreaterThan(0.65);
    expect(talking).toBeLessThan(0.55);
    expect(listening - talking).toBeGreaterThan(0.15);
  });

  it('holds the fixation while the head catches up (vestibulo-ocular reflex)', () => {
    const g = new GazeModel(5);
    g.mode = 'track';
    g.target.yaw = 35; // a big shift: the head has to help
    let worst = 0;
    let headMoved = 0;
    const prev = { gaze: 0, head: 0 };
    for (let i = 0; i < 120; i++) {
      g.update(1 / 120);
      if (!g.inSaccade && i > 2) {
        const headSpeed = Math.abs(g.head.yaw - prev.head) * 120;
        if (headSpeed > 20) {
          headMoved++;
          worst = Math.max(worst, Math.abs(g.gaze.yaw - prev.gaze) * 120);
        }
      }
      prev.gaze = g.gaze.yaw;
      prev.head = g.head.yaw;
    }
    expect(headMoved).toBeGreaterThan(10); // the head really is moving fast…
    expect(worst).toBeLessThan(25); // …while the gaze barely moves (pursuit + drift only)
    expect(Math.abs(g.gaze.yaw - 35)).toBeLessThan(1.5);
  });

  it('the head stays steady when the partner or target is beyond the eyes\' reach', () => {
    // Regression: the head used to swing back and forth (tens of degrees, several times a second) when seen from
    // far below or above, and to tremble when following a cursor near the top or bottom of the screen.
    const reversalsPerSecond = (setup: (g: GazeModel) => void) => {
      const g = new GazeModel(3);
      setup(g);
      const seconds = 20;
      let reversals = 0;
      let lastV = 0;
      let prev = { ...g.head };
      for (let i = 0; i < seconds * 60; i++) {
        g.update(1 / 60);
        for (const k of ['yaw', 'pitch'] as const) {
          const v = (g.head[k] - prev[k]) * 60;
          if (Math.abs(v) > 3) {
            if (k === 'pitch' && lastV !== 0 && Math.sign(v) !== Math.sign(lastV)) reversals++;
            if (k === 'pitch') lastV = v;
          }
        }
        prev = { ...g.head };
      }
      return reversals / seconds;
    };
    for (const partner of [{ yaw: 5, pitch: -45 }, { yaw: 5, pitch: 55 }, { yaw: 90, pitch: 0 }]) {
      const r = reversalsPerSecond((g) => {
        g.mode = 'listening';
        Object.assign(g.partner, partner);
      });
      expect(r, JSON.stringify(partner)).toBeLessThan(1);
    }
    for (const pitch of [60, -65]) {
      const r = reversalsPerSecond((g) => {
        g.mode = 'track';
        g.target.yaw = -8;
        g.target.pitch = pitch;
      });
      expect(r, `track ${pitch}`).toBeLessThan(0.2);
    }
  });

  it('tracks a moving target with pursuit and catch-up saccades', () => {
    const g = new GazeModel(9);
    g.mode = 'track';
    const errors: number[] = [];
    for (let i = 0; i < 60 * 10; i++) {
      const t = i / 60;
      g.target.yaw = 20 * Math.sin(t * 0.6);
      g.target.pitch = 8 * Math.sin(t * 0.9);
      g.update(1 / 60);
      if (t > 1) errors.push(Math.hypot(g.target.yaw - g.gaze.yaw, g.target.pitch - g.gaze.pitch));
    }
    errors.sort((a, b) => a - b);
    expect(errors[errors.length >> 1]).toBeLessThan(1.5);
    expect(errors[Math.floor(errors.length * 0.98)]).toBeLessThan(4);
  });
});
