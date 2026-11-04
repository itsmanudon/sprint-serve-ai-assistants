/**
 * The assistant's view of one restaurant's menu: a compact, model-friendly
 * projection of the public customer menu, plus pure search over it.
 *
 * Only facts the restaurant entered are exposed. Anything the menu does not
 * record (texture, "feeds four") stays unknown rather than being guessed, and
 * the model is told so. Prices here are listed menu prices; the canonical
 * quote, not this file, decides what the customer pays.
 */

export type SpiceLevel = 'NONE' | 'MILD' | 'MEDIUM' | 'HOT' | 'EXTRA_HOT';
const SPICE_RANK: Record<SpiceLevel, number> = {
  NONE: 0,
  MILD: 1,
  MEDIUM: 2,
  HOT: 3,
  EXTRA_HOT: 4,
};

/** Owner-set role of a menu category (Category.assistantRole). */
export type CategoryRole =
  | 'MAIN'
  | 'STARTER'
  | 'SIDE'
  | 'BREAD'
  | 'RICE'
  | 'DRINK'
  | 'DESSERT'
  | 'OTHER';
const CATEGORY_ROLES: readonly string[] = [
  'MAIN',
  'STARTER',
  'SIDE',
  'BREAD',
  'RICE',
  'DRINK',
  'DESSERT',
  'OTHER',
];

export interface CatalogVariant {
  id: string;
  name: string;
  price: number;
  isDefault: boolean;
}

export interface CatalogOptionGroup {
  id: string;
  name: string;
  required: boolean;
  minSelect: number;
  maxSelect: number | null;
  options: Array<{ id: string; name: string; additionalPrice: number }>;
}

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  /** Role the owner gave this dish's category; absent or null when none was set. */
  categoryRole?: CategoryRole | null;
  description: string | null;
  price: number;
  isVeg: boolean;
  containsEgg: boolean;
  spiceLevel: SpiceLevel;
  cuisine: string | null;
  servingSize: string | null;
  dietaryTags: string[];
  allergens: string[];
  variants: CatalogVariant[];
  optionGroups: CatalogOptionGroup[];
  /** Recorded preparation time in minutes; null when the restaurant did not enter one. */
  prepMinutes: number | null;
  featured: boolean;
  calories: number | null;
  /** Ids of dishes the restaurant paired with this one. */
  pairingIds: string[];
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number => {
  const n = Number(typeof v === 'object' && v !== null ? String(v) : v);
  return Number.isFinite(n) ? n : 0;
};
const posInt = (v: unknown): number | null => {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);

/**
 * Flatten the grouped public menu (`menuService.getMenuForCustomer()`). Items a
 * customer cannot order now are dropped, and GUIDED products are left out:
 * their step-by-step builder needs the normal menu screen, not a chat.
 */
export function toCatalog(categories: unknown): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const category of arr(categories)) {
    const categoryName = str(category.name) ?? 'Menu';
    const role = str(category.assistantRole);
    const categoryRole = role && CATEGORY_ROLES.includes(role) ? (role as CategoryRole) : null;
    for (const item of arr(category.items)) {
      if (item.isAvailable === false || item.customizationMode === 'GUIDED') continue;
      const id = str(item.id);
      const name = str(item.name);
      if (!id || !name) continue;
      const options = arr(item.options).filter((o) => o.isAvailable !== false);
      const optionGroups = arr(item.modifierGroups).map((g) => ({
        id: String(g.id),
        name: str(g.name) ?? 'Options',
        required: g.required === true,
        minSelect: num(g.minSelect),
        maxSelect: g.maxSelect === null || g.maxSelect === undefined ? null : num(g.maxSelect),
        options: options
          .filter((o) => o.groupId === g.id)
          .map((o) => ({
            id: String(o.id),
            name: str(o.name) ?? '',
            additionalPrice: num(o.additionalPrice),
          })),
      }));
      const level = str(item.spicyLevel) as SpiceLevel | null;
      out.push({
        id,
        name,
        category: categoryName,
        categoryRole,
        description: str(item.description),
        price: num(item.price),
        isVeg: item.isVeg === true,
        containsEgg: item.containsEgg === true,
        spiceLevel: level && level in SPICE_RANK ? level : 'NONE',
        cuisine: str(item.cuisine),
        servingSize: str(item.servingSize),
        dietaryTags: arr(item.dietaryTags)
          .map((t) => str((t.dietaryTag as Raw | undefined)?.name))
          .filter((t): t is string => !!t),
        allergens: [
          ...new Set([
            ...(Array.isArray(item.allergens) ? (item.allergens as unknown[]).map(str) : []),
            ...arr(item.allergenRefs).map((r) => str((r.allergen as Raw | undefined)?.name)),
          ]),
        ].filter((a): a is string => !!a),
        variants: arr(item.variants)
          .filter((v) => v.isAvailable !== false)
          .map((v) => ({
            id: String(v.id),
            name: str(v.name) ?? '',
            price: num(v.price),
            isDefault: v.isDefault === true,
          })),
        optionGroups,
        prepMinutes: posInt(item.preparationTime),
        featured: item.isFeatured === true,
        calories: posInt(item.calories),
        pairingIds: arr(item.pairings)
          .map((p) => str(p.id))
          .filter((p): p is string => !!p),
      });
    }
  }
  return out;
}

