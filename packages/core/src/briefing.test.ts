import { describe, expect, it } from 'vitest';
import { composeBriefing, type BriefingInput } from './briefing';

// 2026-11-03 is a Tuesday.
const base: BriefingInput = {
  date: '2026-11-03',
  locale: 'en-US',
  today: null,
  month: null,
  bills: [],
  wantsReady: [],
  needsReview: 0,
};

describe('composeBriefing', () => {
  it('puts today’s spendable figure in the title', () => {
    const b = composeBriefing({ ...base, today: { remainingMinor: 8_500, currency: 'USD' } });
    expect(b.title).toBe('Tuesday: $85.00 to spend today');
  });

  it('says so plainly when today is already used', () => {
    const b = composeBriefing({ ...base, today: { remainingMinor: 0, currency: 'USD' } });
    expect(b.title).toBe("Tuesday: today's allowance is already used");
  });

  it('falls back to the month, and does not repeat it in the lines', () => {
    const b = composeBriefing({
      ...base,
      month: { remainingMinor: 124_000, daysRemaining: 28, currency: 'USD' },
    });
    expect(b.title).toBe('Tuesday: $1,240.00 left this month');
    expect(b.lines).toEqual(['Nothing due and nothing waiting on you.']);
  });

  it('names the first two bills by day and counts the rest', () => {
    const b = composeBriefing({
      ...base,
      bills: [
        { name: 'Rent', amountMinor: 150_000, currency: 'USD', daysUntilDue: 0 },
        { name: 'Phone', amountMinor: 2_300, currency: 'USD', daysUntilDue: 3 },
        { name: 'Gym', amountMinor: 4_000, currency: 'USD', daysUntilDue: 5 },
      ],
    });
    expect(b.lines).toEqual([
      'Rent $1,500.00 due today',
      'Phone $23.00 due on Friday',
      '+1 more bill due soon',
    ]);
  });

  it('keeps each bill in its own currency', () => {
    const b = composeBriefing({
      ...base,
      bills: [{ name: 'STC', amountMinor: 23_000, currency: 'SAR', daysUntilDue: 1 }],
    });
    expect(b.lines[0]).toMatch(/^STC SAR\s?230\.00 due tomorrow$/);
  });

  it('lists the month, wants and review queue after the bills', () => {
    const b = composeBriefing({
      ...base,
      today: { remainingMinor: 5_000, currency: 'USD' },
      month: { remainingMinor: 60_000, daysRemaining: 1, currency: 'USD' },
      wantsReady: ['Headphones'],
      needsReview: 3,
    });
    expect(b.lines).toEqual([
      '$600.00 left in the budget for 1 day',
      'Headphones has cooled off — buy it or let it go',
      '3 expenses need a category',
    ]);
  });

  it('counts several ready wants instead of naming them', () => {
    const b = composeBriefing({ ...base, wantsReady: ['A', 'B'], needsReview: 1 });
    expect(b.lines).toEqual([
      '2 wants have cooled off and are ready to decide',
      '1 expense needs a category',
    ]);
  });
});

describe('composeBriefing — weather, tasks and birthdays', () => {
  it('opens with the weather, mentioning rain only when likely', () => {
    const dry = composeBriefing({
      ...base,
      weather: { place: 'Riyadh', summary: 'Partly cloudy', maxC: 34.9, minC: 24.7, rainChancePct: 0 },
    });
    expect(dry.lines).toEqual([
      'Riyadh: Partly cloudy, 35° / 25°',
      'Nothing due and nothing waiting on you.',
    ]);

    const wet = composeBriefing({
      ...base,
      weather: { place: 'London', summary: 'Rain', maxC: 12, minC: 7, rainChancePct: 80 },
    });
    expect(wet.lines[0]).toBe('London: Rain, 12° / 7°, 80% chance of rain');
  });

  it('names the top three tasks and counts the rest', () => {
    const b = composeBriefing({
      ...base,
      tasks: [
        { title: 'Renew iqama', overdue: true },
        { title: 'Call the bank', overdue: false },
        { title: 'Book flights', overdue: false },
        { title: 'Return parcel', overdue: false },
      ],
    });
    expect(b.lines).toEqual([
      'To do: Renew iqama (overdue) · Call the bank · Book flights +1 more',
    ]);
  });

  it('puts today’s birthdays near the top and the coming week at the end', () => {
    const b = composeBriefing({
      ...base,
      bills: [{ name: 'Rent', amountMinor: 150_000, currency: 'USD', daysUntilDue: 0 }],
      birthdays: [
        { name: 'Sara', daysUntil: 0, turning: 30 },
        { name: 'James', daysUntil: 3, turning: null },
      ],
    });
    expect(b.lines[0]).toBe("It's Sara's birthday — they turn 30");
    expect(b.lines.at(-1)).toBe("Coming up: James' birthday on Friday");
  });
});
