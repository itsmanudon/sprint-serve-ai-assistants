import { z } from 'zod';
import { selectedOptions } from '../../../utils/validation';

const MAX_TURN_CHARS = 1000;

/** One line of a candidate cart, in the same shape checkout accepts. */
export const cartLineSchema = z.object({
  menuItemId: z.string().min(1).max(64),
  variantId: z.string().min(1).max(64).nullable().optional(),
  selectedOptions: selectedOptions().optional(),
  quantity: z.number().int().min(1).max(20),
});
export type CartLine = z.infer<typeof cartLineSchema>;

/** The customer's stated limits. Hard limits are enforced by the server. */
export const constraintsSchema = z.object({
  people: z.number().int().min(1).max(30).nullable().optional(),
  vegetarian: z.boolean().optional(),
  noEgg: z.boolean().optional(),
  /** Rupees, final payable amount (GST and charges included). */
  budget: z.number().positive().max(100000).nullable().optional(),
  preferences: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  /** Pills the customer taps: prefer this restaurant's best-sellers / quick dishes. */
  popular: z.boolean().optional(),
  fast: z.boolean().optional(),
});
export type Constraints = z.infer<typeof constraintsSchema>;

export const RELEASABLE_CONSTRAINTS = [
  'vegetarian',
  'noEgg',
  'budget',
  'people',
  'preferences',
  'popular',
  'fast',
] as const;
export type ReleasableConstraint = (typeof RELEASABLE_CONSTRAINTS)[number];

export const customerTurnSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(MAX_TURN_CHARS),
      })
    )
    .min(1)
    .max(20)
    .refine((m) => m[m.length - 1]?.role === 'user', 'The last message must be from the customer'),
  /** The cart currently on screen, so "swap the noodles" edits what they see. */
  cart: z.array(cartLineSchema).max(25).optional(),
  constraints: constraintsSchema.optional(),
  /** Lines already in the customer's takeaway cart; their budget covers these too. */
  existingCart: z.array(cartLineSchema).max(25).optional(),
  /** Keys the customer removed by tapping a chip's ✕ on THIS turn; only these may loosen. */
  released: z.array(z.enum(RELEASABLE_CONSTRAINTS)).max(7).optional(),
});
export type CustomerTurnInput = z.infer<typeof customerTurnSchema>;
