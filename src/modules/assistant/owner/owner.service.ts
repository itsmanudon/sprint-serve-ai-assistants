import { z } from 'zod';
import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { getCurrentTenantId } from '../../../config/tenant-context';
import { badRequest } from '../../../utils/http-error';
import { reportSwallowed } from '../../../utils/swallowed-error';
import { findRestaurant } from '../../menu/menu.repository';
import {
  assistantUnavailable,
  openAiCompatibleClient,
  type CallOptions,
  type ChatMessage,
  type ModelClient,
  type ModelTurn,
} from '../core/model';
import { addCall, emptyUsage, runToolLoop, type TurnUsage } from '../core/tool-loop';
import {
  PERMISSION_TAGS,
  ScopeError,
  metricCatalog,
  metricQueryArgs,
  queryMetrics,
  type MetricResult,
  type PermissionTag,
} from './owner.metrics';
import { finishArgs, plannerPrompt, plannerTools, writerPrompt } from './owner.prompt';
import { openOrders } from './owner.repository';
import type { OwnerTurnInput } from './owner.types';

/**
 * The restaurant owner's assistant, in three steps:
 *
 * 1. PLAN (fast tier, tools): pick and run read-only reports from a fixed
 *    registry. The restaurant and the caller's permission scope come from the
 *    session; the model only chooses metric ids, a period and a split.
 * 2. WRITE (fast tier for lookups, deep tier for "why / what should I do"):
 *    turn the reports into an answer, with NO tools, the reports passed as a
 *    data block. Whatever text sits in the data cannot make it run anything.
 * 3. CHECK: strip links and markup, then match every ₹ amount and percentage in
 *    the answer against the reports; one rewrite if any do not match, and any
 *    that still do not are shown to the owner as flags.
 */

const MAX_PLANNER_CALLS = 4;
const MAX_REPORTS = 4;
const MAX_REPLY_CHARS = 1500;
/** Minutes an order may sit in a status before it is called overdue. */
export const OVERDUE_MINUTES = { NEW: 10, PREPARING: 30, READY: 15 } as const;
/** An owner may see every report. In Sprint Serve this comes from the caller's permissions. */
export const OWNER_SCOPE: ReadonlySet<PermissionTag> = new Set(PERMISSION_TAGS);

export type Depth = 'quick' | 'deep';

export interface OwnerFact {
  tool: string;
  title: string;
  data: unknown;
}

export interface OwnerTurnResult {
  reply: string;
  depth: Depth;
  facts: OwnerFact[];
  /** ₹ amounts or percentages in the reply that no report contains. */
  unverifiedFigures: string[];
  /** Which model wrote the answer (tier name and model id). */
  answeredBy: { tier: 'fast' | 'deep'; model: string };
  debug?: { usage: TurnUsage };
}

export function tierOptions(depth: Depth): CallOptions & { model: string } {
  return depth === 'deep'
    ? {
        model: env.ASSISTANT_DEEP_MODEL ?? env.ASSISTANT_MODEL,
        reasoningEffort: env.ASSISTANT_DEEP_REASONING_EFFORT,
        baseUrl: env.ASSISTANT_DEEP_BASE_URL,
        apiKey: env.ASSISTANT_DEEP_API_KEY,
        maxTokens: 2500,
        timeoutMs: env.ASSISTANT_DEEP_TIMEOUT_MS,
      }
    : { model: env.ASSISTANT_FAST_MODEL ?? env.ASSISTANT_MODEL, reasoningEffort: env.ASSISTANT_FAST_REASONING_EFFORT };
}

function openOrdersFact(restaurantId: string, now: Date): OwnerFact {
  const open = openOrders(restaurantId, now).map((o) => ({
    ...o,
    overdue: o.minutesInStatus > OVERDUE_MINUTES[o.status],
    overdueAfterMinutes: OVERDUE_MINUTES[o.status],
  }));
  return {
    tool: 'orders_needing_attention',
    title: 'Open orders right now',
    data: {
      open: open.length,
      overdue: open.filter((o) => o.overdue).length,
      orders: open,
    },
  };
}

