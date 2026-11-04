import { describe, expect, it } from 'vitest';
import type { ChatMessage, ModelClient, ModelTurn, ToolCall } from '../model';
import { addCall, emptyUsage, runToolLoop } from '../tool-loop';

const call = (id: string, name = 't'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: '{}' },
});

const scripted = (turns: Partial<ModelTurn>[]): ModelClient => {
  let i = 0;
  return {
    async complete() {
      const t = turns[i++] ?? turns[turns.length - 1];
      return {
        message: { role: 'assistant', content: null },
        finishReason: 'stop',
        ...t,
      } as ModelTurn;
    },
  };
};

const base = (client: ModelClient) => ({
  client,
  messages: [{ role: 'user', content: 'hi' }] as ChatMessage[],
  tools: [],
  maxCalls: 3,
  onText: (t: string) => `text:${t}`,
  onExhausted: () => 'exhausted',
});

describe('runToolLoop', () => {
  it('ends on a terminal done and sums usage over calls', async () => {
    const client = scripted([
      {
        message: { role: 'assistant', content: null, tool_calls: [call('a')] },
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        latencyMs: 100,
      },
      {
        message: { role: 'assistant', content: null, tool_calls: [call('b')] },
        usage: { prompt_tokens: 20, completion_tokens: 3 },
        latencyMs: 300,
      },
    ]);
    const { result, usage } = await runToolLoop<string>({
      ...base(client),
      onToolCall: async (c) => (c.id === 'b' ? { content: 'x', done: 'done' } : { content: 'x' }),
    });
    expect(result).toBe('done');
    expect(usage).toEqual({
      modelCalls: 2,
      inputTokens: 30,
      outputTokens: 5,
      cachedTokens: 0,
      latencyMs: 400,
      maxCallLatencyMs: 300,
    });
  });

  it('hands plain text to onText when the model uses no tools', async () => {
    const client = scripted([{ message: { role: 'assistant', content: 'hello' } }]);
    const { result, usage } = await runToolLoop<string>({
      ...base(client),
      onToolCall: async () => ({ content: '' }),
    });
    expect(result).toBe('text:hello');
    expect(usage.modelCalls).toBe(1);
  });

  it('calls onExhausted after maxCalls and feeds tool results back', async () => {
    const seen: ChatMessage[][] = [];
    const client: ModelClient = {
      async complete(messages) {
        seen.push([...messages]);
        return {
          message: { role: 'assistant', content: null, tool_calls: [call('a')] },
          finishReason: 'tool_calls',
        };
      },
    };
    const { result, usage } = await runToolLoop<string>({
      ...base(client),
      onToolCall: async () => ({ content: { ok: true } }),
    });
    expect(result).toBe('exhausted');
    expect(usage.modelCalls).toBe(3);
    expect(seen).toHaveLength(3);
    // The second call sees the first call's tool result appended to the history.
    const toolMsg = seen[1].find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ tool_call_id: 'a', content: JSON.stringify({ ok: true }) });
  });

  it('tolerates a handler that returns undefined content', async () => {
    const seen: ChatMessage[][] = [];
    const client: ModelClient = {
      async complete(messages) {
        seen.push([...messages]);
        return {
          message: { role: 'assistant', content: null, tool_calls: [call('a')] },
          finishReason: 'tool_calls',
        };
      },
    };
    const { result } = await runToolLoop<string>({
      ...base(client),
      maxCalls: 2,
      onToolCall: async () => ({ content: undefined }),
    });
    expect(result).toBe('exhausted');
    expect(seen[1].find((m) => m.role === 'tool')).toMatchObject({ content: 'null' });
  });

  it('never re-sends half-written tool arguments from a truncated turn', async () => {
    const seen: ChatMessage[][] = [];
    const cut = {
      id: 'a',
      type: 'function' as const,
      function: { name: 't', arguments: '{"items":[{"menuItemId":"pa' },
    };
    const client: ModelClient = {
      async complete(messages) {
        seen.push([...messages]);
        return {
          message: { role: 'assistant', content: null, tool_calls: [cut] },
          finishReason: seen.length === 1 ? 'length' : 'stop',
        };
      },
    };
    await runToolLoop<string>({
      ...base(client),
      maxCalls: 2,
      onToolCall: async () => ({ content: { error: 'cut off' } }),
    });
    const assistant = seen[1].find((m) => m.role === 'assistant') as ChatMessage & {
      tool_calls: ToolCall[];
    };
    expect(assistant.tool_calls[0].function.arguments).toBe('{}');
    expect(assistant.tool_calls[0].id).toBe('a');
    // the provider's original object is not mutated
    expect(cut.function.arguments).toBe('{"items":[{"menuItemId":"pa');
  });

  it('counts a missing usage block as zero, never NaN', async () => {
    const client = scripted([{ message: { role: 'assistant', content: 'x' } }]);
    const { usage } = await runToolLoop<string>({
      ...base(client),
      onToolCall: async () => ({ content: '' }),
    });
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
    expect(usage.latencyMs).toBe(0);
    expect(Number.isNaN(usage.cachedTokens)).toBe(false);
  });

  it('sums cached_tokens into cachedTokens', async () => {
    const total = addCall(emptyUsage(), {
      inputTokens: 5,
      outputTokens: 1,
      cachedTokens: 4,
      latencyMs: 1,
    });
    expect(
      addCall(total, { inputTokens: 5, outputTokens: 1, cachedTokens: 3, latencyMs: 1 })
        .cachedTokens
    ).toBe(7);

    const client = scripted([
      {
        message: { role: 'assistant', content: 'x' },
        usage: {
          prompt_tokens: 9,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 6 },
        },
      },
    ]);
    const { usage } = await runToolLoop<string>({
      ...base(client),
      onToolCall: async () => ({ content: '' }),
    });
    expect(usage.cachedTokens).toBe(6);
    expect(usage.inputTokens).toBe(9);
  });
});

describe('runToolLoop usage accumulator', () => {
  it('keeps usage already spent when the loop throws', async () => {
    const client = scripted([
      {
        message: { role: 'assistant', content: null, tool_calls: [call('a')] },
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        latencyMs: 50,
      },
    ]);
    const usage = emptyUsage();
    await expect(
      runToolLoop<string>({
        ...base(client),
        usage,
        onToolCall: async () => {
          throw new Error('boom');
        },
      })
    ).rejects.toThrow('boom');
    expect(usage).toMatchObject({ modelCalls: 1, inputTokens: 10, outputTokens: 2, latencyMs: 50 });
  });
});
