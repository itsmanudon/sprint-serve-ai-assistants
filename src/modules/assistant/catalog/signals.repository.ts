import { getDb } from '../../../db/database';
import { getCurrentTenantId } from '../../../config/tenant-context';

export const SIGNAL_WINDOW_DAYS = 30;

export interface SoldQuantity {
  menuItemId: string;
  quantity: number;
}

const windowStart = (): string => new Date(Date.now() - SIGNAL_WINDOW_DAYS * 86_400_000).toISOString();

/**
 * Quantity sold per dish over the window: only COMPLETED orders of the current
 * restaurant count; cancelled ones never do. (Sprint Serve runs the same query
 * through Prisma, which also excludes voided and rejected lines.)
 */
export async function findSoldQuantities(): Promise<SoldQuantity[]> {
  return getDb()
    .prepare(
      `SELECT oi.menu_item_id AS menuItemId, SUM(oi.quantity) AS quantity
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.restaurant_id = ? AND o.status = 'COMPLETED' AND o.created_at >= ?
       GROUP BY oi.menu_item_id`
    )
    .all(getCurrentTenantId() ?? '', windowStart()) as unknown as SoldQuantity[];
}

export const countCompletedOrders = async (): Promise<number> =>
  (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE restaurant_id = ? AND status = 'COMPLETED' AND created_at >= ?`)
      .get(getCurrentTenantId() ?? '', windowStart()) as { n: number }
  ).n;
