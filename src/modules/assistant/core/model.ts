import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { httpError } from '../../../utils/http-error';

/**
 * Minimal OpenAI-compatible chat-completions client. The Meta Model API
 * (https://api.meta.ai/v1, muse-spark-1.3) and hosts serving Meta open-weights
 * models share this shape, so switching provider is configuration only.
 *
 * Plain fetch, no SDK: one request shape, and staging's default-deny fetch
 * guard applies to it automatically.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ModelTurn {
  message: Extract<ChatMessage, { role: 'assistant' }>;
  finishReason: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  /** Wall-clock time of the provider call; test doubles may omit it. */
  latencyMs?: number;
}

/**
 * Per-call overrides, so one assistant can use a fast tier for tool work and a
 * deeper tier for writing. Anything left out uses the ASSISTANT_* defaults.
 */
export interface CallOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ModelClient {
  complete(messages: ChatMessage[], tools: ToolDefinition[], options?: CallOptions): Promise<ModelTurn>;
}

export const assistantUnavailable = () =>
  httpError(
    'The ordering assistant is not available right now. You can still order from the menu.',
    503,
    'ASSISTANT_UNAVAILABLE'
  );

export function isAssistantConfigured(): boolean {
  return env.ASSISTANT_ENABLED && !!env.ASSISTANT_MODEL_API_KEY;
}

export const openAiCompatibleClient: ModelClient = {
  async complete(messages, tools, options = {}) {
    if (!isAssistantConfigured()) throw assistantUnavailable();
    const baseUrl = options.baseUrl ?? env.ASSISTANT_MODEL_BASE_URL;
    const apiKey = options.apiKey ?? env.ASSISTANT_MODEL_API_KEY;
    let response: Response | undefined;
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2 && !response; attempt++) {
      let failure: string | null = null;
      let status: number | undefined;
      try {
        const res = await fetch(
          `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            // tool_choice is left at its default: the Meta Model API accepts only "auto".
            // A writing-only call sends no tools at all: some providers reject an empty list.
            body: JSON.stringify({
              model: options.model ?? env.ASSISTANT_MODEL,
              messages,
              ...(tools.length && { tools }),
              temperature: 0.2,
              max_tokens: options.maxTokens ?? 1200,
              reasoning_effort: options.reasoningEffort ?? env.ASSISTANT_REASONING_EFFORT,
            }),
            signal: AbortSignal.timeout(options.timeoutMs ?? env.ASSISTANT_MODEL_TIMEOUT_MS),
          }
        );
        if (res.ok) {
          response = res;
          break;
        }
        failure = 'http';
        status = res.status;
      } catch (err) {
        // Only the failure kind: the error text can echo the request or URL.
        failure = (err as { name?: string }).name === 'TimeoutError' ? 'timeout' : 'network';
      }
      // Never log the body: providers echo prompts and key fragments in errors.
      logger.warn('Assistant model call failed', status ? { failure, status } : { failure });
      const transient =
        failure === 'network' || (status !== undefined && [502, 503, 504].includes(status));
      if (attempt === 1 || !transient) throw assistantUnavailable();
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!response) throw assistantUnavailable();
    // swallowed-ok: a non-JSON body falls through to ASSISTANT_UNAVAILABLE below.
    const body = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: ModelTurn['message']; finish_reason?: string }>;
      usage?: ModelTurn['usage'];
    } | null;
    const choice = body?.choices?.[0];
    if (!choice?.message) throw assistantUnavailable();
    return {
      message: {
        role: 'assistant',
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls,
      },
      finishReason: choice.finish_reason ?? 'stop',
      usage: body?.usage,
      latencyMs: Date.now() - startedAt,
    };
  },
};
