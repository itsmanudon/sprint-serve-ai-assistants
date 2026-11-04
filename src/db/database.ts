import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedIfEmpty } from './seed';

/**
 * One local SQLite file (Node's built-in node:sqlite, no native install) that
 * plays the part of Sprint Serve's PostgreSQL for this demo: the menu, the
 * restaurant profile and every order. Delete it or run `npm run db:reset` to
 * start again from the synthetic seed.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chef_notes TEXT,
  ordering_open INTEGER NOT NULL DEFAULT 1,
  utc_offset_minutes INTEGER NOT NULL DEFAULT 330
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  name TEXT NOT NULL,
  assistant_role TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT,
  price REAL NOT NULL CHECK (price >= 0),
  gst_percent REAL NOT NULL DEFAULT 5,
  is_veg INTEGER NOT NULL DEFAULT 0,
  contains_egg INTEGER NOT NULL DEFAULT 0,
  spicy_level TEXT NOT NULL DEFAULT 'NONE',
  preparation_time INTEGER,
  is_featured INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1,
  cuisine TEXT,
  serving_size TEXT,
  allergens TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS menu_item_variants (
  id TEXT PRIMARY KEY,
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
  name TEXT NOT NULL,
  price REAL NOT NULL CHECK (price >= 0),
  is_default INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS menu_item_pairings (
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
  paired_item_id TEXT NOT NULL REFERENCES menu_items(id),
  PRIMARY KEY (menu_item_id, paired_item_id)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
  number INTEGER NOT NULL,
  customer_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('NEW','PREPARING','READY','COMPLETED','CANCELLED')),
  source TEXT NOT NULL DEFAULT 'counter',
  subtotal REAL NOT NULL,
  tax REAL NOT NULL,
  total REAL NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (restaurant_id, number)
);
CREATE INDEX IF NOT EXISTS orders_by_time ON orders (restaurant_id, created_at);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
  name TEXT NOT NULL,
  variant_name TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price REAL NOT NULL,
  line_total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_by_order ON order_items (order_id);
`;

let db: DatabaseSync | null = null;

/** Opens (and on first use creates and seeds) the database. */
export function getDb(): DatabaseSync {
  if (db) return db;
  const file = process.env.DATABASE_FILE ?? resolve(process.cwd(), 'data/demo.db');
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seedIfEmpty(db);
  return db;
}

/** For tests and `db:reset`: forget the open handle. */
export function closeDb(): void {
  db?.close();
  db = null;
}

/** Runs `fn` in one transaction; any throw rolls everything back. */
export function transaction<T>(fn: (d: DatabaseSync) => T): T {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/** The single demo restaurant every request runs inside. */
export const DEMO_RESTAURANT_ID = 'demo-restaurant';
