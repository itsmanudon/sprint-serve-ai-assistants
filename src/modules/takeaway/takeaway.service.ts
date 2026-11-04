import { getCurrentTenantId } from '../../config/tenant-context';
import { badRequest, httpError } from '../../utils/http-error';
import * as menuRepo from '../menu/menu.repository';

export interface QuoteLineInput {
  menuItemId: string;
  quantity: number;
  variantId?: string | null;
  selectedOptions?: string[];
}

export interface QuotedLine {
  menuItemId: string;
  name: string;
  variantName: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Stand-in for Sprint Serve's canonical takeaway quote. Prices every line from
 * the database (never from the caller), adds per-item GST, and refuses dishes,
 * sizes or options that cannot be ordered right now, as the real quote does.
 * Sprint Serve's version also applies promotions, inclusive pricing and charges.
 */
export const quoteTakeawayOrder = async (items: QuoteLineInput[]) => {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) throw badRequest('Choose a restaurant first.');
  const restaurant = menuRepo.findRestaurant(restaurantId);
  if (!restaurant?.ordering_open) throw httpError('Online takeaway is currently closed.', 409);
  if (!items.length) throw httpError('Add at least one dish.', 400);
  const variants = menuRepo.findVariants(restaurantId);
  let subtotal = 0;
  let tax = 0;
  const lines: QuotedLine[] = items.map((line) => {
    const item = menuRepo.findItem(restaurantId, line.menuItemId);
    if (!item || item.is_available !== 1) throw httpError('A dish in this cart is not available.', 409);
    const own = variants.filter((v) => v.menu_item_id === item.id);
    let unit = item.price;
    let variantName: string | null = null;
    if (own.length) {
      const v = line.variantId ? own.find((x) => x.id === line.variantId) : undefined;
      if (!v || v.is_available !== 1) throw httpError(`Choose a size for ${item.name}.`, 400);
      unit = v.price;
      variantName = v.name;
    } else if (line.variantId) {
      throw httpError(`${item.name} has no sizes.`, 400);
    }
    if (line.selectedOptions?.length) throw httpError(`${item.name} has no options.`, 400);
    const lineTotal = round2(unit * line.quantity);
    subtotal += lineTotal;
    tax += round2((lineTotal * item.gst_percent) / 100);
    return { menuItemId: item.id, name: item.name, variantName, quantity: line.quantity, unitPrice: unit, lineTotal };
  });
  subtotal = round2(subtotal);
  tax = round2(tax);
  return { lines, subtotal, tax, total: round2(subtotal + tax) };
};
