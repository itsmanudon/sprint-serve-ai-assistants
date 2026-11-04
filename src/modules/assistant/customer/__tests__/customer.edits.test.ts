import { describe, expect, it } from 'vitest';
import { computeEdits } from '../customer.edits';
import type { CatalogItem, SpiceLevel } from '../../catalog/catalog';
import type { RestaurantSignals } from '../../catalog/signals';

const dish = (id: string, category: string, spiceLevel: SpiceLevel = 'NONE'): CatalogItem =>
  ({ id, name: id, category, spiceLevel }) as CatalogItem;

const signals = (categoryShare: Record<string, number> = {}): RestaurantSignals => ({
  completedOrders30d: 0,
  topItemIds: [],
  categoryShare,
  prepCoverage: 0,
});

const cafe = [
  dish('Latte', 'Coffee'),
  dish('Sandwich', 'Snacks'),
  dish('Brownie', 'Desserts'),
];
const base = { catalog: cafe, signals: signals(), budget: null, modelSuggestions: [] };
const labels = (e: { label: string }[]) => e.map((x) => x.label);

describe('computeEdits', () => {
  it('offers the uncovered categories of a cafe, ranked by share, never the covered one', () => {
    const edits = computeEdits({
      ...base,
      proposalItemIds: ['Latte'],
      signals: signals({ Coffee: 0.5, Snacks: 0.1, Desserts: 0.4 }),
    });
    expect(labels(edits)).toEqual(['+ Desserts', '+ Snacks']);
    expect(edits[0]).toEqual({
      label: '+ Desserts',
      message: 'Add something from Desserts',
      kind: 'category',
    });
  });

  it('falls back to menu order when there is no share data', () => {
    expect(labels(computeEdits({ ...base, proposalItemIds: ['Latte'] }))).toEqual([
      '+ Snacks',
      '+ Desserts',
    ]);
  });

  it('stops offering a category once the proposal covers it', () => {
    const menu = [dish('Curry', 'Mains'), dish('Gulab', 'Desserts'), dish('Naan', 'Breads')];
    const edits = computeEdits({ ...base, catalog: menu, proposalItemIds: ['Curry', 'Gulab'] });
    expect(labels(edits)).not.toContain('+ Desserts');
    expect(labels(edits)).toContain('+ Breads');
  });

  it('shows Cheaper only with a budget or more than one dish', () => {
    expect(labels(computeEdits({ ...base, proposalItemIds: ['Latte'] }))).not.toContain('Cheaper');
    expect(labels(computeEdits({ ...base, proposalItemIds: ['Latte'], budget: 300 }))).toContain('Cheaper');
    expect(labels(computeEdits({ ...base, proposalItemIds: ['Latte', 'Sandwich'] }))).toContain('Cheaper');
    const c = computeEdits({ ...base, proposalItemIds: ['Latte'], budget: 300 }).find((e) => e.kind === 'cheaper');
    expect(c).toEqual({ label: 'Cheaper', message: 'Make it cheaper', kind: 'cheaper' });
  });

  it('shows Less spicy only when a proposed dish is MEDIUM or hotter', () => {
    const menu = [dish('Mild', 'Mains', 'MILD'), dish('Med', 'Mains', 'MEDIUM'), dish('Hot', 'Mains', 'HOT')];
    const run = (ids: string[]) => labels(computeEdits({ ...base, catalog: menu, proposalItemIds: ids }));
    expect(run(['Mild'])).not.toContain('Less spicy');
    expect(run(['Med'])).toContain('Less spicy');
    expect(run(['Hot'])).toContain('Less spicy');
  });

  it('drops model suggestions that add something already in the proposal', () => {
    const menu = [dish('Curry', 'Mains'), dish('Gulab Jamun', 'Desserts')];
    const edits = computeEdits({
      ...base,
      catalog: menu,
      proposalItemIds: ['Curry', 'Gulab Jamun'],
      modelSuggestions: ['Add Gulab Jamun', 'add a desserts item', 'Swap curry for rice'],
    });
    const s = edits.filter((e) => e.kind === 'suggestion').map((e) => e.label);
    expect(s).toEqual(['Swap curry for rice']);
    expect(edits.find((e) => e.kind === 'suggestion')).toMatchObject({
      label: 'Swap curry for rice',
      message: 'Swap curry for rice',
    });
  });

  it('reserves a slot for the first model suggestion', () => {
    const menu = ['A', 'B', 'C', 'D'].map((c) => dish(`${c}1`, c, 'HOT'));
    const edits = computeEdits({
      ...base,
      catalog: menu,
      proposalItemIds: ['A1', 'B1'],
      budget: 100,
      modelSuggestions: ['Swap one', 'Swap two'],
    });
    expect(edits.map((e) => e.kind)).toEqual(['category', 'category', 'cheaper', 'suggestion']);
    expect(edits[3].label).toBe('Swap one');
  });

  it('fills spare slots with further suggestions', () => {
    const edits = computeEdits({ ...base, proposalItemIds: ['Latte'], modelSuggestions: ['Swap one', 'Swap two', 'Swap three'] });
    expect(labels(edits)).toEqual(['+ Snacks', '+ Desserts', 'Swap one', 'Swap two']);
  });

  it('matches names as whole phrases, not substrings', () => {
    const menu = [dish('Naan', 'Breads'), dish('Garlic Naan', 'Breads'), dish('Chai', 'Tea'), dish('Momos', 'Snacks')];
    const run = (ids: string[], s: string) =>
      labels(computeEdits({ ...base, catalog: menu, proposalItemIds: ids, modelSuggestions: [s] })).includes(s);
    expect(run(['Naan'], 'Add Garlic Naan')).toBe(true);
    expect(run(['Chai'], 'Add steamed momos')).toBe(true);
    expect(run(['Naan'], 'Add naan')).toBe(false);
  });

  it('drops "add" suggestions across plural, punctuation and lead-in phrasing', () => {
    const menu = [dish('Naan', 'Breads'), dish('Gulab', 'Desserts'), dish('Momos', 'Snacks'), dish('Chai', 'Tea')];
    const kept = (ids: string[], s: string) =>
      labels(computeEdits({ ...base, catalog: menu, proposalItemIds: ids, modelSuggestions: [s] })).includes(s);
    expect(kept(['Gulab'], 'Add a dessert')).toBe(false);
    expect(kept(['Naan'], 'Add naans')).toBe(false);
    expect(kept(['Momos'], 'Add an item from Snacks')).toBe(false);
    expect(kept(['Naan'], 'Add naan?')).toBe(false);
    expect(kept(['Gulab'], 'Add something from Desserts.')).toBe(false);
    expect(kept(['Naan'], 'Add Garlic Naan')).toBe(true);
    expect(kept(['Chai'], 'Add steamed momos')).toBe(true);
  });

  it('dedupes and caps at four', () => {
    const menu = ['A', 'B', 'C', 'D'].map((c) => dish(`${c}1`, c, 'HOT'));
    const edits = computeEdits({
      ...base,
      catalog: menu,
      proposalItemIds: ['A1', 'B1'],
      budget: 100,
      modelSuggestions: ['x', 'y'],
    });
    expect(edits).toHaveLength(4);
    expect(new Set(labels(edits)).size).toBe(4);
  });

  it('ignores proposal ids that are not in the catalog', () => {
    expect(() => computeEdits({ ...base, proposalItemIds: ['ghost'] })).not.toThrow();
  });

  describe('swap and "also add" suggestions', () => {
    const menu = [
      dish('Jeera Rice', 'Rice'),
      dish('Dal Makhani', 'Mains'),
      dish('Naan', 'Breads'),
      dish('Butter Naan', 'Breads'),
    ];
    const kept = (ids: string[], s: string) =>
      labels(computeEdits({ ...base, catalog: menu, proposalItemIds: ids, modelSuggestions: [s] })).includes(s);

    it('drops a swap to a dish the proposal already has', () => {
      expect(kept(['Jeera Rice', 'Dal Makhani'], 'Swap rice for Jeera Rice')).toBe(false);
      expect(kept(['Dal Makhani'], 'Replace dal with Dal Makhani.')).toBe(false);
      expect(kept(['Jeera Rice'], 'Change the rice to jeera rice')).toBe(false);
      expect(kept(['Naan'], 'Try naan instead')).toBe(false);
      expect(kept(['Naan'], 'Get a naan instead')).toBe(false);
    });

    it('keeps a swap to a dish the proposal does not have', () => {
      expect(kept(['Jeera Rice', 'Naan'], 'Swap rice for Butter Naan')).toBe(true);
      expect(kept(['Naan'], 'Try Dal Makhani instead')).toBe(true);
    });

    it('drops "also add X" and "add X too / as well" when X is proposed', () => {
      expect(kept(['Naan'], 'Also add naan')).toBe(false);
      expect(kept(['Naan'], 'Add naan too')).toBe(false);
      expect(kept(['Naan'], 'Add naan as well')).toBe(false);
      expect(kept(['Naan'], 'Also add Dal Makhani')).toBe(true);
    });
  });

  describe('hard limits', () => {
    const veg = (id: string, category: string): CatalogItem =>
      ({ id, name: id, category, spiceLevel: 'NONE', isVeg: true, containsEgg: false }) as CatalogItem;
    const nonVeg = (id: string, category: string): CatalogItem =>
      ({ id, name: id, category, spiceLevel: 'NONE', isVeg: false, containsEgg: false }) as CatalogItem;
    const egg = (id: string, category: string): CatalogItem =>
      ({ id, name: id, category, spiceLevel: 'NONE', isVeg: false, containsEgg: true }) as CatalogItem;
    const menu = [
      veg('Paneer', 'Mains'),
      nonVeg('Kebab', 'Grill'),
      egg('Omelette', 'Eggs'),
      veg('Kulfi', 'Desserts'),
    ];

    it('never offers a category with no dish passing the vegetarian limit', () => {
      const edits = computeEdits({
        ...base,
        catalog: menu,
        proposalItemIds: ['Paneer'],
        constraints: { vegetarian: true },
      });
      expect(labels(edits)).toEqual(['+ Desserts']);
    });

    it('never offers an egg-only category under no-egg, but still offers non-veg', () => {
      const edits = computeEdits({ ...base, catalog: menu, proposalItemIds: ['Paneer'], constraints: { noEgg: true } });
      expect(labels(edits)).toEqual(['+ Grill', '+ Desserts']);
    });

    it('offers every category without limits', () => {
      const edits = computeEdits({ ...base, catalog: menu, proposalItemIds: ['Paneer'] });
      expect(labels(edits)).toEqual(['+ Grill', '+ Eggs']);
    });
  });

  describe('existing takeaway cart', () => {
    const menu = [dish('Curry', 'Mains'), dish('Gulab Jamun', 'Desserts'), dish('Naan', 'Breads')];

    it('treats categories in the existing cart as covered', () => {
      const edits = computeEdits({ ...base, catalog: menu, proposalItemIds: ['Curry'], existingItemIds: ['Gulab Jamun'] });
      expect(labels(edits)).toEqual(['+ Breads']);
    });

    it('drops suggestions adding a dish already in the existing cart', () => {
      const edits = computeEdits({
        ...base,
        catalog: menu,
        proposalItemIds: ['Curry'],
        existingItemIds: ['Naan'],
        modelSuggestions: ['Add naan', 'Add Gulab Jamun'],
      });
      expect(edits.filter((e) => e.kind === 'suggestion').map((e) => e.label)).toEqual(['Add Gulab Jamun']);
    });

    it('ignores existing ids that are not in the catalog', () => {
      expect(() => computeEdits({ ...base, catalog: menu, proposalItemIds: ['Curry'], existingItemIds: ['ghost'] })).not.toThrow();
    });
  });
});
