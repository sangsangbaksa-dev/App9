// Pure logic for 구독 갱신 장부. No DOM access.
export const CATEGORIES = ['스트리밍', '음악', '클라우드', '개발도구', 'AI', '생활', '기타'];
export const CURRENCIES = ['KRW', 'USD'];
export const CYCLES = ['매월', '매년', '분기'];
export const STATUSES = ['사용 중', '해지 예정'];
export const DEFAULT_RATE = 1350;
const CYCLE_MONTHS = { '매월': 1, '분기': 3, '매년': 12 };
const DAY_MS = 86400000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
export function daysInMonth(y, m) { // m: 1-12
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}
export function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
export function formatDate(p) { return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`; }
function toUtcMs(s) { const p = parseDate(s); return Date.UTC(p.y, p.m - 1, p.d); }

/** Add n months, clamping the day to the target month's length (Jan 31 + 1 => Feb 28/29). */
export function addMonths(dateStr, n) {
  const p = parseDate(dateStr);
  if (!p) throw new RangeError('Invalid date: ' + dateStr);
  const total = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  return formatDate({ y, m, d: Math.min(p.d, daysInMonth(y, m)) });
}
export function addDays(dateStr, n) {
  const dt = new Date(toUtcMs(dateStr) + n * DAY_MS);
  return formatDate({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}
export function daysBetween(fromStr, toStr) {
  return Math.round((toUtcMs(toStr) - toUtcMs(fromStr)) / DAY_MS);
}

/** Roll a past renewal date forward by the cycle to the first date >= today.
 *  Always steps from the original date (k * cycle) so month-end days don't drift. */
export function advanceRenewal(dateStr, cycle, today) {
  const step = CYCLE_MONTHS[cycle];
  if (!step) throw new RangeError('Unknown cycle: ' + cycle);
  if (dateStr >= today) return dateStr;
  let k = 1;
  let next = addMonths(dateStr, step);
  while (next < today) { k++; next = addMonths(dateStr, step * k); }
  return next;
}

/** Cost in KRW per month. */
export function monthlyCost(sub) {
  const rate = sub.currency === 'USD' ? (Number(sub.rate) > 0 ? Number(sub.rate) : DEFAULT_RATE) : 1;
  return (Number(sub.amount) * rate) / CYCLE_MONTHS[sub.cycle];
}
export function yearlyCost(sub) { return monthlyCost(sub) * 12; }

/** Subscriptions (with advanced dates) renewing within `days` days from today, sorted by date. */
export function upcomingWithin(subs, today, days) {
  return subs
    .map(sub => {
      const date = advanceRenewal(sub.nextDate, sub.cycle, today);
      return { sub, date, daysLeft: daysBetween(today, date) };
    })
    .filter(x => x.daysLeft >= 0 && x.daysLeft <= days)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.sub.name.localeCompare(b.sub.name, 'ko'));
}

/** Monthly KRW total per category, sorted desc, zero categories omitted. */
export function categoryTotals(subs) {
  const map = new Map();
  for (const s of subs) map.set(s.category, (map.get(s.category) || 0) + monthlyCost(s));
  return [...map.entries()].map(([category, monthly]) => ({ category, monthly }))
    .sort((a, b) => b.monthly - a.monthly);
}

/** Savings if every 해지 예정 item is cancelled. */
export function savingsIfCancelled(subs) {
  const planned = subs.filter(s => s.status === '해지 예정');
  const monthly = planned.reduce((t, s) => t + monthlyCost(s), 0);
  return { count: planned.length, monthly, yearly: monthly * 12 };
}

// ---- ICS ----
export function escapeIcsText(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}
/** Fold a content line at 75 octets (UTF-8 safe), continuation lines start with a space. */
export function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', curBytes = 0, limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) { out.push(cur); cur = ''; curBytes = 0; limit = 74; }
    cur += ch; curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
/** items: [{sub, date}] as returned by upcomingWithin. nowStamp: 'YYYYMMDDTHHMMSSZ'. */
export function toIcs(items, nowStamp = '20260101T000000Z') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//renewal-ledger//KO', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const { sub, date } of items) {
    const ymd = date.replace(/-/g, '');
    const end = addDays(date, 1).replace(/-/g, '');
    const price = sub.currency === 'USD' ? `$${sub.amount}` : `${Number(sub.amount).toLocaleString('en-US')}원`;
    const summary = `[갱신] ${sub.name}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(sub.id)}-${ymd}@renewal-ledger`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART;VALUE=DATE:${ymd}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `DESCRIPTION:${escapeIcsText(`${sub.category} / ${sub.cycle} / ${price}`)}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(summary)}`,
      'TRIGGER:-P1D',
      'END:VALARM',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ---- Validation ----
export function validateSubscription(input) {
  const errors = {};
  const name = String(input.name ?? '').trim();
  if (!name) errors.name = '서비스 이름을 입력하세요.';
  else if (name.length > 40) errors.name = '이름은 40자 이하로 입력하세요.';
  if (!CATEGORIES.includes(input.category)) errors.category = '카테고리를 선택하세요.';
  if (!CURRENCIES.includes(input.currency)) errors.currency = '통화를 선택하세요.';
  const amountRaw = input.amount;
  const amount = typeof amountRaw === 'number' ? amountRaw : (String(amountRaw ?? '').trim() === '' ? NaN : Number(amountRaw));
  if (!Number.isFinite(amount) || amount <= 0) errors.amount = '0보다 큰 금액을 입력하세요.';
  else if (amount > 1e9) errors.amount = '금액이 너무 큽니다.';
  else if (input.currency === 'KRW' && !Number.isInteger(amount)) errors.amount = '원화는 정수로 입력하세요.';
  let rate = DEFAULT_RATE;
  if (input.currency === 'USD') {
    rate = Number(input.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) errors.rate = '환율을 올바르게 입력하세요.';
  }
  if (!CYCLES.includes(input.cycle)) errors.cycle = '결제 주기를 선택하세요.';
  if (!parseDate(input.nextDate)) errors.nextDate = '올바른 갱신일을 입력하세요.';
  if (!STATUSES.includes(input.status)) errors.status = '상태를 선택하세요.';
  const valid = Object.keys(errors).length === 0;
  return {
    valid, errors,
    value: valid ? {
      name, category: input.category, amount, currency: input.currency,
      rate: input.currency === 'USD' ? rate : DEFAULT_RATE,
      cycle: input.cycle, nextDate: input.nextDate, status: input.status,
    } : null,
  };
}
