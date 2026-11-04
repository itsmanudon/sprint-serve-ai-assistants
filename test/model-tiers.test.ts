import { afterEach, describe, expect, it, vi } from 'vitest';

// Imports are hoisted, so the environment is set in a hoisted block before env.ts loads.
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.ASSISTANT_ENABLED = 'true';
  process.env.ASSISTANT_MODEL_API_KEY = 'default-key-123';
  process.env.ASSISTANT_MODEL_BASE_URL = 'https://default.invalid/v1';
});

import { openAiCompatibleClient } from '../src/modules/assistant/core/model';

const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('model tiers', () => {
  it('uses the defaults when no options are given', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await openAiCompatibleClient.complete([{ role: 'user', content: 'x' }], [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe('https://default.invalid/v1/chat/completions');
    expect(body.model).toBe('muse-spark-1.3');
    expect(body.tools).toHaveLength(1);
  });

  it('applies a tier: host, key, model, effort and token cap; sends no tools for a writing call', async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal('fetch', fetchMock);
    await openAiCompatibleClient.complete([{ role: 'user', content: 'x' }], [], {
      baseUrl: 'https://deep.invalid/v1/',
      apiKey: 'deep-key-12345',
      model: 'bigger-model',
      reasoningEffort: 'high',
      maxTokens: 2500,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url).toBe('https://deep.invalid/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer deep-key-12345');
    expect([body.model, body.reasoning_effort, body.max_tokens]).toEqual(['bigger-model', 'high', 2500]);
    expect('tools' in body).toBe(false);
  });
});
