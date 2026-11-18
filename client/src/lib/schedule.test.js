import { describe, expect, it } from 'vitest';
import { describeDays, expandProposal, layoutWeek, startOfWeek, weekStats } from './schedule.js';

const proposal = {
  title: 'Sleep',
  category: 'sleep',
  startTime: '22:30',
  endTime: '06:30',
  daysOfWeek: [1, 2, 3, 4, 5],
  startDate: '2030-01-07', // a Monday
  repeatWeeks: 2,
  reminderMinutes: 15,
};

describe('expandProposal', () => {
  it('creates one block per matching day across the repeat window', () => {
    const blocks = expandProposal(proposal, new Date(2030, 0, 1));
    expect(blocks).toHaveLength(10);
    const first = blocks[0];
    expect(new Date(first.start).getHours()).toBe(22);
    expect(new Date(first.end).getDate()).toBe(8); // overnight -> ends next day
    expect((new Date(first.end) - new Date(first.start)) / 3_600_000).toBe(8);
  });

  it('skips occurrences that have already ended', () => {
    const blocks = expandProposal(proposal, new Date(2030, 0, 10, 12)); // Thursday noon
    expect(blocks).toHaveLength(7); // Thu, Fri + 5 next week
  });
});

describe('layoutWeek', () => {
  it('splits overnight blocks across two days', () => {
    const weekStart = startOfWeek(new Date(2030, 0, 9));
    const [block] = expandProposal({ ...proposal, daysOfWeek: [1], repeatWeeks: 1 }, new Date(2030, 0, 1));
    const days = layoutWeek([block], weekStart);
    expect(days[0].segments[0]).toMatchObject({ top: 22.5 * 60, height: 90, continuesAfter: true });
    expect(days[1].segments[0]).toMatchObject({ top: 0, height: 390, continuesBefore: true });
  });
});

describe('weekStats & describeDays', () => {
  it('sums hours and finds the next block', () => {
    const weekStart = startOfWeek(new Date(2030, 0, 9));
    const blocks = expandProposal(proposal, new Date(2030, 0, 1));
    const stats = weekStats(blocks, weekStart, new Date(2030, 0, 7, 12));
    expect(stats.total).toBeCloseTo(40, 5); // 5 weeknights x 8h (next week's blocks excluded)
    expect(stats.next.title).toBe('Sleep');
    expect(stats.avgSleep).toBe(8);
  });

  it('labels common day patterns', () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe('Weekdays');
    expect(describeDays([0, 6])).toBe('Weekends');
    expect(describeDays([5, 1, 3])).toBe('Mon, Wed, Fri');
  });
});