export interface CatalogFilters {
  query?: string;
  vegetarianOnly?: boolean;
  excludeEgg?: boolean;
  minSpice?: SpiceLevel;
  maxSpice?: SpiceLevel;
  cuisine?: string;
  category?: string;
  maxPrice?: number;
  limit?: number;
}

/** Lowest listed price a customer can pick for this dish. */
export function startingPrice(item: CatalogItem): number {
  return item.variants.length ? Math.min(...item.variants.map((v) => v.price)) : item.price;
}

/**
 * Structured filtering, not semantic search. Strict-vegetarian excludes egg
 * dishes too: `isVeg=false, containsEgg=true` is how the menu records them, so
 * a vegetarian filter on `isVeg` alone already holds, and `excludeEgg` guards
 * any legacy row marked veg with an egg.
 */
export function searchCatalog(items: CatalogItem[], f: CatalogFilters): CatalogItem[] {
  const terms = (f.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  const has = (hay: string | null, needle?: string) =>
    !needle || (hay ?? '').toLowerCase().includes(needle.trim().toLowerCase());
  const scored = items
    .filter((i) => !f.vegetarianOnly || (i.isVeg && !i.containsEgg))
    .filter((i) => !f.excludeEgg || !i.containsEgg)
    .filter((i) => !f.minSpice || SPICE_RANK[i.spiceLevel] >= SPICE_RANK[f.minSpice])
    .filter((i) => !f.maxSpice || SPICE_RANK[i.spiceLevel] <= SPICE_RANK[f.maxSpice])
    .filter((i) => has(i.cuisine, f.cuisine) || has(i.category, f.cuisine))
    .filter((i) => has(i.category, f.category))
    .filter((i) => f.maxPrice === undefined || startingPrice(i) <= f.maxPrice)
    .map((i) => {
      const text = [i.name, i.category, i.cuisine, i.description, ...i.dietaryTags]
        .join(' ')
        .toLowerCase();
      return { i, score: terms.length ? terms.filter((t) => text.includes(t)).length : 1 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || startingPrice(a.i) - startingPrice(b.i));
  return scored.slice(0, Math.min(Math.max(f.limit ?? 12, 1), 15)).map((s) => s.i);
}

/** Paired dishes that are orderable now, in the order the restaurant recorded them. */
export function availablePairings(
  item: CatalogItem,
  catalog: Map<string, CatalogItem>
): CatalogItem[] {
  return [...new Set(item.pairingIds)]
    .map((id) => catalog.get(id))
    .filter((p): p is CatalogItem => !!p && p.id !== item.id);
}

/**
 * Recorded facts shared by search hits, get_item and the snapshot. `popular` is
 * passed only when the restaurant has enough completed orders to say it, and is
 * omitted otherwise.
 */
const recordedFacts = (item: CatalogItem, popular?: boolean) => ({
  prepMinutes: item.prepMinutes,
  featured: item.featured,
  ...(popular !== undefined && { popular }),
});

/** Compact search hit: only what the model needs to choose and propose a dish. */
export function summarizeForSearch(item: CatalogItem, popular?: boolean) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    startingPrice: startingPrice(item),
    veg: item.isVeg,
    egg: item.containsEgg,
    spice: item.spiceLevel,
    serves: item.servingSize ?? 'not stated',
    hasRequiredChoices: item.optionGroups.some((g) => g.required || g.minSelect > 0),
    variants: item.variants.map((v) => ({ id: v.id, name: v.name, price: v.price })),
    ...recordedFacts(item, popular),
  };
}

/** Full detail for one dish (get_item): short, factual, no internal fields. */
export function summarize(item: CatalogItem, popular?: boolean) {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    startingPrice: startingPrice(item),
    veg: item.isVeg,
    egg: item.containsEgg,
    spice: item.spiceLevel,
    cuisine: item.cuisine,
    serves: item.servingSize ?? 'not stated',
    tags: item.dietaryTags,
    allergens: item.allergens,
    ...(item.calories !== null && { calories: item.calories }),
    hasRequiredChoices: item.optionGroups.some((g) => g.required || g.minSelect > 0),
    variants: item.variants.map((v) => ({ id: v.id, name: v.name, price: v.price })),
    ...recordedFacts(item, popular),
  };
}
