import {
  CATEGORIES, CURRENCIES, CYCLES, STATUSES, DEFAULT_RATE, monthlyCost, yearlyCost, advanceRenewal, upcomingWithin,
  categoryTotals, savingsIfCancelled, savingsFor, toIcs, toCsv, validateSubscription, validateBudget,
  addMonths, formatPrice, displayPrice, normalizeName, priceChangeEntry, findDuplicateGroups, filterSubscriptions,
  sortSubscriptions, monthlySpendTrend, budgetStatus, normalizeSubscription, myMonthlyCost, trialStatus,
  trialAlerts, forecastNextMonths, monthCalendar, toBackup, parseBackup, mergeSubscriptions,
  trialKey, TRIAL_WARN_DAYS, NOTE_MAX,
  digestFacts, localDigest, buildDigestPrompt, buildAnthropicRequest, extractText, parseDigestResponse,
  isPlausibleKey, aiErrorMessage, AI_KEY_STORAGE, parseMoneyText,
  buildSpendReport, compareSubscriptions, money, catLabel, cycleLabel, statusLabel, csvHeader,
} from './logic.js';
import {
  t, setLang, getLang, detectLang, readSavedLang, saveLang, applyI18n, LANGS, fmtDate, fmtNumber, weekdayShort, monthName,
} from './i18n.js';

const KEY = 'renewal-ledger:v1', THEME_KEY = 'renewal-ledger:theme', BUDGET_KEY = 'renewal-ledger:budget';
const DISMISS_KEY = 'renewal-ledger:trial-dismissed';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const $ = id => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const CAT_COLOR = Object.fromEntries(CATEGORIES.map((c, i) => [c, `var(--c${i})`]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SORT_LABEL_KEYS = { next: 'sortNext', monthly: 'sortMonthly', name: 'sortName' };

let subs = [];
let range = 7;
let editingId = null;
let storageOk = true;
let budget = 0;
let dismissed = [];
const simOff = new Set();

const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const won = n => money(n);
const num = n => fmtNumber(Math.round(n), { maximumFractionDigits: 0 });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2));
const monthlyTotal = () => subs.reduce((t0, s) => t0 + monthlyCost(s), 0);
/** Stored price text ("17,000원", "$20") shown in the selected language. */
const showPrice = (text) => { const p = parseMoneyText(text); return p ? displayPrice(p.amount, p.currency) : text; };

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ---- storage ----
// Stored shape: [{ id, name, category, amount, currency, rate, cycle, nextDate, status, demo?, history?,
//                  trialEnds?, sharers?, notes? }]. Missing optional fields get defaults on load.
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // mergeSubscriptions also removes duplicate ids that could make edits hit the wrong record.
    return mergeSubscriptions([], arr.map(normalizeSubscription).filter(Boolean));
  } catch { storageOk = false; return []; }
}
function loadDismissed() {
  try {
    const arr = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
  } catch { return []; }
}
function saveDismissed() {
  try { localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed)); } catch { /* ignore */ }
}
/** Move focus to a heading (tabindex -1) after the focused control was removed by a re-render. */
function focusHeading(id) {
  const h = $(id);
  if (h) h.focus({ preventScroll: true });
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(subs)); }
  catch { if (storageOk) { storageOk = false; toast(t('toastSaveFail')); } }
}
function loadBudget() {
  try { const r = validateBudget(localStorage.getItem(BUDGET_KEY)); return r.valid ? r.value : 0; }
  catch { return 0; }
}
function saveBudget() {
  try { localStorage.setItem(BUDGET_KEY, String(budget)); } catch { /* ignore */ }
}

// ---- toast ----
function toast(msg) {
  const tn = el('div', { class: 'toast', text: msg });
  $('toasts').append(tn);
  setTimeout(() => tn.remove(), 3200);
}

// ---- auto advance on load/render ----
function advanceAll() {
  const today = todayStr();
  let changed = false;
  for (const s of subs) {
    const n = advanceRenewal(s.nextDate, s.cycle, today);
    if (n !== s.nextDate) { s.nextDate = n; changed = true; }
  }
  if (changed) save();
}

