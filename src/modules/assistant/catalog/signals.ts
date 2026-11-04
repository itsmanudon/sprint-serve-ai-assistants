import { redisConnection } from '../../../config/redis';
import { getCurrentTenantId } from '../../../config/tenant-context';
import { reportSwallowed } from '../../../utils/swallowed-error';
import type { CatalogItem } from './catalog';
import { countCompletedOrders, findSoldQuantities, type SoldQuantity } from './signals.repository';

/**
 * Per-restaurant facts the chef persona may lean on. All derive from this
 * restaurant's own completed, non-removed orders and its own menu records.
 */
export interface RestaurantSignals {
  completedOrders30d: number;
  /** Up to 15 menuItemIds by quantity sold, last 30 days. */
  topItemIds: string[];
  /** Category name -> share of quantity sold, 0..1. */
  categoryShare: Record<string, number>;
  /** Share of available dishes with a recorded preparation time, 0..1. */
  prepCoverage: number;
}

/** Fewer completed orders than this and "Popular here" is not trustworthy. */
export const POPULAR_MIN_ORDERS = 30;
/** Below this share of dishes with prep times, "Ready fast" is not offered. */
export const FAST_MIN_COVERAGE = 0.5;
export const FAST_MAX_MINUTES = 15;

const TOP_N = 15;
const CACHE_TTL_SECONDS = 3600;

interface SalesData {
  completedOrders30d: number;
  sold: SoldQuantity[];
}

const cacheKey = (restaurantId: string) => `assistant:signals:v1:${restaurantId}`;

const isSalesData = (v: unknown): v is SalesData => {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.completedOrders30d === 'number' &&
    Array.isArray(d.sold) &&
    d.sold.every(
      (s) =>
        s &&
        typeof (s as SoldQuantity).menuItemId === 'string' &&
        typeof (s as SoldQuantity).quantity === 'number'
    )
  );
};

/** Derive everything catalog-dependent from raw sales and the live catalog. */
function derive(data: SalesData, catalog: CatalogItem[]): RestaurantSignals {
  const categoryOf = new Map(catalog.map((i) => [i.id, i.category]));
  const ranked = data.sold
    .filter((s) => s.quantity > 0 && categoryOf.has(s.menuItemId))
    .sort((a, b) => b.quantity - a.quantity);
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const s of ranked) {
    const cat = categoryOf.get(s.menuItemId) as string;
    byCategory[cat] = (byCategory[cat] ?? 0) + s.quantity;
    total += s.quantity;
  }
  const categoryShare: Record<string, number> = {};
  if (total > 0) for (const [cat, q] of Object.entries(byCategory)) categoryShare[cat] = q / total;
  const withPrep = catalog.filter((i) => i.prepMinutes !== null).length;
  return {
    completedOrders30d: data.completedOrders30d,
    topItemIds: ranked.slice(0, TOP_N).map((s) => s.menuItemId),
    categoryShare,
    prepCoverage: catalog.length ? withPrep / catalog.length : 0,
  };
}

/**
 * Signals for the current tenant. Only the raw sales aggregation is cached (one
 * hour); ranking, category share and prep coverage are derived from the live
 * catalog on every call so a menu edit is never hidden by the cache.
 */
export async function loadSignals(catalog: CatalogItem[]): Promise<RestaurantSignals> {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) return derive({ completedOrders30d: 0, sold: [] }, catalog);

  let data: SalesData | null = null;
  try {
    const raw = await redisConnection.get(cacheKey(restaurantId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isSalesData(parsed)) data = parsed;
    }
  } catch (err) {
    reportSwallowed('assistant', 'signals_cache')(err);
  }
  if (!data) {
    const [sold, completedOrders30d] = await Promise.all([
      findSoldQuantities(),
      countCompletedOrders(),
    ]);
    data = { completedOrders30d, sold };
    try {
      await redisConnection.set(
        cacheKey(restaurantId),
        JSON.stringify(data),
        'EX',
        CACHE_TTL_SECONDS
      );
    } catch (err) {
      reportSwallowed('assistant', 'signals_cache')(err);
    }
  }
  return derive(data, catalog);
}
