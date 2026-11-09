import { formatMoney } from '@eco/shared';
import type { IsoDate } from './date-utils';

export interface BriefingBill {
  name: string;
  amountMinor: number;
  currency: string;
  daysUntilDue: number;
}

export interface BriefingInput {
  /** The user's local date, which names the day in the title. */
  date: IsoDate;
  locale: string;
  /** What is still spendable today, or null when there is no budget. */
  today: { remainingMinor: number; currency: string } | null;
  /** What is left of the month's budget, and the days it has to last. */
  month: { remainingMinor: number; daysRemaining: number; currency: string } | null;
  /** Already filtered to the window worth mentioning, soonest first. */
  bills: BriefingBill[];
  /** Names of wants whose cooling-off period is over and are undecided. */
  wantsReady: string[];
  /** Captured expenses filed under a guessed category. */
  needsReview: number;
  /** Today's forecast where the user lives; null when no place is set or the
   *  provider did not answer — the briefing goes out regardless. */
  weather?: {
    place: string;
    summary: string;
    maxC: number;
    minC: number;
    rainChancePct: number | null;
  } | null;
  /** Open tasks, already in order of attention. */
  tasks?: Array<{ title: string; overdue: boolean }>;
  /** Birthdays within the coming week, soonest first; 0 is today. */
  birthdays?: Array<{ name: string; daysUntil: number; turning: number | null }>;
}

export interface Briefing {
  title: string;
  lines: string[];
}

/** Bills named individually before the rest are counted. A lock-screen push
 *  shows about four lines, and the first ones have to be the ones that matter. */
const BILLS_NAMED = 2;

/** "Top three": the tasks named in the briefing. */
const TASKS_NAMED = 3;

/** A rain chance below this is not worth a mention in a desert. */
const RAIN_WORTH_SAYING = 30;

/**
 * The morning push, as text.
 *
 * The title carries the one number worth acting on — what can be spent today —
 * because a notification is usually read from its title alone. The lines are
 * what is due and what is waiting on the user, most urgent first; nothing that
 * merely restates the dashboard.
 */
export function composeBriefing(input: BriefingInput): Briefing {
  const day = weekday(input.date, input.locale);
  const money = (minor: number, currency: string) =>
    formatMoney(minor, currency, { locale: input.locale });

  let title: string;
  let monthInTitle = false;
  if (input.today) {
    title =
      input.today.remainingMinor > 0
        ? `${day}: ${money(input.today.remainingMinor, input.today.currency)} to spend today`
        : `${day}: today's allowance is already used`;
  } else if (input.month) {
    title = `${day}: ${money(Math.max(0, input.month.remainingMinor), input.month.currency)} left this month`;
    monthInTitle = true;
  } else {
    title = `${day}: your morning briefing`;
  }

  const lines: string[] = [];

  // Weather first: it is what the morning is planned around.
  if (input.weather) {
    const w = input.weather;
    const rain =
      w.rainChancePct !== null && w.rainChancePct >= RAIN_WORTH_SAYING
        ? `, ${w.rainChancePct}% chance of rain`
        : '';
    lines.push(`${w.place}: ${w.summary}, ${Math.round(w.maxC)}° / ${Math.round(w.minC)}°${rain}`);
  }

  const birthdays = input.birthdays ?? [];
  for (const b of birthdays.filter((x) => x.daysUntil === 0)) {
    lines.push(`It's ${possessive(b.name)} birthday${b.turning ? ` — they turn ${b.turning}` : ''}`);
  }

  for (const bill of input.bills.slice(0, BILLS_NAMED)) {
    lines.push(
      `${bill.name} ${money(bill.amountMinor, bill.currency)} due ${when(bill.daysUntilDue, input.date, input.locale)}`,
    );
  }
  const unnamed = input.bills.length - BILLS_NAMED;
  if (unnamed > 0) lines.push(`+${unnamed} more bill${unnamed === 1 ? '' : 's'} due soon`);

  const tasks = input.tasks ?? [];
  if (tasks.length > 0) {
    const named = tasks
      .slice(0, TASKS_NAMED)
      .map((t) => (t.overdue ? `${t.title} (overdue)` : t.title))
      .join(' · ');
    const more = tasks.length - TASKS_NAMED;
    lines.push(`To do: ${named}${more > 0 ? ` +${more} more` : ''}`);
  }

  if (input.month && !monthInTitle) {
    lines.push(
      input.month.remainingMinor > 0
        ? `${money(input.month.remainingMinor, input.month.currency)} left in the budget for ${input.month.daysRemaining} day${input.month.daysRemaining === 1 ? '' : 's'}`
        : `The month's budget is spent, with ${input.month.daysRemaining} day${input.month.daysRemaining === 1 ? '' : 's'} to go`,
    );
  }

  if (input.wantsReady.length === 1) {
    lines.push(`${input.wantsReady[0]} has cooled off — buy it or let it go`);
  } else if (input.wantsReady.length > 1) {
    lines.push(`${input.wantsReady.length} wants have cooled off and are ready to decide`);
  }

  if (input.needsReview > 0) {
    lines.push(
      `${input.needsReview} expense${input.needsReview === 1 ? ' needs' : 's need'} a category`,
    );
  }

  const soon = birthdays.filter((x) => x.daysUntil > 0).slice(0, 2);
  if (soon.length > 0) {
    lines.push(
      `Coming up: ${soon
        .map((b) => `${possessive(b.name)} birthday ${when(b.daysUntil, input.date, input.locale)}`)
        .join(' · ')}`,
    );
  }

  // Weather alone is not "something due", so the reassurance still applies.
  if (lines.length === (input.weather ? 1 : 0)) {
    lines.push('Nothing due and nothing waiting on you.');
  }

  return { title, lines };
}

/** "Sara's", "James'". */
function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function weekday(date: IsoDate, locale: string): string {
  // Noon UTC, formatted in UTC: the calendar date as given, whatever the
  // machine's own timezone.
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

function when(daysUntilDue: number, today: IsoDate, locale: string): string {
  if (daysUntilDue <= 0) return 'today';
  if (daysUntilDue === 1) return 'tomorrow';
  // Within the week a day name is clearer than a count; beyond it, a count.
  if (daysUntilDue < 7) {
    const due = new Date(`${today}T12:00:00Z`);
    due.setUTCDate(due.getUTCDate() + daysUntilDue);
    return `on ${weekday(due.toISOString().slice(0, 10) as IsoDate, locale)}`;
  }
  return `in ${daysUntilDue} days`;
}
