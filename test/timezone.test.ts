import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatZonedDateTime, formatZonedTime, isValidTimeZone, resolveTimeZone } from '../src/timezone.js';

describe('agent-visible timezone formatting', () => {
  const winter = new Date('2026-01-15T12:34:56.789Z');
  const summer = new Date('2026-07-15T12:34:56.789Z');

  it('renders the configured zone with the correct DST offset', () => {
    assert.equal(
      formatZonedDateTime(winter, 'America/Los_Angeles'),
      '2026-01-15T04:34:56.789-08:00 [America/Los_Angeles]',
    );
    assert.equal(
      formatZonedDateTime(summer, 'America/Los_Angeles'),
      '2026-07-15T05:34:56.789-07:00 [America/Los_Angeles]',
    );
    assert.equal(formatZonedTime(summer, 'America/Los_Angeles'), '05:34');
  });

  it('validates IANA zones', () => {
    assert.equal(isValidTimeZone('Europe/Paris'), true);
    assert.equal(isValidTimeZone('Definitely/Not_A_Zone'), false);
    assert.throws(() => resolveTimeZone('Definitely/Not_A_Zone'), /Invalid IANA time zone/);
  });
});
