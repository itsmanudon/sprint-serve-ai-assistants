import { getDb } from '../../../db/database';

/**
 * Live operations read for the owner assistant: open orders and how long they
 * have waited. Order numbers and counts only, no customer names or notes.
 * (Sales figures go through owner.metrics.ts.)
 */

export interface OpenOrder {
  number: number;
  status: 'NEW' | 'PREPARING' | 'READY';
  minutesSincePlaced: number;
  minutesInStatus: number;
  items: number;
}

export function openOrders(restaurantId: string, now = new Date()): OpenOrder[] {
  const rows = getDb()
    .prepare(
      `SELECT o.number, o.status, o.updated_at, o.created_at, COALESCE(SUM(oi.quantity),0) AS items
       FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.restaurant_id = ? AND o.status IN ('NEW','PREPARING','READY')
       GROUP BY o.id ORDER BY o.created_at`
    )
    .all(restaurantId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    number: Number(r.number),
    status: r.status as OpenOrder['status'],
    minutesSincePlaced: Math.max(0, Math.round((now.getTime() - Date.parse(String(r.created_at))) / 60_000)),
    minutesInStatus: Math.max(0, Math.round((now.getTime() - Date.parse(String(r.updated_at))) / 60_000)),
    items: Number(r.items),
  }));
}
