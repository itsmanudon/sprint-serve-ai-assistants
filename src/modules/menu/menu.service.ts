import { demoRestaurant } from './demo-data';

/**
 * Stand-in for Sprint Serve's public customer menu: categories with their
 * available items, in the same shape `toCatalog` reads.
 */
export const getMenuForCustomer = async (): Promise<unknown> =>
  structuredClone(demoRestaurant().categories);
