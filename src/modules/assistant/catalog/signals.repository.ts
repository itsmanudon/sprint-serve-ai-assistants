import { demoRestaurant } from '../../menu/demo-data';

export const SIGNAL_WINDOW_DAYS = 30;

export interface SoldQuantity {
  menuItemId: string;
  quantity: number;
}

/**
 * Quantity sold per dish over the last 30 days. Sprint Serve aggregates the
 * restaurant's own completed, non-removed orders; the demo file carries a
 * synthetic equivalent.
 */
export async function findSoldQuantities(): Promise<SoldQuantity[]> {
  return demoRestaurant().sales.sold.map((s) => ({ ...s }));
}

export const countCompletedOrders = async (): Promise<number> =>
  demoRestaurant().sales.completedOrders30d;
