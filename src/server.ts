import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { env } from './config/env';
import { logger } from './config/logger';
import { runWithTenantId } from './config/tenant-context';
import { isAssistantConfigured as assistantEnabled } from './modules/assistant/core/model';
import { customerOptions, customerTurn } from './modules/assistant/customer/customer.service';
import { cartLineSchema, customerTurnSchema } from './modules/assistant/customer/customer.types';
import { demoRestaurant } from './modules/menu/demo-data';
import { quoteTakeawayOrder } from './modules/takeaway/takeaway.service';

/**
 * A tiny local server around the meal assistant: the guest page, the two
 * assistant routes, and a pretend checkout + kitchen board so the whole loop
 * (ask → proposal → edit → order → kitchen) can be shown without Sprint Serve.
 */

const MAX_BODY = 64 * 1024;
const publicDir = resolve(process.cwd(), 'public');

interface KitchenOrder {
  id: string;
  number: number;
  name: string;
  lines: Awaited<ReturnType<typeof quoteTakeawayOrder>>['lines'];
  total: number;
  placedAt: string;
}
const kitchen: KitchenOrder[] = [];
// Retries with the same key return the same order, like Sprint Serve's idempotent checkout.
const placedByKey = new Map<string, KitchenOrder>();

const checkoutSchema = z.object({
  name: z.string().trim().min(1).max(60).default('Guest'),
  items: z.array(cartLineSchema).min(1).max(25),
  /** The total the guest saw; refused if the menu changed underneath it. */
  quotedTotal: z.number().nonnegative(),
});

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

async function serveStatic(res: ServerResponse, name: string, type: string) {
  const body = await readFile(resolve(publicDir, name));
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /':
      return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
    case 'GET /kitchen':
      return serveStatic(res, 'kitchen.html', 'text/html; charset=utf-8');
    case 'GET /api/status':
      return send(res, 200, {
        enabled: assistantEnabled(),
        restaurant: demoRestaurant().name,
        model: env.ASSISTANT_MODEL,
      });
    case 'GET /api/options':
      return send(res, 200, assistantEnabled() ? await customerOptions() : { popularHere: false, readyFast: false });
    case 'POST /api/turn': {
      if (!assistantEnabled())
        return send(res, 503, { error: 'Set ASSISTANT_ENABLED=true and ASSISTANT_MODEL_API_KEY in .env.' });
      const parsed = customerTurnSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { error: 'Invalid request.', issues: parsed.error.issues });
      return send(res, 200, await customerTurn(parsed.data));
    }
    case 'POST /api/checkout': {
      const key = String(req.headers['x-idempotency-key'] ?? '');
      if (!/^[A-Za-z0-9-]{8,80}$/.test(key)) return send(res, 400, { error: 'X-Idempotency-Key is required.' });
      const previous = placedByKey.get(key);
      if (previous) return send(res, 200, previous);
      const parsed = checkoutSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { error: 'Invalid order.', issues: parsed.error.issues });
      const quote = await quoteTakeawayOrder(parsed.data.items);
      if (Math.abs(quote.total - parsed.data.quotedTotal) > 0.005)
        return send(res, 409, { error: 'The price changed. Please review your order.', code: 'QUOTE_TOTAL_CHANGED', total: quote.total });
      const order: KitchenOrder = {
        id: randomUUID(),
        number: kitchen.length + 1,
        name: parsed.data.name,
        lines: quote.lines,
        total: quote.total,
        placedAt: new Date().toISOString(),
      };
      kitchen.unshift(order);
      placedByKey.set(key, order);
      return send(res, 201, order);
    }
    // Same paths and envelope as Sprint Serve, so scripts/assistant-eval.mjs runs unchanged.
    case 'GET /api/v1/menu/customer':
      return send(res, 200, { success: true, data: demoRestaurant().categories });
    case 'POST /api/v1/assistant/customer/turn': {
      if (!assistantEnabled()) return send(res, 404, { success: false, code: 'ASSISTANT_DISABLED' });
      const parsed = customerTurnSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { success: false, issues: parsed.error.issues });
      return send(res, 200, { success: true, data: await customerTurn(parsed.data) });
    }
    case 'GET /api/kitchen':
      return send(res, 200, kitchen.slice(0, 50));
    default:
      return send(res, 404, { error: 'Not found.' });
  }
}

const server = createServer((req, res) => {
  runWithTenantId(demoRestaurant().id, () =>
    handle(req, res).catch((err: { status?: number; message?: string }) => {
      const status = err.status && err.status < 600 ? err.status : 500;
      if (status >= 500) logger.error('request failed', { error: err.message });
      send(res, status, { error: status >= 500 ? 'Something went wrong.' : err.message });
    })
  );
});

server.listen(env.PORT, () => {
  console.log(`Meal assistant demo on http://localhost:${env.PORT}  (kitchen board: /kitchen)`);
  if (!assistantEnabled()) console.log('Assistant is OFF: set ASSISTANT_ENABLED=true and ASSISTANT_MODEL_API_KEY in .env');
});
