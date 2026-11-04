import { z } from 'zod';
import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { getCurrentTenantId } from '../../../config/tenant-context';
import { badRequest } from '../../../utils/http-error';
import { reportSwallowed } from '../../../utils/swallowed-error';
import { findRestaurant } from '../../menu/menu.repository';
import { assistantUnavailable, openAiCompatibleClient, type ChatMessage, type ModelClient } from '../core/model';
import { emptyUsage, runToolLoop, type TurnUsage } from '../core/tool-loop';
import { resolvePeriod, type Period } from './owner.periods';
import { OWNER_TOOLS, buildOwnerSystemPrompt, dishArgs, dishLookupArgs, periodOnlyArgs, salesArgs } from './owner.prompt';
import * as repo from './owner.repository';
import type { OwnerTurnInput } from './owner.types';

/**
 * The restaurant owner's assistant. Read-only: its tools return aggregates of
 * this restaurant's own orders, and every figure in the reply is checked
 * against what the tools returned before it is shown.
 */

const MAX_MODEL_CALLS = 5;
const MAX_REPLY_CHARS = 900;
/** Minutes an order may sit in a status before the assistant calls it overdue. */
export const OVERDUE_MINUTES = { NEW: 10, PREPARING: 30, READY: 15 } as const;

export interface OwnerFact {
  tool: string;
  title: string;
  data: unknown;
}

export interface OwnerTurnResult {
  reply: string;
  /** The tool results the reply was built from, for the owner to check. */
  facts: OwnerFact[];
  /** ₹ amounts or percentages in the reply that no tool returned. */
  unverifiedFigures: string[];
  debug?: { usage: TurnUsage };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const change = (now: number, before: number): number | null => (before ? round1(((now - before) / before) * 100) : null);

function runTool(name: string, raw: unknown, restaurantId: string, now: Date): OwnerFact {
  switch (name) {
    case 'sales_summary': {
      const { period } = salesArgs.parse(raw);
      const { current, previous } = resolvePeriod(period as Period, now);
      const a = repo.salesTotals(restaurantId, current);
      const b = repo.salesTotals(restaurantId, previous);
      return {
        tool: name,
        title: `Sales: ${current.label} vs ${previous.label}`,
        data: {
          period: current.label,
          comparedWith: previous.label,
          current: a,
          previous: b,
          changePercent: {
            revenue: change(a.revenue, b.revenue),
            orders: change(a.orders, b.orders),
            averageOrderValue: change(a.averageOrderValue, b.averageOrderValue),
          },
        },
      };
    }
    case 'dish_ranking': {
      const args = dishArgs.parse(raw);
      const { current } = resolvePeriod(args.period as Period, now);
      const key = args.rank_by;
      const rows = repo
        .dishSales(restaurantId, current)
        .filter((r) => args.order === 'top' || r.available)
        .sort((x, y) => (args.order === 'top' ? y[key] - x[key] : x[key] - y[key]) || x.dish.localeCompare(y.dish))
        .slice(0, args.limit)
        .map(({ dish, category, quantity, revenue }) => ({ dish, category, quantity, revenue }));
      return {
        tool: name,
        title: `${args.order === 'top' ? 'Best' : 'Slowest'} dishes by ${key}: ${current.label}`,
        data: { period: current.label, rankedBy: key, order: args.order, dishes: rows },
      };
    }
    case 'dish_sales': {
      const { period, name: query } = dishLookupArgs.parse(raw);
      const { current, previous } = resolvePeriod(period as Period, now);
      const needle = query.toLowerCase();
      const before = new Map(repo.dishSales(restaurantId, previous).map((r) => [r.dish, r]));
      const rows = repo
        .dishSales(restaurantId, current)
        .filter((r) => r.dish.toLowerCase().includes(needle))
        .slice(0, 10)
        .map((r) => ({
          dish: r.dish,
          available: r.available,
          quantity: r.quantity,
          revenue: r.revenue,
          previousQuantity: before.get(r.dish)?.quantity ?? 0,
          quantityChangePercent: change(r.quantity, before.get(r.dish)?.quantity ?? 0),
        }));
      return {
        tool: name,
        title: `Dishes matching "${query}": ${current.label} vs ${previous.label}`,
        data: { period: current.label, comparedWith: previous.label, dishes: rows, found: rows.length > 0 },
      };
    }
    case 'category_sales': {
      const { period } = periodOnlyArgs.parse(raw);
      const { current } = resolvePeriod(period as Period, now);
      const byCat = new Map<string, { quantity: number; revenue: number }>();
      for (const r of repo.dishSales(restaurantId, current)) {
        const c = byCat.get(r.category) ?? { quantity: 0, revenue: 0 };
        c.quantity += r.quantity;
        c.revenue = Math.round((c.revenue + r.revenue) * 100) / 100;
        byCat.set(r.category, c);
      }
      const total = [...byCat.values()].reduce((s, c) => s + c.revenue, 0);
      const categories = [...byCat.entries()]
        .map(([category, c]) => ({ category, ...c, sharePercent: total ? round1((c.revenue / total) * 100) : 0 }))
        .sort((a, b) => b.revenue - a.revenue);
      return { tool: name, title: `Sales by category: ${current.label}`, data: { period: current.label, categories } };
    }
    case 'busy_hours': {
      const { period } = periodOnlyArgs.parse(raw);
      const { current } = resolvePeriod(period as Period, now);
      const hours = repo
        .hourlySales(restaurantId, current)
        .map((h) => ({ hour: `${String(h.hour).padStart(2, '0')}:00–${String((h.hour + 1) % 24).padStart(2, '0')}:00`, orders: h.orders, revenue: h.revenue }))
        .sort((a, b) => b.orders - a.orders);
      return { tool: name, title: `Busiest hours: ${current.label}`, data: { period: current.label, hours } };
    }
    case 'orders_needing_attention': {
      const open = repo.openOrders(restaurantId, now).map((o) => ({
        ...o,
        overdue: o.minutesInStatus > OVERDUE_MINUTES[o.status],
        thresholdMinutes: OVERDUE_MINUTES[o.status],
      }));
      return {
        tool: name,
        title: 'Open orders right now',
        data: {
          open: open.length,
          overdue: open.filter((o) => o.overdue).length,
          byStatus: { NEW: open.filter((o) => o.status === 'NEW').length, PREPARING: open.filter((o) => o.status === 'PREPARING').length, READY: open.filter((o) => o.status === 'READY').length },
          orders: open,
        },
      };
    }
    default:
      throw badRequest('Unknown tool.');
  }
}

/** Numbers that appear anywhere in the facts, for checking the reply against. */
function factNumbers(facts: OwnerFact[]): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  facts.forEach((f) => walk(f.data));
  return out;
}