// ---- count-up ----
function countUp(node, to, fmt = won) {
  const from = Number(node.dataset.v || 0);
  node.dataset.v = to;
  if (reduceMotion || from === to) { node.textContent = fmt(to); return; }
  const start = performance.now(), dur = 700;
  const tick = now => {
    const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
    node.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- render ----
function renderBar() {
  $('barTotal').textContent = won(monthlyTotal());
}

function renderStats() {
  const box = $('stats');
  if (!box.children.length) {
    for (const [id, k] of [['sMonth', t('statMonth')], ['sYear', t('statYear')], ['sActive', t('statusActive')]]) {
      box.append(el('div', { class: 'stat' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', id, text: '0' })));
    }
  }
  const yearly = subs.reduce((t0, s) => t0 + yearlyCost(s), 0);
  countUp($('sMonth'), monthlyTotal());
  countUp($('sYear'), yearly);
  countUp($('sActive'), subs.filter(s => s.status === '사용 중').length, n => t('countItems', { n: Math.round(n) }));
}

function renderDonut() {
  const totals = categoryTotals(subs), sum = totals.reduce((t0, x) => t0 + x.monthly, 0);
  const donut = $('donut'), legend = $('legend');
  donut.replaceChildren(); legend.replaceChildren();
  const svg = svgEl('svg', { viewBox: '0 0 42 42', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 21, cy: 21, r: 15.9155, fill: 'none', 'stroke-width': 6, stroke: 'currentColor', opacity: .08 }));
  const segs = [];
  let cum = 0;
  totals.forEach(tt => {
    const pct = sum ? (tt.monthly / sum) * 100 : 0;
    const c = svgEl('circle', { cx: 21, cy: 21, r: 15.9155, fill: 'none', 'stroke-width': 6, stroke: CAT_COLOR[tt.category], 'stroke-dashoffset': -cum, 'stroke-dasharray': '0 100' });
    c.classList.add('seg');
    svg.append(c);
    segs.push([c, Math.max(pct - (totals.length > 1 ? 0.8 : 0), 0.01)]);
    cum += pct;
  });
  donut.append(svg, el('div', { class: 'center' }, el('span', { text: sum ? won(sum) : t('noData') }), el('small', { text: t('donutCenter') })));
  donut.setAttribute('aria-label', totals.length
    ? t('donutAria', { list: totals.map(tt => `${catLabel(tt.category)} ${won(tt.monthly)}`).join(', ') })
    : t('noData'));
  const bars = [];
  totals.forEach(tt => {
    const pct = sum ? (tt.monthly / sum) * 100 : 0;
    const bar = el('i'); bar.style.background = CAT_COLOR[tt.category];
    bars.push([bar, pct]);
    const dot = el('span', { class: 'dot' }); dot.style.background = CAT_COLOR[tt.category];
    legend.append(el('li', {}, dot, el('span', { text: t('legendItem', { cat: catLabel(tt.category), pct: pct.toFixed(0) }) }), el('span', { class: 'amt', text: won(tt.monthly) }), el('span', { class: 'bar' }, bar)));
  });
  if (!totals.length) legend.append(el('li', { class: 'empty', text: t('donutEmpty') }));
  const go = () => { segs.forEach(([c, p]) => c.setAttribute('stroke-dasharray', `${p} ${100 - p}`)); bars.forEach(([b, p]) => { b.style.width = p + '%'; }); };
  if (reduceMotion) go(); else requestAnimationFrame(() => requestAnimationFrame(go));
}

function renderTrials() {
  const box = $('trialAlerts'), list = $('trialList');
  const alerts = trialAlerts(subs, todayStr(), TRIAL_WARN_DAYS, dismissed);
  list.replaceChildren();
  box.hidden = !alerts.length;
  for (const a of alerts) {
    const when = a.state === 'ended' ? t('trialEndedAgo', { n: -a.daysLeft })
      : a.state === 'today' ? t('trialTodayEnds') : t('trialSoonEnds', { n: a.daysLeft });
    const advice = a.state === 'ended' ? t('trialAdvEnded') : t('trialAdvSoon');
    list.append(el('li', { class: `alert-item ${a.state}` },
      el('span', { class: 'alert-text' }, el('strong', { text: a.sub.name }), el('span', { text: ` · ${when}. ${advice}` })),
      el('button', { class: 'btn ghost small', type: 'button', text: t('trialOff'), 'aria-label': t('trialOffAria', { name: a.sub.name }), onclick: () => dismissTrial(a.sub) })));
  }
}
function dismissTrial(sub) {
  dismissed = [...dismissed, trialKey(sub)];
  saveDismissed();
  renderTrials();
  // A hidden heading cannot take focus, so fall back to the list when the last alert is gone.
  focusHeading($('trialList').children.length ? 'trialH' : 'listH');
  toast(t('toastTrialOff'));
}

function renderTrend() {
  const box = $('trend');
  box.replaceChildren();
  if (!subs.length) {
    $('trendSummary').textContent = t('trendNone');
    return;
  }
  const data = monthlySpendTrend(subs, todayStr(), 12);
  const current = data[data.length - 1].total;
  const avg = data.reduce((t0, d) => t0 + d.total, 0) / data.length;
  $('trendSummary').textContent = t('trendSummary', { cur: won(current), avg: won(avg) });

  const W = 320, H = 170, top = 10, bottom = 22, left = 4, right = 4;
  const chartH = H - top - bottom;
  const max = Math.max(1, ...data.map(d => d.total), budget > 0 ? budget : 0);
  const slot = (W - left - right) / data.length;
  const y = v => top + chartH - (v / max) * chartH;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend-svg', role: 'img', 'aria-label': t('ariaTrend') });
  data.forEach((d, i) => {
    const x = left + i * slot + slot * 0.18, w = slot * 0.64;
    const h = (d.total / max) * chartH;
    const rect = svgEl('rect', {
      x: x.toFixed(2), y: (top + chartH - h).toFixed(2), width: w.toFixed(2), height: h.toFixed(2), rx: 2,
      class: 'bar' + (i === data.length - 1 ? ' cur' : ''),
    });
    const title = svgEl('title');
    title.textContent = `${d.label}: ${won(d.total)}`;
    rect.append(title);
    svg.append(rect);
    const label = svgEl('text', { x: (left + i * slot + slot / 2).toFixed(2), y: H - 6, 'text-anchor': 'middle' });
    label.textContent = d.label;
    svg.append(label);
  });
  if (budget > 0) {
    const by = y(budget).toFixed(2);
    svg.append(svgEl('line', { x1: left, x2: W - right, y1: by, y2: by, class: 'budget-line' }));
  }
  box.append(svg);
}

function renderBudget() {
  const st = budgetStatus(monthlyTotal(), budget);
  const card = $('budgetCard'), meter = $('budgetMeter'), msg = $('budgetMsg'), state = $('budgetState');
  card.classList.toggle('over', st.enabled && st.over);
  meter.hidden = !st.enabled;
  state.hidden = !st.enabled;
  if (!st.enabled) {
    msg.textContent = t('budgetNone');
    return;
  }
  const pct = Math.round(st.percent);
  $('budgetFill').style.width = st.percent + '%';
  meter.setAttribute('aria-valuenow', String(pct));
  state.className = st.over ? 'tag over' : 'tag ok';
  state.textContent = st.over ? t('budgetOver') : t('budgetPct', { pct });
  msg.textContent = st.over
    ? t('budgetOverBy', { amt: won(-st.remaining) })
    : t('budgetLeft', { amt: won(st.remaining) });
}

function renderForecast() {
  const box = $('forecast');
  box.replaceChildren();
  if (!subs.length) {
    $('forecastTotal').textContent = '';
    box.append(el('p', { class: 'empty', text: t('forecastEmpty') }));
    return;
  }
  const f = forecastNextMonths(subs, todayStr(), 12);
  $('forecastTotal').textContent = t('forecastTotal', { amt: won(f.total) });
  const thead = el('thead', {}, el('tr', {},
    el('th', { scope: 'col', text: t('colSub') }),
    ...f.cols.map(c => el('th', { scope: 'col', text: c.label })),
    el('th', { scope: 'col', class: 'num', text: t('colTotal') })));
  const tbody = el('tbody', {}, ...f.rows.map(r => el('tr', {},
    el('th', { scope: 'row', text: r.name }),
    ...r.cells.map(v => el('td', { class: v ? '' : 'zero', text: v ? num(v) : '–' })),
    el('td', { class: 'num', text: num(r.total) }))));
  const tfoot = el('tfoot', {}, el('tr', {},
    el('th', { scope: 'row', text: t('rowTotal') }),
    ...f.totals.map(v => el('td', { text: num(v) })),
    el('td', { class: 'num', text: num(f.total) })));
  box.append(el('table', { class: 'forecast-table' }, thead, tbody, tfoot));
}

function renderCalendar() {
  const c = monthCalendar(subs, todayStr());
  $('calTitle').textContent = monthName(c.year, c.month);
  const grid = $('calGrid');
  grid.replaceChildren();
  for (let i = 0; i < 7; i++) grid.append(el('div', { class: 'cal-wd', 'aria-hidden': 'true', text: weekdayShort(i) }));
  for (let i = 0; i < c.firstWeekday; i++) grid.append(el('div', { class: 'cal-cell blank', 'aria-hidden': 'true' }));
  c.days.forEach((items, i) => {
    const day = i + 1;
    const cell = el('div', { class: 'cal-cell' + (day === c.today ? ' today' : '') + (items.length ? ' has' : '') });
    cell.append(el('span', { class: 'cal-day', text: String(day) }));
    if (items.length) {
      const dots = el('span', { class: 'cal-dots', 'aria-hidden': 'true' });
      items.slice(0, 3).forEach(it => { const d = el('i'); d.style.background = CAT_COLOR[it.category]; dots.append(d); });
      cell.append(dots);
    }
    grid.append(cell);
  });
  const list = $('calList');
  list.replaceChildren();
  const hits = c.days.flatMap((items, i) => items.map(it => ({ day: i + 1, ...it })));
  if (!hits.length) list.append(el('li', { class: 'empty', text: t('calEmpty') }));
  for (const h of hits) {
    list.append(el('li', {},
      el('span', { class: 'cal-date', text: `${c.month}/${h.day}` }),
      el('span', { class: 'cal-name', text: h.name }),
      el('span', { class: 'amt', text: won(h.krw) })));
  }
}

function renderTimeline() {
  const ol = $('timeline'); ol.replaceChildren();
  const items = upcomingWithin(subs, todayStr(), range);
  if (!items.length) ol.append(el('li', { class: 'empty', text: t('timelineEmpty', { n: range }) }));
  items.forEach((it, i) => {
    const urg = it.daysLeft <= 3 ? 'u-high' : it.daysLeft <= 7 ? 'u-mid' : 'u-low';
    const li = el('li', { class: `tl ${urg}` },
      el('div', {},
        el('div', { class: 'n', text: it.sub.name }),
        el('div', { class: 'm', text: `${fmtDate(it.date)} · ${displayPrice(it.sub.amount, it.sub.currency)} · ${cycleLabel(it.sub.cycle)}${it.sub.status === '해지 예정' ? ' · ' + statusLabel(it.sub.status) : ''}` })),
      el('span', { class: 'badge', text: it.daysLeft === 0 ? t('dDay') : `D-${it.daysLeft}` }));
    li.style.animationDelay = `${i * 60}ms`;
    ol.append(li);
  });
  $('icsBtn').disabled = !items.length;
}

function renderSavings() {
  const s = savingsIfCancelled(subs), box = $('savings');
  box.replaceChildren();
  if (!s.count) {
    box.append(el('p', { class: 'empty', text: t('savingsEmpty') }));
    return;
  }
  box.append(
    el('div', {},
      el('div', { text: t('savingsLead', { n: s.count }) }),
      el('div', {}, el('strong', { text: t('savingsMonthly', { amt: won(s.monthly) }) }))),
    el('div', {}, el('div', { text: t('savingsYearLabel') }), el('strong', { text: won(s.yearly) })));
}

function renderSim() {
  for (const id of [...simOff]) if (!subs.some(s => s.id === id)) simOff.delete(id);
  const list = $('simList');
  list.replaceChildren();
  $('simReset').disabled = !simOff.size;
  if (!subs.length) list.append(el('li', { class: 'empty', text: t('simEmpty') }));
  for (const s of sortSubscriptions(subs, 'monthly')) {
    const cb = el('input', { type: 'checkbox', value: s.id });
    cb.checked = simOff.has(s.id);
    cb.addEventListener('change', () => {
      if (cb.checked) simOff.add(s.id); else simOff.delete(s.id);
      $('simReset').disabled = !simOff.size;
      renderSimResult();
    });
    list.append(el('li', {}, el('label', { class: 'check' }, cb, el('span', { text: t('simItem', { name: s.name, amt: won(monthlyCost(s)) }) }))));
  }
  renderSimResult();
}

function renderSimResult() {
  const box = $('simResult');
  if (!simOff.size) {
    box.replaceChildren(el('p', { class: 'hint', text: t('simPick') }));
    return;
  }
  const s = savingsFor(subs, simOff);
  const left = Math.max(0, monthlyTotal() - s.monthly);
  box.replaceChildren(
    el('div', {}, el('strong', { class: 'hi', text: t('simResultSave', { n: s.count, amt: won(s.monthly) }) })),
    el('div', {}, el('span', { text: t('simYear', { amt: won(s.yearly) }) })),
    el('div', {}, el('span', { text: t('simLeft', { amt: won(left) }) })));
}

function renderDuplicates() {
  const box = $('dupWarn'), groups = findDuplicateGroups(subs);
  box.replaceChildren();
  box.hidden = !groups.length;
  if (!groups.length) return;
  box.append(
    el('strong', { text: t('dupTitle') }),
    document.createTextNode(t('dupDetail', { list: groups.map(g => t('dupEach', { name: g.name, n: g.ids.length })).join(', ') })));
}

function historyEl(history) {
  const ol = el('ol', { class: 'hist-list' });
  for (const h of [...history].reverse()) ol.append(el('li', { text: t('histLine', { date: fmtDate(h.date), from: showPrice(h.from), to: showPrice(h.to) }) }));
  return el('details', { class: 'hist' }, el('summary', { text: t('histSummary', { n: history.length }) }), ol);
}

function emptyState() {
  const art = svgEl('svg', { viewBox: '0 0 160 120', class: 'empty-art', 'aria-hidden': 'true', focusable: 'false' });
  art.append(
    svgEl('circle', { cx: 122, cy: 26, r: 12, class: 'art-soft' }),
    svgEl('circle', { cx: 30, cy: 96, r: 7, class: 'art-soft' }),
    svgEl('rect', { x: 46, y: 18, width: 68, height: 86, rx: 6, class: 'art-paper' }),
    svgEl('rect', { x: 60, y: 34, width: 40, height: 7, rx: 3.5, class: 'art-line' }),
    svgEl('rect', { x: 60, y: 50, width: 28, height: 6, rx: 3, class: 'art-line soft' }),
    svgEl('rect', { x: 60, y: 64, width: 34, height: 6, rx: 3, class: 'art-line soft' }),
    svgEl('circle', { cx: 100, cy: 90, r: 14, class: 'art-accent' }),
    svgEl('path', { d: 'M93 90 l5 5 l9 -10', class: 'art-check' }));
  return el('li', { class: 'empty-state' },
    art,
    el('h3', { text: t('emptyTitle') }),
    el('p', { class: 'hint', text: t('emptyHint') }),
    el('div', { class: 'empty-actions' },
      el('button', { class: 'btn primary small', type: 'button', text: t('addBtn'), onclick: () => openForm() }),
      el('button', { class: 'btn ghost small', type: 'button', text: t('heroDemo'), onclick: demoData })));
}

function itemEl(s, i, isDup) {
  const cancelling = s.status === '해지 예정';
  const li = el('li', { class: 'item' + (cancelling ? ' cancelling' : '') });
  li.style.setProperty('--cc', CAT_COLOR[s.category]);
  li.style.animationDelay = `${Math.min(i, 10) * 40}ms`;
  const tags = [];
  if (s.demo) tags.push(el('span', { class: 'tag demo', text: t('demoTag') }));
  if (cancelling) tags.push(el('span', { class: 'tag cancel', text: statusLabel(s.status) }));
  if (isDup) tags.push(el('span', { class: 'tag dup', text: t('dupTag') }));
  const trial = trialStatus(s, todayStr());
  if (trial && trial.state !== 'later') {
    const label = trial.state === 'ended' ? t('trialEnded') : trial.state === 'today' ? t('trialTodayTag') : t('trialDaysTag', { n: trial.daysLeft });
    tags.push(el('span', { class: 'tag ' + (trial.state === 'ended' ? 'over' : 'warn'), text: label }));
  }
  const history = s.history || [];
  const shared = s.sharers > 1;
  li.append(
    el('div', { class: 'top' },
      el('div', { class: 'title' },
        el('h3', { text: s.name }),
        el('div', { class: 'sub', text: t('itemSub', { cat: catLabel(s.category), cycle: cycleLabel(s.cycle), date: fmtDate(s.nextDate) }) }),
        shared ? el('div', { class: 'sub share', text: t('shareLine', { amt: won(myMonthlyCost(s)), n: s.sharers }) }) : null),
      el('div', { class: 'price' },
        document.createTextNode(displayPrice(s.amount, s.currency)),
        el('div', { class: 'sub', text: t('monthlyLine', { amt: won(monthlyCost(s)) }) }))),
    el('div', { class: 'tags' }, ...tags),
    s.notes ? el('p', { class: 'note', text: s.notes }) : null,
    ...(history.length ? [historyEl(history)] : []),
    el('div', { class: 'acts' },
      el('button', { class: 'btn ghost small', type: 'button', 'data-act': 'cancel', 'data-id': s.id, 'aria-pressed': String(cancelling), text: cancelling ? t('btnResume') : t('btnCancel'), onclick: () => toggleCancel(s.id) }),
      el('button', { class: 'btn ghost small', type: 'button', text: t('editBtn'), 'aria-label': t('ariaEdit', { name: s.name }), onclick: () => openForm(s.id) }),
      el('button', { class: 'btn danger small', type: 'button', text: t('deleteBtn'), 'aria-label': t('ariaDel', { name: s.name }), onclick: () => askDelete(s) })));
  return li;
}

function renderList() {
  const ul = $('list'); ul.replaceChildren();
  $('demoTag').hidden = !subs.some(s => s.demo);
  $('csvBtn').disabled = !subs.length;
  renderDuplicates();
  if (!subs.length) {
    ul.append(emptyState());
    $('resultInfo').textContent = '';
    return;
  }
  const filters = { query: $('flQuery').value, category: $('flCat').value, status: $('flStatus').value, currency: $('flCur').value };
  const shown = sortSubscriptions(filterSubscriptions(subs, filters), $('flSort').value);
  $('resultInfo').textContent = t('resultInfo', { n: shown.length, total: subs.length });
  if (!shown.length) {
    ul.append(el('li', { class: 'empty', text: t('noFilterMatch') }));
    return;
  }
  const dupKeys = new Set(findDuplicateGroups(subs).map(g => g.key));
  shown.forEach((s, i) => ul.append(itemEl(s, i, dupKeys.has(normalizeName(s.name)))));
}

// ---- comparison of two subscriptions ----
const CMP_UNIT = { won: v => won(v), days: v => t('cmpUnitDays', { n: v }), count: v => t('cmpUnitCount', { n: v }), text: v => String(v) };
function fmtCmp(unit, v) { return v == null ? '-' : CMP_UNIT[unit](v); }
function fmtCmpDiff(unit, d) {
  if (d == null) return '-';
  const sign = d > 0 ? '+' : '';
  if (unit === 'won') return sign + won(d);
  if (unit === 'days') return sign + t('cmpUnitDays', { n: d });
  return sign + t('cmpUnitCount', { n: d });
}
function fillCmpSelect(sel, prevId, index) {
  const list = [...subs].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  sel.replaceChildren(...list.map(s => el('option', { value: s.id, text: s.name })));
  if (list.some(s => s.id === prevId)) sel.value = prevId;
  else if (list[index]) sel.value = list[index].id;
}
function renderCompare() {
  const a = $('cmpA'), b = $('cmpB'), out = $('cmpOut');
  const prevA = a.value, prevB = b.value;
  fillCmpSelect(a, prevA, 0);
  fillCmpSelect(b, prevB, 1);
  a.disabled = b.disabled = subs.length < 2;
  if (subs.length < 2) { out.replaceChildren(el('p', { class: 'hint', text: t('cmpNeed') })); return; }
  const c = compareSubscriptions(subs.find(s => s.id === a.value), subs.find(s => s.id === b.value), todayStr());
  if (!c) { out.replaceChildren(el('p', { class: 'hint', text: t('cmpDiffNeed') })); return; }
  const rows = c.rows.map(r => el('tr', {},
    el('th', { scope: 'row', text: r.label }),
    el('td', { class: 'num', text: r.unit === 'text' ? String(r.left ?? '-') : fmtCmp(r.unit, r.left) }),
    el('td', { class: 'num', text: r.unit === 'text' ? String(r.right ?? '-') : fmtCmp(r.unit, r.right) }),
    el('td', { class: 'num diff', text: r.diff == null ? '-' : fmtCmpDiff(r.unit, r.diff) })));
  out.replaceChildren(el('div', { class: 'cmp-wrap', role: 'region', tabindex: '0', 'aria-label': t('cmpRegion') },
    el('table', { class: 'cmp' },
      el('caption', { class: 'sr-only', text: t('cmpCaption', { a: c.left.name, b: c.right.name }) }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: t('cmpMetric') }),
        el('th', { scope: 'col', text: t('cmpColA', { name: c.left.name }) }),
        el('th', { scope: 'col', text: t('cmpColB', { name: c.right.name }) }),
        el('th', { scope: 'col', text: t('cmpColDiff') }))),
      el('tbody', {}, ...rows))));
}
$('cmpA').addEventListener('change', renderCompare);
$('cmpB').addEventListener('change', renderCompare);

// ---- printable report ----
function printReport() {
  const r = buildSpendReport(subs, todayStr(), budget, 30);
  $('printArea').replaceChildren(
    el('h1', { text: r.title }),
    el('p', { text: t('printBase', { d: fmtDate(r.date) }) }),
    el('dl', { class: 'print-stats' }, ...r.stats.map(x => el('div', {}, el('dt', { text: x.label }), el('dd', { text: x.value })))),
    r.categories.length ? el('table', { class: 'print-table' },
      el('thead', {}, el('tr', {}, el('th', { text: t('colCategory') }), el('th', { class: 'num', text: t('colMonthly') }), el('th', { class: 'num', text: t('colShare') }))),
      el('tbody', {}, ...r.categories.map(c => el('tr', {}, el('td', { text: c.category }), el('td', { class: 'num', text: c.monthly }), el('td', { class: 'num', text: c.share }))))) : null,
    el('h2', { text: t('upcomingHead') }),
    r.upcoming.length ? el('table', { class: 'print-table' },
      el('thead', {}, el('tr', {}, el('th', { text: t('colService') }), el('th', { text: t('colDate') }), el('th', { class: 'num', text: t('colLeft') }), el('th', { class: 'num', text: t('colAmount') }))),
      el('tbody', {}, ...r.upcoming.map(u => el('tr', {}, el('td', { text: u.name }), el('td', { text: fmtDate(u.date) }), el('td', { class: 'num', text: u.daysLeft }), el('td', { class: 'num', text: u.amount }))))) : el('p', { text: t('printNoUpcoming', { days: 30 }) }),
    el('p', { class: 'print-note', text: r.note }));
  window.print();
}
$('printBtn').addEventListener('click', printReport);

function render() {
  advanceAll();
  renderBar();
  renderStats();
  renderDonut();
  renderTrials();
  renderDigest();
  renderTrend();
  renderBudget();
  renderForecast();
  renderCalendar();
  renderTimeline();
  renderSavings();
  renderSim();
  renderCompare();
  renderList();
}

// ---- AI renewal briefing (optional, uses the user's own key) ----
// aiState.sig is the facts the AI result was made from. When the subscriptions or the date change, the AI result is dropped.
let aiState = { sig: '', result: null, note: '' };
let aiBusy = false;
const readAiKey = () => { try { return (localStorage.getItem(AI_KEY_STORAGE) || '').trim(); } catch { return ''; } };
const writeAiKey = v => { try { localStorage.setItem(AI_KEY_STORAGE, v); return true; } catch { return false; } };
const removeAiKey = () => { try { localStorage.removeItem(AI_KEY_STORAGE); return true; } catch { return false; } };

function digestBlock(title, list, empty, key) {
  const wrap = el('div', { class: 'digest-block' }, el('h3', { class: 'digest-h', text: title }));
  if (!list.length) { wrap.append(el('p', { class: 'hint', text: empty })); return wrap; }
  const ul = el('ul', { class: 'digest-list' });
  for (const x of list) ul.append(el('li', {}, el('strong', { text: x.name }), el('span', { text: ' ' + x[key] })));
  wrap.append(ul);
  return wrap;
}
// Everything is written with textContent, so model output is never parsed as HTML.
function paintDigest(result, source, note) {
  const out = $('digestOut');
  out.replaceChildren();
  const mode = $('aiMode');
  mode.textContent = source === 'ai' ? t('digestAi') : t('digestLocal');
  mode.className = source === 'ai' ? 'tag ok' : 'tag est';
  if (note) out.append(el('p', { class: 'notice', role: 'note', text: note }));
  out.append(el('p', { class: 'digest-sum', text: result.summary }));
  out.append(digestBlock(t('digestRenewals'), result.renewals, t('digestNoRenew', { days: 30 }), 'note'));
  out.append(digestBlock(t('digestFlags'), result.flags, t('digestNoFlags'), 'reason'));
  out.append(el('p', { class: 'hint', text: source === 'ai' ? t('digestAiNote') : t('digestLocalNote') }));
}
function renderDigest() {
  const facts = digestFacts(subs, todayStr());
  const fresh = aiState.sig === JSON.stringify(facts);
  if (fresh && aiState.result) paintDigest(aiState.result, 'ai', '');
  else paintDigest(localDigest(facts), 'local', fresh ? aiState.note : '');
}
async function runDigest() {
  if (aiBusy) return;
  const facts = digestFacts(subs, todayStr());
  const sig = JSON.stringify(facts);
  const key = readAiKey();
  if (!key) {
    aiState = { sig, result: null, note: t('digestNoKey') };
    renderDigest();
    return;
  }
  aiBusy = true;
  $('aiRunBtn').disabled = true;
  $('digestOut').replaceChildren(el('p', { class: 'hint', text: t('digestBusy') }));
  let result = null;
  let failNote = '';
  try {
    const { system, user } = buildDigestPrompt(facts, getLang());
    const req = buildAnthropicRequest({ apiKey: key, system, user });
    const res = await fetch(req.url, req.init);
    if (!res.ok) {
      failNote = aiErrorMessage(res.status);
    } else {
      const body = await res.json();
      const usable = body.stop_reason !== 'max_tokens' && body.stop_reason !== 'refusal';
      result = usable ? parseDigestResponse(extractText(body)) : null;
      if (!result) failNote = t('aiParseFail');
    }
  } catch (err) {
    failNote = err instanceof TypeError ? t('digestNetFail') : t('aiReadFail');
  } finally {
    aiBusy = false;
    $('aiRunBtn').disabled = false;
  }
  aiState = { sig, result, note: result ? '' : t('digestFallback', { note: failNote }) };
  renderDigest();
}
function syncAiKeyUi() {
  $('aiKeyToggle').textContent = readAiKey() ? t('aiKeyManage') : t('aiKeySet');
}
$('aiRunBtn').addEventListener('click', runDigest);
$('aiKeyToggle').addEventListener('click', () => {
  const box = $('aiKeyBox');
  const open = box.hidden;
  box.hidden = !open;
  $('aiKeyToggle').setAttribute('aria-expanded', String(open));
  if (open) $('aiKeyInput').focus();
});
$('aiKeySave').addEventListener('click', () => {
  const v = $('aiKeyInput').value.trim();
  if (!isPlausibleKey(v)) { toast(t('keyBad')); return; }
  if (!writeAiKey(v)) { toast(t('keyCantSave')); return; }
  $('aiKeyInput').value = '';
  syncAiKeyUi();
  toast(t('keySaved'));
});
$('aiKeyClear').addEventListener('click', () => {
  removeAiKey();
  $('aiKeyInput').value = '';
  syncAiKeyUi();
  toast(t('keyDeleted'));
});

// ---- actions ----
function toggleCancel(id) {
  const s = subs.find(x => x.id === id); if (!s) return;
  s.status = s.status === '해지 예정' ? '사용 중' : '해지 예정';
  save(); render();
  // Imported ids are arbitrary strings, so escape them before building the selector.
  $('list').querySelector(`[data-act="cancel"][data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  toast(s.status === '해지 예정' ? t('toastCancelOn', { name: s.name }) : t('toastCancelOff', { name: s.name }));
}
function confirmDialog(title, msg, okText) {
  return new Promise(res => {
    const d = $('confirmDlg');
    $('confirmTitle').textContent = title; $('confirmMsg').textContent = msg; $('confirmOk').textContent = okText;
    d.returnValue = 'cancel';
    d.addEventListener('close', () => res(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}
async function askDelete(s) {
  if (await confirmDialog(t('askDelTitle'), t('askDelMsg', { name: s.name }), t('deleteBtn'))) {
    subs = subs.filter(x => x.id !== s.id); save(); render(); focusHeading('listH'); toast(t('toastDeleted'));
  }
}

// form
function fillSelect(sel, opts) { for (const [v, label] of opts) sel.append(el('option', { value: v, text: label })); }
function fillFormOptions() {
  const fc = $('fCat'), fcy = $('fCycle'), fs = $('fStatus');
  const keepFc = fc.value, keepCy = fcy.value, keepFs = fs.value;
  fc.replaceChildren(); fcy.replaceChildren(); fs.replaceChildren();
  fillSelect(fc, CATEGORIES.map(c => [c, catLabel(c)]));
  fillSelect(fcy, CYCLES.map(c => [c, cycleLabel(c)]));
  fillSelect(fs, STATUSES.map(c => [c, statusLabel(c)]));
  fc.value = keepFc || CATEGORIES[0]; fcy.value = keepCy || '매월'; fs.value = keepFs || '사용 중';
  const flc = $('flCat'), fls = $('flStatus'), flcur = $('flCur'), flsort = $('flSort');
  const keep = [flc.value, fls.value, flcur.value, flsort.value];
  flc.replaceChildren(el('option', { value: '', text: t('allOption') }));
  fls.replaceChildren(el('option', { value: '', text: t('allOption') }));
  flcur.replaceChildren(el('option', { value: '', text: t('allOption') }));
  fillSelect(flc, CATEGORIES.map(c => [c, catLabel(c)]));
  fillSelect(fls, STATUSES.map(c => [c, statusLabel(c)]));
  fillSelect(flcur, CURRENCIES.map(c => [c, c]));
  flsort.replaceChildren();
  fillSelect(flsort, SORT_KEYS_ORDER.map(k => [k, t(SORT_LABEL_KEYS[k])]));
  flc.value = keep[0]; fls.value = keep[1]; flcur.value = keep[2]; flsort.value = keep[3] || 'next';
}
const SORT_KEYS_ORDER = ['next', 'monthly', 'name'];
function updateCurrencyUi() {
  const usd = $('fCur').value === 'USD';
  $('rateField').hidden = !usd;
  $('fAmt').step = usd ? '0.01' : '1';
  const a = Number($('fAmt').value), r = Number($('fRate').value);
  $('krwPreview').textContent = usd && a > 0 && r > 0 ? t('krwPreview', { amt: won(a * r) }) : '';
  updateSplitUi();
}
function updateSplitUi() {
  const amount = Number($('fAmt').value), rate = Number($('fRate').value);
  const people = Math.floor(Number($('fPeople').value)) || 1;
  const cost = amount > 0 ? monthlyCost({ amount, currency: $('fCur').value, rate, cycle: $('fCycle').value }) : 0;
  $('splitPreview').textContent = cost > 0 && people > 1 ? t('splitPreview', { amt: won(cost / people), n: people }) : '';
}
function updateNotesCount() {
  $('notesCount').textContent = `${$('fNotes').value.length}/${NOTE_MAX}`;
}
function clearErrors() {
  document.querySelectorAll('#subForm .err').forEach(p => { p.textContent = ''; });
  document.querySelectorAll('#subForm [aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'));
}
function openForm(id = null) {
  clearErrors();
  const s = subs.find(x => x.id === id);
  // Only keep an edit target that still exists; otherwise saving would silently do nothing.
  editingId = s ? id : null;
  $('formTitle').textContent = s ? t('formEdit') : t('formAdd');
  $('fName').value = s ? s.name : '';
  $('fCat').value = s ? s.category : CATEGORIES[0];
  $('fCycle').value = s ? s.cycle : '매월';
  $('fCur').value = s ? s.currency : 'KRW';
  $('fAmt').value = s ? s.amount : '';
  $('fRate').value = s ? s.rate : DEFAULT_RATE;
  $('fDate').value = s ? s.nextDate : addMonths(todayStr(), 1);
  $('fStatus').value = s ? s.status : '사용 중';
  $('fTrial').value = s ? (s.trialEnds || '') : '';
  $('fPeople').value = s ? String(s.sharers || 1) : '1';
  $('fNotes').value = s ? (s.notes || '') : '';
  updateNotesCount();
  updateCurrencyUi();
  $('formDlg').showModal();
  $('fName').focus();
}
function submitForm(e) {
  e.preventDefault(); clearErrors();
  const f = $('subForm');
  const input = Object.fromEntries(new FormData(f).entries());
  const r = validateSubscription(input);
  if (!r.valid) {
    for (const [k, msg] of Object.entries(r.errors)) {
      const p = f.querySelector(`.err[data-for="${k}"]`); if (p) p.textContent = msg;
      const inp = f.elements[k]; if (inp) inp.setAttribute('aria-invalid', 'true');
    }
    const first = f.querySelector('[aria-invalid="true"]'); if (first) first.focus();
    return;
  }
  const today = todayStr();
  let msg;
  if (editingId) {
    const i = subs.findIndex(x => x.id === editingId);
    if (i < 0) return;
    const prev = subs[i];
    const entry = priceChangeEntry(prev, r.value, today);
    const history = prev.history || [];
    subs[i] = { ...prev, ...r.value, history: entry ? [...history, entry] : history };
    msg = entry ? t('toastEditedPrice') : t('toastEdited');
  } else {
    const sameName = subs.some(x => normalizeName(x.name) === normalizeName(r.value.name));
    subs.push({ id: uid(), demo: false, history: [], ...r.value });
    msg = sameName ? t('toastAddedDup') : t('toastAdded');
  }
  save(); $('formDlg').close(); render(); toast(msg);
}

function demoData() {
  const off = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const base = { demo: true, rate: DEFAULT_RATE, currency: 'KRW', status: '사용 중', cycle: '매월', history: [], trialEnds: '', sharers: 1, notes: '' };
  const items = [
    { name: t('demoSvc1'), category: '스트리밍', amount: 17000, nextDate: off(2), sharers: 4, notes: t('demoNote1') },
    { name: t('demoSvc2'), category: '음악', amount: 10900, nextDate: off(5) },
    { name: t('demoSvc3'), category: '클라우드', amount: 11900, nextDate: off(12), status: '해지 예정' },
    { name: 'GitHub Copilot', category: '개발도구', amount: 10, currency: 'USD', rate: 1350, nextDate: off(21) },
    { name: 'ChatGPT Plus', category: 'AI', amount: 20, currency: 'USD', rate: 1350, nextDate: off(-9) /* past: auto-advances */, history: [{ date: off(-40), from: '$18', to: '$20' }] },
    { name: t('demoSvc4'), category: '생활', amount: 59000, cycle: '매년', nextDate: off(40) },
    { name: 'Notion', category: '개발도구', amount: 10, currency: 'USD', rate: 1350, nextDate: off(30), trialEnds: off(4), notes: t('demoNote2') },
  ];
  const kept = subs.filter(s => !s.demo);
  subs = [...kept, ...items.map(i => ({ id: uid(), ...base, ...i }))];
  save(); render(); toast(t('toastDemo', { n: items.length }));
}

// ---- export ----
function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportIcs() {
  const items = upcomingWithin(subs, todayStr(), range);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  download(`renewals-${todayStr()}.ics`, new Blob([toIcs(items, stamp)], { type: 'text/calendar;charset=utf-8' }));
  toast(t('toastIcs', { n: items.length }));
}
function exportCsv() {
  if (!subs.length) return toast(t('toastCsvNone'));
  // BOM so spreadsheet apps read the header text correctly.
  download(`subscriptions-${todayStr()}.csv`, new Blob(['﻿' + toCsv(subs)], { type: 'text/csv;charset=utf-8' }));
  toast(t('toastCsv', { n: subs.length }));
}
function exportJson() {
  download(`renewal-ledger-backup-${todayStr()}.json`,
    new Blob([toBackup(subs, budget, new Date().toISOString())], { type: 'application/json;charset=utf-8' }));
  toast(t('toastBackup', { n: subs.length }));
}
async function importJson(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > MAX_IMPORT_BYTES) return toast(t('toastFileBig'));
  let parsed;
  try { parsed = parseBackup(await file.text()); }
  catch { parsed = { valid: false, error: t('toastFileRead') }; }
  if (!parsed.valid) return toast(parsed.error);
  const n = parsed.subscriptions.length;
  if (!n) return toast(t('toastNothingImport'));
  const skipNote = parsed.skipped ? t('importSkip', { n: parsed.skipped }) : '';
  const budgetNote = parsed.budget > 0 ? t('importBudget') : '';
  const ok = await confirmDialog(t('importTitle'), t('importMsg', { n, skip: skipNote, budget: budgetNote }), t('importBtn'));
  if (!ok) return;
  subs = mergeSubscriptions(subs, parsed.subscriptions);
  if (parsed.budget > 0) {
    budget = parsed.budget;
    saveBudget();
    $('budgetInput').value = String(budget);
  }
  save(); render(); toast(t('toastImported', { n }));
}

// ---- budget ----
function submitBudget(e) {
  e.preventDefault();
  const input = $('budgetInput'), err = $('budgetErr');
  const r = validateBudget(input.value);
  if (!r.valid) {
    err.textContent = r.error;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return;
  }
  err.textContent = '';
  input.removeAttribute('aria-invalid');
  budget = r.value;
  saveBudget();
  renderBudget(); renderTrend();
  toast(budget ? t('toastBudgetSaved') : t('toastBudgetCleared'));
}
function clearBudget() {
  budget = 0;
  $('budgetInput').value = '';
  $('budgetErr').textContent = '';
  $('budgetInput').removeAttribute('aria-invalid');
  saveBudget();
  renderBudget(); renderTrend();
  toast(t('toastBudgetCleared'));
}

// ---- theme ----
function applyTheme(th) {
  if (th) document.documentElement.setAttribute('data-theme', th); else document.documentElement.removeAttribute('data-theme');
}
function initTheme() {
  try { const th = localStorage.getItem(THEME_KEY); if (th === 'light' || th === 'dark') applyTheme(th); } catch { /* ignore */ }
  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  });
}
function initAppbar() {
  const bar = $('appbar');
  const onScroll = () => bar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// ---- language ----
function applyLanguage(code) {
  setLang(code);
  saveLang(code);
  applyI18n();
  document.title = t('docTitle');
  document.querySelector('meta[name="description"]').setAttribute('content', t('metaDesc'));
  $('langSelect').value = getLang();
  fillFormOptions();
  syncAiKeyUi();
  $('themeBtn').textContent = t('themeToggle');
  $('stats').replaceChildren(); // rebuild the stat labels in the new language
  render();
  paintDigest(aiState.result || localDigest(digestFacts(subs, todayStr())), aiState.result ? 'ai' : 'local', aiState.result ? '' : aiState.note);
}
{
  const sel = $('langSelect');
  sel.replaceChildren(...Object.entries(LANGS).map(([k, v]) => el('option', { value: k, text: v.name })));
  sel.addEventListener('change', (e) => applyLanguage(e.target.value));
}

// ---- init ----
setLang(detectLang(readSavedLang()));
$('langSelect').value = getLang();
applyI18n();
document.title = t('docTitle');
document.querySelector('meta[name="description"]').setAttribute('content', t('metaDesc'));
fillFormOptions();
initTheme();
initAppbar();
subs = load();
budget = loadBudget();
dismissed = loadDismissed();
$('budgetInput').value = budget > 0 ? String(budget) : '';
$('addBtn').addEventListener('click', () => openForm());
$('demoBtn').addEventListener('click', demoData);
$('icsBtn').addEventListener('click', exportIcs);
$('csvBtn').addEventListener('click', exportCsv);
$('jsonExportBtn').addEventListener('click', exportJson);
$('jsonImportBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', importJson);
$('clearBtn').addEventListener('click', async () => {
  if (!subs.length) return toast(t('toastClearNone'));
  if (await confirmDialog(t('clearTitle'), t('clearMsg', { n: subs.length }), t('clearBtn'))) { subs = []; save(); render(); focusHeading('listH'); toast(t('toastClearDone')); }
});
// "/" moves focus to the search box unless the user is already typing or a dialog is open.
document.addEventListener('keydown', e => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const tg = e.target;
  if (tg instanceof HTMLElement && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
  if ($('formDlg').open || $('confirmDlg').open) return;
  e.preventDefault();
  $('flQuery').focus();
});
$('cancelBtn').addEventListener('click', () => $('formDlg').close());
$('subForm').addEventListener('submit', submitForm);
for (const id of ['fCur', 'fAmt', 'fRate', 'fPeople']) $(id).addEventListener('input', updateCurrencyUi);
$('fCycle').addEventListener('change', updateCurrencyUi);
$('fNotes').addEventListener('input', updateNotesCount);
document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
  range = Number(b.dataset.range);
  document.querySelectorAll('.seg-btn').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderTimeline();
}));
$('budgetForm').addEventListener('submit', submitBudget);
$('budgetClear').addEventListener('click', clearBudget);
$('flQuery').addEventListener('input', renderList);
for (const id of ['flCat', 'flStatus', 'flCur', 'flSort']) $(id).addEventListener('change', renderList);
$('flReset').addEventListener('click', () => {
  $('flQuery').value = ''; $('flCat').value = ''; $('flStatus').value = ''; $('flCur').value = ''; $('flSort').value = 'next';
  renderList();
});
$('simReset').addEventListener('click', () => { simOff.clear(); renderSim(); });
$('themeBtn').textContent = t('themeToggle');
syncAiKeyUi();
render();
if (!storageOk) toast(t('toastStorageOff'));
