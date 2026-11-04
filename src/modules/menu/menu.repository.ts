import { DEMO_RESTAURANT_ID, getDb } from '../../db/database';

export interface ItemRow {
  id: string;
  category_id: string;
  name: string;
  description: string | null;
  price: number;
  gst_percent: number;
  is_veg: number;
  contains_egg: number;
  spicy_level: string;
  preparation_time: number | null;
  is_featured: number;
  is_available: number;
  cuisine: string | null;
  serving_size: string | null;
  allergens: string;
}
export interface VariantRow {
  id: string;
  menu_item_id: string;
  name: string;
  price: number;
  is_default: number;
  is_available: number;
}

export const findRestaurant = (id = DEMO_RESTAURANT_ID) =>
  getDb().prepare('SELECT id, name, chef_notes, ordering_open FROM restaurants WHERE id = ?').get(id) as
    | { id: string; name: string; chef_notes: string | null; ordering_open: number }
    | undefined;

export const findCategories = (restaurantId: string) =>
  getDb()
    .prepare('SELECT id, name, assistant_role FROM categories WHERE restaurant_id = ? ORDER BY sort_order')
    .all(restaurantId) as Array<{ id: string; name: string; assistant_role: string | null }>;

export const findItems = (restaurantId: string) =>
  getDb()
    .prepare('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY sort_order')
    .all(restaurantId) as unknown as ItemRow[];

export const findItem = (restaurantId: string, id: string) =>
  getDb().prepare('SELECT * FROM menu_items WHERE restaurant_id = ? AND id = ?').get(restaurantId, id) as
    | ItemRow
    | undefined;

export const findVariants = (restaurantId: string) =>
  getDb()
    .prepare(
      `SELECT v.* FROM menu_item_variants v JOIN menu_items i ON i.id = v.menu_item_id
       WHERE i.restaurant_id = ? ORDER BY v.sort_order`
    )
    .all(restaurantId) as unknown as VariantRow[];

export const findPairings = (restaurantId: string) =>
  getDb()
    .prepare(
      `SELECT p.menu_item_id, p.paired_item_id FROM menu_item_pairings p
       JOIN menu_items i ON i.id = p.menu_item_id WHERE i.restaurant_id = ?`
    )
    .all(restaurantId) as Array<{ menu_item_id: string; paired_item_id: string }>;

export const setAvailability = (restaurantId: string, id: string, available: boolean) =>
  getDb()
    .prepare('UPDATE menu_items SET is_available = ? WHERE restaurant_id = ? AND id = ?')
    .run(available ? 1 : 0, restaurantId, id).changes > 0;
