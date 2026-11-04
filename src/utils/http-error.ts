export type TaggedError = Error & { status?: number; code?: string };

export const httpError = (message: string, status: number, code?: string): TaggedError =>
  Object.assign(new Error(message), { status, ...(code && { code }) });

export const badRequest = (message: string): TaggedError => httpError(message, 400);
