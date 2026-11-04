import type { CatalogItem, SpiceLevel } from '../catalog/catalog';
import type { RestaurantSignals } from '../catalog/signals';
import { itemLimitViolation } from './customer.rules';
import type { Constraints } from './customer.types';

/**
 * The one-tap edit buttons under a proposal, computed from THIS restaurant's
 * own menu: no category name is hard-coded, and a category the cart already
 * covers is never offered. The model's own suggestions are appended last.
 */
export interface Edit {
  label: string;
  message: string;
  kind: 'category' | 'cheaper' | 'spice' | 'suggestion';
}

export const MAX_EDITS = 4;
const MAX_CATEGORY_EDITS = 2;
const SPICY: ReadonlySet<SpiceLevel> = new Set(['MEDIUM', 'HOT', 'EXTRA_HOT']);

export function computeEdits(input: {
  proposalItemIds: string[];
  catalog: CatalogItem[];
  signals: RestaurantSignals;
  budget: number | null;
  modelSuggestions: string[];
  /** Merged limits: a category is offered only if one of its dishes passes them. */
  constraints?: Constraints;
  /** Valid lines already in the takeaway cart: they count as covered and present. */
  existingItemIds?: string[];
}): Edit[] {
  const { proposalItemIds, catalog, signals, budget, modelSuggestions } = input;
  const constraints = input.constraints ?? {};
  const byId = new Map(catalog.map((i) => [i.id, i]));
  const proposed = proposalItemIds.flatMap((id) => byId.get(id) ?? []);
  const inCart = [
    ...proposed,
    ...(input.existingItemIds ?? []).flatMap((id) => byId.get(id) ?? []),
  ];
  const covered = new Set(inCart.map((i) => i.category));
  // Same predicate the server applies to a proposal: never offer a category the limits empty.
  const allowed = new Set(
    catalog.filter((i) => itemLimitViolation(i, constraints) === null).map((i) => i.category)
  );

  // Menu order is the tie-break: Array.sort is stable.
  const menuOrder = [...new Set(catalog.map((i) => i.category))];
  const edits: Edit[] = menuOrder
    .filter((c) => !covered.has(c) && allowed.has(c))
    .sort((a, b) => (signals.categoryShare[b] ?? 0) - (signals.categoryShare[a] ?? 0))
    .slice(0, MAX_CATEGORY_EDITS)
    .map((c) => ({ label: `+ ${c}`, message: `Add something from ${c}`, kind: 'category' }));

  if ((budget ?? 0) > 0 || proposalItemIds.length > 1)
    edits.push({ label: 'Cheaper', message: 'Make it cheaper', kind: 'cheaper' });
  if (proposed.some((i) => SPICY.has(i.spiceLevel)))
    edits.push({ label: 'Less spicy', message: 'Make it less spicy', kind: 'spice' });

  // A suggestion whose target the cart already has is noise: "Add X", "Also add X",
  // "Add X too", "Swap A for X", "Try X instead". X must BE a dish in the cart or a
  // covered category (so "Add Garlic Naan" survives a proposed "Naan").
  // Compare names loosely: case, trailing punctuation and a singular/plural last word.
  const normalize = (raw: string): string => {
    const words = raw
      .toLowerCase()
      .replace(/[.!?,;\s]+$/, '')
      .trim()
      .split(/\s+/);
    const last = words.length - 1;
    if (/(?:[sxz]|ch|sh)es$/.test(words[last])) words[last] = words[last].slice(0, -2);
    else if (words[last].length > 3 && words[last].endsWith('s'))
      words[last] = words[last].slice(0, -1);
    return words.join(' ');
  };
  const present = new Set([...inCart.map((i) => i.name), ...covered].map(normalize));
  const target = (text: string): string | null =>
    /^\s*(?:also\s+)?add\s+(.*?)(?:[,\s]+(?:too|as well))?[.!?,;\s]*$/i.exec(text)?.[1] ??
    /^\s*(?:swap|replace|change)\s+.+?\s+(?:for|with|to)\s+(.+)$/i.exec(text)?.[1] ??
    /^\s*(?:try|get)\s+(.+?)\s+instead[.!?,;\s]*$/i.exec(text)?.[1] ??
    null;
  const targetsPresent = (text: string): boolean => {
    const raw = target(text);
    if (raw === null) return false;
    const object = raw
      .toLowerCase()
      .replace(/^(?:(?:an?|the|some|any|more|another)\s+)+/, '')
      .replace(/^(?:something|an item|one|a dish|item|dish)\s+from\s+/, '')
      .replace(/\s+(?:items?|dish(?:es)?)[.!?,;\s]*$/, '');
    return object.trim() !== '' && present.has(normalize(object));
  };
  const suggestions: Edit[] = modelSuggestions
    .filter((s) => !targetsPresent(s))
    .map((s) => ({ label: s, message: s, kind: 'suggestion' }));

  const dedupe = (list: Edit[]) => {
    const seen = new Set<string>();
    return list.filter((e) => {
      const key = e.label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const fixed = dedupe(edits);
  const fixedKeys = new Set(fixed.map((e) => e.label.toLowerCase()));
  const extra = dedupe(suggestions).filter((e) => !fixedKeys.has(e.label.toLowerCase()));
  if (!extra.length) return fixed.slice(0, MAX_EDITS);
  // Reserve a slot so the model's own suggestion is never crowded out.
  const kept = fixed.slice(0, MAX_EDITS - 1);
  return [...kept, ...extra].slice(0, MAX_EDITS);
}
