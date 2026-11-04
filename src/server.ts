import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { env } from './config/env';
import { logger } from './config/logger';
import { runWithTenantId } from './config/tenant-context';
import { DEMO_RESTAURANT_ID, getDb } from './db/database';
import { isAssistantConfigured } from './modules/assistant/core/model';
import { customerOptions, customerTurn } from './modules/assistant/customer/customer.service';
import { cartLineSchema, customerTurnSchema } from './modules/assistant/customer/customer.types';
import { ownerOverview, ownerTurn } from './modules/assistant/owner/owner.service';
import { ownerTurnSchema } from './modules/assistant/owner/owner.types';
import { getMenuForCustomer, getMenuForOwner, setItemAvailability } from './modules/menu/menu.service';
import { findRestaurant } from './modules/menu/menu.repository';
import { openOrders, placeOrder, setStatus } from './modules/orders/orders.service';

/**
 * A small local server around the assistant, backed by one SQLite file:
 * - /         guest takeaway page with "Help me choose"
 * - /kitchen  kitchen board (advance orders; completed orders feed the reports)
 * - /owner    owner dashboard with the owner's assistant and menu availability
 * There is no login: in Sprint Serve the owner side is OWNER-only and the guest
 * side sits behind the restaurant's gate, rate limits and checkout OTP.
 */

const MAX_BODY = 64 * 1024;
const publicDir = resolve(process.cwd(), 'public');

const checkoutSchema = z.object({
  name: z.string().trim().min(1).max(60).default('Guest'),
  items: z.array(cartLineSchema).min(1).max(25),
  /** The total the guest saw; refused if the menu changed underneath it. */
  quotedTotal: z.number().nonnegative(),
});
const statusSchema = z.object({ status: z.enum(['PREPARING', 'READY', 'COMPLETED', 'CANCELLED']) });
const availabilitySchema = z.object({ available: z.boolean() });

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
  }
}

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw Object.assign(new Error('Invalid request.'), { status: 400 });
  return r.data;
};

const PAGES: Record<string, string> = { '/': 'index.html', '/kitchen': 'kitchen.html', '/owner': 'owner.html' };
const notConfigured = 'The assistant is off: set ASSISTANT_ENABLED=true and ASSISTANT_MODEL_API_KEY in .env (or run the model stub).';

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  if (req.method === 'GET' && PAGES[path]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(await readFile(resolve(publicDir, PAGES[path])));
  }

  // Kitchen status and menu availability carry an id in the path.
  const statusMatch = path.match(/^\/api\/kitchen\/([\w-]+)\/status$/);
  if (req.method === 'POST' && statusMatch)
    return send(res, 200, await setStatus(statusMatch[1], parse(statusSchema, await readJson(req)).status));
  const availMatch = path.match(/^\/api\/owner\/menu\/([\w-]+)\/availability$/);
  if (req.method === 'POST' && availMatch)
    return send(res, 200, await setItemAvailability(availMatch[1], parse(availabilitySchema, await readJson(req)).available));

  switch (`${req.method} ${path}`) {
    case 'GET /api/status':
      return send(res, 200, {
        enabled: isAssistantConfigured(),
        restaurant: findRestaurant()?.name ?? 'Demo restaurant',
        model: env.ASSISTANT_MODEL,
      });
    case 'GET /api/options':
      return send(res, 200, isAssistantConfigured() ? await customerOptions() : { popularHere: false, readyFast: false });
    case 'POST /api/turn':
      if (!isAssistantConfigured()) return send(res, 503, { error: notConfigured });
      return send(res, 200, await customerTurn(parse(customerTurnSchema, await readJson(req))));
    case 'POST /api/checkout': {
      const key = String(req.headers['x-idempotency-key'] ?? '');
      if (!/^[A-Za-z0-9-]{8,80}$/.test(key)) return send(res, 400, { error: 'X-Idempotency-Key is required.' });
      const body = parse(checkoutSchema, await readJson(req));
      const { order, created } = await placeOrder({ ...body, idempotencyKey: key });
      return send(res, created ? 201 : 200, order);
    }
    case 'GET /api/kitchen':
      return send(res, 200, await openOrders());
    case 'GET /api/owner/overview':
      return send(res, 200, ownerOverview());
    case 'GET /api/owner/menu':
      return send(res, 200, await getMenuForOwner());
    case 'POST /api/owner/turn':
      if (!isAssistantConfigured()) return send(res, 503, { error: notConfigured });
      return send(res, 200, await ownerTurn(parse(ownerTurnSchema, await readJson(req))));

    // Same paths and envelope as Sprint Serve, so scripts/assistant-eval.mjs runs unchanged.
    case 'GET /api/v1/menu/customer':
      return send(res, 200, { success: true, data: await getMenuForCustomer() });
    case 'POST /api/v1/assistant/customer/turn':
      if (!isAssistantConfigured()) return send(res, 404, { success: false, code: 'ASSISTANT_DISABLED' });
      return send(res, 200, { success: true, data: await customerTurn(parse(customerTurnSchema, await readJson(req))) });
    default:
      return send(res, 404, { error: 'Not found.' });
  }
}

getDb(); // create and seed on first start, before the first request

const server = createServer((req, res) => {
  runWithTenantId(DEMO_RESTAURANT_ID, () =>
    handle(req, res).catch((err: { status?: number; message?: string; code?: string; total?: number }) => {
      const status = err.status && err.status < 600 ? err.status : 500;
      if (status >= 500) logger.error('request failed', { error: err.message });
      send(res, status, {
        error: status >= 500 ? 'Something went wrong.' : err.message,
        ...(err.code && { code: err.code }),
        ...(err.total !== undefined && { total: err.total }),
      });
    })
  );
});

server.listen(env.PORT, () => {
  console.log(`Meal assistant demo on http://localhost:${env.PORT}`);
  console.log(`  guest: /   kitchen board: /kitchen   owner dashboard: /owner`);
  if (!isAssistantConfigured()) console.log(`  ${notConfigured}`);
});
