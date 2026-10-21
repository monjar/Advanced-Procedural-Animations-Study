/**
 * The animation program an LLM writes: a short list of steps over the procedural vocabulary of studies 02–07
 * (walk with the stride-wheel biped, turn, look at things, point / reach / wave with two-bone IK, nod, shake).
 * LLMs are poor at joint angles and good at intent, so the vocabulary is intent-level and everything below it
 * stays procedural.
 *
 * Two layers of checking: the JSON schema (sent with the request as a structured-output format, so the reply
 * always has this shape) and `validateProgram`, which checks what a schema cannot express — known object names,
 * value ranges, steps that would fight over the same limb — and returns messages precise enough to send back
 * to the model for a repair.
 */

export interface SceneObject {
  id: string;
  label: string;
  x: number;
  z: number;
  /** Height of the point to look or point at. */
  y: number;
  /** Height of the surface a hand touches (reach_for). */
  touch: number;
  /** Footprint radius: walk_to stops this far from the centre plus a step. */
  radius: number;
  color: number;
}

export const SCENE: SceneObject[] = [
  { id: 'red_cube', label: 'red cube', x: 3.5, z: 2, y: 0.5, touch: 1.0, radius: 0.5, color: 0xe5484d },
  { id: 'blue_ball', label: 'blue ball', x: -3, z: 3, y: 0.35, touch: 0.62, radius: 0.35, color: 0x3e8ef7 },
  { id: 'green_cone', label: 'green cone', x: -4, z: -2.5, y: 0.9, touch: 1.0, radius: 0.45, color: 0x46c37b },
  { id: 'yellow_pillar', label: 'yellow pillar', x: 2, z: -4, y: 1.9, touch: 1.2, radius: 0.35, color: 0xf5c84c },
  { id: 'bench', label: 'bench', x: 0.5, z: 5, y: 0.45, touch: 0.5, radius: 0.9, color: 0x9a7b5a },
  { id: 'lamp', label: 'street lamp', x: -1, z: -6, y: 2.6, touch: 1.2, radius: 0.2, color: 0xc8ccd4 },
];

/** Targets: scene objects, plus the viewer and "forward". */
export const TARGETS = [...SCENE.map((o) => o.id), 'camera', 'ahead'] as const;
export type Target = (typeof TARGETS)[number];

export const ACTIONS = ['walk_to', 'turn_to', 'wait', 'look_at', 'point_at', 'reach_for', 'wave', 'nod', 'shake_head'] as const;
export type Action = (typeof ACTIONS)[number];

export interface Step {
  action: Action;
  target?: Target | 'none';
  /** walk_to: m/s (0.3 stroll … 1.4 walk … 4 run). */
  speed?: number;
  hand?: 'left' | 'right' | 'either';
  /** wait / point_at / reach_for / look_at: seconds. */
  seconds?: number;
  /** wave / nod / shake_head: repetitions. */
  times?: number;
  /** Start together with the previous step instead of after it. */
  with_previous?: boolean;
}

export interface Program {
  /** One line restating what the character will do. */
  summary: string;
  steps: Step[];
}

export const LIMITS = { speed: [0.3, 4.5], seconds: [0.2, 10], times: [1, 8], steps: 24 } as const;

/** JSON schema for structured outputs (no numeric ranges: the API does not support them; the validator does). */
export const PROGRAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'steps'],
  properties: {
    summary: { type: 'string', description: 'One sentence restating what the character will do.' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: [...ACTIONS] },
          target: { type: 'string', enum: [...TARGETS, 'none'] },
          speed: { type: 'number', description: `walk_to only: metres per second, ${LIMITS.speed[0]}–${LIMITS.speed[1]}` },
          hand: { type: 'string', enum: ['left', 'right', 'either'] },
          seconds: { type: 'number', description: `${LIMITS.seconds[0]}–${LIMITS.seconds[1]}` },
          times: { type: 'integer', description: `${LIMITS.times[0]}–${LIMITS.times[1]}` },
          with_previous: { type: 'boolean', description: 'Run at the same time as the previous step.' },
        },
      },
    },
  },
} as const;

const NEEDS_TARGET: Action[] = ['walk_to', 'turn_to', 'look_at', 'point_at', 'reach_for'];
const ARM_ACTIONS: Action[] = ['point_at', 'reach_for', 'wave'];
const HEAD_ACTIONS: Action[] = ['nod', 'shake_head'];
const BODY_ACTIONS: Action[] = ['walk_to', 'turn_to'];

export type Validation = { ok: true; program: Program } | { ok: false; errors: string[] };

