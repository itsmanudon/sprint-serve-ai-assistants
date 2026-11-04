import { z } from 'zod';
import { env } from '../../../config/env';
import { getCurrentTenantId } from '../../../config/tenant-context';
import { logger } from '../../../config/logger';
import { badRequest } from '../../../utils/http-error';
import { reportSwallowed } from '../../../utils/swallowed-error';
import * as menuService from '../../menu/menu.service';
import * as takeawayService from '../../takeaway/takeaway.service';
import {
  searchCatalog,
  summarizeForSearch,
  toCatalog,
  type CatalogItem,
  type SpiceLevel,
} from '../catalog/catalog';
import {
  assistantUnavailable,
  openAiCompatibleClient,
  type ChatMessage,
  type ModelClient,
} from '../core/model';
import { emptyUsage, runToolLoop, type TurnUsage } from '../core/tool-loop';
import { buildMenuSnapshot, loadProfile, popularIds } from '../catalog/profile';
import {
  FAST_MIN_COVERAGE,
  POPULAR_MIN_ORDERS,
  loadSignals,
  type RestaurantSignals,
} from '../catalog/signals';
import { computeEdits, type Edit } from './customer.edits';
import {
  CUSTOMER_TOOLS,
  buildSystemContext,
  itemArgs,
  proposeArgs,
  quoteArgs,
  searchArgs,
} from './customer.prompt';
import {
  MAX_REPLY_CHARS,
  describeItem,
  describeLines,
  hardLimitViolation,
  mealShapeViolation,
  mergeConstraints,
  readyInMinutes,
  sanitizeSuggestions,
  validateLines,
  type ProposedLine,
} from './customer.rules';
import type { CartLine, Constraints, CustomerTurnInput } from './customer.types';

/**
 * One customer turn of the meal-selection assistant.
 *
 * The model interprets and explains; this service decides. It can only read
 * the public menu and ask the canonical quote for a price. It never places an
 * order: the customer confirms the returned cart in the normal checkout, which
 * keeps its own authentication, idempotency and stale-price check.
 */

const MAX_MODEL_CALLS = 6;
// Exactly one over-budget proposal is pushed back; other rejections are bounded by MAX_MODEL_CALLS.
const MAX_BUDGET_PUSHBACKS = 1;
// Same for a group meal with no main when the owner has labelled a MAIN category; its own counter.
const MAX_MEAL_SHAPE_PUSHBACKS = 1;

type Quote = Awaited<ReturnType<typeof takeawayService.quoteTakeawayOrder>>;

export type { ProposedLine };

export interface CustomerTurnResult {
  reply: string;
  constraints: Constraints;
  proposal: null | {
    items: ProposedLine[];
    quote: { subtotal: number; tax: number; total: number };
    withinBudget: boolean | null;
    /** Longest recorded prep over the lines; null if any line has no prep time. */
    readyInMinutes: number | null;
    /** Existing cart + this proposal; omitted when there are no valid existing lines. */
    combinedQuote?: { subtotal: number; tax: number; total: number };
  };
  /** Facts the reply relied on that the menu does not record. */
  unverified: string[];
  /** Short one-tap follow-up edits the model suggested. */
  suggestions: string[];
  /** One-tap edits computed from this restaurant's own menu; supersedes `suggestions`. */
  edits: Edit[];
  /** Token usage of this turn; only set outside production when ASSISTANT_DEBUG_USAGE is on. */
  debug?: { usage: TurnUsage };
}

/** Which intake pills this restaurant's own data supports. No model call. */
export async function customerOptions(): Promise<{ popularHere: boolean; readyFast: boolean }> {
  if (!getCurrentTenantId()) throw badRequest('Choose a restaurant first.');
  const catalogItems = toCatalog(await menuService.getMenuForCustomer());
  if (!catalogItems.length) return { popularHere: false, readyFast: false };
  const signals = await loadSignals(catalogItems);
  return {
    popularHere: signals.completedOrders30d >= POPULAR_MIN_ORDERS && signals.topItemIds.length > 0,
    readyFast: signals.prepCoverage >= FAST_MIN_COVERAGE,
  };
}

