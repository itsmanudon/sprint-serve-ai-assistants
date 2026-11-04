import { z } from 'zod';
import type { ToolDefinition } from '../core/model';
import { PERIODS } from './owner.periods';

/** Read-only tools over the restaurant's own aggregates. None of them can change anything. */

export const periodArg = z.enum(PERIODS);
export const salesArgs = z.object({ period: periodArg });
export const dishArgs = z.object({
  period: periodArg,
  rank_by: z.enum(['quantity', 'revenue']).default('quantity'),
  order: z.enum(['top', 'bottom']).default('top'),
  limit: z.number().int().min(1).max(15).default(5),
});
export const dishLookupArgs = z.object({ period: periodArg, name: z.string().trim().min(2).max(60) });
export const periodOnlyArgs = z.object({ period: periodArg });

const period = {
  type: 'string',
  enum: [...PERIODS],
  description: 'Reporting period in restaurant local time. "this_week" starts Monday.',
};

export const OWNER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'sales_summary',
      description:
        'Completed orders, revenue (incl. GST), net sales, GST, average order value, items sold, cancelled orders and orders placed through the meal assistant, for a period, with the comparison period and percentage changes already computed.',
      parameters: { type: 'object', properties: { period }, required: ['period'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dish_ranking',
      description:
        'Dishes ranked by quantity sold or by revenue for a period. order "bottom" lists the slowest sellers, including dishes that sold nothing.',
      parameters: {
        type: 'object',
        properties: {
          period,
          rank_by: { type: 'string', enum: ['quantity', 'revenue'] },
          order: { type: 'string', enum: ['top', 'bottom'] },
          limit: { type: 'integer', minimum: 1, maximum: 15 },
        },
        required: ['period'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dish_sales',
      description: 'Sales of dishes whose name matches the text, for a period, compared with the comparison period.',
      parameters: {
        type: 'object',
        properties: { period, name: { type: 'string', description: 'Part of the dish name, e.g. "naan".' } },
        required: ['period', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'category_sales',
      description: 'Quantity and revenue by menu category for a period, with each category\'s share of revenue.',
      parameters: { type: 'object', properties: { period }, required: ['period'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'busy_hours',
      description: 'Completed orders and revenue by hour of day (local time) for a period, busiest first.',
      parameters: { type: 'object', properties: { period }, required: ['period'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'orders_needing_attention',
      description:
        'Orders still open right now (new, preparing, ready for pickup), how long each has waited, and which are overdue against the restaurant\'s thresholds.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

export function buildOwnerSystemPrompt(restaurantName: string, localNow: string): string {
  return [
    `You are the business assistant for the owner of ${restaurantName}, a restaurant in India. It is ${localNow} local time.`,
    'Answer questions about this restaurant\'s sales, dishes, busy hours and open orders by calling the tools. You can only read reports: you cannot change prices, the menu, orders or settings. If asked to, say where in the dashboard the owner can do it.',
    'Rules:',
    '- Every number you state must come from a tool result in this conversation. Never estimate, extrapolate or invent figures, and never do your own arithmetic when the tool already gives a total or a percentage change.',
    '- Money is in Indian rupees, written like ₹12,340. "Revenue" includes GST; say "net sales" for the amount before GST.',
    '- If a tool returns no data for the period, say so plainly.',
    '- You have no customer names, phone numbers or reviews. Say so if asked.',
    '- For questions unrelated to running this restaurant, say briefly that you can only help with the restaurant\'s numbers.',
    '- Reply in 2 to 4 short sentences of plain English, most important fact first. When something needs action (an overdue order, a dish that sold nothing), say what to look at. No markdown tables.',
  ].join('\n');
}
