import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@prisma/client', () => ({ Prisma: { Decimal: { isDecimal: () => false } } }));
const envMock = vi.hoisted(() => ({
  ASSISTANT_ENABLED: true,
  ASSISTANT_MODEL_API_KEY: 'test-key-123',
  ASSISTANT_MODEL_BASE_URL: 'https://model.invalid/v1',
  ASSISTANT_MODEL: 'muse-spark-1.3',
  ASSISTANT_MODEL_TIMEOUT_MS: 1000,
  ASSISTANT_DEBUG_USAGE: false,
  NODE_ENV: 'development',
}));
vi.mock('../../../../config/env', () => ({ env: envMock }));
const info = vi.hoisted(() => vi.fn());
vi.mock('../../../../config/logger', () => ({ logger: { warn: vi.fn(), info, error: vi.fn() } }));
vi.mock('@sentry/node', () => ({}));
vi.mock('../../../../config/tenant-context', () => ({ getCurrentTenantId: () => 'tenant-1' }));
const getMenuForCustomer = vi.fn();
vi.mock('../../../menu/menu.service', () => ({ getMenuForCustomer: () => getMenuForCustomer() }));
vi.mock('../../../../utils/swallowed-error', () => ({ reportSwallowed: () => vi.fn() }));
const quoteTakeawayOrder = vi.fn();
vi.mock('../../../takeaway/takeaway.service', () => ({
  quoteTakeawayOrder: (...args: unknown[]) => quoteTakeawayOrder(...args),
}));

vi.mock('../../catalog/profile.repository', () => ({ findProfileSource: async () => ({ name: 'T', chefNotes: null }) }));
vi.mock('../../catalog/signals.repository', () => ({ findSoldQuantities: async () => [], countCompletedOrders: async () => 0 }));
vi.mock('../../../../config/redis', () => ({ redisConnection: { get: async () => null, set: async () => 'OK' } }));

import { customerTurn } from '../customer.service';
import { assistantUnavailable, type ModelClient, type ModelTurn } from '../../core/model';

const MENU = [
  { name: 'Mains', items: [{ id: 'paneer', name: 'Chilli Paneer', price: 280, isVeg: true, spicyLevel: 'HOT' }] },
];
const usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } };
const toolCall = (name: string, args: unknown): ModelTurn['message'] => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const clientOf = (steps: Array<ModelTurn['message'] | Error>): ModelClient => ({
  complete: vi.fn(async () => {
    const s = steps.shift()!;
    if (s instanceof Error) throw s;
    return { message: s, finishReason: 'stop', usage, latencyMs: 30 } as ModelTurn;
  }),
});
const ask = { messages: [{ role: 'user' as const, content: 'secret customer words' }] };
const propose = toolCall('propose_meal', {
  reply: 'secret reply',
  constraints: {},
  items: [{ menuItemId: 'paneer', quantity: 1 }],
});
const turnLogs = () => info.mock.calls.filter((c) => c[0] === 'assistant.turn');

beforeEach(() => {
  info.mockClear();
  envMock.ASSISTANT_DEBUG_USAGE = false;
  envMock.NODE_ENV = 'development';
  getMenuForCustomer.mockResolvedValue(MENU);
  quoteTakeawayOrder.mockResolvedValue({ subtotal: 280, tax: 14, total: 294 });
});

describe('assistant.turn metrics', () => {
  it('logs one content-free line per proposal turn', async () => {
    await customerTurn(ask, clientOf([propose]));
    expect(turnLogs()).toHaveLength(1);
    const fields = turnLogs()[0][1];
    expect(fields).toEqual({
      side: 'customer',
      restaurantId: 'tenant-1',
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 10,
      cachedTokens: 40,
      latencyMs: 30,
      maxCallLatencyMs: 30,
      outcome: 'proposal',
    });
    expect(JSON.stringify(fields)).not.toMatch(/secret/);
  });

  it('logs outcome clarify for a plain-text reply', async () => {
    await customerTurn(ask, clientOf([{ role: 'assistant', content: 'secret question?' }]));
    expect(turnLogs()[0][1]).toMatchObject({ outcome: 'clarify', modelCalls: 1 });
  });

  it('logs outcome truncated when a text reply was cut off by the token cap', async () => {
    const client: ModelClient = {
      complete: vi.fn(
        async () =>
          ({ message: { role: 'assistant', content: 'half a sen' }, finishReason: 'length', usage, latencyMs: 30 }) as ModelTurn
      ),
    };
    const r = await customerTurn(ask, client);
    expect(r.proposal).toBeNull();
    expect(r.reply).toBe('Could you tell me a little more about what you would like?');
    expect(turnLogs()[0][1]).toMatchObject({ outcome: 'truncated', modelCalls: 1 });
  });

  it('logs outcome unavailable with partial usage when the model fails mid-turn', async () => {
    const search = toolCall('search_menu', {});
    await expect(customerTurn(ask, clientOf([search, assistantUnavailable()]))).rejects.toMatchObject({
      status: 503,
    });
    expect(turnLogs()).toHaveLength(1);
    expect(turnLogs()[0][1]).toMatchObject({ outcome: 'unavailable', modelCalls: 1, inputTokens: 100 });
  });

  it('logs outcome exhausted when the call cap passes without a proposal', async () => {
    const search = toolCall('search_menu', {});
    await expect(customerTurn(ask, clientOf(Array(6).fill(search)))).rejects.toMatchObject({ status: 503 });
    expect(turnLogs()).toHaveLength(1);
    expect(turnLogs()[0][1]).toMatchObject({ outcome: 'exhausted', modelCalls: 6 });
  });
});

describe('debug usage readout', () => {
  it('is present with the flag in development', async () => {
    envMock.ASSISTANT_DEBUG_USAGE = true;
    const r = await customerTurn(ask, clientOf([propose]));
    expect(r.debug?.usage).toMatchObject({ modelCalls: 1, inputTokens: 100, cachedTokens: 40 });
  });
  it('is absent with the flag when NODE_ENV is production', async () => {
    envMock.ASSISTANT_DEBUG_USAGE = true;
    envMock.NODE_ENV = 'production';
    const r = await customerTurn(ask, clientOf([propose]));
    expect(r).not.toHaveProperty('debug');
  });
  it('is absent without the flag', async () => {
    const r = await customerTurn(ask, clientOf([propose]));
    expect(r).not.toHaveProperty('debug');
  });
});
