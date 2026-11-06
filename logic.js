// Pure logic for 구독 갱신 장부. No DOM access.
export const CATEGORIES = ['스트리밍', '음악', '클라우드', '개발도구', 'AI', '생활', '기타'];
export const CURRENCIES = ['KRW', 'USD'];
export const CYCLES = ['매월', '매년', '분기'];
export const STATUSES = ['사용 중', '해지 예정'];
export const SORT_KEYS = ['next', 'monthly', 'name'];
export const DEFAULT_RATE = 1350;
export const NOTE_MAX = 200;
export const SHARERS_MAX = 20;
export const TRIAL_WARN_DAYS = 7;
export const BACKUP_APP = 'renewal-ledger';
export const BACKUP_VERSION = 2;
export const MAX_BACKUP_ITEMS = 2000;
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

/** Keep the original billing day across saves (Jan 31 -> Feb 28 -> Mar 31). */
export function renewalAnchor(sub) {
  return parseDate(sub.renewalAnchor) && sub.renewalAnchor <= sub.nextDate ? sub.renewalAnchor : sub.nextDate;
}
export function rollSubscription(sub, today) {
  const anchor = renewalAnchor(sub);
  return { ...sub, renewalAnchor: anchor, nextDate: advanceRenewal(anchor, sub.cycle, today) };
}

const rateOf = sub => (sub.currency === 'USD' ? (Number(sub.rate) > 0 ? Number(sub.rate) : DEFAULT_RATE) : 1);

/** Cost in KRW per month. */
export function monthlyCost(sub) {
  return (Number(sub.amount) * rateOf(sub)) / CYCLE_MONTHS[sub.cycle];
}
export function yearlyCost(sub) { return monthlyCost(sub) * 12; }
/** KRW amount of a single charge (one payment). */
export function chargeKrw(sub) { return Number(sub.amount) * rateOf(sub); }
/** The user's share of the monthly cost when the plan is shared (sharers defaults to 1). */
export function myMonthlyCost(sub) {
  return monthlyCost(sub) / Math.max(1, Number(sub.sharers) || 1);
}

