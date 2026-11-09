import { describe, expect, it } from 'vitest';
import { describeWeatherCode, nextBirthday, orderTasks, taskState } from './everyday';

describe('nextBirthday', () => {
  it('is today when it falls today, with the age turned', () => {
    expect(nextBirthday({ month: 11, day: 3, year: 1996 }, '2026-11-03')).toEqual({
      date: '2026-11-03',
      daysUntil: 0,
      turning: 30,
    });
  });

  it('rolls into next year once this year’s has passed', () => {
    expect(nextBirthday({ month: 1, day: 10, year: 2000 }, '2026-11-03')).toEqual({
      date: '2027-01-10',
      daysUntil: 68,
      turning: 27,
    });
  });

  it('keeps a leap-day birthday on the 28th in a common year', () => {
    expect(nextBirthday({ month: 2, day: 29 }, '2027-01-01').date).toBe('2027-02-28');
    expect(nextBirthday({ month: 2, day: 29 }, '2028-01-01').date).toBe('2028-02-29');
  });

  it('does not invent an age without a year', () => {
    expect(nextBirthday({ month: 12, day: 1 }, '2026-11-03').turning).toBeNull();
  });
});

describe('tasks', () => {
  const today = '2026-11-03';
  const t = (id: string, dueOn: string | null, createdAt = '2026-11-01T00:00:00Z') => ({
    id,
    dueOn,
    doneAt: null,
    createdAt,
  });

  it('places a task on the user’s calendar', () => {
    expect(taskState(t('a', '2026-11-02'), today)).toBe('OVERDUE');
    expect(taskState(t('a', today), today)).toBe('TODAY');
    expect(taskState(t('a', '2026-11-09'), today)).toBe('UPCOMING');
    expect(taskState(t('a', null), today)).toBe('SOMEDAY');
    expect(taskState({ ...t('a', null), doneAt: '2026-11-03T08:00:00Z' }, today)).toBe('DONE');
  });

  it('orders overdue, today, by date, then undated oldest first', () => {
    const ordered = orderTasks(
      [
        t('someday-new', null, '2026-11-02T00:00:00Z'),
        t('later', '2026-11-20'),
        t('today', today),
        t('someday-old', null, '2026-10-01T00:00:00Z'),
        t('soon', '2026-11-05'),
        t('overdue', '2026-10-30'),
      ],
      today,
    );
    expect(ordered.map((x) => x.id)).toEqual([
      'overdue',
      'today',
      'soon',
      'later',
      'someday-old',
      'someday-new',
    ]);
  });
});

describe('describeWeatherCode', () => {
  it('names the common codes', () => {
    expect(describeWeatherCode(0)).toBe('Clear');
    expect(describeWeatherCode(2)).toBe('Partly cloudy');
    expect(describeWeatherCode(63)).toBe('Rain');
    expect(describeWeatherCode(95)).toBe('Thunderstorms');
  });
});
