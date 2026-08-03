import { createBooking, hm, mickey, minnie } from '@/__fixtures__/ll';
import { DateTime, ParkTime } from '@/datetime';
import { TODAY, TOMORROW } from '@/testing';

import {
  coversExpectedParty,
  isActiveBookingForDate,
} from './AutoBookProvider';

describe('AutoBookProvider reliability helpers', () => {
  it('keeps a future morning booking active after that clock time today', () => {
    const booking = createBooking(hm, {
      date: TOMORROW,
      startTime: new ParkTime(9),
    });

    expect(
      isActiveBookingForDate(
        booking,
        TOMORROW,
        new DateTime(TODAY, new ParkTime(17))
      )
    ).toBe(true);
  });

  it('expires a same-day booking only after its return window', () => {
    const booking = createBooking(hm, {
      date: TODAY,
      startTime: new ParkTime(9),
    });

    expect(
      isActiveBookingForDate(
        booking,
        TODAY,
        new DateTime(TODAY, new ParkTime(11))
      )
    ).toBe(false);
  });

  it('requires every intended guest before treating a target as complete', () => {
    const expectedParty = new Set([mickey.id, minnie.id]);

    expect(coversExpectedParty([mickey.id], expectedParty)).toBe(false);
    expect(coversExpectedParty([mickey.id, minnie.id], expectedParty)).toBe(
      true
    );
  });
});
