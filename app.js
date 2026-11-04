import {
  CATEGORIES, CYCLES, STATUSES, DEFAULT_RATE, monthlyCost, yearlyCost, advanceRenewal, upcomingWithin,
  categoryTotals, savingsIfCancelled, toIcs, validateSubscription, addMonths,
} from './logic.js';

const KEY = 'renewal-ledger:v1', THEME_KEY = 'renewal-ledger:theme';
const $ = id => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const CAT_COLOR = Object.fromEntries(CATEGORIES.map((c, i) => [c, `var(--c${i})`]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let subs = [];
let range = 7;
let editingId = null;
let storageOk = true;

const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const won = n => Math.round(n).toLocaleString('ko-KR') + '원';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id' + Date.now() + Math.random().toString(16).slice(2));

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

// ---- storage ----
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(s => s && typeof s.id === 'string' && validateSubscription(s).valid)
      .map(s => ({ ...validateSubscription(s).value, id: s.id, demo: !!s.demo }));
  } catch { storageOk = false; return []; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(subs)); }
  catch { if (storageOk) { storageOk = false; toast('저장소를 사용할 수 없어 새로고침하면 데이터가 사라집니다.'); } }
}

// ---- toast ----
function toast(msg) {
  const t = el('div', { class: 'toast', text: msg });
  $('toasts').append(t);
  setTimeout(() => t.remove(), 3200);
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
  const start = performance.now(), dur = 800;
  const tick = now => {
    const p = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - p, 3);
    node.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---- render ----
function renderStats() {
  const box = $('stats');
  if (!box.children.length) {
    for (const [id, k] of [['sMonth', '월 지출 합계'], ['sYear', '연 지출 합계'], ['sActive', '사용 중']]) {
      box.append(el('div', { class: 'stat' }, el('div', { class: 'k', text: k }), el('div', { class: 'v', id, text: '0' })));
    }
  }
  const monthly = subs.reduce((t, s) => t + monthlyCost(s), 0);
  const yearly = subs.reduce((t, s) => t + yearlyCost(s), 0);
  countUp($('sMonth'), monthly);
  countUp($('sYear'), yearly);
  countUp($('sActive'), subs.filter(s => s.status === '사용 중').length, n => `${Math.round(n)}개`);
}

function renderDonut() {
  const totals = categoryTotals(subs), sum = totals.reduce((t, x) => t + x.monthly, 0);
  const donut = $('donut'), legend = $('legend');
  donut.replaceChildren(); legend.replaceChildren();
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 42 42'); svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(SVGNS, 'circle');
  for (const [k, v] of Object.entries({ cx: 21, cy: 21, r: 15.9155, fill: 'none', 'stroke-width': 6, stroke: 'currentColor', opacity: .08 })) track.setAttribute(k, v);
  svg.append(track);
  const segs = [];
  let cum = 0;
  totals.forEach(t => {
    const pct = sum ? (t.monthly / sum) * 100 : 0;
    const c = document.createElementNS(SVGNS, 'circle');
    for (const [k, v] of Object.entries({ cx: 21, cy: 21, r: 15.9155, fill: 'none', 'stroke-width': 6, stroke: CAT_COLOR[t.category], 'stroke-dashoffset': -cum, 'stroke-dasharray': '0 100' })) c.setAttribute(k, v);
    c.classList.add('seg');
    svg.append(c);
    segs.push([c, Math.max(pct - (totals.length > 1 ? 0.8 : 0), 0.01)]);
    cum += pct;
  });
  donut.append(svg, el('div', { class: 'center' }, el('span', { text: sum ? won(sum) : '데이터 없음' }), el('small', { text: '월 합계' })));
  donut.setAttribute('aria-label', totals.length ? '카테고리별 월 지출: ' + totals.map(t => `${t.category} ${won(t.monthly)}`).join(', ') : '데이터 없음');
  const bars = [];
  totals.forEach(t => {
    const pct = sum ? (t.monthly / sum) * 100 : 0;
    const bar = el('i'); bar.style.background = CAT_COLOR[t.category];
    bars.push([bar, pct]);
    const dot = el('span', { class: 'dot' }); dot.style.background = CAT_COLOR[t.category];
    legend.append(el('li', {}, dot, el('span', { text: `${t.category} · ${pct.toFixed(0)}%` }), el('span', { class: 'amt', text: won(t.monthly) }), el('span', { class: 'bar' }, bar)));
  });
  if (!totals.length) legend.append(el('li', { class: 'empty', text: '구독을 추가하면 차트가 나타납니다.' }));
  const go = () => { segs.forEach(([c, p]) => c.setAttribute('stroke-dasharray', `${p} ${100 - p}`)); bars.forEach(([b, p]) => { b.style.width = p + '%'; }); };
  if (reduceMotion) go(); else requestAnimationFrame(() => requestAnimationFrame(go));
}

function renderTimeline() {
  const ol = $('timeline'); ol.replaceChildren();
  const items = upcomingWithin(subs, todayStr(), range);
  if (!items.length) ol.append(el('li', { class: 'empty', text: `${range}일 안에 갱신되는 구독이 없어요.` }));
  items.forEach((it, i) => {
    const urg = it.daysLeft <= 3 ? 'u-high' : it.daysLeft <= 7 ? 'u-mid' : 'u-low';
    const li = el('li', { class: `tl ${urg}` },
      el('div', {},
        el('div', { class: 'n', text: it.sub.name }),
        el('div', { class: 'm', text: `${it.date} · ${it.sub.currency === 'USD' ? '$' + it.sub.amount : won(it.sub.amount)} · ${it.sub.cycle}${it.sub.status === '해지 예정' ? ' · 해지 예정' : ''}` })),
      el('span', { class: 'badge', text: it.daysLeft === 0 ? 'D-DAY' : `D-${it.daysLeft}` }));
    li.style.animationDelay = `${i * 60}ms`;
    ol.append(li);
  });
  $('icsBtn').disabled = !items.length;
}

function renderSavings() {
  const s = savingsIfCancelled(subs), box = $('savings');
  box.replaceChildren();
  if (!s.count) { box.append(el('p', { class: 'empty', text: '해지 예정으로 표시한 구독이 없어요. 구독 카드의 “해지 예정” 버튼으로 절약액을 확인해 보세요.' })); return; }
  box.append(el('div', {}, el('div', { text: `해지 예정 ${s.count}건을 모두 해지하면` }), el('div', {}, el('strong', { text: `월 ${won(s.monthly)}` }), document.createTextNode(' 절약')),),
    el('div', {}, el('div', { text: '연간 절약액' }), el('strong', { text: won(s.yearly) })));
}

function renderList() {
  const ul = $('list'); ul.replaceChildren();
  $('demoTag').hidden = !subs.some(s => s.demo);
  if (!subs.length) { ul.append(el('li', { class: 'empty', text: '등록된 구독이 없어요. “구독 추가” 또는 예시 데이터를 사용해 보세요.' })); }
  const sorted = [...subs].sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  sorted.forEach((s, i) => {
    const cancelling = s.status === '해지 예정';
    const li = el('li', { class: 'item' + (cancelling ? ' cancelling' : '') });
    li.style.setProperty('--cc', CAT_COLOR[s.category]);
    li.style.animationDelay = `${Math.min(i, 10) * 40}ms`;
    const price = s.currency === 'USD' ? `$${s.amount}` : won(s.amount);
    li.append(
      el('div', { class: 'top' },
        el('div', {}, el('h3', { text: s.name }), el('div', { class: 'sub', text: `${s.category} · ${s.cycle} · 다음 ${s.nextDate}` })),
        el('div', { class: 'price' }, document.createTextNode(price), el('div', { class: 'sub', text: `월 ${won(monthlyCost(s))}` }))),
      el('div', {}, ...(s.demo ? [el('span', { class: 'tag demo', text: '예시 데이터' }), document.createTextNode(' ')] : []),
        ...(cancelling ? [el('span', { class: 'tag cancel', text: '해지 예정' })] : [])),
      el('div', { class: 'acts' },
        el('button', { class: 'btn ghost small', type: 'button', 'aria-pressed': String(cancelling), text: cancelling ? '해지 취소' : '해지 예정', onclick: () => toggleCancel(s.id) }),
        el('button', { class: 'btn ghost small', type: 'button', text: '수정', 'aria-label': `${s.name} 수정`, onclick: () => openForm(s.id) }),
        el('button', { class: 'btn danger small', type: 'button', text: '삭제', 'aria-label': `${s.name} 삭제`, onclick: () => askDelete(s) })));
    ul.append(li);
  });
}

function render() { advanceAll(); renderStats(); renderDonut(); renderTimeline(); renderSavings(); renderList(); }

// ---- actions ----
function toggleCancel(id) {
  const s = subs.find(x => x.id === id); if (!s) return;
  s.status = s.status === '해지 예정' ? '사용 중' : '해지 예정';
  save(); render(); toast(s.status === '해지 예정' ? `${s.name}: 해지 예정으로 표시` : `${s.name}: 사용 중으로 복원`);
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
  if (await confirmDialog('구독 삭제', `“${s.name}” 구독을 삭제할까요?`, '삭제')) {
    subs = subs.filter(x => x.id !== s.id); save(); render(); toast('삭제했어요.');
  }
}

// form
function fillSelect(sel, opts) { for (const o of opts) sel.append(el('option', { value: o, text: o })); }
function updateCurrencyUi() {
  const usd = $('fCur').value === 'USD';
  $('rateField').hidden = !usd;
  $('fAmt').step = usd ? '0.01' : '1';
  const a = Number($('fAmt').value), r = Number($('fRate').value);
  $('krwPreview').textContent = usd && a > 0 && r > 0 ? `≈ ${won(a * r)} (결제 1회 기준)` : '';
}
function clearErrors() {
  document.querySelectorAll('#subForm .err').forEach(p => { p.textContent = ''; });
  document.querySelectorAll('#subForm [aria-invalid]').forEach(i => i.removeAttribute('aria-invalid'));
}
function openForm(id = null) {
  editingId = id; clearErrors();
  const s = subs.find(x => x.id === id);
  $('formTitle').textContent = s ? '구독 수정' : '구독 추가';
  $('fName').value = s ? s.name : '';
  $('fCat').value = s ? s.category : CATEGORIES[0];
  $('fCycle').value = s ? s.cycle : '매월';
  $('fCur').value = s ? s.currency : 'KRW';
  $('fAmt').value = s ? s.amount : '';
  $('fRate').value = s ? s.rate : DEFAULT_RATE;
  $('fDate').value = s ? s.nextDate : addMonths(todayStr(), 1);
  $('fStatus').value = s ? s.status : '사용 중';
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
  if (editingId) { const i = subs.findIndex(x => x.id === editingId); subs[i] = { ...subs[i], ...r.value }; }
  else subs.push({ id: uid(), demo: false, ...r.value });
  save(); $('formDlg').close(); render(); toast(editingId ? '수정했어요.' : '추가했어요.');
}

function demoData() {
  const today = todayStr();
  const off = n => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const base = { demo: true, rate: DEFAULT_RATE, currency: 'KRW', status: '사용 중', cycle: '매월' };
  const items = [
    { name: '넷플릭스', category: '스트리밍', amount: 17000, nextDate: off(2) },
    { name: '멜론', category: '음악', amount: 10900, nextDate: off(5) },
    { name: '구글 원 2TB', category: '클라우드', amount: 11900, nextDate: off(12), status: '해지 예정' },
    { name: 'GitHub Copilot', category: '개발도구', amount: 10, currency: 'USD', rate: 1350, nextDate: off(21) },
    { name: 'ChatGPT Plus', category: 'AI', amount: 20, currency: 'USD', rate: 1350, nextDate: off(-9) /* past: auto-advances */ },
    { name: '쿠팡 와우', category: '생활', amount: 59000, cycle: '매년', nextDate: off(40) },
  ];
  const kept = subs.filter(s => !s.demo);
  subs = [...kept, ...items.map(i => ({ id: uid(), ...base, ...i }))];
  save(); render(); toast('예시 데이터 6개를 불러왔어요.');
}

function exportIcs() {
  const items = upcomingWithin(subs, todayStr(), range);
  const d = new Date(), stamp = d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const blob = new Blob([toIcs(items, stamp)], { type: 'text/calendar;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `renewals-${todayStr()}.ics` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${items.length}건을 내보냈어요.`);
}

// ---- theme ----
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
}
function initTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') applyTheme(t); } catch { /* ignore */ }
  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  });
}

// ---- init ----
fillSelect($('fCat'), CATEGORIES); fillSelect($('fCycle'), CYCLES); fillSelect($('fStatus'), STATUSES);
initTheme();
subs = load();
$('addBtn').addEventListener('click', () => openForm());
$('demoBtn').addEventListener('click', demoData);
$('icsBtn').addEventListener('click', exportIcs);
$('clearBtn').addEventListener('click', async () => {
  if (!subs.length) return toast('삭제할 데이터가 없어요.');
  if (await confirmDialog('전체 삭제', `구독 ${subs.length}개를 모두 삭제할까요? 되돌릴 수 없습니다.`, '전체 삭제')) { subs = []; save(); render(); toast('모두 삭제했어요.'); }
});
$('cancelBtn').addEventListener('click', () => $('formDlg').close());
$('subForm').addEventListener('submit', submitForm);
for (const id of ['fCur', 'fAmt', 'fRate']) $(id).addEventListener('input', updateCurrencyUi);
document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => {
  range = Number(b.dataset.range);
  document.querySelectorAll('.seg-btn').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderTimeline();
}));
render();
if (!storageOk) toast('저장소를 사용할 수 없어요. 이 세션에서만 유지됩니다.');
