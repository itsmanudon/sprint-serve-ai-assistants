import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../config/env', () => ({
  env: {
    ASSISTANT_ENABLED: true,
    ASSISTANT_MODEL_API_KEY: 'test-key-123',
    ASSISTANT_MODEL_BASE_URL: 'https://model.invalid/v1',
    ASSISTANT_MODEL: 'muse-spark-1.3',
    ASSISTANT_MODEL_TIMEOUT_MS: 1000,
    ASSISTANT_REASONING_EFFORT: 'minimal',
  },
}));
const warn = vi.fn();
vi.mock('../../../../config/logger', () => ({ logger: { warn: (...a: unknown[]) => warn(...a) } }));

import { env } from '../../../../config/env';
import { openAiCompatibleClient } from '../model';

const fetchMock = vi.fn();
const messages = [{ role: 'user' as const, content: 'secret dinner plans' }];

beforeEach(() => {
  warn.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** Everything logged, flattened, so the test can prove nothing sensitive leaked. */
const logged = () => JSON.stringify(warn.mock.calls);

describe('model client failure logging', () => {
  it('logs the HTTP status, never the body, messages or key', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"quota for test-key-123"}', { status: 429 }));
    await expect(openAiCompatibleClient.complete(messages, [])).rejects.toMatchObject({ status: 503 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ failure: 'http', status: 429 });
    expect(logged()).not.toMatch(/quota|test-key-123|secret dinner/);
  });

  it('logs a timeout', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(openAiCompatibleClient.complete(messages, [])).rejects.toMatchObject({ status: 503 });
    expect(warn.mock.calls[0][1]).toEqual({ failure: 'timeout' });
  });

  it('logs a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed: test-key-123'));
    await expect(openAiCompatibleClient.complete(messages, [])).rejects.toMatchObject({ status: 503 });
    expect(warn.mock.calls[0][1]).toEqual({ failure: 'network' });
    expect(logged()).not.toMatch(/test-key-123/);
  });
});

describe('model request', () => {
  it('caps the completion at 1200 tokens', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 })
    );
    await openAiCompatibleClient.complete(messages, []);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.max_tokens).toBe(1200);
  });
});

describe('model retry', () => {
  const okResponse = () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });

  it('retries a network failure once and succeeds with one warn log', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(okResponse());
    const turn = await openAiCompatibleClient.complete(messages, []);
    expect(turn.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('throws unavailable after a 503 then a 503', async () => {
    fetchMock.mockImplementation(async () => new Response('x', { status: 503 }));
    await expect(openAiCompatibleClient.complete(messages, [])).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 or a timeout', async () => {
    fetchMock.mockResolvedValue(new Response('bad', { status: 400 }));
    await expect(openAiCompatibleClient.complete(messages, [])).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    await expect(openAiCompatibleClient.complete(messages, [])).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('reasoning effort', () => {
  const ok = () =>
    new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });

  it('sends the configured reasoning_effort at the top level (default minimal)', async () => {
    fetchMock.mockResolvedValue(ok());
    await openAiCompatibleClient.complete(messages, []);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).reasoning_effort).toBe('minimal');
  });

  it('sends a different configured value', async () => {
    (env as { ASSISTANT_REASONING_EFFORT: string }).ASSISTANT_REASONING_EFFORT = 'high';
    try {
      fetchMock.mockResolvedValue(ok());
      await openAiCompatibleClient.complete(messages, []);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).reasoning_effort).toBe('high');
    } finally {
      (env as { ASSISTANT_REASONING_EFFORT: string }).ASSISTANT_REASONING_EFFORT = 'minimal';
    }
  });
});
