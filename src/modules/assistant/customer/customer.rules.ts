import { availablePairings, summarize, type CatalogItem } from '../catalog/catalog';
import type { CartLine, Constraints, ReleasableConstraint } from './customer.types';

/**
 * Replies come back to the server as conversation history, where each message is
 * capped at 1,000 characters; 900 leaves room so a long reply never breaks a turn.
 */
export const MAX_REPLY_CHARS = 900;

export interface ProposedLine extends CartLine {
  name: string;
  variantName: string | null;
  optionNames: string[];
  /** Variant price (or dish price) plus selected option deltas, per unit. */
  unitPrice: number;
  /** True only when the restaurant has enough orders AND this dish is a top seller. */
  popular: boolean;
  /** Recorded preparation minutes, or null. */
  prepMinutes: number | null;
}

/**
 * get_item: full detail plus the dishes the restaurant paired with this one,
 * resolved against the live catalog so an unavailable pairing is never offered.
 */
export function describeItem(
  item: CatalogItem,
  catalog: Map<string, CatalogItem>,
  popular?: boolean
) {
  return {
    ...summarize(item, popular),
    description: item.description?.slice(0, 300) ?? null,
    pairsWith: availablePairings(item, catalog).map((p) => ({ id: p.id, name: p.name })),
    optionGroups: item.optionGroups,
  };
}

/** Rejects anything that is not exactly a real, orderable selection. */
export function validateLines(lines: CartLine[], catalog: Map<string, CatalogItem>): string | null {
  for (const line of lines) {
    const item = catalog.get(line.menuItemId);
    if (!item) return `Unknown dish id ${line.menuItemId}. Use ids from search_menu.`;
    if (item.variants.length && !item.variants.some((v) => v.id === line.variantId))
      return `${item.name} needs one of its variant ids.`;
    if (!item.variants.length && line.variantId) return `${item.name} has no variants.`;
    const optionIds = new Set(item.optionGroups.flatMap((g) => g.options.map((o) => o.id)));
    if ((line.selectedOptions ?? []).some((id) => !optionIds.has(id)))
      return `Unknown option for ${item.name}.`;
  }
  return null;
}

/**
 * The model may tighten a limit, never loosen one; only the customer removing a
 * chip (`released`, sent on that turn alone) loosens it. Without this a model
 * echo of `vegetarian: false` would be sent back as the customer's own value and
 * block a later "make it veg".
 */
export function mergeConstraints(
  customer: Constraints | undefined,
  model: Constraints,
  released: ReleasableConstraint[] = []
): Constraints {
  const c = customer ?? {};
  const merged: Constraints = {};
  for (const key of ['vegetarian', 'noEgg'] as const) {
    if (c[key] === true || (model[key] === true && !released.includes(key))) merged[key] = true;
    else if (c[key] !== undefined) merged[key] = c[key];
    else if (model[key] !== undefined) merged[key] = model[key];
  }
  if (released.includes('budget')) merged.budget = null;
  else if (typeof c.budget === 'number' && typeof model.budget === 'number')
    merged.budget = Math.min(c.budget, model.budget);
  else if (typeof c.budget === 'number') merged.budget = c.budget;
  else if (typeof model.budget === 'number') merged.budget = model.budget;
  else if (c.budget !== undefined) merged.budget = c.budget;
  // Soft preferences: the model's reading of the latest message wins.
  // Pills are the customer's preference: their value wins; the model may only fill an unset one.
  for (const key of ['popular', 'fast'] as const) {
    if (released.includes(key)) merged[key] = false;
    else if (c[key] !== undefined) merged[key] = c[key];
    else if (model[key] !== undefined) merged[key] = model[key];
  }
  if (model.people != null) merged.people = model.people;
  else if (c.people !== undefined) merged.people = c.people;
  if (model.preferences !== undefined) merged.preferences = model.preferences;
  else if (c.preferences !== undefined) merged.preferences = c.preferences;
  return merged;
}

/** Why one dish breaks the vegetarian / no-egg limits, or null when it passes. */
export function itemLimitViolation(item: CatalogItem, constraints: Constraints): string | null {
  if (constraints.vegetarian && (!item.isVeg || item.containsEgg))
    return `${item.name} is not vegetarian.`;
  if (constraints.noEgg && item.containsEgg) return `${item.name} contains egg.`;
  return null;
}

export function hardLimitViolation(
  lines: CartLine[],
  constraints: Constraints,
  catalog: Map<string, CatalogItem>
) {
  for (const line of lines) {
    const violation = itemLimitViolation(catalog.get(line.menuItemId)!, constraints);
    if (violation) return violation;
  }
  return null;
}

export const MEAL_SHAPE_MESSAGE = 'Include a main course (role MAIN) for this group.';

/**
 * Owner-set roles make "a main for the group" checkable. Returns the push-back
 * message when roles are recorded, the group is two or more, no line (proposed
 * or already in the cart) sits in a MAIN category, and an available MAIN dish
 * passes the guest's limits; otherwise null.
 */
export function mealShapeViolation(
  lines: CartLine[],
  constraints: Constraints,
  catalogItems: CatalogItem[],
  catalog: Map<string, CatalogItem>
): string | null {
  if (!catalogItems.some((i) => i.categoryRole)) return null;
  if ((constraints.people ?? 1) < 2) return null;
  if (lines.some((l) => catalog.get(l.menuItemId)?.categoryRole === 'MAIN')) return null;
  const eligible = catalogItems.some(
    (i) => i.categoryRole === 'MAIN' && itemLimitViolation(i, constraints) === null
  );
  return eligible ? MEAL_SHAPE_MESSAGE : null;
}

export const MAX_SUGGESTIONS = 4;
export const MAX_SUGGESTION_LENGTH = 40;

export function sanitizeSuggestions(raw: unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw ?? []) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    const key = text.toLowerCase();
    if (!text || text.length > MAX_SUGGESTION_LENGTH || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

export function describeLines(
  lines: CartLine[],
  catalog: Map<string, CatalogItem>,
  popular?: Set<string> | null
): ProposedLine[] {
  return lines.map((line) => {
    const item = catalog.get(line.menuItemId)!;
    const options = item.optionGroups.flatMap((g) => g.options);
    const base = item.variants.find((v) => v.id === line.variantId)?.price ?? item.price;
    const extras = (line.selectedOptions ?? []).reduce(
      (sum, id) => sum + (options.find((o) => o.id === id)?.additionalPrice ?? 0),
      0
    );
    return {
      ...line,
      name: item.name,
      variantName: item.variants.find((v) => v.id === line.variantId)?.name ?? null,
      optionNames: (line.selectedOptions ?? []).map(
        (id) => options.find((o) => o.id === id)?.name ?? ''
      ),
      unitPrice: Math.round((base + extras) * 100) / 100,
      popular: popular?.has(item.id) ?? false,
      prepMinutes: item.prepMinutes,
    };
  });
}

/** Longest recorded prep over the lines; null if any line has none. */
export function readyInMinutes(lines: ProposedLine[]): number | null {
  if (!lines.length || lines.some((l) => l.prepMinutes === null)) return null;
  return Math.max(...lines.map((l) => l.prepMinutes as number));
}