/** Subscriptions (with advanced dates) renewing within `days` days from today, sorted by date. */
export function upcomingWithin(subs, today, days) {
  return subs
    .map(sub => {
      const date = advanceRenewal(renewalAnchor(sub), sub.cycle, today);
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

/** Savings if the subscriptions with the given ids were cancelled (ids: Set or array). */
export function savingsFor(subs, ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  const picked = subs.filter(s => set.has(s.id));
  const monthly = picked.reduce((t, s) => t + monthlyCost(s), 0);
  return { count: picked.length, monthly, yearly: monthly * 12 };
}

/** Estimated KRW charges per calendar month for the last `months` months, oldest first.
 *  Back-projects each subscription's billing cycle from its next renewal date. This is an
 *  estimate based on current subscriptions, not a record of actual payments. */
export function monthlySpendTrend(subs, today, months = 12) {
  const t = parseDate(today);
  if (!t) throw new RangeError('Invalid date: ' + today);
  const cur = t.y * 12 + (t.m - 1);
  const out = [];
  for (let k = months - 1; k >= 0; k--) {
    const idx = cur - k;
    const y = Math.floor(idx / 12), m = idx - y * 12 + 1;
    let total = 0;
    for (const s of subs) {
      const a = parseDate(renewalAnchor(s));
      if (!a) continue;
      const step = CYCLE_MONTHS[s.cycle];
      const anchor = a.y * 12 + (a.m - 1);
      if ((((idx - anchor) % step) + step) % step === 0) total += chargeKrw(s);
    }
    out.push({ ym: `${y}-${pad(m)}`, label: `${m}월`, total });
  }
  return out;
}

/** Estimated charges for the next `months` months starting with the current month.
 *  Returns columns, one row per subscription (sorted by total, desc), and column totals. */
export function forecastNextMonths(subs, today, months = 12) {
  const t = parseDate(today);
  if (!t) throw new RangeError('Invalid date: ' + today);
  const cur = t.y * 12 + (t.m - 1);
  const cols = [];
  for (let k = 0; k < months; k++) {
    const idx = cur + k;
    const y = Math.floor(idx / 12), m = idx - y * 12 + 1;
    cols.push({ ym: `${y}-${pad(m)}`, label: `${m}월` });
  }
  const rows = subs.map(s => {
    const a = parseDate(renewalAnchor(s));
    const step = CYCLE_MONTHS[s.cycle];
    const cells = cols.map((_, k) => {
      if (!a) return 0;
      const anchor = a.y * 12 + (a.m - 1);
      const idx = cur + k;
      return (((idx - anchor) % step) + step) % step === 0 ? chargeKrw(s) : 0;
    });
    const total = cells.reduce((x, v) => x + v, 0);
    return { id: s.id, name: s.name, cells, total };
  }).sort((p, q) => q.total - p.total || p.name.localeCompare(q.name, 'ko'));
  const totals = cols.map((_, k) => rows.reduce((x, r) => x + r.cells[k], 0));
  return { cols, rows, totals, total: totals.reduce((x, v) => x + v, 0) };
}

/** Estimated charges in one calendar month, keyed by day of month (1-based index = day - 1).
 *  A charge lands on the subscription's renewal day, clamped to the month's length. */
export function monthCalendar(subs, today) {
  const t = parseDate(today);
  if (!t) throw new RangeError('Invalid date: ' + today);
  const dim = daysInMonth(t.y, t.m);
  const firstWeekday = new Date(Date.UTC(t.y, t.m - 1, 1)).getUTCDay(); // 0 = Sunday
  const cur = t.y * 12 + (t.m - 1);
  const days = Array.from({ length: dim }, () => []);
  for (const s of subs) {
    const a = parseDate(renewalAnchor(s));
    if (!a) continue;
    const step = CYCLE_MONTHS[s.cycle];
    const anchor = a.y * 12 + (a.m - 1);
    if ((((cur - anchor) % step) + step) % step !== 0) continue;
    const d = Math.min(a.d, dim);
    days[d - 1].push({ id: s.id, name: s.name, category: s.category, krw: chargeKrw(s) });
  }
  return { year: t.y, month: t.m, today: t.d, firstWeekday, daysInMonth: dim, days };
}

/** Budget progress for a monthly KRW total. A missing or non-positive budget means no budget. */
export function budgetStatus(monthlyTotal, budget) {
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return { enabled: false };
  const ratio = monthlyTotal / b;
  return {
    enabled: true,
    budget: b,
    ratio,
    percent: Math.min(100, ratio * 100),
    over: monthlyTotal > b,
    remaining: b - monthlyTotal,
  };
}

/** Free-trial state: null without a trial date, otherwise daysLeft and state. */
export function trialStatus(sub, today, days = TRIAL_WARN_DAYS) {
  if (!sub.trialEnds || !parseDate(sub.trialEnds)) return null;
  const daysLeft = daysBetween(today, sub.trialEnds);
  let state = 'later';
  if (daysLeft < 0) state = 'ended';
  else if (daysLeft === 0) state = 'today';
  else if (daysLeft <= days) state = 'soon';
  return { daysLeft, state };
}

/** Key for a dismissed trial alert. Changing the trial end date re-enables the alert. */
export function trialKey(sub) { return `${sub.id}|${sub.trialEnds}`; }

/** Trials that end soon, end today, or ended within the last 7 days; soonest first.
 *  dismissed: array of trialKey values the user hid. */
export function trialAlerts(subs, today, days = TRIAL_WARN_DAYS, dismissed = []) {
  const off = new Set(dismissed);
  return subs.flatMap(sub => {
    const st = trialStatus(sub, today, days);
    if (!st || st.state === 'later') return [];
    if (st.state === 'ended' && st.daysLeft < -7) return [];
    if (off.has(trialKey(sub))) return [];
    return [{ sub, ...st }];
  }).sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Empty input clears the budget (value 0). Otherwise a whole number of won, 0 or more. */
export function validateBudget(raw) {
  if (raw != null && typeof raw !== 'number' && typeof raw !== 'string') return { valid: false, value: 0, error: '예산은 숫자로 입력하세요.' };
  const s = String(raw ?? '').trim();
  if (s === '') return { valid: true, value: 0 };
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 1e10) return { valid: false, value: 0, error: '예산은 0 이상의 정수(원)로 입력하세요.' };
  return { valid: true, value: n };
}

/** Display-normalized name for comparisons: NFKC, lowercase, no whitespace. */
export function normalizeName(name) {
  return String(name ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** Groups of subscriptions whose names match after normalizeName (2 or more entries). */
export function findDuplicateGroups(subs) {
  const map = new Map();
  for (const s of subs) {
    const key = normalizeName(s.name);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return [...map.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, name: list[0].name, ids: list.map(s => s.id) }));
}

/** Filter by name (substring, ignoring case and spaces) and exact category/status/currency. '' means any. */
export function filterSubscriptions(subs, { query = '', category = '', status = '', currency = '' } = {}) {
  const q = normalizeName(query);
  return subs.filter(s =>
    (!q || normalizeName(s.name).includes(q)) &&
    (!category || s.category === category) &&
    (!status || s.status === status) &&
    (!currency || s.currency === currency));
}

/** Sorted copy. by: 'next' (renewal date), 'monthly' (monthly KRW cost, high first), 'name'. */
export function sortSubscriptions(subs, by = 'next') {
  if (!SORT_KEYS.includes(by)) throw new RangeError('Unknown sort: ' + by);
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
  let cmp;
  if (by === 'next') cmp = (a, b) => a.nextDate.localeCompare(b.nextDate) || byName(a, b);
  else if (by === 'monthly') cmp = (a, b) => monthlyCost(b) - monthlyCost(a) || byName(a, b);
  else cmp = byName;
  return [...subs].sort(cmp);
}

/** Human-readable price, e.g. '$20' or '17,000원'. */
export function formatPrice(amount, currency) {
  return currency === 'USD' ? `$${amount}` : `${Number(amount).toLocaleString('en-US')}원`;
}

/** Price history entry when the amount or currency changes, otherwise null. */
export function priceChangeEntry(prev, next, date) {
  if (Number(prev.amount) === Number(next.amount) && prev.currency === next.currency) return null;
  return { date, from: formatPrice(prev.amount, prev.currency), to: formatPrice(next.amount, next.currency) };
}

/** Shape check for a stored price history entry. */
export function isPriceEntry(h) {
  return !!h && typeof h === 'object' && parseDate(h.date) !== null
    && typeof h.from === 'string' && typeof h.to === 'string';
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

// ---- CSV ----
const CSV_HEADER = ['서비스명', '카테고리', '결제주기', '통화', '금액', '환율', '월 환산(원)', '다음 갱신일', '상태'];
/** RFC 4180 cell. Values a spreadsheet could read as a formula get a leading apostrophe. */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(subs) {
  const rows = [CSV_HEADER, ...subs.map(s => [
    s.name, s.category, s.cycle, s.currency, s.amount,
    s.currency === 'USD' ? s.rate : '',
    Math.round(monthlyCost(s)), s.nextDate, s.status,
  ])];
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// ---- JSON backup ----
/** Full backup document. exportedAt is passed in so the function stays deterministic. */
export function toBackup(subs, budget = 0, exportedAt = '') {
  return JSON.stringify({
    app: BACKUP_APP, version: BACKUP_VERSION, exportedAt,
    budget: Number(budget) || 0, subscriptions: subs,
  }, null, 2) + '\n';
}
/** Parse a backup file's text. Items that fail validation are counted in `skipped`. */
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
  catch { return { valid: false, error: 'JSON 형식이 아니에요.' }; }
  if (!data || typeof data !== 'object' || data.app !== BACKUP_APP || !Array.isArray(data.subscriptions)) {
    return { valid: false, error: '이 앱에서 내보낸 백업 파일이 아니에요.' };
  }
  if (data.subscriptions.length > MAX_BACKUP_ITEMS) {
    return { valid: false, error: `한 번에 ${MAX_BACKUP_ITEMS}건까지 가져올 수 있어요.` };
  }
  const subscriptions = [];
  let skipped = 0;
  for (const raw of data.subscriptions) {
    const item = normalizeSubscription(raw);
    if (item) subscriptions.push(item); else skipped++;
  }
  const b = validateBudget(data.budget);
  return { valid: true, subscriptions, budget: b.valid ? b.value : 0, hasBudget: Object.hasOwn(data, 'budget') && b.valid, skipped };
}
/** Incoming subscriptions replace current ones with the same id; the rest are appended. */
export function mergeSubscriptions(current, incoming) {
  const map = new Map(current.map(s => [s.id, s]));
  for (const s of incoming) map.set(s.id, s);
  return [...map.values()];
}

// ---- Validation ----
/** Validate and normalize one subscription. Optional fields get defaults when absent. */
export function validateSubscription(input) {
  const errors = {};
  const name = String(input.name ?? '').trim();
  if (!name) errors.name = '서비스 이름을 입력하세요.';
  else if (name.length > 40) errors.name = '이름은 40자 이하로 입력하세요.';
  if (!CATEGORIES.includes(input.category)) errors.category = '카테고리를 선택하세요.';
  if (!CURRENCIES.includes(input.currency)) errors.currency = '통화를 선택하세요.';
  const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) ? Number(value) : NaN;
  const amount = numeric(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) errors.amount = '0보다 큰 금액을 입력하세요.';
  else if (amount > 1e9) errors.amount = '금액이 너무 큽니다.';
  else if (input.currency === 'KRW' && !Number.isInteger(amount)) errors.amount = '원화는 정수로 입력하세요.';
  let rate = DEFAULT_RATE;
  if (input.currency === 'USD') {
    rate = numeric(input.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100000) errors.rate = '환율을 올바르게 입력하세요.';
  }
  if (!CYCLES.includes(input.cycle)) errors.cycle = '결제 주기를 선택하세요.';
  if (!parseDate(input.nextDate)) errors.nextDate = '올바른 갱신일을 입력하세요.';
  if (!STATUSES.includes(input.status)) errors.status = '상태를 선택하세요.';

  const trialRaw = String(input.trialEnds ?? '').trim();
  let trialEnds = '';
  if (trialRaw) {
    if (parseDate(trialRaw)) trialEnds = trialRaw;
    else errors.trialEnds = '체험 종료일을 올바르게 입력하세요.';
  }
  const peopleRaw = input.sharers;
  const people = peopleRaw === undefined || peopleRaw === null || String(peopleRaw).trim() === '' ? 1 : numeric(peopleRaw);
  if (!Number.isInteger(people) || people < 1 || people > SHARERS_MAX) {
    errors.sharers = `함께 쓰는 인원은 1~${SHARERS_MAX}명으로 입력하세요.`;
  }
  const notes = String(input.notes ?? '').trim();
  if (notes.length > NOTE_MAX) errors.notes = `메모는 ${NOTE_MAX}자 이하로 입력하세요.`;

  const valid = Object.keys(errors).length === 0;
  return {
    valid, errors,
    value: valid ? {
      name, category: input.category, amount, currency: input.currency,
      rate: input.currency === 'USD' ? rate : DEFAULT_RATE,
      cycle: input.cycle, nextDate: input.nextDate, status: input.status,
      trialEnds, sharers: people, notes,
    } : null,
  };
}

/** Validate a stored or imported record. Returns the normalized subscription, or null if unusable. */
export function normalizeSubscription(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || s.id === '' || s.id.length > 100) return null;
  // Optional fields that are malformed fall back to defaults; the record itself is kept.
  const safe = { ...s };
  if (safe.trialEnds && !parseDate(String(safe.trialEnds))) safe.trialEnds = '';
  const people = Number(safe.sharers);
  if (!Number.isInteger(people) || people < 1 || people > SHARERS_MAX) safe.sharers = 1;
  safe.notes = typeof safe.notes === 'string' ? safe.notes.trim().slice(0, NOTE_MAX) : '';
  const r = validateSubscription(safe);
  if (!r.valid) return null;
  return {
    ...r.value, id: s.id, demo: !!s.demo, renewalAnchor: renewalAnchor(s),
    history: Array.isArray(s.history) ? s.history.filter(isPriceEntry) : [],
  };
}
