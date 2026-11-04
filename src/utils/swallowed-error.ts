import { logger } from '../config/logger';

/** Report an error that is deliberately not rethrown (Sprint Serve sends these to Sentry). */
export const reportSwallowed =
  (module: string, op: string, extra?: Record<string, unknown>) =>
  (err: unknown): void => {
    logger.warn('swallowed error', {
      module,
      op,
      ...extra,
      error: err instanceof Error ? err.message : String(err),
    });
  };
