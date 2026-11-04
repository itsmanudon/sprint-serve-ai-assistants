import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_FILE = ':memory:';
  process.env.NODE_ENV = 'test';
});

import { getDb, DEMO_RESTAURANT_ID } from '../src/db/database';
import { runWithTenantId } from '../src/config/tenant-context';
import { placeOrder, setStatus } from '../src/modules/orders/orders.service';
import { setItemAvailability, getMenuForCustomer } from '../src/modules/menu/menu.service';
import { quoteTakeawayOrder } from '../src/modules/takeaway/takeaway.service';

const inDemo = <T>(fn: () => Promise<T>) => runWithTenantId(DEMO_RESTAURANT_ID, fn);
const cart = [
  { menuItemId: 'dal-makhani', variantId: 'dal-makhani-full', quantity: 1 },
  { menuItemId: 'butter-naan', quantity: 2 },
];

beforeAll(() => getDb());

describe('quote', () => {
  it('prices from the database with GST', async () => {
    const q = await inDemo(() => quoteTakeawayOrder(cart));
    expect([q.subtotal, q.tax, q.total]).toEqual([440, 22, 462]);
  });
  it('requires a size for dishes that have sizes', async () => {
    await expect(inDemo(() => quoteTakeawayOrder([{ menuItemId: 'dal-makhani', quantity: 1 }]))).rejects.toMatchObject({ status: 400 });
  });
});

describe('checkout', () => {
  it('creates one order per idempotency key', async () => {
    const a = await inDemo(() => placeOrder({ name: 'Asha', items: cart, quotedTotal: 462, idempotencyKey: 'key-00000001' }));
    const b = await inDemo(() => placeOrder({ name: 'Asha', items: cart, quotedTotal: 462, idempotencyKey: 'key-00000001' }));
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.order.id).toBe(a.order.id);
    expect(a.order.status).toBe('NEW');
  });
  it('refuses a total that changed since the guest saw it', async () => {
    await expect(
      inDemo(() => placeOrder({ name: 'Asha', items: cart, quotedTotal: 400, idempotencyKey: 'key-00000002' }))
    ).rejects.toMatchObject({ status: 409, code: 'QUOTE_TOTAL_CHANGED', total: 462 });
  });
  it('moves through kitchen states in order only', async () => {
    const { order } = await inDemo(() => placeOrder({ name: 'B', items: cart, quotedTotal: 462, idempotencyKey: 'key-00000003' }));
    await expect(inDemo(() => setStatus(order.id, 'COMPLETED'))).rejects.toMatchObject({ status: 409 });
    await inDemo(() => setStatus(order.id, 'PREPARING'));
    await inDemo(() => setStatus(order.id, 'READY'));
    const done = await inDemo(() => setStatus(order.id, 'COMPLETED'));
    expect(done.status).toBe('COMPLETED');
  });
});

describe('availability', () => {
  it('hides an unavailable dish from the guest menu and refuses to quote it', async () => {
    await inDemo(() => setItemAvailability('butter-naan', false));
    const menu = (await inDemo(() => getMenuForCustomer())) as Array<{ items: Array<{ id: string }> }>;
    expect(menu.flatMap((c) => c.items).some((i) => i.id === 'butter-naan')).toBe(false);
    await expect(inDemo(() => quoteTakeawayOrder(cart))).rejects.toMatchObject({ status: 409 });
    await inDemo(() => setItemAvailability('butter-naan', true));
  });
});
