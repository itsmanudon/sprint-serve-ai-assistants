/** Console logger with the same call shape as Sprint Serve's Winston logger. */
const write =
  (level: string) =>
  (message: string, meta?: Record<string, unknown>): void => {
    if (process.env.NODE_ENV === 'test') return;
    const line = JSON.stringify({ level, message, ...meta, at: new Date().toISOString() });
    (level === 'error' ? console.error : console.log)(line);
  };

export const logger = { info: write('info'), warn: write('warn'), error: write('error') };
