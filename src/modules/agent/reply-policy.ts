const hours: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const hourWord = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|1[0-2]|[1-9])';

// Parse common restaurant time expressions, including British "half five".
// A bare 5 without am/pm is interpreted in the requested slot's half of the day.
export function bookingTimes(text: string, referenceTime: string): string[] {
  const found = new Set<string>();
  const referenceHour = Number(referenceTime.slice(0, 2));
  function add(raw: string, minutes = 0, suffix?: string, delta = 0): void {
    let hour = hours[raw.toLowerCase()] ?? Number(raw);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
    if (suffix) hour = hour % 12 + (suffix.toLowerCase().startsWith('p') ? 12 : 0);
    else if (hour >= 1 && hour <= 12 && !/^0\d/.test(raw)) hour = hour % 12 + (referenceHour >= 12 ? 12 : 0);
    const total = (hour * 60 + minutes + delta + 1440) % 1440;
    found.add(String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0'));
  }
  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\s*([ap]\.?m\.?)?/gi)) add(m[1]!, Number(m[2]), m[3]);
  for (const m of text.matchAll(/\b(1[0-2]|[1-9])\s*([ap]\.?m\.?)\b/gi)) add(m[1]!, 0, m[2]);
  for (const m of text.matchAll(new RegExp('\\bhalf(?:\\s+past)?\\s+(' + hourWord + ')\\b', 'gi'))) add(m[1]!, 30);
  for (const m of text.matchAll(new RegExp('\\bquarter\\s+(past|to)\\s+(' + hourWord + ')\\b', 'gi'))) add(m[2]!, 0, undefined, m[1]!.toLowerCase() === 'to' ? -15 : 15);
  for (const m of text.matchAll(new RegExp('\\b(' + hourWord + ')\\s+(thirty|fifteen|forty[- ]five)\\b', 'gi'))) {
    add(m[1]!, m[2]!.toLowerCase() === 'thirty' ? 30 : m[2]!.toLowerCase() === 'fifteen' ? 15 : 45);
  }
  for (const m of text.matchAll(new RegExp('\\b(' + hourWord + ')\\s*o[’\']?clock\\b', 'gi'))) add(m[1]!);
  for (const m of text.matchAll(new RegExp('\\b(?:at|or|could do|can do)\\s+(' + hourWord + ')(?![\\w:]|\\s+(?:thirty|fifteen|forty))\\b', 'gi'))) {
    // Explicit am/pm is handled above; do not infer the opposite half of the day.
    if (!/^\s*[ap]\.?m\b/i.test(text.slice(m.index! + m[0].length))) add(m[1]!);
  }
  return [...found];
}

export function bookingCalendar(date: string) {
  const day = new Date(date + 'T12:00:00Z');
  return {
    date,
    weekday: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(day),
    readableDate: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(day),
  };
}

export function wrongWeekday(text: string, date: string): boolean {
  const expected = bookingCalendar(date).weekday.toLowerCase();
  return [...text.matchAll(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi)]
    .some(m => m[0].toLowerCase() !== expected);
}

export function removeGreeting(text: string): string {
  const result = text.trim().replace(/^(?:(?:hello|hi|hey|good morning|good afternoon|good evening)[\s,!:.—-]+)+/i, '').trim();
  return result ? result[0]!.toUpperCase() + result.slice(1) : '';
}

export function asksAiIdentity(text: string): boolean {
  return /\b(?:are you|is this|am I (?:chatting|speaking|talking) (?:to|with))\b[^?\n]{0,90}\b(?:AI|artificial intelligence|bot|human|person|automated)\b/i.test(text);
}

export function honestAiIdentity(text: string): boolean {
  return /\b(?:AI|artificial intelligence|automated|bot)\b/i.test(text) &&
    !/\b(?:not|never)\s+(?:an?\s+)?(?:AI|bot|automated)\b|\b(?:I am|I'm|I’m)\s+(?:an?\s+)?(?:human|person)\b/i.test(text);
}

export function financialRequest(text: string): boolean {
  if (/\b(?:card number|card details|expiry|expiration|credit card|debit card)\b/i.test(text)) return true;
  if (/\b(?:no|without)\s+(?:a\s+)?deposit\b|\bdeposit\s+(?:is\s+)?(?:waived|not required)\b/i.test(text)) return false;
  return /\b(?:deposit|pay(?:ment)?|card number|card details|expiry|expiration|credit card|debit card)\b|[£$€]\s*\d/i.test(text);
}

export function acceptsPayment(text: string): boolean {
  return /\b(?:I|we)\s+(?:will pay|agree to pay|accept (?:the |a )?deposit|agree to (?:the |a )?deposit|authori[sz]e|approve (?:the |a )?(?:payment|deposit))\b|\b(?:deposit|payment)\s+(?:is fine|is acceptable|has been paid|is paid|is approved)\b/i.test(text);
}

export function cardData(text: string, financialContext = false): boolean {
  // Card-like numbers never belong in a restaurant Telegram conversation.
  if (/(?:\d[ -]?){13,19}/.test(text)) return true;
  if (financialContext && (/\b(?:0?[1-9]|1[0-2])\s*\/\s*(?:\d{4}|\d{2})\b/.test(text) || /^\s*\d{3,4}\s*$/.test(text))) return true;
  return /\b(?:expiry|expiration|expires|cvv|cvc|security code)\b[^.!?\n]{0,25}\d{2,4}/i.test(text);
}

export function approvesDeposit(text: string): boolean {
  return !/\b(?:no|not|don't|do not|decline)\b|не\s*(?:погоджую|дозволяю)|відмов/i.test(text) &&
    /\b(?:approve|accept|agree|authori[sz]e)\b|погоджую|дозволяю/i.test(text) &&
    /\b(?:deposit|payment)\b|депозит|оплат/i.test(text);
}

export function moneyAmounts(text: string): string[] {
  return [...text.matchAll(/([£$€])\s*(\d+(?:\.\d{1,2})?)/g)].map(m => m[1]! + Number(m[2]).toFixed(2));
}

export function acceptsAlternative(text: string): boolean {
  return /\b(?:later|alternative|either|both|that time|that slot)\b[^.!?\n]{0,24}\b(?:works?|fine|perfect|lovely|suits?|acceptable)\b|\b(?:that works|sounds good)\b|\b(?:I|we)(?:['’]ll| will| can| would like to)?\s+(?:please\s+)?(?:take|accept|book|go for|go ahead with)\s+(?:it|that|either|the later|the alternative)\b/i.test(text);
}

export function guestNeeds(text: string): boolean {
  return /\b(?:dietary|allerg\w*|accessib\w*|wheelchair|mobility|medical needs|special needs)\b|алергі|доступніст|візок|дієт|особлив\w* потреб/iu.test(text);
}
