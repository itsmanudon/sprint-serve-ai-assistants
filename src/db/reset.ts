import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDb, getDb } from './database';

/** Deletes the demo database and builds it again from the seed (fresh history ending now). */
const file = process.env.DATABASE_FILE ?? resolve(process.cwd(), 'data/demo.db');
closeDb();
for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
const db = getDb();
const { n } = db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number };
console.log(`Database reset: ${file} (${n} synthetic orders)`);
closeDb();
