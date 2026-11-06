import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, advanceRenewal, rollSubscription, monthlyCost, yearlyCost, upcomingWithin, categoryTotals,
  savingsIfCancelled, toIcs, validateSubscription, daysBetween, parseDate, addDays, escapeIcsText,
  savingsFor, monthlySpendTrend, budgetStatus, validateBudget, normalizeName, findDuplicateGroups,
  filterSubscriptions, sortSubscriptions, formatPrice, priceChangeEntry, isPriceEntry, toCsv, csvCell,
  myMonthlyCost, trialStatus, trialAlerts, forecastNextMonths, monthCalendar, toBackup, parseBackup,
  mergeSubscriptions, normalizeSubscription, NOTE_MAX, trialKey,
} from '../logic.js';

const mk = (o = {}) => ({ id: 'a1', name: 'Netflix', category: '스트리밍', amount: 10000, currency: 'KRW', rate: 1350, cycle: '매월', nextDate: '2026-12-01', status: '사용 중', ...o });
const ids = list => list.map(s => s.id);

test('addMonths clamps month-end (Jan 31 + 1 month)', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-03-31', 1), '2026-04-30');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
});
test('addMonths handles leap years', () => {
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2028-02-29', 12), '2029-02-28');
  assert.equal(addMonths('2028-02-29', 48), '2032-02-29');
  assert.equal(addMonths('2100-01-31', 1), '2100-02-28'); // 2100 is not leap
  assert.equal(addMonths('2000-01-31', 1), '2000-02-29'); // 2000 is leap
});
test('addMonths negative and invalid', () => {
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.throws(() => addMonths('2026-02-30', 1));
});
test('parseDate rejects invalid', () => {
  assert.equal(parseDate('2026-02-29'), null);
  assert.equal(parseDate('2026-13-01'), null);
  assert.equal(parseDate('abc'), null);
  assert.deepEqual(parseDate('2028-02-29'), { y: 2028, m: 2, d: 29 });
});
test('advanceRenewal leaves future/today dates alone', () => {
  assert.equal(advanceRenewal('2026-11-04', '매월', '2026-11-04'), '2026-11-04');
  assert.equal(advanceRenewal('2027-01-01', '매년', '2026-11-04'), '2027-01-01');
});
test('advanceRenewal rolls monthly past dates forward', () => {
  assert.equal(advanceRenewal('2026-08-15', '매월', '2026-11-04'), '2026-11-15');
  assert.equal(advanceRenewal('2026-11-03', '매월', '2026-11-04'), '2026-12-03');
});
test('advanceRenewal does not drift on month-end anchors', () => {
  // Jan 31 monthly: Feb 28 then back to Mar 31, not Mar 28
  assert.equal(advanceRenewal('2026-01-31', '매월', '2026-03-01'), '2026-03-31');
  assert.equal(advanceRenewal('2026-01-31', '매월', '2026-02-01'), '2026-02-28');
});
test('advanceRenewal yearly and quarterly, incl. leap day', () => {
  assert.equal(advanceRenewal('2024-02-29', '매년', '2026-11-04'), '2027-02-28');
  assert.equal(advanceRenewal('2025-01-10', '분기', '2026-11-04'), '2027-01-10');
  assert.equal(advanceRenewal('2020-02-29', '매년', '2024-03-01'), '2025-02-28');
  assert.equal(advanceRenewal('2020-02-29', '매년', '2024-02-29'), '2024-02-29');
});
test('advanceRenewal rejects unknown cycle', () => {
  assert.throws(() => advanceRenewal('2020-01-01', '매주', '2026-01-01'));
});

test('monthlyCost / yearlyCost normalize cycles', () => {
  assert.equal(monthlyCost(mk()), 10000);
  assert.equal(yearlyCost(mk()), 120000);
  assert.equal(monthlyCost(mk({ cycle: '매년', amount: 120000 })), 10000);
  assert.equal(monthlyCost(mk({ cycle: '분기', amount: 30000 })), 10000);
  assert.equal(yearlyCost(mk({ cycle: '분기', amount: 30000 })), 120000);
});
test('USD conversion uses user rate, default 1350', () => {
  assert.equal(monthlyCost(mk({ currency: 'USD', amount: 10, rate: 1400 })), 14000);
  assert.equal(monthlyCost(mk({ currency: 'USD', amount: 10, rate: undefined })), 13500);
  assert.equal(monthlyCost(mk({ currency: 'USD', amount: 120, rate: 1350, cycle: '매년' })), 13500);
});

