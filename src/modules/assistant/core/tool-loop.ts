import type { CallOptions, ChatMessage, ModelClient, ModelTurn, ToolCall, ToolDefinition } from './model';

/** Usage of one model call. Providers omit figures; a missing one counts as 0. */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
}

/** Usage summed over every model call of one assistant turn. */
export interface TurnUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  maxCallLatencyMs: number;
}

export const emptyUsage = (): TurnUsage => ({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  latencyMs: 0,
  maxCallLatencyMs: 0,
});

const num = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0;

export function addCall(total: TurnUsage, call: CallUsage): TurnUsage {
  const latency = num(call.latencyMs);
  return {
    modelCalls: total.modelCalls + 1,
    inputTokens: total.inputTokens + num(call.inputTokens),
    outputTokens: total.outputTokens + num(call.outputTokens),
    cachedTokens: total.cachedTokens + num(call.cachedTokens),
    latencyMs: total.latencyMs + latency,
    maxCallLatencyMs: Math.max(total.maxCallLatencyMs, latency),
  };
}

const callUsage = (turn: ModelTurn): CallUsage => ({
  inputTokens: num(turn.usage?.prompt_tokens),
  outputTokens: num(turn.usage?.completion_tokens),
  cachedTokens: num(turn.usage?.prompt_tokens_details?.cached_tokens),
  latencyMs: num(turn.latencyMs),
});

/**
 * Drives the model/tool conversation: call the model, run each requested tool
 * through `onToolCall`, feed the result back, repeat up to `maxCalls`. Callers
 * own the tools and the result type; a thrown error from `onToolCall` aborts
 * the loop, so the handler decides which failures the model gets to hear.
 */
export async function runToolLoop<R>(opts: {
  client: ModelClient;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxCalls: number;
  /** Model tier for every call of this loop; omitted means the defaults. */
  callOptions?: CallOptions;
  /** `done` ends the loop with that result, skipping any remaining tool calls. */
  onToolCall(
    call: ToolCall,
    ctx: { finishReason: string }
  ): Promise<{ content: unknown; done?: R }>;
  /** The model replied without calling a tool. */
  onText(text: string, finishReason: string): R;
  /** `maxCalls` model calls passed without a terminal result. */
  onExhausted(): R;
  /**
   * Optional accumulator the loop updates after every model call, so a caller
   * still holds the usage already spent when the loop throws.
   */
  usage?: TurnUsage;
}): Promise<{ result: R; usage: TurnUsage }> {
  const { client, messages, tools, maxCalls } = opts;
  const usage = opts.usage ?? emptyUsage();

  for (let n = 0; n < maxCalls; n++) {
    const turn = opts.callOptions
      ? await client.complete(messages, tools, opts.callOptions)
      : await client.complete(messages, tools);
    Object.assign(usage, addCall(usage, callUsage(turn)));
    const toolCalls = turn.message.tool_calls ?? [];
    if (!toolCalls.length)
      return { result: opts.onText(turn.message.content ?? '', turn.finishReason), usage };
    // A turn cut off by the token cap may hold half-written JSON arguments; providers
    // can reject that history on the next call, so keep the calls but blank the arguments.
    messages.push(
      turn.finishReason === 'length'
        ? {
            ...turn.message,
            tool_calls: toolCalls.map((tc) => ({
              ...tc,
              function: { ...tc.function, arguments: '{}' },
            })),
          }
        : turn.message
    );

    for (const toolCall of toolCalls) {
      const { content, done } = await opts.onToolCall(toolCall, {
        finishReason: turn.finishReason,
      });
      if (done !== undefined) return { result: done, usage };
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(content ?? null).slice(0, 12000),
      });
    }
  }
  return { result: opts.onExhausted(), usage };
}
