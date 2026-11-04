import { z } from 'zod';
import { getDb } from '../../../db/database';
import { PERIODS, resolvePeriod, type Period, type Range } from './owner.periods';

/**
 * The owner assistant's only window onto the data: a fixed registry of metrics
 * and dimensions, shaped like Sprint Serve's insights registry (id, unit,
 * permission tag, allowed dimensions). The model chooses from these lists; the
 * server builds the SQL from whitelisted fragments and always binds the
 * restaurant from the session, never from model arguments. Nothing here can
 * return a customer's name, phone number or free-text note.
 */

export const PERMISSION_TAGS = ['sales.view', 'orders.view', 'menu.view', 'ops.view'] as const;
export type PermissionTag = (typeof PERMISSION_TAGS)[number];

export const DIMENSIONS = ['day', 'weekday', 'hour', 'channel', 'item', 'category'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

type Grain = 'order' | 'item';
interface MetricDef {
  id: string;
  label: string;
  unit: 'INR' | 'COUNT' | 'PERCENT' | 'MINUTES';
  tag: PermissionTag;
  grain: Grain;
  description: string;
  /** SQL aggregate over `o` (orders) and, for item grain, `oi` (order lines). */
  sql: string;
  /** Rows counted: completed orders unless stated. */
  status?: 'COMPLETED' | 'CANCELLED';
}

const COMPLETED_MIN = `(julianday(o.completed_at) - julianday(o.created_at)) * 1440`;

export const METRICS: readonly MetricDef[] = [
  { id: 'revenue', label: 'Revenue (incl. GST)', unit: 'INR', tag: 'sales.view', grain: 'order', sql: 'SUM(o.total)', description: 'What customers paid for completed orders, GST included.' },
  { id: 'net_sales', label: 'Net sales (before GST)', unit: 'INR', tag: 'sales.view', grain: 'order', sql: 'SUM(o.subtotal)', description: 'Completed-order sales before GST.' },
  { id: 'gst_collected', label: 'GST collected', unit: 'INR', tag: 'sales.view', grain: 'order', sql: 'SUM(o.tax)', description: 'GST on completed orders.' },
  { id: 'orders', label: 'Completed orders', unit: 'COUNT', tag: 'orders.view', grain: 'order', sql: 'COUNT(*)', description: 'Number of completed orders.' },
  { id: 'avg_order_value', label: 'Average order value', unit: 'INR', tag: 'sales.view', grain: 'order', sql: 'SUM(o.total) * 1.0 / COUNT(*)', description: 'Revenue per completed order, GST included.' },
  { id: 'cancelled_orders', label: 'Cancelled orders', unit: 'COUNT', tag: 'orders.view', grain: 'order', sql: 'COUNT(*)', status: 'CANCELLED', description: 'Orders cancelled before they were made.' },
  { id: 'assistant_orders', label: 'Orders via meal assistant', unit: 'COUNT', tag: 'orders.view', grain: 'order', sql: "SUM(o.source = 'assistant')", description: 'Completed orders the guest built with "Help me choose".' },
  { id: 'assistant_share', label: 'Share of orders via assistant', unit: 'PERCENT', tag: 'orders.view', grain: 'order', sql: "SUM(o.source = 'assistant') * 100.0 / COUNT(*)", description: 'Percent of completed orders built with the assistant.' },
  { id: 'avg_fulfilment_minutes', label: 'Average minutes from order to pickup', unit: 'MINUTES', tag: 'ops.view', grain: 'order', sql: `AVG(${COMPLETED_MIN})`, description: 'Average time from placing to completing an order.' },
  { id: 'slow_orders', label: 'Orders slower than 30 minutes', unit: 'COUNT', tag: 'ops.view', grain: 'order', sql: `SUM(${COMPLETED_MIN} > 30)`, description: 'Completed orders that took more than 30 minutes.' },
  { id: 'items_sold', label: 'Items sold', unit: 'COUNT', tag: 'menu.view', grain: 'item', sql: 'SUM(oi.quantity)', description: 'Dish quantity sold in completed orders.' },
  { id: 'item_sales', label: 'Dish sales (before GST)', unit: 'INR', tag: 'menu.view', grain: 'item', sql: 'SUM(oi.line_total)', description: 'Line value of dishes sold, before GST.' },
];
const METRIC_IDS = METRICS.map((m) => m.id) as [string, ...string[]];

/** Which dimensions each grain may be split by, and the tag a dimension needs. */
const DIMENSION_DEF: Record<Dimension, { grains: Grain[]; tag: PermissionTag; label: string }> = {
  day: { grains: ['order', 'item'], tag: 'sales.view', label: 'Day' },
  weekday: { grains: ['order', 'item'], tag: 'sales.view', label: 'Day of week' },
  hour: { grains: ['order', 'item'], tag: 'sales.view', label: 'Hour of day' },
  channel: { grains: ['order'], tag: 'orders.view', label: 'Channel' },
  item: { grains: ['item'], tag: 'menu.view', label: 'Dish' },
  category: { grains: ['item'], tag: 'menu.view', label: 'Category' },
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LOCAL = `'+330 minutes'`;
const DIM_SQL: Record<Dimension, string> = {
  day: `date(o.created_at, ${LOCAL})`,
  weekday: `CAST(strftime('%w', o.created_at, ${LOCAL}) AS INTEGER)`,
  hour: `CAST(strftime('%H', o.created_at, ${LOCAL}) AS INTEGER)`,
  channel: 'o.source',
  item: 'm.name',
  category: 'c.name',
};

export const metricQueryArgs = z.object({
  metrics: z.array(z.enum(METRIC_IDS)).min(1).max(4),
  period: z.enum(PERIODS),
  dimension: z.enum(DIMENSIONS).optional(),
  compare: z.boolean().default(true),
  sort_by: z.enum(METRIC_IDS).optional(),
  order: z.enum(['top', 'bottom']).default('top'),
  limit: z.number().int().min(1).max(24).default(10),
});
export type MetricQuery = z.infer<typeof metricQueryArgs>;

export class ScopeError extends Error {
  status = 403;
}

// Control, zero-width, bidi-override and line/paragraph separator characters.
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g');

/** Text the restaurant typed (dish and category names) is data: clean and bound it. */
export function cleanLabel(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, ' ')
    .replace(/[<>`{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

const round = (n: number, unit: MetricDef['unit']) =>
  unit === 'COUNT' ? Math.round(n) : Math.round(n * (unit === 'INR' ? 100 : 10)) / (unit === 'INR' ? 100 : 10);
const changePct = (now: number, before: number): number | null =>
  before ? Math.round(((now - before) / before) * 1000) / 10 : null;

function dimKey(dim: Dimension | undefined, raw: unknown): string {
  if (dim === 'weekday') return WEEKDAYS[Number(raw)] ?? String(raw);
  if (dim === 'hour') return `${String(raw).padStart(2, '0')}:00`;
  if (dim === 'channel') return raw === 'assistant' ? 'Meal assistant' : 'Counter';
  return cleanLabel(raw);
}

/** One metric over one range, optionally split by a dimension. Key → value. */
function runMetric(restaurantId: string, m: MetricDef, range: Range, dim?: Dimension): Map<string, number> {
  const status = m.status ?? 'COMPLETED';
  const out = new Map<string, number>();
  let sql: string;
  // Dish and category splits start from the menu, so dishes that sold nothing appear with 0.
  if (m.grain === 'item' && (dim === 'item' || dim === 'category')) {
    sql = `SELECT ${DIM_SQL[dim]} AS k,
             COALESCE(${m.sql.replace(/oi\./g, 'x.')}, 0) AS v
           FROM menu_items m JOIN categories c ON c.id = m.category_id
           LEFT JOIN (SELECT oi.menu_item_id, oi.quantity, oi.line_total FROM order_items oi
                      JOIN orders o ON o.id = oi.order_id
                      WHERE o.restaurant_id = :r AND o.status = :s AND o.created_at >= :f AND o.created_at < :t) x
             ON x.menu_item_id = m.id
           WHERE m.restaurant_id = :r AND (m.is_available = 1 OR x.menu_item_id IS NOT NULL)
           GROUP BY k`;
  } else {
    const from =
      m.grain === 'item'
        ? 'order_items oi JOIN orders o ON o.id = oi.order_id JOIN menu_items m ON m.id = oi.menu_item_id JOIN categories c ON c.id = m.category_id'
        : 'orders o';
    sql = `SELECT ${dim ? DIM_SQL[dim] : "'total'"} AS k, ${m.sql} AS v FROM ${from}
           WHERE o.restaurant_id = :r AND o.status = :s AND o.created_at >= :f AND o.created_at < :t
           GROUP BY k`;
  }
  const rows = getDb().prepare(sql).all({ r: restaurantId, s: status, f: range.from, t: range.to }) as Array<{ k: unknown; v: number | null }>;
  for (const row of rows) out.set(dimKey(dim, row.k), round(Number(row.v ?? 0), m.unit));
  return out;
}

export interface MetricResult {
  period: string;
  comparedWith?: string;
  dimension?: string;
  metrics: Array<{ id: string; label: string; unit: string }>;
  totals?: Record<string, { value: number; previous?: number; changePercent?: number | null }>;
  rows?: Array<{ key: string; values: Record<string, { value: number; previous?: number; changePercent?: number | null }> }>;
  rowsShown?: number;
  rowsTotal?: number;
}

export function queryMetrics(
  restaurantId: string,
  q: MetricQuery,
  scope: ReadonlySet<PermissionTag>,
  now: Date = new Date()
): MetricResult {
  const defs = q.metrics.map((id) => METRICS.find((m) => m.id === id)!);
  for (const d of defs) if (!scope.has(d.tag)) throw new ScopeError(`Not permitted: ${d.label}.`);
  if (q.dimension) {
    const dd = DIMENSION_DEF[q.dimension];
    if (!scope.has(dd.tag)) throw new ScopeError(`Not permitted: split by ${dd.label}.`);
    const bad = defs.find((d) => !dd.grains.includes(d.grain));
    if (bad) throw Object.assign(new Error(`${bad.label} cannot be split by ${dd.label.toLowerCase()}.`), { status: 400 });
  }
  const { current, previous } = resolvePeriod(q.period as Period, now);
  const cur = defs.map((d) => runMetric(restaurantId, d, current, q.dimension));
  const prev = q.compare ? defs.map((d) => runMetric(restaurantId, d, previous, q.dimension)) : null;
  const cell = (i: number, key: string) => {
    const value = cur[i].get(key) ?? 0;
    if (!prev) return { value };
    const before = prev[i].get(key) ?? 0;
    return { value, previous: before, changePercent: changePct(value, before) };
  };
  const base: MetricResult = {
    period: current.label,
    ...(prev && { comparedWith: previous.label }),
    metrics: defs.map((d) => ({ id: d.id, label: d.label, unit: d.unit })),
  };
  if (!q.dimension) {
    return { ...base, totals: Object.fromEntries(defs.map((d, i) => [d.id, cell(i, 'total')])) };
  }
  const keys = new Set<string>(cur.flatMap((m) => [...m.keys()]));
  const sortIdx = Math.max(0, defs.findIndex((d) => d.id === (q.sort_by ?? q.metrics[0])));
  const chronological = q.dimension === 'day' || q.dimension === 'hour';
  const rows = [...keys]
    .map((key) => ({ key, values: Object.fromEntries(defs.map((d, i) => [d.id, cell(i, key)])) }))
    .sort((a, b) => {
      if (chronological && !q.sort_by) return a.key.localeCompare(b.key);
      const va = a.values[defs[sortIdx].id].value;
      const vb = b.values[defs[sortIdx].id].value;
      return (q.order === 'top' ? vb - va : va - vb) || a.key.localeCompare(b.key);
    });
  return {
    ...base,
    dimension: DIMENSION_DEF[q.dimension].label,
    rows: rows.slice(0, chronological && !q.sort_by ? 31 : q.limit),
    rowsShown: Math.min(rows.length, chronological && !q.sort_by ? 31 : q.limit),
    rowsTotal: rows.length,
  };
}

/** The catalog the planner sees: ids, meaning and allowed splits, within the caller's scope. */
export function metricCatalog(scope: ReadonlySet<PermissionTag>): string {
  const metrics = METRICS.filter((m) => scope.has(m.tag)).map(
    (m) =>
      `- ${m.id} (${m.unit}): ${m.description} Split by: ${DIMENSIONS.filter((d) => DIMENSION_DEF[d].grains.includes(m.grain) && scope.has(DIMENSION_DEF[d].tag)).join(', ')}.`
  );
  return metrics.join('\n');
}
