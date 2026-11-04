import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The restaurant a request belongs to. Sprint Serve resolves it from the
 * subdomain and scopes every query to it; here every request runs inside the
 * one demo restaurant.
 */
const storage = new AsyncLocalStorage<string>();

export const getCurrentTenantId = (): string | undefined => storage.getStore();

export const runWithTenantId = <T>(tenantId: string, fn: () => T): T => storage.run(tenantId, fn);
