/**
 * Report periods in the restaurant's local time (India, UTC+05:30, no DST).
 * Every range is [from, to) in UTC ISO strings, plus the range it is compared
 * with. "So far" periods are compared with the same elapsed time before them,
 * so a Tuesday-noon "this week" is not judged against a whole previous week.
 */

export const PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
] as const;
export type Period = (typeof PERIODS)[number];

export interface Range {
  from: string;
  to: string;
  label: string;
}

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function resolvePeriod(
  period: Period,
  now: Date = new Date(),
  offsetMinutes = 330
): { current: Range; previous: Range } {
  const off = offsetMinutes * 60_000;
  const t = now.getTime();
  const localMidnight = Math.floor((t + off) / DAY) * DAY - off; // today 00:00 local, as UTC ms
  const weekday = (new Date(localMidnight + off).getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = localMidnight - weekday * DAY;
  const local = new Date(localMidnight + off);
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - off;
  const prevMonthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1) - off;
  const r = (from: number, to: number, label: string): Range => ({ from: iso(from), to: iso(to), label });

  switch (period) {
    case 'today':
      return { current: r(localMidnight, t, 'today so far'), previous: r(localMidnight - DAY, t - DAY, 'yesterday, same time') };
    case 'yesterday':
      return { current: r(localMidnight - DAY, localMidnight, 'yesterday'), previous: r(localMidnight - 2 * DAY, localMidnight - DAY, 'the day before') };
    case 'this_week':
      return { current: r(weekStart, t, 'this week so far (from Monday)'), previous: r(weekStart - 7 * DAY, t - 7 * DAY, 'last week, same point') };
    case 'last_week':
      return { current: r(weekStart - 7 * DAY, weekStart, 'last week (Mon–Sun)'), previous: r(weekStart - 14 * DAY, weekStart - 7 * DAY, 'the week before') };
    case 'last_7_days':
      return { current: r(t - 7 * DAY, t, 'last 7 days'), previous: r(t - 14 * DAY, t - 7 * DAY, 'the 7 days before') };
    case 'last_30_days':
      return { current: r(t - 30 * DAY, t, 'last 30 days'), previous: r(t - 60 * DAY, t - 30 * DAY, 'the 30 days before') };
    case 'this_month':
      return { current: r(monthStart, t, 'this month so far'), previous: r(prevMonthStart, Math.min(prevMonthStart + (t - monthStart), monthStart), 'last month, same point') };
    case 'last_month': {
      const before = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 2, 1) - off;
      return { current: r(prevMonthStart, monthStart, 'last month'), previous: r(before, prevMonthStart, 'the month before') };
    }
  }
}
