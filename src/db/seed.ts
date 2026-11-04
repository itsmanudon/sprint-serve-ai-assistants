import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Seeds the demo restaurant: the menu from data/demo-restaurant.json (copied
 * from Sprint Serve's development seed) and ~45 days of SYNTHETIC order history
 * so sales signals and the owner's reports have something real to read.
 * Deterministic (fixed random seed), relative to the moment it runs.
 */

interface SeedItem {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  gstPercent?: number;
  isVeg?: boolean;
  containsEgg?: boolean;
  spicyLevel?: string;
  preparationTime?: number | null;
  isFeatured?: boolean;
  isAvailable?: boolean;
  cuisine?: string | null;
  servingSize?: string | null;
  allergens?: string[];
  variants?: Array<{ id: string; name: string; price: number; isDefault?: boolean; isAvailable?: boolean }>;
  pairings?: Array<{ id: string }>;
}
interface SeedFile {
  id: string;
  name: string;
  chefNotes: string | null;
  categories: Array<{ id: string; name: string; assistantRole: string | null; items: SeedItem[] }>;
  /** Relative popularity used only to generate synthetic history. */
  popularity?: Record<string, number>;
}

const HISTORY_DAYS = 45;

/** mulberry32: small deterministic PRNG so every reset produces the same history. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function seedIfEmpty(db: DatabaseSync, now = new Date()): void {
  const has = db.prepare('SELECT COUNT(*) AS n FROM restaurants').get() as { n: number };
  if (has.n > 0) return;
  const file = process.env.DEMO_RESTAURANT_FILE ?? resolve(process.cwd(), 'data/demo-restaurant.json');
  const data = JSON.parse(readFileSync(file, 'utf8')) as SeedFile;

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO restaurants (id, name, chef_notes) VALUES (?, ?, ?)').run(
      data.id,
      data.name,
      data.chefNotes
    );
    const insCat = db.prepare(
      'INSERT INTO categories (id, restaurant_id, name, assistant_role, sort_order) VALUES (?, ?, ?, ?, ?)'
    );
    const insItem = db.prepare(`INSERT INTO menu_items (id, restaurant_id, category_id, name, description, price,
      gst_percent, is_veg, contains_egg, spicy_level, preparation_time, is_featured, is_available, cuisine,
      serving_size, allergens, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insVariant = db.prepare(
      'INSERT INTO menu_item_variants (id, menu_item_id, name, price, is_default, is_available, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insPair = db.prepare('INSERT INTO menu_item_pairings (menu_item_id, paired_item_id) VALUES (?, ?)');
    const pairs: Array<[string, string]> = [];
    data.categories.forEach((c, ci) => {
      insCat.run(c.id, data.id, c.name, c.assistantRole, ci);
      c.items.forEach((i, ii) => {
        insItem.run(
          i.id, data.id, c.id, i.name, i.description ?? null, i.price, i.gstPercent ?? 5,
          i.isVeg ? 1 : 0, i.containsEgg ? 1 : 0, i.spicyLevel ?? 'NONE', i.preparationTime ?? null,
          i.isFeatured ? 1 : 0, i.isAvailable === false ? 0 : 1, i.cuisine ?? null, i.servingSize ?? null,
          JSON.stringify(i.allergens ?? []), ii
        );
        (i.variants ?? []).forEach((v, vi) =>
          insVariant.run(v.id, i.id, v.name, v.price, v.isDefault ? 1 : 0, v.isAvailable === false ? 0 : 1, vi)
        );
        for (const p of i.pairings ?? []) pairs.push([i.id, p.id]);
      });
    });
    for (const [a, b] of pairs) insPair.run(a, b);
    seedHistory(db, data, now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function seedHistory(db: DatabaseSync, data: SeedFile, now: Date): void {
  const random = rng(20261104);
  const items = data.categories.flatMap((c) =>
    c.items.map((i) => ({
      ...i,
      unit: i.variants?.find((v) => v.isDefault)?.price ?? i.price,
      variantName: i.variants?.find((v) => v.isDefault)?.name ?? null,
      weight: data.popularity?.[i.id] ?? 1,
    }))
  );
  const totalWeight = items.reduce((s, i) => s + i.weight, 0);
  const pick = () => {
    let r = random() * totalWeight;
    for (const i of items) if ((r -= i.weight) <= 0) return i;
    return items[items.length - 1];
  };
  // Lunch and dinner peaks, IST hours.
  const hours = [11, 12, 12, 13, 13, 13, 14, 14, 15, 17, 18, 19, 19, 20, 20, 20, 21, 21, 22];
  const insOrder = db.prepare(`INSERT INTO orders (id, restaurant_id, number, customer_name, status, source,
    subtotal, tax, total, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insLine = db.prepare(`INSERT INTO order_items (order_id, menu_item_id, name, variant_name, quantity,
    unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const IST = 330 * 60_000;
  let number = 0;
  const today = new Date(Math.floor((now.getTime() + IST) / 86_400_000) * 86_400_000 - IST); // IST midnight, as UTC

  for (let d = HISTORY_DAYS; d >= 0; d--) {
    const dayStart = today.getTime() - d * 86_400_000;
    const weekday = new Date(dayStart + IST).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    // Gentle growth: recent weeks a little busier than older ones.
    const growth = 1 + (HISTORY_DAYS - d) * 0.006;
    const count = Math.round((weekend ? 17 : 11) * growth + random() * 5);
    for (let k = 0; k < count; k++) {
      const hour = hours[Math.floor(random() * hours.length)];
      const at = dayStart + hour * 3_600_000 + Math.floor(random() * 3_600_000);
      if (at > now.getTime() - 60 * 60_000) continue; // nothing in the last hour: those are live orders
      const lines = new Map<string, { item: (typeof items)[number]; qty: number }>();
      const n = 1 + Math.floor(random() * 3);
      for (let j = 0; j < n; j++) {
        const item = pick();
        const cur = lines.get(item.id);
        lines.set(item.id, { item, qty: (cur?.qty ?? 0) + 1 + (random() < 0.25 ? 1 : 0) });
      }
      let subtotal = 0;
      let tax = 0;
      for (const { item, qty } of lines.values()) {
        const line = round2(item.unit * qty);
        subtotal += line;
        tax += round2((line * (item.gstPercent ?? 5)) / 100);
      }
      const cancelled = random() < 0.04;
      const id = `hist-${++number}`;
      const createdAt = new Date(at).toISOString();
      const doneAt = new Date(at + (15 + Math.floor(random() * 25)) * 60_000).toISOString();
      insOrder.run(
        id, data.id, number, 'Guest', cancelled ? 'CANCELLED' : 'COMPLETED', random() < 0.3 ? 'assistant' : 'counter',
        round2(subtotal), round2(tax), round2(subtotal + tax), createdAt, cancelled ? createdAt : doneAt,
        cancelled ? null : doneAt
      );
      for (const { item, qty } of lines.values())
        insLine.run(id, item.id, item.name, item.variantName, qty, item.unit, round2(item.unit * qty));
    }
  }

  // Three live orders so "orders needing attention" has something to find.
  const live: Array<[string, number, string[]]> = [
    ['NEW', 14, ['paneer-tikka', 'garlic-naan']],
    ['PREPARING', 38, ['butter-chicken', 'butter-naan', 'mango-lassi']],
    ['READY', 6, ['veg-biryani']],
  ];
  for (const [status, minsAgo, ids] of live) {
    const at = new Date(now.getTime() - minsAgo * 60_000).toISOString();
    const chosen = ids.map((id) => items.find((i) => i.id === id)).filter((i): i is (typeof items)[number] => !!i);
    const subtotal = round2(chosen.reduce((s, i) => s + i.unit, 0));
    const tax = round2(chosen.reduce((s, i) => s + round2((i.unit * (i.gstPercent ?? 5)) / 100), 0));
    const id = `live-${++number}`;
    insOrder.run(id, data.id, number, 'Guest', status, 'counter', subtotal, tax, round2(subtotal + tax), at, at, null);
    for (const i of chosen) insLine.run(id, i.id, i.name, i.variantName, 1, i.unit, i.unit);
  }
}