function titleFor(r: MetricResult): string {
  const names = r.metrics.map((m) => m.label).join(', ');
  return `${names}${r.dimension ? ` by ${r.dimension.toLowerCase()}` : ''}: ${r.period}${r.comparedWith ? ` vs ${r.comparedWith}` : ''}`;
}

/** Remove anything that could carry data out or render as markup. */
export function sanitizeReply(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link removed]')
    .replace(/<[^>]{0,200}>/g, '')
    .replace(/[*_#`>|]{2,}/g, '')
    .replace(/^\s*[-*#>]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_REPLY_CHARS);
}

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

/** ₹ amounts (to the rupee) and percentages (to one decimal) that no report contains. */
export function unverifiedFigures(reply: string, facts: OwnerFact[]): string[] {
  const known = factNumbers(facts);
  const misses: string[] = [];
  for (const m of reply.matchAll(/(?:₹|Rs\.?\s?)\s?(\d+(?:,\d+)*(?:\.\d+)?)(\s?(?:lakh|lakhs|crore|crores|k)\b)?/gi)) {
    const v = Number(m[1].replace(/,/g, ''));
    // "₹1.2 lakh" style figures cannot be matched exactly: always flag them for checking.
    if (m[2] || !known.some((k) => Math.abs(Math.abs(k) - v) <= 1)) misses.push(m[0].trim());
  }
  for (const m of reply.matchAll(/(-?\d+(?:\.\d+)?)\s?%/g)) {
    const v = Math.abs(Number(m[1]));
    if (!known.some((k) => Math.abs(Math.abs(k) - v) <= 0.6)) misses.push(m[0].trim());
  }
  return [...new Set(misses)];
}

const localNowText = (now: Date) => {
  const local = new Date(now.getTime() + 330 * 60_000);
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][local.getUTCDay()];
  return `${day} ${local.toISOString().slice(0, 10)} ${local.toISOString().slice(11, 16)}`;
};

const turnUsage = (t: ModelTurn) => ({
  inputTokens: t.usage?.prompt_tokens ?? 0,
  outputTokens: t.usage?.completion_tokens ?? 0,
  cachedTokens: t.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  latencyMs: t.latencyMs ?? 0,
});

export async function ownerTurn(
  input: OwnerTurnInput,
  client: ModelClient = openAiCompatibleClient,
  now: Date = new Date(),
  scope: ReadonlySet<PermissionTag> = OWNER_SCOPE
): Promise<OwnerTurnResult> {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) throw badRequest('Choose a restaurant first.');
  const name = findRestaurant(restaurantId)?.name ?? 'this restaurant';
  const localNow = localNowText(now);
  const history = input.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
  const question = input.messages[input.messages.length - 1].content;
  const usage = emptyUsage();
  const facts: OwnerFact[] = [];
  let depth: Depth = 'quick';
  let outcome = 'unavailable';

  try {
    // 1. PLAN
    const planned = await runToolLoop<Depth>({
      client,
      usage,
      maxCalls: MAX_PLANNER_CALLS,
      callOptions: tierOptions('quick'),
      tools: plannerTools(scope),
      messages: [{ role: 'system', content: plannerPrompt(name, localNow, metricCatalog(scope)) }, ...history],
      // A planner that answers in prose instead of finishing: its text is discarded.
      onText: () => (facts.length > 1 ? 'deep' : 'quick'),
      onExhausted: () => (facts.length > 1 ? 'deep' : 'quick'),
      onToolCall: async (call) => {
        try {
          const raw = JSON.parse(call.function.arguments || '{}');
          if (call.function.name === 'finish_research') return { content: { ok: true }, done: finishArgs.parse(raw).depth };
          if (facts.length >= MAX_REPORTS)
            return { content: { error: `At most ${MAX_REPORTS} reports per question. Call finish_research now.` } };
          if (call.function.name === 'query_metrics') {
            const result = queryMetrics(restaurantId, metricQueryArgs.parse(raw), scope, now);
            const fact = { tool: 'query_metrics', title: titleFor(result), data: result };
            facts.push(fact);
            return { content: result };
          }
          if (call.function.name === 'orders_needing_attention' && scope.has('ops.view')) {
            const fact = openOrdersFact(restaurantId, now);
            facts.push(fact);
            return { content: fact.data };
          }
          return { content: { error: 'Unknown tool.' } };
        } catch (err) {
          if (err instanceof ScopeError) return { content: { error: err.message } };
          const expected =
            err instanceof SyntaxError || err instanceof z.ZodError || (err as { status?: number }).status === 400;
          if (!expected) reportSwallowed('assistant', 'owner_report')(err);
          return {
            content: {
              error: err instanceof z.ZodError ? 'Invalid arguments: use the metric ids, periods and splits from the catalog.' : (err as Error).message,
            },
          };
        }
      },
    });
    depth = planned.result;

    // 2. WRITE (no tools; reports as data in the final message)
    const tier = tierOptions(depth);
    const reports = JSON.stringify(facts.map((f) => ({ report: f.title, data: f.data })));
    const writerMessages: ChatMessage[] = [
      { role: 'system', content: writerPrompt(name, localNow, depth) },
      ...history.slice(0, -1),
      { role: 'user', content: `${question}\n\n<reports>\n${facts.length ? reports : '[] (no reports were run)'}\n</reports>` },
    ];
    const write = async (messages: ChatMessage[]) => {
      const turn = await client.complete(messages, [], tier);
      Object.assign(usage, addCall(usage, turnUsage(turn)));
      return turn.finishReason === 'length' ? '' : sanitizeReply(turn.message.content ?? '');
    };
    let reply = await write(writerMessages);
    let misses = unverifiedFigures(reply, facts);

    // 3. CHECK: one rewrite when figures do not match the reports.
    if (reply && misses.length) {
      const retry = await write([
        ...writerMessages,
        { role: 'assistant', content: reply },
        {
          role: 'user',
          content: `These figures are not in the reports: ${misses.join(', ')}. Rewrite the answer using only figures that appear in the reports, or say the figure is not available.`,
        },
      ]);
      const retryMisses = unverifiedFigures(retry, facts);
      if (retry && retryMisses.length < misses.length) {
        reply = retry;
        misses = retryMisses;
      }
    }
    outcome = reply ? (misses.length ? 'answer_flagged' : 'answer') : 'empty';
    const result: OwnerTurnResult = {
      reply: reply || 'I could not put an answer together. Try asking about one period, for example "sales this week".',
      depth,
      facts,
      unverifiedFigures: misses,
      answeredBy: { tier: depth === 'deep' ? 'deep' : 'fast', model: tier.model },
    };
    return env.ASSISTANT_DEBUG_USAGE && env.NODE_ENV !== 'production' ? { ...result, debug: { usage } } : result;
  } catch (err) {
    if ((err as { status?: number }).status === 503) throw err;
    reportSwallowed('assistant', 'owner_turn')(err);
    throw assistantUnavailable();
  } finally {
    // Counts and status only: never the question, the reports or the answer.
    logger.info('assistant.turn', { side: 'owner', restaurantId, depth, reports: facts.length, ...usage, outcome });
  }
}

/** The dashboard cards: the same registry, no model call. */
export function ownerOverview(now: Date = new Date()) {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) throw badRequest('Choose a restaurant first.');
  const q = (args: Record<string, unknown>) => queryMetrics(restaurantId, metricQueryArgs.parse(args), OWNER_SCOPE, now);
  return {
    today: q({ metrics: ['revenue', 'orders', 'cancelled_orders', 'assistant_orders'], period: 'today' }),
    week: q({ metrics: ['revenue', 'orders'], period: 'this_week' }),
    trend: q({ metrics: ['revenue'], period: 'last_30_days', dimension: 'day', compare: false }),
    top: q({ metrics: ['items_sold', 'item_sales'], period: 'last_7_days', dimension: 'item', compare: false, limit: 5 }),
    open: openOrdersFact(restaurantId, now).data,
  };
}
