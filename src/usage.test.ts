import { describe, expect, it } from 'vitest';
import { parseUsage } from './usage.js';

const sample = `You are currently using your subscription to power your Claude Code usage

Current session: 1% used · resets Sep 25 at 2:09pm (Asia/Tokyo)
Current week (all models): 25% used · resets Sep 29 at 9:59am (Asia/Tokyo)

What's contributing to your limits usage?
  57% of your usage was at >150k context`;

describe('parseUsage (scenario 13)', () => {
  it('reads each limit and drops the date when it resets today', () => {
    expect(parseUsage(sample, new Date(2026, 8, 25))).toEqual([
      { label: 'session', percent: 1, resets: '2:09pm' },
      { label: 'week (all models)', percent: 25, resets: 'Sep 29 9:59am' },
    ]);
  });

  it('returns nothing when the wording is unknown', () => {
    expect(parseUsage('Usage is not available for API key users')).toEqual([]);
  });
});
