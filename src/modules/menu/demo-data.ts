import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The one demo restaurant, loaded from data/demo-restaurant.json (synthetic data). */
export interface DemoItem {
  id: string;
  name: string;
  price: number;
  gstPercent: number;
  isAvailable: boolean;
  variants: Array<{ id: string; name: string; price: number; isAvailable: boolean }>;
  options: Array<{ id: string; groupId: string; additionalPrice: number; isAvailable?: boolean }>;
  [key: string]: unknown;
}

export interface DemoRestaurant {
  id: string;
  name: string;
  chefNotes: string | null;
  orderingOpen: boolean;
  sales: { completedOrders30d: number; sold: Array<{ menuItemId: string; quantity: number }> };
  categories: Array<{ id: string; name: string; assistantRole: string | null; items: DemoItem[] }>;
}

const file = process.env.DEMO_RESTAURANT_FILE ?? resolve(process.cwd(), 'data/demo-restaurant.json');
let cached: DemoRestaurant | null = null;

export function demoRestaurant(): DemoRestaurant {
  cached ??= JSON.parse(readFileSync(file, 'utf8')) as DemoRestaurant;
  return cached;
}

export function demoItem(id: string): DemoItem | undefined {
  for (const c of demoRestaurant().categories) {
    const hit = c.items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return undefined;
}
