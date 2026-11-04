import { httpError } from '../../utils/http-error';
import { demoItem, demoRestaurant } from '../menu/demo-data';

export interface QuoteLineInput {
  menuItemId: string;
  quantity: number;
  variantId?: string | null;
  selectedOptions?: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Stand-in for Sprint Serve's canonical takeaway quote. Prices every line from
 * the menu (never from the caller), adds per-item GST, and refuses dishes,
 * variants or options that are not orderable, the way the real quote does.
 * Sprint Serve's version also applies promotions, inclusive pricing and charges.
 */
export const quoteTakeawayOrder = async (items: QuoteLineInput[]) => {
  if (!demoRestaurant().orderingOpen) throw httpError('Online takeaway is currently closed.', 409);
  if (!items.length) throw httpError('Add at least one dish.', 400);
  let subtotal = 0;
  let tax = 0;
  const lines = items.map((line) => {
    const item = demoItem(line.menuItemId);
    if (!item || item.isAvailable === false) throw httpError('A dish in this cart is not available.', 409);
    let unit = item.price;
    if (item.variants.length) {
      const variant = line.variantId
        ? item.variants.find((v) => v.id === line.variantId)
        : undefined;
      if (!variant || variant.isAvailable === false)
        throw httpError(`Choose a size for ${item.name}.`, 400);
      unit = variant.price;
    } else if (line.variantId) {
      throw httpError(`${item.name} has no sizes.`, 400);
    }
    for (const optionId of line.selectedOptions ?? []) {
      const option = item.options.find((o) => o.id === optionId);
      if (!option || option.isAvailable === false)
        throw httpError(`An option for ${item.name} is not available.`, 400);
      unit += option.additionalPrice;
    }
    const lineTotal = round2(unit * line.quantity);
    const lineTax = round2((lineTotal * item.gstPercent) / 100);
    subtotal += lineTotal;
    tax += lineTax;
    return { menuItemId: item.id, name: item.name, quantity: line.quantity, unitPrice: unit, lineTotal };
  });
  subtotal = round2(subtotal);
  tax = round2(tax);
  return { lines, subtotal, tax, total: round2(subtotal + tax) };
};
