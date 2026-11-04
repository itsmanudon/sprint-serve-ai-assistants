import { getCurrentTenantId } from '../../../config/tenant-context';
import { findRestaurant } from '../../menu/menu.repository';

export interface ProfileSource {
  name: string | null;
  chefNotes: string | null;
}

/**
 * The current restaurant's name and owner-written chef notes, keyed on the
 * request's restaurant. No tenant, no data. (Sprint Serve: Prisma, tenant-scoped.)
 */
export async function findProfileSource(): Promise<ProfileSource> {
  const restaurantId = getCurrentTenantId();
  if (!restaurantId) return { name: null, chefNotes: null };
  const r = findRestaurant(restaurantId);
  return { name: r?.name ?? null, chefNotes: r?.chef_notes ?? null };
}
