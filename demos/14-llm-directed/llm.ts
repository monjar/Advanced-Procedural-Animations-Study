import Anthropic from '@anthropic-ai/sdk';
import { PROGRAM_SCHEMA, systemPrompt, validateProgram, type Program } from './program';

export const MODEL = 'claude-opus-5-5';

export interface DirectResult {
  program: Program;
  /** Raw JSON text of each reply, for display. */
  replies: string[];
  /** Validator messages that were sent back for a repair, if any. */
  repairs: string[][];
  model: string;
}

/**
 * Natural language → program. The reply is constrained to PROGRAM_SCHEMA by structured outputs; whatever the
 * schema cannot express is checked by `validateProgram`, and its messages go back for one repair round.
 *
 * Bring-your-own key: the browser calls the API directly with the viewer's key (the SDK's
 * dangerouslyAllowBrowser), which never leaves their machine except to api.anthropic.com.
 * Server-side fallbacks are on, so a request declined by a safety classifier is retried on a fallback model.
 */
export async function direct(
  prompt: string,
  apiKey: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<DirectResult> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1, fetch: options.fetch });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
  const replies: string[] = [];
  const repairs: string[][] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await client.beta.messages.create(
      {
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // The system prompt never changes, so it is cached across requests.
        system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: PROGRAM_SCHEMA as unknown as Record<string, unknown> } },
        messages,
      },
      { signal: options.signal },
    );
    if (response.stop_reason === 'refusal') throw new Error('The request was declined.');
    if (response.stop_reason === 'max_tokens') throw new Error('The reply was cut off (max_tokens).');
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    replies.push(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const v = validateProgram(parsed);
    if (v.ok) return { program: v.program, replies, repairs, model: response.model };
    repairs.push(v.errors);
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: `That program cannot run:\n- ${v.errors.join('\n- ')}\nReturn a corrected program.` });
  }
  throw new Error(`No valid program after a repair: ${repairs[repairs.length - 1].join(' ')}`);
}

/** A readable message for the UI. */
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was not accepted.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This key cannot use that model.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited — try again in a moment.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the API.';
  if (e instanceof Anthropic.APIError) return `API error ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
