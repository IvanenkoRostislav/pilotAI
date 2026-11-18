const MASK = '[REDACTED]';
const publicMessages = new Set([
  'hello', 'hi', 'thank you', 'thanks', 'yes', 'no', 'confirmed', 'yes, confirmed',
  'your booking is confirmed', 'booking confirmed', 'reservation confirmed',
  'a table is available', 'we have a table available',
]);

export class Redactor {
  private readonly privateValues = new Set<string>();

  remember(value: string): void {
    if (value.trim()) this.privateValues.add(value.trim());
  }

  conversation(value: string, trusted: boolean): string {
    const phrase = value.trim().replace(/[.!?]+$/, '').toLowerCase();
    return trusted || publicMessages.has(phrase)
      ? this.text(value) : '[REDACTED: free-form message]';
  }

  text(value: string): string {
    let text = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
    for (const [key, secret] of Object.entries(process.env)) {
      if (secret && /(?:API_KEY|API_HASH|API_ID|TOKEN|PASSWORD|SECRET|SESSION_STRING|TELEGRAM_SESSION)$/.test(key)) {
        this.privateValues.add(secret);
      }
    }
    // Replace longer values first, so a name cannot expose part of a secret.
    for (const secret of [...this.privateValues].sort((a, b) => b.length - a.length)) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = secret.length < 6 ? '(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])' : escaped;
      text = text.replace(new RegExp(pattern, 'gu'), MASK);
    }
    return text
      .replace(/AIza[A-Za-z0-9_-]{20,}/g, MASK)
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, MASK)
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, MASK)
      .replace(/[A-Za-z0-9+/=_-]{80,}/g, MASK)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, MASK)
      .replace(/@[A-Za-z][A-Za-z0-9_]{3,31}/g, MASK)
      .replace(/\+?\d[\d ()-]{5,}\d/g, (match) => /^\d{4}-\d{2}-\d{2}$/.test(match) ? match : MASK);
  }

  data(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value instanceof Error) return '[ERROR DETAILS OMITTED]';
    if (typeof value === 'string') return this.text(value);
    if (typeof value === 'bigint') return '[IDENTIFIER OMITTED]';
    if (typeof value === 'number') return this.text(String(value)) === String(value) ? value : MASK;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.data(item, seen));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
      if (/^(name|personal|credentials)$|apikey|apihash|apiid|token|password|secret|authorization|cookie|session|phone|email|fullname|firstname|lastname|username|accountid|senderid|targetid/.test(normalized)) {
        result[key] = MASK;
      } else {
        result[key] = this.data(item, seen);
      }
    }
    return result;
  }
}
