import { availablePairings, startingPrice, type CatalogItem } from './catalog';
import { findProfileSource } from './profile.repository';
import { POPULAR_MIN_ORDERS, type RestaurantSignals } from './signals';

/**
 * What the chef persona knows about the restaurant as a whole, and the compact
 * menu snapshot that lets most turns be answered in one model call. Everything
 * here comes from the restaurant's own records.
 */
export interface RestaurantProfile {
  name: string;
  cuisines: string[];
  /** Categories in menu order, available dishes only. */
  categories: string[];
  /** Owner's house notes: trimmed, at most CHEF_NOTES_MAX chars. Data, not instructions. */
  chefNotes: string | null;
  /** True when any available dish has a recorded serving size. */
  servingSizesRecorded: boolean;
  /** True when every available dish has a recorded serving size. */
  servingSizesComplete: boolean;
  /** True when the owner set a role on at least one category with an available dish. */
  rolesRecorded: boolean;
}

export const CHEF_NOTES_MAX = 1000;
export const SNAPSHOT_MAX_DISHES = 120;

export async function loadProfile(catalog: CatalogItem[]): Promise<RestaurantProfile> {
  const source = await findProfileSource();
  const notes = source.chefNotes?.trim().slice(0, CHEF_NOTES_MAX).trim() || null;
  return {
    name: source.name?.trim() || 'this restaurant',
    cuisines: [...new Set(catalog.map((i) => i.cuisine).filter((c): c is string => !!c))].slice(
      0,
      12
    ),
    categories: [...new Set(catalog.map((i) => i.category))].slice(0, 40),
    chefNotes: notes,
    servingSizesRecorded: catalog.some((i) => !!i.servingSize),
    servingSizesComplete: catalog.length > 0 && catalog.every((i) => !!i.servingSize),
    rolesRecorded: catalog.some((i) => !!i.categoryRole),
  };
}

/** Restaurant text on one line, without the column separator. */
export const flat = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();

const rupees = (n: number) => `₹${Number.isInteger(n) ? n : n.toFixed(2)}`;

/**
 * Dishes the model may call popular: this restaurant's top sellers, but only
 * once it has POPULAR_MIN_ORDERS completed orders. Null means "do not say".
 */
export function popularIds(signals: RestaurantSignals): Set<string> | null {
  return signals.completedOrders30d >= POPULAR_MIN_ORDERS ? new Set(signals.topItemIds) : null;
}

const MAX_SNAPSHOT_PAIRS = 3;

function snapshotLine(item: CatalogItem, popular: boolean, byId: Map<string, CatalogItem>): string {
  const pairs = availablePairings(item, byId)
    .slice(0, MAX_SNAPSHOT_PAIRS)
    .map((p) => p.id);
  const price = item.variants.length
    ? item.variants.map((v) => `${flat(v.name)} ${rupees(v.price)} (variantId ${v.id})`).join(', ')
    : rupees(startingPrice(item));
  const diet = item.containsEgg ? 'egg' : item.isVeg ? 'veg' : 'non-veg';
  const cols = [
    item.id,
    flat(item.name),
    flat(item.category),
    price,
    diet,
    // The enum keys the prompt's heat rule and the search_menu tool use.
    item.spiceLevel === 'NONE' ? '-' : item.spiceLevel,
    item.servingSize ? flat(item.servingSize) : '-',
    item.prepMinutes ? `~${item.prepMinutes} min` : '-',
    popular ? 'popular' : '-',
    item.featured ? 'featured' : '-',
    pairs.length ? pairs.join(', ') : '-',
    item.categoryRole ? item.categoryRole.toLowerCase() : '-',
  ];
  if (item.optionGroups.some((g) => g.required || g.minSelect > 0))
    cols.push('choices required: use get_item');
  return cols.join(' | ');
}

/**
 * One line per orderable dish. Over `max`, featured dishes and top sellers are
 * kept first, then menu order, and the model is told to search for the rest.
 * "popular" is only printed once the restaurant has enough completed orders.
 */
export function buildMenuSnapshot(
  catalog: CatalogItem[],
  signals: RestaurantSignals,
  max = SNAPSHOT_MAX_DISHES
): string {
  const popular = popularIds(signals);
  const byId = new Map(catalog.map((i) => [i.id, i]));
  let dishes = catalog;
  const truncated = catalog.length > max;
  if (truncated) {
    const first = [
      ...catalog.filter((i) => i.featured),
      ...signals.topItemIds.map((id) => byId.get(id)).filter((i): i is CatalogItem => !!i),
    ];
    dishes = [...new Set([...first, ...catalog])].slice(0, max);
  }
  const lines = [
    'Menu snapshot (id | name | category | price | diet | spice | serves | prep | popular | featured | pairs | role; "-" means not recorded; pairs = paired dish ids; role = owner-set category role):',
    ...dishes.map((i) => snapshotLine(i, !!popular?.has(i.id), byId)),
  ];
  if (truncated) lines.push('Menu truncated; use search_menu for other dishes.');
  return lines.join('\n');
}