/** Check a parsed reply. On success the program has defaults filled in and is safe to run. */
export function validateProgram(raw: unknown): Validation {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['The reply must be a JSON object with "summary" and "steps".'] };
  const r = raw as Record<string, unknown>;
  if (typeof r.summary !== 'string' || !r.summary.trim()) errors.push('"summary" must be a non-empty string.');
  if (!Array.isArray(r.steps) || r.steps.length === 0) return { ok: false, errors: [...errors, '"steps" must be a non-empty array.'] };
  if (r.steps.length > LIMITS.steps) errors.push(`At most ${LIMITS.steps} steps (got ${r.steps.length}).`);
  const steps: Step[] = [];
  r.steps.forEach((s: unknown, i: number) => {
    const at = `Step ${i + 1}`;
    if (typeof s !== 'object' || s === null) {
      errors.push(`${at} must be an object.`);
      return;
    }
    const step = { ...(s as Record<string, unknown>) } as Record<string, unknown>;
    const allowed = new Set(['action', 'target', 'speed', 'hand', 'seconds', 'times', 'with_previous']);
    for (const k of Object.keys(step)) if (!allowed.has(k)) errors.push(`${at}: unknown field "${k}".`);
    const action = step.action as Action;
    if (!ACTIONS.includes(action)) {
      errors.push(`${at}: unknown action "${String(step.action)}". Use one of ${ACTIONS.join(', ')}.`);
      return;
    }
    if (NEEDS_TARGET.includes(action)) {
      const okTarget = action === 'look_at' ? [...TARGETS, 'none'] : TARGETS;
      if (!okTarget.includes(step.target as Target)) errors.push(`${at} (${action}): target must be one of ${okTarget.join(', ')} (got ${JSON.stringify(step.target)}).`);
      if (action === 'walk_to' && (step.target === 'camera' || step.target === 'ahead')) errors.push(`${at}: walk_to needs a scene object, not "${step.target}".`);
    }
    const range = (k: 'speed' | 'seconds' | 'times') => {
      if (step[k] === undefined) return;
      const v = step[k];
      const [lo, hi] = LIMITS[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (k === 'times' && !Number.isInteger(v))) errors.push(`${at} (${action}): ${k} must be ${k === 'times' ? 'an integer' : 'a number'} in ${lo}–${hi} (got ${JSON.stringify(v)}).`);
    };
    range('speed');
    range('seconds');
    range('times');
    if (step.speed !== undefined && action !== 'walk_to') errors.push(`${at}: speed only applies to walk_to.`);
    if (step.hand !== undefined && !['left', 'right', 'either'].includes(step.hand as string)) errors.push(`${at}: hand must be left, right or either.`);
    if (step.with_previous !== undefined && typeof step.with_previous !== 'boolean') errors.push(`${at}: with_previous must be true or false.`);
    if (i === 0 && step.with_previous) errors.push(`${at}: the first step cannot run with a previous one.`);
    steps.push({
      action,
      target: step.target as Target | 'none' | undefined,
      speed: (step.speed as number | undefined) ?? (action === 'walk_to' ? 1.3 : undefined),
      hand: (step.hand as Step['hand']) ?? (ARM_ACTIONS.includes(action) ? 'either' : undefined),
      seconds: step.seconds as number | undefined,
      times: step.times as number | undefined,
      with_previous: !!step.with_previous,
    });
  });
  // Steps that run together must not need the same limb.
  let group: Step[] = [];
  const checkGroup = (g: Step[], first: number) => {
    const body = g.filter((s) => BODY_ACTIONS.includes(s.action));
    if (body.length > 1) errors.push(`Steps ${first}–${first + g.length - 1} run together but more than one moves the whole body (${body.map((s) => s.action).join(', ')}).`);
    const head = g.filter((s) => HEAD_ACTIONS.includes(s.action) || s.action === 'look_at');
    if (head.length > 1) errors.push(`Steps ${first}–${first + g.length - 1} run together but more than one moves the head.`);
    for (const hand of ['left', 'right'] as const) {
      const arms = g.filter((s) => ARM_ACTIONS.includes(s.action) && s.hand === hand);
      if (arms.length > 1) errors.push(`Steps ${first}–${first + g.length - 1} run together but use the ${hand} hand twice.`);
    }
  };
  let groupStart = 1;
  steps.forEach((s, i) => {
    if (!s.with_previous && group.length) {
      checkGroup(group, groupStart);
      group = [];
      groupStart = i + 1;
    }
    group.push(s);
  });
  if (group.length) checkGroup(group, groupStart);
  if (errors.length) return { ok: false, errors };
  return { ok: true, program: { summary: (r.summary as string).trim(), steps } };
}

/** The system prompt: the vocabulary, the scene, and how to compose steps. Stable, so it caches. */
export function systemPrompt(): string {
  const objects = SCENE.map((o) => `- ${o.id}: a ${o.label} at x=${o.x}, z=${o.z} (${o.y} m high)`).join('\n');
  return `You direct a small animated character on a plaza by writing a short animation program. The character is fully procedural: you choose what it does, its animation system decides how its joints move.

The plaza (metres; the character starts at the centre, facing +z):
${objects}
- camera: the viewer, in front of the character.
- ahead: straight in front of the character.

Actions (each is one step):
- walk_to {target, speed}: walk to a scene object and stop next to it. speed 0.3 (stroll) … 1.3 (walk, default) … 4.5 (sprint).
- turn_to {target}: turn on the spot to face a target.
- wait {seconds}
- look_at {target, seconds?}: turn the head and eyes toward a target and keep looking (until another look_at, or for seconds if given). target "none" looks ahead again.
- point_at {target, hand, seconds}: point with an outstretched arm (default 2 s).
- reach_for {target, hand, seconds}: reach out to touch it (works within about an arm's length; walk there first).
- wave {hand, times}: wave a hand above the shoulder (default 3).
- nod {times}, shake_head {times}: yes / no.

Steps run one after another. Set with_previous: true on a step to start it together with the previous one — for example waving or looking around while walking. Steps that run together must not use the same limb twice (one body movement, one head movement, each hand once). hand "either" lets the character pick the hand nearer the target.

Write a program that does what the user asks, in the order they ask, using only these actions and targets. If the request asks for something the vocabulary cannot do (jumping, sitting, speaking), do the closest thing it can and say so in the summary. Keep programs short — usually 2 to 10 steps.`;
}
