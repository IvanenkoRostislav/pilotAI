// Synthetic replies for mocked AI only. Production has no canned dialogue menu.
export function fixtureMenu({ booking: b, personal = {} }) {
  const details = `${b.restaurant}, London, ${b.date} at ${b.time} (Europe/London), ${b.guests} guests`;
  const menu = {
    opening: `Good afternoon. May I enquire about a table for ${b.guests} at ${b.restaurant} in London on ${b.date} at ${b.time} London time, please?`,
    confirm: `Could you please confirm this exact booking: ${details}?`,
    repeat: `We would still like the following: ${details}. Is that exact booking available, please?`,
    reply: 'Thank you. I am checking those details for you.',
    final: `Thank you for confirming. Booking confirmed: ${b.restaurant}, London, ${b.date}, ${b.time} (Europe/London), ${b.guests} guests.`,
  };
  for (const field of ['name', 'phone', 'email']) {
    if (personal[field]) menu['details_' + field] = `The ${field} for the booking is ${personal[field]}. Thank you.`;
  }
  return menu;
}
