import { beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_FILE = ':memory:';
process.env.NODE_ENV = 'test';

import { getDb, DEMO_RESTAURANT_ID } from '../src/db/database';
import { runWithTenantId } from '../src/config/tenant-context';
import { resolvePeriod } from '../src/modules/assistant/owner/owner.periods';
import * as repo from '../src/modules/assistant/owner/owner.repository';
import { ownerTurn, unverifiedFigures, OVERDUE_MINUTES } from '../src/modules/assistant/owner/owner.service';
import type { ModelClient, ModelTurn } from '../src/modules/assistant/core/model';

// A "now" far after the seeded history, so these tests control every order in range.
const NOW = new Date('2030-03-13T08:30:00.000Z'); // Wednesday 14:00 IST
const R = DEMO_RESTAURANT_ID;

function addOrder(id: string, at: Date, status: string, lines: Array<[string, number, number]>, source = 'counter') {
  const d = getDb();
  const subtotal = lines.reduce((s, [, q, p]) => s + q * p, 0);
  const tax = Math.round(subtotal * 5) / 100;
  const n = (d.prepare('SELECT MAX(number) AS n FROM orders').get() as { n: number }).n + 1;
  d.prepare(
    `INSERT INTO orders (id, restaurant_id, number, customer_name, status, source, subtotal, tax, total, created_at, updated_at)
     VALUES (?, ?, ?, 'Guest', ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, R, n, status, source, subtotal, tax, subtotal + tax, at.toISOString(), at.toISOString());
  for (const [item, q, p] of lines)
    d.prepare('INSERT INTO order_items (order_id, menu_item_id, name, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)').run(
      id, item, item, q, p, q * p
    );
}

const minutesBefore = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeAll(() => {
  getDb();
  // Today (IST): two completed, one cancelled. Yesterday same morning: one completed.
  addOrder('t1', minutesBefore(60), 'COMPLETED', [['dal-makhani', 1, 320], ['butter-naan', 2, 60]], 'assistant');
  addOrder('t2', minutesBefore(120), 'COMPLETED', [['butter-naan', 3, 60]]);
  addOrder('t3', minutesBefore(90), 'CANCELLED', [['paneer-tikka', 5, 320]]);
  addOrder('y1', minutesBefore(24 * 60 + 60), 'COMPLETED', [['dal-makhani', 1, 320]]);
  // Open orders: one overdue NEW, one fresh PREPARING.
  addOrder('o1', minutesBefore(OVERDUE_MINUTES.NEW + 5), 'NEW', [['veg-biryani', 1, 340]]);
  addOrder('o2', minutesBefore(5), 'PREPARING', [['garlic-naan', 2, 70]]);
});

describe('periods', () => {
  it('starts "today" at local midnight and compares with yesterday up to the same time', () => {
    const { current, previous } = resolvePeriod('today', NOW);
    expect(current.from).toBe('2030-03-12T18:30:00.000Z'); // 13 Mar 00:00 IST
    expect(current.to).toBe(NOW.toISOString());
    expect(previous.from).toBe('2030-03-11T18:30:00.000Z');
    expect(previous.to).toBe('2030-03-12T08:30:00.000Z');
  });
  it('starts the week on Monday in local time', () => {
    expect(resolvePeriod('this_week', NOW).current.from).toBe('2030-03-10T18:30:00.000Z'); // Mon 11 Mar 00:00 IST
    const last = resolvePeriod('last_week', NOW).current;
    expect([last.from, last.to]).toEqual(['2030-03-03T18:30:00.000Z', '2030-03-10T18:30:00.000Z']);
  });
});

describe('owner repository', () => {
  it('counts completed orders only and reports cancellations apart', () => {
    const s = repo.salesTotals(R, resolvePeriod('today', NOW).current);
    expect(s.orders).toBe(2);
    expect(s.netSales).toBe(620);
    expect(s.revenue).toBe(651);
    expect(s.cancelledOrders).toBe(1);
    expect(s.itemsSold).toBe(6);
    expect(s.assistantOrders).toBe(1);
  });
  it('ranks dishes from completed orders and lists unsold ones with zero', () => {
    const rows = repo.dishSales(R, resolvePeriod('today', NOW).current);
    expect(rows.find((r) => r.dish === 'Butter Naan')?.quantity).toBe(5);
    expect(rows.find((r) => r.dish === 'Paneer Tikka')?.quantity).toBe(0); // only in a cancelled order
  });
  it('groups hours in local time', () => {
    const hours = repo.hourlySales(R, resolvePeriod('today', NOW).current);
    expect(hours.map((h) => h.hour)).toEqual([12, 13]); // 12:00 and 13:00 IST
  });
  it('exposes no customer names', () => {
    expect(JSON.stringify(repo.openOrders(R, NOW))).not.toContain('Guest');
  });
});

describe('figure check', () => {
  const facts = [{ tool: 'sales_summary', title: 't', data: { revenue: 12340.5, changePercent: { revenue: 12.3 } } }];
  it('accepts rupee amounts rounded to the rupee and percentages to one decimal', () => {
    expect(unverifiedFigures('Revenue was ₹12,341, up 12.3% (about 12%).', facts)).toEqual([]);
  });
  it('flags figures no tool returned', () => {
    expect(unverifiedFigures('Revenue was ₹15,000, up 40%.', facts)).toEqual(['₹15,000', '40%']);
  });
});

describe('ownerTurn', () => {
  const scripted = (turns: ModelTurn[]): ModelClient & { seen: unknown[][] } => {
    const seen: unknown[][] = [];
    return {
      seen,
      async complete(messages) {
        seen.push(structuredClone(messages));
        const t = turns.shift();
        if (!t) throw new Error('no more turns');
        return t;
      },
    };
  };
  const call = (name: string, args: unknown): ModelTurn => ({
    message: { role: 'assistant', content: null, tool_calls: [{ id: `c-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    finishReason: 'tool_calls',
  });
  const say = (text: string): ModelTurn => ({ message: { role: 'assistant', content: text }, finishReason: 'stop' });
  const ask = (q: string) => ({ messages: [{ role: 'user' as const, content: q }] });

  it('answers from tool results and returns the figures it used', async () => {
    const client = scripted([call('sales_summary', { period: 'today' }), say('Today so far: 2 orders, ₹651 revenue, up from ₹336 yesterday.')]);
    const out = await runWithTenantId(R, () => ownerTurn(ask('How are we doing today?'), client, NOW));
    expect(out.reply).toContain('₹651');
    expect(out.facts[0].tool).toBe('sales_summary');
    expect(out.unverifiedFigures).toEqual([]);
    const toolMsg = (client.seen[1] as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content).current.revenue).toBe(651);
  });

  it('flags a made-up figure instead of hiding it', async () => {
    const client = scripted([call('sales_summary', { period: 'today' }), say('Revenue today is ₹9,999.')]);
    const out = await runWithTenantId(R, () => ownerTurn(ask('Revenue today?'), client, NOW));
    expect(out.unverifiedFigures).toEqual(['₹9,999']);
  });

  it('finds the overdue order', async () => {
    const client = scripted([call('orders_needing_attention', {}), say('One order is overdue.')]);
    const out = await runWithTenantId(R, () => ownerTurn(ask('Anything stuck?'), client, NOW));
    const data = out.facts[0].data as { open: number; overdue: number };
    expect(data.overdue).toBeGreaterThanOrEqual(1);
  });

  it('tells the model when arguments are invalid, and carries on', async () => {
    const client = scripted([call('sales_summary', { period: 'forever' }), say('Which period do you mean?')]);
    const out = await runWithTenantId(R, () => ownerTurn(ask('Sales?'), client, NOW));
    const toolMsg = (client.seen[1] as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
    expect(JSON.parse(toolMsg!.content)).toEqual({ error: 'Invalid arguments for this tool.' });
    expect(out.facts).toEqual([]);
  });

  it('offers no tool that can change data', async () => {
    const { OWNER_TOOLS } = await import('../src/modules/assistant/owner/owner.prompt');
    const names = OWNER_TOOLS.map((t) => t.function.name);
    expect(names.every((n) => !/(set|update|delete|create|place|cancel)/.test(n))).toBe(true);
  });
});
