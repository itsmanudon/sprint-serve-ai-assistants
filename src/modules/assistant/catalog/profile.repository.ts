import { getCurrentTenantId } from '../../../config/tenant-context';
import { demoRestaurant } from '../../menu/demo-data';

export interface ProfileSource {
  name: string | null;
  chefNotes: string | null;
}

/**
 * The restaurant's name and owner-written chef notes. In Sprint Serve these
 * are tenant-scoped database reads; here they come from the demo file.
 * No tenant, no data.
 */
export async function findProfileSource(): Promise<ProfileSource> {
  if (!getCurrentTenantId()) return { name: null, chefNotes: null };
  const r = demoRestaurant();
  return { name: r.name, chefNotes: r.chefNotes };
}
