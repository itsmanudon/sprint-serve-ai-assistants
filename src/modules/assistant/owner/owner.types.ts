import { z } from 'zod';

export const ownerTurnSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(1000),
      })
    )
    .min(1)
    .max(20)
    .refine((m) => m[m.length - 1]?.role === 'user', 'The last message must be from the owner'),
});
export type OwnerTurnInput = z.infer<typeof ownerTurnSchema>;