async function quote(lines: CartLine[]): Promise<Quote> {
  return takeawayService.quoteTakeawayOrder(
    lines.map((l) => ({
      menuItemId: l.menuItemId,
      quantity: l.quantity,
      variantId: l.variantId ?? null,
      selectedOptions: l.selectedOptions ?? [],
    }))
  );
}

interface Proposal {
  lines: ProposedLine[];
  constraints: Constraints;
  reply: string;
  unverified: string[];
  suggestions: string[];
  q: Quote;
  combined?: Quote;
}

const money = (q: Quote) => ({
  subtotal: Number(q.subtotal),
  tax: Number(q.tax),
  total: Number(q.total),
});

export async function customerTurn(
  input: CustomerTurnInput,
  client: ModelClient = openAiCompatibleClient
): Promise<CustomerTurnResult> {
  if (!getCurrentTenantId()) throw badRequest('Choose a restaurant first.');
  const catalogItems = toCatalog(await menuService.getMenuForCustomer());
  if (!catalogItems.length)
    throw badRequest('This restaurant has no dishes available to order right now.');
  const catalog = new Map(catalogItems.map((i) => [i.id, i]));
  const [profile, signals] = await Promise.all([
    loadProfile(catalogItems),
    loadSignals(catalogItems),
  ]);
  // Popularity is only claimed once the restaurant has enough completed orders.
  const popular = popularIds(signals);

  // The budget covers the whole cart: lines already in it are priced, and any that
  // have left the menu are dropped and reported instead of failing the turn.
  const unverifiedExisting: string[] = [];
  const validExisting: CartLine[] = [];
  for (const line of input.existingCart ?? []) {
    if (validateLines([line], catalog) === null) validExisting.push(line);
    else
      unverifiedExisting.push(
        `${catalog.get(line.menuItemId)?.name ?? line.menuItemId} in your cart is no longer available`
      );
  }
  let existingTotal: number | null = null;
  if (validExisting.length) {
    try {
      existingTotal = money(await quote(validExisting)).total;
    } catch (err) {
      // The context line is advisory; the per-proposal quote reports refusals.
      existingTotal = null;
      reportSwallowed('assistant', 'existing_cart_quote')(err);
    }
  }
  const customerBudget = input.constraints?.budget;
  const budgetNote =
    existingTotal !== null && customerBudget
      ? existingTotal >= customerBudget
        ? `The existing cart already costs ₹${existingTotal.toFixed(2)}, which is at or over the ₹${customerBudget} budget; explain this instead of adding dishes.`
        : `Remaining budget: ₹${(customerBudget - existingTotal).toFixed(2).replace(/\.00$/, '')} (the budget covers the existing cart plus your proposal).`
      : '';

  const context = [
    input.constraints ? `Limits agreed so far: ${JSON.stringify(input.constraints)}.` : '',
    input.cart?.length
      ? `Cart on screen: ${JSON.stringify(
          describeLines(
            input.cart.filter((l) => catalog.has(l.menuItemId)),
            catalog,
            popular
          )
        )}.`
      : '',
    validExisting.length
      ? `Existing takeaway cart (kept as is; counts toward the budget): ${JSON.stringify(
          describeLines(validExisting, catalog, popular)
        )}${existingTotal !== null ? `, quoted total ₹${existingTotal.toFixed(2)}` : ''}.`
      : '',
    budgetNote,
  ].filter(Boolean);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemContext(profile, buildMenuSnapshot(catalogItems, signals), context),
    },
    ...input.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  const existingItemIds = validExisting.map((l) => l.menuItemId);
  let budgetPushbacks = 0;
  let mealShapePushbacks = 0;
  let lastValid: Proposal | null = null;

  const usage = emptyUsage();
  // 'proposal' also covers a call cap that still returned the last valid proposal;
  // 'exhausted' means the cap passed and the turn threw.
  let outcome: 'proposal' | 'clarify' | 'truncated' | 'unavailable' | 'exhausted' = 'unavailable';

  let turnResult: CustomerTurnResult;
  try {
    turnResult = (
      await runToolLoop<CustomerTurnResult>({
        client,
        messages,
        usage,
        tools: CUSTOMER_TOOLS,
        maxCalls: MAX_MODEL_CALLS,
        // A clarifying question or a model that skipped its tools: show the text,
        // keep whatever cart the customer already has.
        onText: (text, finishReason) => {
          // A reply cut off by the token cap must never reach the guest half-written.
          const cutOff = finishReason === 'length';
          outcome = cutOff ? 'truncated' : 'clarify';
          const usable = cutOff ? '' : text.trim();
          return {
            reply:
              usable.slice(0, MAX_REPLY_CHARS) ||
              'Could you tell me a little more about what you would like?',
            constraints: input.constraints ?? {},
            proposal: null,
            unverified: unverifiedExisting,
            suggestions: [],
            edits: input.cart?.length
              ? computeEdits({
                  proposalItemIds: input.cart.map((l) => l.menuItemId),
                  catalog: catalogItems,
                  signals,
                  budget: input.constraints?.budget ?? null,
                  modelSuggestions: [],
                  constraints: input.constraints,
                  existingItemIds,
                })
              : [],
          };
        },
        onExhausted: () => {
          if (lastValid) {
            outcome = 'proposal';
            return finalize(lastValid, catalogItems, signals, existingItemIds);
          }
          outcome = 'exhausted';
          logger.warn('Assistant turn ended without a proposal', {
            tenantId: getCurrentTenantId(),
          });
          throw assistantUnavailable();
        },
        onToolCall: async (callItem, { finishReason }) => {
          let result: unknown;
          let finished = false;
          // Arguments of a cut-off turn are incomplete: never run them. Expected, not a defect.
          if (finishReason === 'length') {
            return {
              content: {
                error:
                  'Your previous reply was cut off before the tool arguments finished. Call the tool again with fewer items or shorter text.',
              },
            };
          }
          try {
            const raw = JSON.parse(callItem.function.arguments || '{}');
            switch (callItem.function.name) {
              case 'search_menu': {
                const args = searchArgs.parse(raw);
                result = searchCatalog(catalogItems, {
                  ...args,
                  minSpice: args.minSpice as SpiceLevel | undefined,
                  maxSpice: args.maxSpice as SpiceLevel | undefined,
                }).map((i) => summarizeForSearch(i, popular?.has(i.id)));
                break;
              }
              case 'get_item': {
                const item = catalog.get(itemArgs.parse(raw).id);
                result = item
                  ? describeItem(item, catalog, popular?.has(item.id))
                  : { error: 'Unknown dish id.' };
                break;
              }
              case 'quote_cart': {
                const { items } = quoteArgs.parse(raw);
                const invalid = validateLines(items, catalog);
                result = invalid ? { error: invalid } : money(await quote(items));
                break;
              }
              case 'propose_meal': {
                const args = proposeArgs.parse(raw);
                const merged = mergeConstraints(
                  input.constraints,
                  args.constraints,
                  input.released
                );
                const invalid =
                  validateLines(args.items, catalog) ??
                  hardLimitViolation(args.items, merged, catalog);
                if (invalid) {
                  result = {
                    error: `Rejected: ${invalid} Fix the cart and call propose_meal again.`,
                  };
                  break;
                }
                const q = await quote(args.items);
                const combined = validExisting.length
                  ? await quote([...validExisting, ...args.items])
                  : undefined;
                lastValid = {
                  lines: describeLines(args.items, catalog, popular),
                  constraints: merged,
                  reply: args.reply,
                  unverified: [...unverifiedExisting, ...(args.unverified ?? [])],
                  suggestions: sanitizeSuggestions(args.suggestions),
                  q,
                  combined,
                };
                const missingMain = mealShapeViolation(
                  [...validExisting, ...args.items],
                  merged,
                  catalogItems,
                  catalog
                );
                if (missingMain && mealShapePushbacks < MAX_MEAL_SHAPE_PUSHBACKS) {
                  mealShapePushbacks++;
                  result = { error: `Rejected: ${missingMain} Fix the cart and call propose_meal again.` };
                  break;
                }
                const budget = merged.budget;
                const spend = Number((combined ?? q).total);
                if (budget && spend > budget && budgetPushbacks < MAX_BUDGET_PUSHBACKS) {
                  budgetPushbacks++;
                  result = {
                    error: `Rejected: the final total is ₹${spend.toFixed(2)}, over the ₹${budget} budget. Choose cheaper dishes or fewer, or explain that the budget cannot be met.`,
                  };
                  break;
                }
                finished = true;
                result = { accepted: true };
                break;
              }
              default:
                result = { error: 'Unknown tool.' };
            }
          } catch (err) {
            const status = (err as { status?: number }).status;
            if (status === 503) throw err;
            const expected =
              err instanceof SyntaxError || err instanceof z.ZodError || (!!status && status < 500);
            if (!expected) reportSwallowed('assistant', 'tool_call')(err);
            // Quote refusals (closed, item unavailable) are facts the model should hear.
            result = {
              error:
                err instanceof SyntaxError
                  ? 'Your tool arguments were not valid JSON. Call the tool again.'
                  : err instanceof z.ZodError
                    ? 'Invalid arguments for this tool.'
                    : status && status < 500
                      ? (err as Error).message
                      : 'That check failed; try a different choice.',
            };
          }
          if (finished && lastValid) {
            outcome = 'proposal';
            return {
              content: result,
              done: finalize(lastValid, catalogItems, signals, existingItemIds),
            };
          }
          return { content: result };
        },
      })
    ).result;
  } finally {
    // One content-free line per turn on every exit path: counts and status only.
    logger.info('assistant.turn', {
      side: 'customer',
      restaurantId: getCurrentTenantId(),
      ...usage,
      outcome,
    });
  }
  return env.ASSISTANT_DEBUG_USAGE && env.NODE_ENV !== 'production'
    ? { ...turnResult, debug: { usage } }
    : turnResult;
}

