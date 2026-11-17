export interface Booking {
  restaurant: string;
  city: 'London';
  timezone: 'Europe/London';
  date: string;
  time: string;
  guests: number;
}

export function londonClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return {
    date: value('year') + '-' + value('month') + '-' + value('day'),
    time: value('hour') + ':' + value('minute'),
  };
}

export function loadBooking(now = new Date()): Booking {
  const guests = Number(process.env.BOOKING_GUESTS ?? '2');
  const time = process.env.BOOKING_TIME?.trim() || '17:00';
  const restaurant = process.env.BOOKING_RESTAURANT?.trim() || '';
  if (!Number.isInteger(guests) || guests < 1 || guests > 20 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      restaurant.length > 100 || /[\r\n]/.test(restaurant)) {
    throw new Error('BOOKING_CONFIG');
  }
  return {
    restaurant, city: 'London', timezone: 'Europe/London',
    date: londonClock(now).date, time, guests,
  };
}

export function slotIsFuture(booking: Booking, now = new Date()): boolean {
  const clock = londonClock(now);
  return clock.date < booking.date ||
    (clock.date === booking.date && clock.time < booking.time);
}
