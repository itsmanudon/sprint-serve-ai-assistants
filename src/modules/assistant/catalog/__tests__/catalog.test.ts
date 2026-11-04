import { describe, expect, it } from 'vitest';
import { searchCatalog, startingPrice, summarize, summarizeForSearch, toCatalog } from '../catalog';

const menu = [
  {
    name: 'Chinese',
    items: [
      { id: 'hakka', name: 'Veg Hakka Noodles', price: '220.00', isVeg: true, spicyLevel: 'MEDIUM', cuisine: 'Chinese', servingSize: 'Serves 2', isAvailable: true },
      { id: 'chilli-paneer', name: 'Chilli Paneer Dry', price: '280', isVeg: true, spicyLevel: 'HOT', cuisine: 'Chinese', isAvailable: true,
        dietaryTags: [{ dietaryTag: { name: 'Spicy' } }], allergens: ['Dairy'], allergenRefs: [{ allergen: { name: 'Soy' } }] },
      { id: 'egg-rice', name: 'Egg Fried Rice', price: 200, isVeg: false, containsEgg: true, spicyLevel: 'MILD', cuisine: 'Chinese', isAvailable: true },
      { id: 'chicken', name: 'Chilli Chicken', price: 320, isVeg: false, spicyLevel: 'EXTRA_HOT', cuisine: 'Chinese', isAvailable: true },
      { id: 'sold-out', name: 'Veg Manchurian', price: 240, isVeg: true, isAvailable: false },
      { id: 'guided', name: 'Build Your Bowl', price: 300, isVeg: true, isAvailable: true, customizationMode: 'GUIDED' },
    ],
  },
  {
    name: 'Drinks',
    items: [
      {
        id: 'lime', name: 'Fresh Lime Soda', price: 0, isVeg: true, isAvailable: true,
        variants: [
          { id: 'small', name: 'Small', price: '60', isDefault: true },
          { id: 'large', name: 'Large', price: '90' },
          { id: 'gone', name: 'Jug', price: '200', isAvailable: false },
        ],
        modifierGroups: [{ id: 'g1', name: 'Style', required: true, minSelect: 1, maxSelect: 1 }],
        options: [
          { id: 'sweet', name: 'Sweet', additionalPrice: 0, groupId: 'g1' },
          { id: 'salted', name: 'Salted', additionalPrice: '0', groupId: 'g1' },
          { id: 'hidden', name: 'Masala', additionalPrice: 10, groupId: 'g1', isAvailable: false },
        ],
      },
    ],
  },
];

describe('assistant catalog', () => {
  const catalog = toCatalog(menu);

  it('keeps only orderable, non-guided dishes with the facts the menu records', () => {
    expect(catalog.map((i) => i.id)).toEqual(['hakka', 'chilli-paneer', 'egg-rice', 'chicken', 'lime']);
    const paneer = catalog.find((i) => i.id === 'chilli-paneer')!;
    expect(paneer).toMatchObject({ price: 280, spiceLevel: 'HOT', dietaryTags: ['Spicy'] });
    expect(paneer.allergens.sort()).toEqual(['Dairy', 'Soy']);
  });

  it('drops unavailable variants and options and groups options under their rule', () => {
    const lime = catalog.find((i) => i.id === 'lime')!;
    expect(lime.variants.map((v) => v.id)).toEqual(['small', 'large']);
    expect(lime.optionGroups[0]).toMatchObject({ required: true, minSelect: 1 });
    expect(lime.optionGroups[0].options.map((o) => o.id)).toEqual(['sweet', 'salted']);
    expect(startingPrice(lime)).toBe(60);
  });

  it('vegetarian search never returns meat or egg dishes', () => {
    const ids = searchCatalog(catalog, { vegetarianOnly: true }).map((i) => i.id);
    expect(ids).not.toContain('chicken');
    expect(ids).not.toContain('egg-rice');
  });

  it('filters by spice range, cuisine and listed price, cheapest first among equal matches', () => {
    const spicyVeg = searchCatalog(catalog, { vegetarianOnly: true, minSpice: 'MEDIUM', cuisine: 'chinese' });
    expect(spicyVeg.map((i) => i.id)).toEqual(['hakka', 'chilli-paneer']);
    expect(searchCatalog(catalog, { maxPrice: 210 }).map((i) => i.id)).toEqual(['lime', 'egg-rice']);
  });

  it('ranks dishes that match more query words first', () => {
    expect(searchCatalog(catalog, { query: 'chilli paneer' })[0].id).toBe('chilli-paneer');
    expect(searchCatalog(catalog, { query: 'pizza' })).toEqual([]);
  });

  it('says when serving size is not recorded instead of guessing', () => {
    expect(summarize(catalog.find((i) => i.id === 'chicken')!).serves).toBe('not stated');
    expect(summarize(catalog.find((i) => i.id === 'hakka')!).serves).toBe('Serves 2');
  });

  it('search hits and item summaries carry the same recorded facts as snapshot rows', () => {
    const dish = { ...catalog.find((i) => i.id === 'hakka')!, prepMinutes: 12, featured: true, allergens: ['Soy'] };
    for (const view of [summarize(dish), summarizeForSearch(dish)]) {
      expect(view).toMatchObject({ prepMinutes: 12, featured: true });
      expect(view).not.toHaveProperty('popular');
    }
    expect(summarize(dish).allergens).toEqual(['Soy']);
    expect(summarize(dish, true).popular).toBe(true);
    expect(summarizeForSearch(dish, false).popular).toBe(false);
  });

  it('includes calories in item details only when recorded', () => {
    const dish = catalog.find((i) => i.id === 'hakka')!;
    expect(summarize({ ...dish, calories: 450 }).calories).toBe(450);
    expect(summarize({ ...dish, calories: null })).not.toHaveProperty('calories');
  });
});