function finalize(
  v: Proposal,
  catalogItems: CatalogItem[],
  signals: RestaurantSignals,
  existingItemIds: string[]
): CustomerTurnResult {
  const totals = money(v.q);
  const combinedQuote = v.combined ? money(v.combined) : undefined;
  const spend = (combinedQuote ?? totals).total;
  const withinBudget = v.constraints.budget ? spend <= v.constraints.budget : null;
  const note =
    withinBudget === false
      ? ` (Note: the total of ₹${spend.toFixed(2)} is above your ₹${v.constraints.budget} budget.)`
      : '';
  return {
    reply: `${v.reply.slice(0, MAX_REPLY_CHARS - note.length).trimEnd()}${note}`,
    constraints: v.constraints,
    proposal: {
      items: v.lines,
      quote: totals,
      withinBudget,
      readyInMinutes: readyInMinutes(v.lines),
      ...(combinedQuote && { combinedQuote }),
    },
    unverified: v.unverified,
    suggestions: v.suggestions,
    edits: computeEdits({
      proposalItemIds: v.lines.map((l) => l.menuItemId),
      catalog: catalogItems,
      signals,
      budget: v.constraints.budget ?? null,
      modelSuggestions: v.suggestions,
      constraints: v.constraints,
      existingItemIds,
    }),
  };
}