/**
 * ₹ amounts and percentages in the reply that do not match a tool figure
 * (allowing the model to round to the rupee or to one decimal of a percent).
 */
export function unverifiedFigures(reply: string, facts: OwnerFact[]): string[] {
  const known = factNumbers(facts);
  const misses: string[] = [];
  const money = /(?:₹|Rs\.?\s?)\s?(\d+(?:,\d+)*(?:\.\d+)?)/gi;
  const percent = /(-?\d+(?:\.\d+)?)\s?%/g;
  for (const m of reply.matchAll(money)) {
    const v = Number(m[1].replace(/,/g, ''));
    if (!known.some((k) => Math.abs(Math.abs(k) - v) <= 1)) misses.push(m[0].trim());
  }
  for (const m of reply.matchAll(percent)) {
    const v = Math.abs(Number(m[1]));
    if (!known.some((k) => Math.abs(Math.abs(k) - v) <= 0.6)) misses.push(m[0].trim());
  }
  return [...new Set(misses)];
}

export async function ownerTurn(
  input: OwnerTurnInput,
  client: ModelClient = openAiCompatibleClient,
  now: Date = new Date()
): Promise<OwnerTurnResult> {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) throw badRequest('Choose a restaurant first.');
  const restaurant = findRestaurant(restaurantId);
  const localNow = new Date(now.getTime() + 330 * 60_000).toISOString().replace('T', ' ').slice(0, 16);
  const messages: ChatMessage[] = [
    { role: 'system', content: buildOwnerSystemPrompt(restaurant?.name ?? 'this restaurant', localNow) },
    ...input.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];
  const facts: OwnerFact[] = [];
  const usage = emptyUsage();
  let outcome: 'answer' | 'truncated' | 'exhausted' | 'unavailable' = 'unavailable';
  let reply: string;
  try {
    reply = (
      await runToolLoop<string>({
        client,
        messages,
        usage,
        tools: OWNER_TOOLS,
        maxCalls: MAX_MODEL_CALLS,
        onText: (text, finishReason) => {
          outcome = finishReason === 'length' ? 'truncated' : 'answer';
          return finishReason === 'length' ? '' : text.trim();
        },
        onExhausted: () => {
          outcome = 'exhausted';
          throw assistantUnavailable();
        },
        onToolCall: async (call, { finishReason }) => {
          if (finishReason === 'length')
            return { content: { error: 'Your previous reply was cut off. Call the tool again.' } };
          try {
            const fact = runTool(call.function.name, JSON.parse(call.function.arguments || '{}'), restaurantId, now);
            facts.push(fact);
            return { content: fact.data };
          } catch (err) {
            const expected = err instanceof SyntaxError || err instanceof z.ZodError || (err as { status?: number }).status === 400;
            if (!expected) reportSwallowed('assistant', 'owner_tool_call')(err);
            return { content: { error: err instanceof z.ZodError ? 'Invalid arguments for this tool.' : 'That report failed; try another.' } };
          }
        },
      })
    ).result;
  } finally {
    logger.info('assistant.turn', { side: 'owner', restaurantId, ...usage, outcome });
  }
  const text = reply.slice(0, MAX_REPLY_CHARS) || 'I could not put an answer together. Try asking about one period, for example "sales this week".';
  const result: OwnerTurnResult = { reply: text, facts, unverifiedFigures: unverifiedFigures(text, facts) };
  return env.ASSISTANT_DEBUG_USAGE && env.NODE_ENV !== 'production' ? { ...result, debug: { usage } } : result;
}

/** The dashboard cards: the same queries, no model call. */
export function ownerOverview(now: Date = new Date()) {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) throw badRequest('Choose a restaurant first.');
  const facts = ['sales_summary:today', 'sales_summary:this_week', 'orders_needing_attention:', 'dish_ranking:last_7_days'].map((k) => {
    const [tool, period] = k.split(':');
    return runTool(tool, period ? { period, limit: 3 } : {}, restaurantId, now);
  });
  return { facts };
}
