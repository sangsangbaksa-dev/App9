import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, advanceRenewal, monthlyCost, yearlyCost, upcomingWithin, categoryTotals,
  savingsIfCancelled, toIcs, validateSubscription, daysBetween, parseDate, addDays, escapeIcsText,
} from '../logic.js';

const mk = (o = {}) => ({ id: 'a1', name: 'Netflix', category: '스트리밍', amount: 10000, currency: 'KRW', rate: 1350, cycle: '매월', nextDate: '2026-12-01', status: '사용 중', ...o });

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
