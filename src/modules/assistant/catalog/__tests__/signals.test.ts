import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  groupBy: vi.fn(),
  count: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  swallowed: vi.fn(),
  handler: vi.fn(),
  tenant: vi.fn(),
}));

// Standalone: the repository reads the demo file; Sprint Serve's version (and its
// "completed, non-removed, last 30 days" query test) lives in the main repo.
vi.mock('../signals.repository', () => ({
  findSoldQuantities: async () =>
    ((await h.groupBy()) as Array<{ menuItemId: string; _sum: { quantity: number } }>).map((r) => ({
      menuItemId: r.menuItemId,
      quantity: r._sum.quantity,
    })),
  countCompletedOrders: () => h.count(),
}));
vi.mock('../../../../config/redis', () => ({ redisConnection: { get: h.get, set: h.set } }));
vi.mock('../../../../config/tenant-context', () => ({ getCurrentTenantId: h.tenant }));
vi.mock('../../../../utils/swallowed-error', () => ({ reportSwallowed: h.swallowed }));

import { loadSignals, FAST_MIN_COVERAGE, POPULAR_MIN_ORDERS, FAST_MAX_MINUTES } from '../signals';
import { toCatalog, type CatalogItem } from '../catalog';

const item = (id: string, category: string, prepMinutes: number | null): CatalogItem =>
  ({ id, name: id, category, prepMinutes }) as CatalogItem;

const catalog = [
  item('a', 'Mains', 10),
  item('b', 'Mains', null),
  item('c', 'Coffee', 5),
  item('d', 'Coffee', null),
];

describe('loadSignals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.swallowed.mockReturnValue(h.handler);
    h.tenant.mockReturnValue('rest-1');
    h.get.mockResolvedValue(null);
    h.set.mockResolvedValue('OK');
    h.count.mockResolvedValue(42);
    h.groupBy.mockResolvedValue([
      { menuItemId: 'c', _sum: { quantity: 30 } },
      { menuItemId: 'a', _sum: { quantity: 60 } },
      { menuItemId: 'zz', _sum: { quantity: 10 } }, // not in catalog (e.g. now unavailable)
    ]);
  });

  it('exports the thresholds', () => {
    expect([POPULAR_MIN_ORDERS, FAST_MIN_COVERAGE, FAST_MAX_MINUTES]).toEqual([30, 0.5, 15]);
  });

  it('orders topItemIds by quantity and caps at 15', async () => {
    h.groupBy.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({ menuItemId: `m${i}`, _sum: { quantity: i + 1 } }))
    );
    const big = Array.from({ length: 20 }, (_, i) => item(`m${i}`, 'X', null));
    const s = await loadSignals(big);
    expect(s.topItemIds).toHaveLength(15);
    expect(s.topItemIds[0]).toBe('m19');
    expect(s.topItemIds[14]).toBe('m5');
  });

  it('computes categoryShare summing to 1 over sold categories', async () => {
    const s = await loadSignals(catalog);
    expect(s.categoryShare['Mains']).toBeCloseTo(60 / 90, 3);
    expect(s.categoryShare['Coffee']).toBeCloseTo(30 / 90, 3);
    const total = Object.values(s.categoryShare).reduce((x, y) => x + y, 0);
    expect(Math.abs(total - 1)).toBeLessThan(0.001);
    expect(s.topItemIds).toEqual(['a', 'c']); // 'zz' is not orderable
    expect(s.completedOrders30d).toBe(42);
  });

  it('computes prepCoverage from the catalog', async () => {
    expect((await loadSignals(catalog)).prepCoverage).toBe(0.5);
    expect((await loadSignals([])).prepCoverage).toBe(0);
  });

  it('caches per restaurant for an hour and serves the cached value', async () => {
    await loadSignals(catalog);
    const [key, , ex, ttl] = h.set.mock.calls[0];
    expect(key).toBe('assistant:signals:v1:rest-1');
    expect([ex, ttl]).toEqual(['EX', 3600]);

    h.groupBy.mockClear();
    h.get.mockResolvedValue(
      JSON.stringify({ completedOrders30d: 7, sold: [{ menuItemId: 'a', quantity: 5 }] })
    );
    const s = await loadSignals(catalog);
    expect(h.groupBy).not.toHaveBeenCalled();
    expect(s.completedOrders30d).toBe(7);
    expect(s.topItemIds).toEqual(['a']);
    expect(s.prepCoverage).toBe(0.5);
  });

  it('derives from the live catalog even when sales are cached', async () => {
    h.get.mockResolvedValue(
      JSON.stringify({
        completedOrders30d: 50,
        sold: [
          { menuItemId: 'a', quantity: 60 },
          { menuItemId: 'c', quantity: 30 },
        ],
      })
    );
    // 'a' became unavailable (gone from catalog); 'c' moved to Drinks.
    const live = [item('c', 'Drinks', 5), item('d', 'Coffee', null)];
    const s = await loadSignals(live);
    expect(h.groupBy).not.toHaveBeenCalled();
    expect(s.topItemIds).toEqual(['c']);
    expect(s.categoryShare).toEqual({ Drinks: 1 });
  });

  it('ignores a malformed cache entry and queries instead', async () => {
    h.get.mockResolvedValue(JSON.stringify({ completedOrders30d: 'x', topItemIds: [] }));
    const s = await loadSignals(catalog);
    expect(h.groupBy).toHaveBeenCalled();
    expect(s.completedOrders30d).toBe(42);
  });

  it('returns empty signals without querying when there is no tenant', async () => {
    h.tenant.mockReturnValue(null);
    const s = await loadSignals(catalog);
    expect(s).toEqual({
      completedOrders30d: 0,
      topItemIds: [],
      categoryShare: {},
      prepCoverage: 0.5,
    });
    expect(h.groupBy).not.toHaveBeenCalled();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('falls through to the query when redis fails', async () => {
    h.get.mockRejectedValue(new Error('down'));
    h.set.mockRejectedValue(new Error('down'));
    const s = await loadSignals(catalog);
    expect(s.completedOrders30d).toBe(42);
    expect(h.swallowed).toHaveBeenCalledWith('assistant', 'signals_cache');
    expect(h.handler).toHaveBeenCalled();
  });
});

describe('toCatalog signal fields', () => {
  it('maps preparationTime, isFeatured, calories and pairing ids', () => {
    const [x, y] = toCatalog([
      {
        name: 'Mains',
        items: [
          {
            id: 'p', name: 'P', price: 10, isAvailable: true,
            preparationTime: 12, isFeatured: true, calories: 450,
            pairings: [{ id: 'q', name: 'Q' }, { id: 'r' }, {}],
          },
          { id: 'q', name: 'Q', price: 5, isAvailable: true },
        ],
      },
    ]);
    expect(x).toMatchObject({ prepMinutes: 12, featured: true, calories: 450, pairingIds: ['q', 'r'] });
    expect(y).toMatchObject({ prepMinutes: null, featured: false, calories: null, pairingIds: [] });
  });
});