test('upcomingWithin filters, advances and sorts', () => {
  const today = '2026-11-04';
  const subs = [
    mk({ id: '1', name: 'B', nextDate: '2026-11-20' }),
    mk({ id: '2', name: 'A', nextDate: '2026-11-06' }),
    mk({ id: '3', name: 'Far', nextDate: '2027-03-01' }),
    mk({ id: '4', name: 'Past', nextDate: '2026-10-05' }), // -> 2026-11-05
  ];
  const r7 = upcomingWithin(subs, today, 7);
  assert.deepEqual(r7.map(x => x.sub.id), ['4', '2']);
  assert.deepEqual(r7.map(x => x.daysLeft), [1, 2]);
  const r30 = upcomingWithin(subs, today, 30);
  assert.deepEqual(r30.map(x => x.sub.id), ['4', '2', '1']);
  assert.equal(upcomingWithin(subs, today, 0).length, 0);
  assert.equal(upcomingWithin([mk({ nextDate: today })], today, 0).length, 1);
});

test('categoryTotals sums monthly KRW per category', () => {
  const t = categoryTotals([
    mk({ id: '1', category: 'AI', amount: 20, currency: 'USD', rate: 1350 }),
    mk({ id: '2', category: '스트리밍', amount: 10000 }),
    mk({ id: '3', category: '스트리밍', amount: 36000, cycle: '분기' }),
  ]);
  assert.deepEqual(t, [{ category: 'AI', monthly: 27000 }, { category: '스트리밍', monthly: 22000 }]);
  assert.deepEqual(categoryTotals([]), []);
});

