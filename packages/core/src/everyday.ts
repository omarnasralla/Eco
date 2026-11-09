import { diffDays, type IsoDate } from './date-utils';

/* ── Birthdays ─────────────────────────────────────────────────────────── */

export interface BirthdayLike {
  month: number;
  day: number;
  year?: number | null;
}

export interface NextBirthday {
  date: IsoDate;
  daysUntil: number;
  /** The age turned on that date; null when the birth year is unknown. */
  turning: number | null;
}

/**
 * When a birthday next falls, today included.
 *
 * A 29 February birthday is kept on the 28th in a common year: the day before
 * is when people celebrate it, and the alternative — skipping three years in
 * four — is how a reminder app loses someone's birthday.
 */
export function nextBirthday(birthday: BirthdayLike, today: IsoDate): NextBirthday {
  const thisYear = Number(today.slice(0, 4));
  let year = thisYear;
  let date = birthdayIn(birthday, year);
  if (date < today) {
    year += 1;
    date = birthdayIn(birthday, year);
  }
  return {
    date,
    daysUntil: diffDays(today, date),
    turning: birthday.year ? year - birthday.year : null,
  };
}

function birthdayIn(birthday: BirthdayLike, year: number): IsoDate {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const day = birthday.month === 2 && birthday.day === 29 && !leap ? 28 : birthday.day;
  return `${year}-${pad(birthday.month)}-${pad(day)}` as IsoDate;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/* ── Tasks ─────────────────────────────────────────────────────────────── */

export interface TaskLike {
  dueOn: IsoDate | null;
  doneAt: string | null;
  createdAt: string;
}

export type TaskState = 'OVERDUE' | 'TODAY' | 'UPCOMING' | 'SOMEDAY' | 'DONE';

export function taskState(task: TaskLike, today: IsoDate): TaskState {
  if (task.doneAt) return 'DONE';
  if (!task.dueOn) return 'SOMEDAY';
  if (task.dueOn < today) return 'OVERDUE';
  return task.dueOn === today ? 'TODAY' : 'UPCOMING';
}

const STATE_ORDER: Record<TaskState, number> = {
  OVERDUE: 0,
  TODAY: 1,
  UPCOMING: 2,
  SOMEDAY: 3,
  DONE: 4,
};

/**
 * Open tasks in the order they deserve attention: overdue, due today, then by
 * date, then the undated ones oldest first — a task with no deadline that has
 * sat for a month should rise, not sink under newer ones.
 */
export function orderTasks<T extends TaskLike>(tasks: T[], today: IsoDate): T[] {
  return [...tasks].sort((a, b) => {
    const byState = STATE_ORDER[taskState(a, today)] - STATE_ORDER[taskState(b, today)];
    if (byState !== 0) return byState;
    if (a.dueOn && b.dueOn && a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

/* ── Weather ───────────────────────────────────────────────────────────── */

/**
 * WMO weather interpretation codes, as Open-Meteo reports them, in words.
 * https://open-meteo.com/en/docs — "WMO Weather interpretation codes".
 */
export function describeWeatherCode(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code === 61 || code === 80) return 'Light rain';
  if (code === 63 || code === 81) return 'Rain';
  if (code === 65 || code === 82) return 'Heavy rain';
  if (code === 66 || code === 67) return 'Freezing rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'Snow';
  if (code >= 95) return 'Thunderstorms';
  return 'Mixed weather';
}
