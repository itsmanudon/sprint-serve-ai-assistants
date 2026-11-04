import { getCurrentTenantId } from '../../config/tenant-context';
import { badRequest } from '../../utils/http-error';
import * as repo from './menu.repository';

/**
 * The public customer menu: active categories with their available dishes, in
 * the same shape Sprint Serve's `getMenuForCustomer` returns (the assistant's
 * `toCatalog` reads it). Unavailable dishes are left out, as they are there.
 */
export const getMenuForCustomer = async (): Promise<unknown> => {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) throw badRequest('Choose a restaurant first.');
  const variants = repo.findVariants(restaurantId);
  const pairings = repo.findPairings(restaurantId);
  const items = repo.findItems(restaurantId).filter((i) => i.is_available === 1);
  return repo
    .findCategories(restaurantId)
    .map((c) => ({
      id: c.id,
      name: c.name,
      assistantRole: c.assistant_role,
      items: items
        .filter((i) => i.category_id === c.id)
        .map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          price: i.price,
          isVeg: i.is_veg === 1,
          containsEgg: i.contains_egg === 1,
          spicyLevel: i.spicy_level,
          preparationTime: i.preparation_time,
          isFeatured: i.is_featured === 1,
          isAvailable: true,
          cuisine: i.cuisine,
          servingSize: i.serving_size,
          allergens: JSON.parse(i.allergens) as string[],
          variants: variants
            .filter((v) => v.menu_item_id === i.id)
            .map((v) => ({ id: v.id, name: v.name, price: v.price, isDefault: v.is_default === 1, isAvailable: v.is_available === 1 })),
          modifierGroups: [],
          options: [],
          pairings: pairings.filter((p) => p.menu_item_id === i.id).map((p) => ({ id: p.paired_item_id })),
        })),
    }))
    .filter((c) => c.items.length > 0);
};

/** Every dish, available or not, for the owner's menu screen. */
export const getMenuForOwner = async () => {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) throw badRequest('Choose a restaurant first.');
  const categories = new Map(repo.findCategories(restaurantId).map((c) => [c.id, c.name]));
  return repo.findItems(restaurantId).map((i) => ({
    id: i.id,
    name: i.name,
    category: categories.get(i.category_id) ?? '',
    price: i.price,
    isVeg: i.is_veg === 1,
    isAvailable: i.is_available === 1,
  }));
};

export const setItemAvailability = async (id: string, available: boolean) => {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) throw badRequest('Choose a restaurant first.');
  if (!repo.setAvailability(restaurantId, id, available)) throw Object.assign(new Error('Unknown dish.'), { status: 404 });
  return { id, isAvailable: available };
};