test('savingsIfCancelled counts only 해지 예정', () => {
  const s = savingsIfCancelled([
    mk({ id: '1', status: '해지 예정', amount: 10000 }),
    mk({ id: '2', status: '해지 예정', amount: 120000, cycle: '매년' }),
    mk({ id: '3', status: '사용 중', amount: 99999 }),
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.monthly, 20000);
  assert.equal(s.yearly, 240000);
  assert.deepEqual(savingsIfCancelled([]), { count: 0, monthly: 0, yearly: 0 });
});

test('savingsFor sums only the chosen ids (Set or array)', () => {
  const list = [mk({ id: '1', amount: 10000 }), mk({ id: '2', amount: 120000, cycle: '매년' }), mk({ id: '3', amount: 5000 })];
  assert.deepEqual(savingsFor(list, new Set(['2'])), { count: 1, monthly: 10000, yearly: 120000 });
  assert.deepEqual(savingsFor(list, ['1', '3']), { count: 2, monthly: 15000, yearly: 180000 });
  assert.deepEqual(savingsFor(list, new Set()), { count: 0, monthly: 0, yearly: 0 });
});

test('monthlySpendTrend back-projects cycles over the last 12 months', () => {
  const t = monthlySpendTrend([
    mk({ id: '1', amount: 10000 }),
    mk({ id: '2', cycle: '분기', amount: 30000, nextDate: '2027-01-10' }),
  ], '2026-11-04', 12);
  assert.equal(t.length, 12);
  assert.equal(t[0].ym, '2025-12');
  assert.equal(t[11].ym, '2026-11');
  assert.equal(t[11].total, 10000); // quarterly not due in Nov
  assert.equal(t[10].total, 40000); // Oct: monthly + quarterly
  assert.equal(t[9].total, 10000);  // Sep: monthly only
});

test('budgetStatus: disabled without a positive budget, over and under', () => {
  assert.equal(budgetStatus(100, 0).enabled, false);
  assert.equal(budgetStatus(100, undefined).enabled, false);
  const over = budgetStatus(120000, 100000);
  assert.equal(over.enabled, true);
  assert.equal(over.over, true);
  assert.equal(over.percent, 100);
  assert.equal(over.remaining, -20000);
  const under = budgetStatus(50000, 100000);
  assert.equal(under.over, false);
  assert.equal(under.percent, 50);
  assert.equal(under.remaining, 50000);
});

test('validateBudget: empty clears, whole won only', () => {
  assert.deepEqual(validateBudget(''), { valid: true, value: 0 });
  assert.deepEqual(validateBudget(null), { valid: true, value: 0 });
  assert.equal(validateBudget('150000').value, 150000);
  assert.equal(validateBudget('1.5').valid, false);
  assert.equal(validateBudget('-1').valid, false);
  assert.equal(validateBudget('abc').valid, false);
});

test('normalizeName ignores case, spaces and width', () => {
  assert.equal(normalizeName(' Netflix '), 'netflix');
  assert.equal(normalizeName('구글 원 2TB'), '구글원2tb');
  assert.equal(normalizeName(null), '');
});

test('findDuplicateGroups returns only names that occur more than once', () => {
  const groups = findDuplicateGroups([mk({ id: '1', name: 'Netflix' }), mk({ id: '2', name: ' netflix ' }), mk({ id: '3', name: 'Spotify' })]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'netflix');
  assert.deepEqual(groups[0].ids, ['1', '2']);
  assert.deepEqual(findDuplicateGroups([mk({ id: '1' }), mk({ id: '2', name: 'Other' })]), []);
});

test('filterSubscriptions by name, category, status and currency', () => {
  const list = [
    mk({ id: '1', name: 'Netflix' }),
    mk({ id: '2', name: '멜론', category: '음악' }),
    mk({ id: '3', name: 'GPT', category: 'AI', currency: 'USD', amount: 20, status: '해지 예정' }),
  ];
  assert.deepEqual(ids(filterSubscriptions(list, { query: 'NET' })), ['1']);
  assert.deepEqual(ids(filterSubscriptions(list, { query: '멜 론' })), ['2']);
  assert.deepEqual(ids(filterSubscriptions(list, { category: 'AI', currency: 'USD' })), ['3']);
  assert.deepEqual(ids(filterSubscriptions(list, { status: '해지 예정' })), ['3']);
  assert.deepEqual(ids(filterSubscriptions(list, { category: '음악', status: '해지 예정' })), []);
  assert.equal(filterSubscriptions(list, {}).length, 3);
});

test('sortSubscriptions by next date, monthly cost and name, without mutating input', () => {
  const list = [
    mk({ id: 'a', name: 'B', nextDate: '2026-12-05', amount: 10000 }),
    mk({ id: 'b', name: 'A', nextDate: '2026-12-01', amount: 30000 }),
    mk({ id: 'c', name: 'C', nextDate: '2026-12-05', amount: 20000 }),
  ];
  assert.deepEqual(ids(sortSubscriptions(list, 'next')), ['b', 'a', 'c']);
  assert.deepEqual(ids(sortSubscriptions(list, 'monthly')), ['b', 'c', 'a']);
  assert.deepEqual(ids(sortSubscriptions(list, 'name')), ['b', 'a', 'c']);
  assert.deepEqual(ids(list), ['a', 'b', 'c']);
  assert.throws(() => sortSubscriptions(list, 'bogus'));
});

test('formatPrice and price change history', () => {
  assert.equal(formatPrice(20, 'USD'), '$20');
  assert.equal(formatPrice(17000, 'KRW'), '17,000원');
  assert.deepEqual(
    priceChangeEntry(mk({ amount: 10, currency: 'USD' }), mk({ amount: 12, currency: 'USD' }), '2026-11-04'),
    { date: '2026-11-04', from: '$10', to: '$12' });
  assert.equal(priceChangeEntry(mk({ amount: 10, currency: 'USD' }), mk({ amount: 10, currency: 'USD', rate: 1400 }), '2026-11-04'), null);
  assert.deepEqual(
    priceChangeEntry(mk({ amount: 10, currency: 'USD' }), mk({ amount: 13500, currency: 'KRW' }), '2026-11-04'),
    { date: '2026-11-04', from: '$10', to: '13,500원' });
  assert.equal(isPriceEntry({ date: '2026-11-04', from: '$10', to: '$12' }), true);
  assert.equal(isPriceEntry({ date: '2026-02-30', from: '$10', to: '$12' }), false);
  assert.equal(isPriceEntry({ date: '2026-11-04', from: 1, to: '$12' }), false);
});

test('toIcs format: CRLF, all-day events, 1-day alarm', () => {
  const ics = toIcs([{ sub: mk(), date: '2026-12-31' }], '20261104T000000Z');
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'no bare LF');
  assert.match(ics, /DTSTART;VALUE=DATE:20261231\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20270101\r\n/); // year rollover
  assert.match(ics, /TRIGGER:-P1D\r\n/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(ics, /DTSTAMP:20261104T000000Z/);
});
test('toIcs escapes commas, semicolons, backslashes, newlines', () => {
  const ics = toIcs([{ sub: mk({ name: 'A,B;C\\D\nE' }), date: '2026-12-01' }]);
  // RFC 5545 TEXT escaping: \\ then \; then \, then \n
  assert.match(ics, /SUMMARY:\[갱신\] A\\,B\\;C\\\\D\\nE\r\n/);
});
test('escapeIcsText escapes semicolons and commas', () => {
  assert.equal(escapeIcsText('a;b,c'), 'a\\;b\\,c');
  assert.equal(escapeIcsText('x\\y'), 'x\\\\y');
});
test('toIcs KRW description uses thousands separators, comma escaped per RFC 5545', () => {
  const ics = toIcs([{ sub: mk({ category: '개발도구', cycle: '매월', amount: 10000 }), date: '2026-12-01' }]);
  assert.match(ics, /DESCRIPTION:개발도구 \/ 매월 \/ 10\\,000원\r\n/);
});
test('toIcs USD description and quarterly/yearly rollover dates', () => {
  const ics = toIcs([{ sub: mk({ currency: 'USD', amount: 20, cycle: '분기', name: 'GPT' }), date: '2028-02-28' }]);
  assert.match(ics, /DESCRIPTION:스트리밍 \/ 분기 \/ \$20\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20280228\r\n/);
  assert.match(ics, /DTEND;VALUE=DATE:20280229\r\n/); // leap day
});
test('toIcs folds long lines to 75 octets and one event per renewal', () => {
  const long = 'ㄱ'.repeat(60);
  const ics = toIcs([{ sub: mk({ name: long }), date: '2026-12-01' }, { sub: mk({ id: 'b', name: 'X' }), date: '2026-12-02' }]);
  const enc = new TextEncoder();
  for (const line of ics.split('\r\n')) assert.ok(enc.encode(line).length <= 75, line);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  // unfolding restores the summary
  assert.ok(ics.replace(/\r\n /g, '').includes('SUMMARY:[갱신] ' + long));
});
test('toIcs with no items is still a valid calendar', () => {
  const ics = toIcs([]);
  assert.ok(ics.includes('BEGIN:VCALENDAR') && !ics.includes('VEVENT'));
});

test('csvCell escapes quotes and commas and guards formulas', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell(10000), '10000');
  assert.equal(csvCell(null), '');
});
test('toCsv has a Korean header, one row per subscription, CRLF endings', () => {
  const csv = toCsv([
    mk({ id: '1', name: 'A,"B"' }),
    mk({ id: '2', name: '=evil', currency: 'USD', amount: 20, rate: 1350, cycle: '매년', nextDate: '2027-01-01' }),
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], '서비스명,카테고리,결제주기,통화,금액,환율,월 환산(원),다음 갱신일,상태');
  assert.equal(lines[1], '"A,""B""",스트리밍,매월,KRW,10000,,10000,2026-12-01,사용 중');
  assert.equal(lines[2], "'=evil,스트리밍,매년,USD,20,1350,2250,2027-01-01,사용 중");
  assert.equal(lines.length, 4); // header, two rows, trailing empty after final CRLF
  assert.ok(csv.endsWith('\r\n'));
});

