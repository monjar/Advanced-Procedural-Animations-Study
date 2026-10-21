import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../demos/14-llm-directed/examples';
import { direct, MODEL } from '../../demos/14-llm-directed/llm';
import { Performer } from '../../demos/14-llm-directed/performer';
import { PROGRAM_SCHEMA, validateProgram, type Program } from '../../demos/14-llm-directed/program';

function perform(program: Program, seconds = 90) {
  const p = new Performer();
  p.load(program);
  let t = 0;
  while (!p.finished && t < seconds) {
    p.update(1 / 60);
    t += 1 / 60;
  }
  return { p, t };
}

describe('Program validation', () => {
  it('accepts every example and fills in defaults', () => {
    for (const ex of EXAMPLES) {
      const v = validateProgram(ex.program);
      expect(v.ok, `${ex.prompt}: ${v.ok ? '' : v.errors.join(' ')}`).toBe(true);
    }
    const v = validateProgram({ summary: 's', steps: [{ action: 'walk_to', target: 'bench' }, { action: 'wave' }] });
    expect(v.ok && v.program.steps[0].speed).toBe(1.3);
    expect(v.ok && v.program.steps[1].hand).toBe('either');
  });

  it('rejects what the schema cannot catch, with messages a model can act on', () => {
    const bad = (steps: unknown[]) => {
      const v = validateProgram({ summary: 'x', steps });
      return v.ok ? [] : v.errors;
    };
    expect(bad([{ action: 'jump' }])[0]).toMatch(/unknown action "jump"/);
    expect(bad([{ action: 'walk_to', target: 'moon' }])[0]).toMatch(/target must be one of/);
    expect(bad([{ action: 'walk_to', target: 'camera' }])[0]).toMatch(/needs a scene object/);
    expect(bad([{ action: 'walk_to', target: 'bench', speed: 30 }])[0]).toMatch(/speed must be a number in 0.3–4.5/);
    expect(bad([{ action: 'wave', times: 2.5 }])[0]).toMatch(/times must be an integer/);
    expect(bad([{ action: 'wave', with_previous: true }])[0]).toMatch(/first step/);
    expect(bad([{ action: 'walk_to', target: 'bench' }, { action: 'turn_to', target: 'lamp', with_previous: true }])[0]).toMatch(/more than one moves the whole body/);
    expect(bad([{ action: 'wave', hand: 'left' }, { action: 'point_at', target: 'lamp', hand: 'left', with_previous: true }])[0]).toMatch(/left hand twice/);
    expect(validateProgram('hello').ok).toBe(false);
  });

  it('keeps numeric ranges out of the schema (structured outputs do not support them)', () => {
    expect(JSON.stringify(PROGRAM_SCHEMA)).not.toMatch(/minimum|maximum/);
  });
});

describe('Performing programs on the procedural biped', () => {
  it.each(EXAMPLES.map((e) => [e.prompt, e.program] as const))('achieves every step: %s', (_prompt, program) => {
    const v = validateProgram(program);
    if (!v.ok) throw new Error(v.errors.join(' '));
    const { p } = perform(v.program);
    expect(p.finished).toBe(true);
    expect(p.results).toHaveLength(v.program.steps.length);
    for (const r of p.results) expect(r.achieved, `step ${r.index + 1} ${r.action} (error ${r.error.toFixed(3)})`).toBe(true);
  });

  it('runs with_previous steps together and the rest in order', () => {
    const v = validateProgram(EXAMPLES[2].program); // look, shake, walk + look
    if (!v.ok) throw new Error();
    const { p } = perform(v.program);
    const r = (i: number) => p.results.find((x) => x.index === i)!;
    expect(r(1).start).toBeGreaterThanOrEqual(r(0).end - 1e-9);
    expect(Math.abs(r(3).start - r(2).start)).toBeLessThan(1e-9);
  });

  it('stops next to what it walks to and touches what it reaches for, crouching for low things', () => {
    const { p } = perform({ summary: '', steps: [{ action: 'walk_to', target: 'blue_ball', speed: 1.3 }, { action: 'reach_for', target: 'blue_ball', hand: 'either', seconds: 1.5 }] });
    expect(p.results[1].error).toBeLessThan(0.12);
    expect(p.crouch).toBeGreaterThan(0.2);
  });
});

describe('Claude client', () => {
  /** A fake fetch that answers with canned messages and records the requests. */
  function fakeApi(replies: string[]) {
    const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      requests.push({ url: String(url), headers, body: JSON.parse(String(init.body)) });
      const text = replies[requests.length - 1];
      return new Response(
        JSON.stringify({
          id: `msg_${requests.length}`,
          type: 'message',
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { fetchFn, requests };
  }

  it('asks for the program schema and returns a validated program', async () => {
    const api = fakeApi([JSON.stringify(EXAMPLES[1].program)]);
    const r = await direct('Run to the yellow pillar', 'sk-test', { fetch: api.fetchFn });
    expect(r.program.steps[0].target).toBe('yellow_pillar');
    const req = api.requests[0];
    expect(req.url).toMatch(/\/v1\/messages/);
    expect(req.body.model).toBe('claude-opus-5-5');
    expect((req.body.output_config as { format: { type: string; schema: unknown } }).format).toEqual({ type: 'json_schema', schema: PROGRAM_SCHEMA });
    expect(req.body.fallbacks).toBe('default');
    expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(req.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(req.headers['x-api-key']).toBe('sk-test');
  });

  it('sends validator errors back once and accepts the repaired program', async () => {
    const broken = { summary: 'x', steps: [{ action: 'walk_to', target: 'bench', speed: 12 }] };
    const api = fakeApi([JSON.stringify(broken), JSON.stringify(EXAMPLES[0].program)]);
    const r = await direct('go to the bench fast', 'sk-test', { fetch: api.fetchFn });
    expect(r.repairs).toHaveLength(1);
    expect(r.repairs[0][0]).toMatch(/speed/);
    const second = api.requests[1].body.messages as { role: string; content: unknown }[];
    expect(second).toHaveLength(3);
    expect(JSON.stringify(second[2].content)).toMatch(/speed must be/);
  });

  it('gives up after one failed repair', async () => {
    const api = fakeApi(['not json', 'still not json']);
    await expect(direct('???', 'sk-test', { fetch: api.fetchFn })).rejects.toThrow(/No valid program/);
  });
});
