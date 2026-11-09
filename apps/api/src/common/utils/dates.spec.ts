import { localClock, withinWindow } from './dates';

describe('localClock', () => {
  it('reads the date and minute on the user’s own clock', () => {
    // 22:30 UTC on 9 Nov is 01:30 on 10 Nov in Riyadh.
    const at = new Date('2026-11-09T22:30:00Z');
    expect(localClock('Asia/Riyadh', at)).toEqual({ date: '2026-11-10', minutes: 90 });
    expect(localClock('Etc/GMT-3', at)).toEqual({ date: '2026-11-10', minutes: 90 });
  });

  it('falls back to UTC for a zone it does not know', () => {
    const at = new Date('2026-11-09T22:30:00Z');
    expect(localClock('Not/AZone', at)).toEqual({ date: '2026-11-09', minutes: 22 * 60 + 30 });
  });
});

describe('withinWindow', () => {
  it('handles a window inside one day', () => {
    expect(withinWindow(13 * 60, '12:00', '14:00')).toBe(true);
    expect(withinWindow(14 * 60, '12:00', '14:00')).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(withinWindow(23 * 60, '22:00', '07:00')).toBe(true);
    expect(withinWindow(6 * 60 + 59, '22:00', '07:00')).toBe(true);
    expect(withinWindow(7 * 60, '22:00', '07:00')).toBe(false);
    expect(withinWindow(12 * 60, '22:00', '07:00')).toBe(false);
  });
});