test('validateSubscription accepts valid input and normalizes', () => {
  const r = validateSubscription({ name: '  Netflix ', category: '스트리밍', amount: '17000', currency: 'KRW', cycle: '매월', nextDate: '2026-12-01', status: '사용 중' });
  assert.ok(r.valid);
  assert.equal(r.value.name, 'Netflix');
  assert.equal(r.value.amount, 17000);
});
test('validateSubscription rejects bad input', () => {
  const r = validateSubscription({ name: '', category: 'x', amount: '-1', currency: 'EUR', cycle: '매주', nextDate: '2026-02-30', status: '?' });
  assert.equal(r.valid, false);
  for (const k of ['name', 'category', 'amount', 'currency', 'cycle', 'nextDate', 'status']) assert.ok(r.errors[k], k);
  assert.equal(r.value, null);
});
test('validateSubscription USD needs a sane rate; KRW must be integer', () => {
  const base = { name: 'GPT', category: 'AI', amount: '20', currency: 'USD', cycle: '매월', nextDate: '2026-12-01', status: '사용 중' };
  assert.ok(validateSubscription({ ...base, rate: '1350' }).valid);
  assert.ok(validateSubscription({ ...base, rate: '0' }).errors.rate);
  assert.ok(validateSubscription({ ...base, rate: '' }).errors.rate);
  assert.ok(validateSubscription({ ...base, currency: 'KRW', amount: '10.5' }).errors.amount);
  assert.ok(validateSubscription({ ...base, rate: '1350', amount: '' }).errors.amount);
  assert.ok(validateSubscription({ ...base, rate: '1350', name: 'x'.repeat(41) }).errors.name);
});
test('date helpers', () => {
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('validateSubscription defaults optional fields and checks them', () => {
  const base = { name: 'Netflix', category: '스트리밍', amount: '17000', currency: 'KRW', cycle: '매월', nextDate: '2026-12-01', status: '사용 중' };
  const ok = validateSubscription(base);
  assert.ok(ok.valid);
  assert.equal(ok.value.sharers, 1);
  assert.equal(ok.value.trialEnds, '');
  assert.equal(ok.value.notes, '');
  assert.ok(validateSubscription({ ...base, sharers: '4', trialEnds: '2026-12-01', notes: '가족' }).valid);
  assert.ok(validateSubscription({ ...base, sharers: '0' }).errors.sharers);
  assert.ok(validateSubscription({ ...base, sharers: '21' }).errors.sharers);
  assert.ok(validateSubscription({ ...base, sharers: '2.5' }).errors.sharers);
  assert.ok(validateSubscription({ ...base, trialEnds: '2026-02-30' }).errors.trialEnds);
  assert.ok(validateSubscription({ ...base, notes: 'x'.repeat(NOTE_MAX + 1) }).errors.notes);
});

test('myMonthlyCost divides by sharers, defaulting to 1', () => {
  assert.equal(myMonthlyCost(mk()), 10000);
  assert.equal(myMonthlyCost(mk({ sharers: 4 })), 2500);
  assert.equal(myMonthlyCost(mk({ sharers: 0 })), 10000);
});

test('trialStatus classifies soon, today, ended and later', () => {
  const today = '2026-11-04';
  assert.equal(trialStatus(mk({ trialEnds: '' }), today), null);
  assert.equal(trialStatus(mk({}), today), null);
  assert.deepEqual(trialStatus(mk({ trialEnds: '2026-11-06' }), today), { daysLeft: 2, state: 'soon' });
  assert.deepEqual(trialStatus(mk({ trialEnds: '2026-11-04' }), today), { daysLeft: 0, state: 'today' });
  assert.deepEqual(trialStatus(mk({ trialEnds: '2026-11-01' }), today), { daysLeft: -3, state: 'ended' });
  assert.deepEqual(trialStatus(mk({ trialEnds: '2026-12-20' }), today), { daysLeft: 46, state: 'later' });
});

test('trialAlerts keeps soon/today/recently ended, soonest first', () => {
  const today = '2026-11-04';
  const list = trialAlerts([
    mk({ id: 'late', trialEnds: '2026-12-20' }),
    mk({ id: 'old', trialEnds: '2026-10-01' }),
    mk({ id: 'soon', trialEnds: '2026-11-06' }),
    mk({ id: 'today', trialEnds: '2026-11-04' }),
  ], today);
  assert.deepEqual(list.map(x => x.sub.id), ['today', 'soon']);
});

test('forecastNextMonths projects cycles over 12 columns with totals', () => {
  const today = '2026-11-04';
  const f = forecastNextMonths([
    mk({ id: 'm', amount: 10000, nextDate: '2026-12-01' }),
    mk({ id: 'q', cycle: '분기', amount: 30000, nextDate: '2027-01-10' }),
  ], today, 12);
  assert.equal(f.cols.length, 12);
  assert.equal(f.cols[0].ym, '2026-11');
  assert.equal(f.cols[11].ym, '2027-10');
  const q = f.rows.find(r => r.id === 'q');
  assert.equal(q.cells[0], 0);       // Nov: not due
  assert.equal(q.cells[2], 30000);   // Jan 2027
  assert.equal(q.cells[5], 30000);   // Apr 2027
  assert.equal(q.total, 120000);
  assert.equal(f.rows.find(r => r.id === 'm').total, 120000);
  assert.equal(f.totals[0], 10000);
  assert.equal(f.total, 240000);
  assert.deepEqual(f.rows.map(r => r.id), ['m', 'q']); // equal totals and names keep input order
});

test('monthCalendar places charges on renewal day, clamped to month length', () => {
  const c = monthCalendar([
    mk({ id: 'm', nextDate: '2026-12-01' }),
    mk({ id: 'end', nextDate: '2026-12-31' }),
    mk({ id: 'y', cycle: '매년', nextDate: '2027-11-15' }),
    mk({ id: 'q', cycle: '분기', nextDate: '2027-01-10' }),
  ], '2026-11-04');
  assert.equal(c.year, 2026);
  assert.equal(c.month, 11);
  assert.equal(c.today, 4);
  assert.equal(c.daysInMonth, 30);
  assert.equal(c.firstWeekday, new Date(Date.UTC(2026, 10, 1)).getUTCDay());
  assert.deepEqual(c.days[0].map(x => x.id), ['m']);
  assert.deepEqual(c.days[14].map(x => x.id), ['y']);
  assert.deepEqual(c.days[29].map(x => x.id), ['end']); // Dec 31 clamped to Nov 30
  assert.equal(c.days.reduce((t, d) => t + d.length, 0), 3);
});

test('toBackup and parseBackup round-trip, with defaults and skip counting', () => {
  const subs = [mk({ id: 'x', notes: 'hi', sharers: 2, trialEnds: '2026-12-01' })];
  const text = toBackup(subs, 150000, '2026-11-04T00:00:00.000Z');
  const r = parseBackup(text);
  assert.equal(r.valid, true);
  assert.equal(r.budget, 150000);
  assert.equal(r.skipped, 0);
  assert.equal(r.subscriptions.length, 1);
  assert.equal(r.subscriptions[0].id, 'x');
  assert.equal(r.subscriptions[0].notes, 'hi');
  assert.equal(r.subscriptions[0].sharers, 2);
  assert.equal(r.subscriptions[0].trialEnds, '2026-12-01');
  assert.deepEqual(r.subscriptions[0].history, []);

  assert.equal(parseBackup('not json').valid, false);
  assert.equal(parseBackup('{"app":"other","subscriptions":[]}').valid, false);
  const mixed = JSON.stringify({ app: 'renewal-ledger', version: 2, subscriptions: [{ id: 'a' }, mk({ id: 'b' })] });
  const m = parseBackup(mixed);
  assert.equal(m.valid, true);
  assert.equal(m.skipped, 1);
  assert.equal(m.subscriptions.length, 1);
  assert.equal(m.budget, 0);
});

test('mergeSubscriptions replaces by id and appends the rest', () => {
  const merged = mergeSubscriptions(
    [{ id: '1', name: 'A' }, { id: '2', name: 'Old' }],
    [{ id: '2', name: 'B' }, { id: '3', name: 'C' }]);
  assert.deepEqual(merged.map(s => s.id), ['1', '2', '3']);
  assert.equal(merged[1].name, 'B');
});

test('normalizeSubscription rejects missing ids and keeps valid records', () => {
  assert.equal(normalizeSubscription(mk({ id: '' })), null);
  assert.equal(normalizeSubscription(null), null);
  const n = normalizeSubscription(mk({ id: 'z' }));
  assert.equal(n.id, 'z');
  assert.equal(n.demo, false);
  assert.equal(n.sharers, 1);
});

test('normalizeSubscription keeps records with malformed optional fields', () => {
  const n = normalizeSubscription(mk({ id: 's', trialEnds: 'bad-date', sharers: 'x', notes: 'y'.repeat(300) }));
  assert.ok(n, 'record should not be dropped');
  assert.equal(n.trialEnds, '');
  assert.equal(n.sharers, 1);
  assert.equal(n.notes.length, NOTE_MAX);
  assert.equal(normalizeSubscription(mk({ id: 't', sharers: null })).sharers, 1);
});

test('mergeSubscriptions with an empty base removes duplicate ids (last wins)', () => {
  const m = mergeSubscriptions([], [{ id: '1', name: 'A' }, { id: '1', name: 'B' }]);
  assert.equal(m.length, 1);
  assert.equal(m[0].name, 'B');
});

test('trialAlerts hides dismissed trials until the end date changes', () => {
  const today = '2026-11-04';
  const sub = mk({ id: 'n', trialEnds: '2026-11-06' });
  assert.equal(trialAlerts([sub], today).length, 1);
  assert.equal(trialAlerts([sub], today, 7, [trialKey(sub)]).length, 0);
  const moved = mk({ id: 'n', trialEnds: '2026-11-08' });
  assert.equal(trialAlerts([moved], today, 7, [trialKey(sub)]).length, 1);
});

// This exercises separate loads, rather than advancing directly from January to March.
test('saved monthly renewal keeps its billing day after February and unrelated edits', () => {
  const january = mk({ nextDate: '2026-01-31' });
  const february = rollSubscription(january, '2026-02-01');
  assert.equal(february.nextDate, '2026-02-28');
  const reloaded = normalizeSubscription(JSON.parse(JSON.stringify({ ...february, notes: 'changed' })));
  const march = rollSubscription(reloaded, '2026-03-01');
  assert.equal(march.nextDate, '2026-03-31');
  assert.equal(march.renewalAnchor, '2026-01-31');
  assert.equal(upcomingWithin([march], '2026-04-01', 30)[0].date, '2026-04-30');
  const cal = monthCalendar([march], '2026-05-01');
  assert.equal(cal.days[30][0].id, january.id);
});
test('saved annual renewal returns to leap day when the next leap year arrives', () => {
  let s = mk({ nextDate: '2024-02-29', cycle: '매년' });
  for (let year = 2025; year <= 2028; year++) s = rollSubscription(normalizeSubscription(s), year + '-02-01');
  assert.equal(s.nextDate, '2028-02-29');
  assert.equal(s.renewalAnchor, '2024-02-29');
});
test('bad saved renewal anchors fall back to the current date', () => {
  for (const anchor of ['bad', '2026-02-30', '2099-01-01']) {
    const s = normalizeSubscription(mk({ renewalAnchor: anchor }));
    assert.equal(s.renewalAnchor, s.nextDate);
  }
});

test('backup preserves an explicitly cleared budget and distinguishes legacy missing budgets', () => {
  const cleared = parseBackup(toBackup([], 0));
  assert.equal(cleared.hasBudget, true);
  assert.equal(cleared.budget, 0);
  const legacy = parseBackup(JSON.stringify({ app: 'renewal-ledger', subscriptions: [] }));
  assert.equal(legacy.hasBudget, false);
  const broken = parseBackup(JSON.stringify({ app: 'renewal-ledger', subscriptions: [], budget: 'wrong' }));
  assert.equal(broken.hasBudget, false);
});

test('backup accepts UTF-8 BOM without changing Korean text', () => {
  const source = [mk({ name: '한글 구독' })];
  const back = parseBackup('\uFEFF' + toBackup(source, 10000));
  assert.equal(back.valid, true);
  assert.equal(back.subscriptions.length, source.length);
  assert.equal(back.subscriptions[0].name, source[0].name);
});
