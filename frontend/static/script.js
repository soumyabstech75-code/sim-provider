/* bstpl sim info - front end. Everything shown comes from MySQL through /api/... (no data is stored in these files). */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)], enc = encodeURIComponent, PAGE = 100, ALL = '__all__';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = n => Number(n || 0).toLocaleString('en-IN', {maximumFractionDigits: 2});
const DEFAULT_PROVIDERS = ['sensorise', 'iotivity', 'vi', 'growspace', 'taisys'];
const S = {
  user: null,
  tables: [],
  cur: '',
  cols: [],
  allColNames: [],
  visibleCols: null,
  lastData: null,
  pageSize: 100,
  dcol: null,
  pcol: '',
  sort: '',
  desc: true,
  off: 0,
  total: 0,
  prov: '',
  cust: '',
  customers: [],
  providers: []
};

const colsKey = () => 'sim-visible-cols:' + (S.cur || '');
function getStoredCols() {
  try { const v = localStorage.getItem(colsKey()); return v ? JSON.parse(v) : null } catch (e) { return null }
}
function saveStoredCols(cols) {
  try { if (cols && cols.length) localStorage.setItem(colsKey(), JSON.stringify(cols)); else localStorage.removeItem(colsKey()) } catch (e) {}
}
const provNames = () => { const n = (S.providers || []).map(p => p.provider); return n.length ? n : DEFAULT_PROVIDERS };
const TYPES = {text: 'Text', longtext: 'Long text', int: 'Whole number', decimal: 'Decimal / amount', date: 'Date'};
const CUST = /customer/i, LIST = /plan|product|profile|requested|raised|provider|status|type/i, NUMCOL = /^(qty|quantity|amount|total|price|cost)$/i;
const rowsUrl = t => t == ALL ? '/api/all' : `/api/tables/${enc(t)}`;

/* ---------- backend URL detection (Netlify + Render support) ---------- */
const RENDER_BACKEND_URL = 'https://sim-provider-1f4c.onrender.com';
// Default to relative '' so Netlify's _redirects proxy handles /api/* without CORS or preflight issues.
// Can be overridden with window.API_BASE = 'https://sim-provider-1f4c.onrender.com' if direct calls are desired.
const API_BASE = window.API_BASE !== undefined ? window.API_BASE : '';
const apiUrl = u => (u.startsWith('http://') || u.startsWith('https://')) ? u : (API_BASE + u);

const getToken = () => { try { return localStorage.getItem('vi-token') || ''; } catch (e) { return ''; } };
const setToken = tok => { try { if (tok) localStorage.setItem('vi-token', tok); else localStorage.removeItem('vi-token'); } catch (e) {} };

/* ---------- talking to the backend ---------- */
async function api(u, o = {}) {
  const headers = {'Content-Type': 'application/json', ...(o.headers || {})};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  if (o.body && typeof o.body != 'string') {
    o = {...o, body: JSON.stringify(o.body)};
  }
  let r, d = {};
  try {
    r = await fetch(apiUrl(u), {credentials: 'include', ...o, headers});
    d = await r.json().catch(() => ({}));
  } catch (err) {
    if (err && err.message && err.message.toLowerCase().includes('fetch')) {
      throw Error('Cannot connect to backend server. If the server is waking up from sleep, please wait 15 seconds and try again.');
    }
    throw err;
  }
  if (r.status == 401 && u != '/api/login') {
    setToken('');
    showLogin('Your session ended. Please sign in again.');
    throw Object.assign(Error('Signed out'), {silent: true});
  }
  if (!r.ok) throw Error(typeof d.detail == 'string' ? d.detail : 'Please check the values you entered');
  return d;
}
const post = (u, body) => api(u, {method: 'POST', body});
const toast = (m, bad) => { const t = $('#toast'); t.textContent = m; t.className = 'show' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', Math.max(3200, m.length * 45)) };
const fail = e => e.silent || toast(e.message, 1);

/* ---------- themes (saved in this browser) ---------- */
const THEMES = [['light', 'Daylight', '#ffffff', '#4f46e5'], ['dark', 'Midnight', '#151b33', '#8b83ff'], ['ocean', 'Ocean', '#e5f3fa', '#0284c7'],
  ['forest', 'Forest', '#0f1f18', '#34d399'], ['sunset', 'Sunset', '#fff0e6', '#ea580c'], ['rose', 'Rose', '#fdeef3', '#e11d48'], ['graphite', 'Graphite', '#1b1d21', '#f5a524']];
function setTheme(t, save) {
  document.documentElement.dataset.theme = t; if (save) try { localStorage.setItem('vi-theme', t) } catch (e) {}
  $('#themeMenu').innerHTML = THEMES.map(([id, name, c1, c2]) => `<button class="sw ${id == t ? 'on' : ''}" data-th="${id}" role="menuitem"><i style="--c1:${c1};--c2:${c2}"></i>${name}${id == t ? '<small>✓</small>' : ''}</button>`).join('');
  bg.color(); bg.redraw();
}
$('#themeBtn').onclick = e => { e.stopPropagation(); $('#themeMenu').classList.toggle('hide') };
$('#themeMenu').onclick = e => { const b = e.target.closest('[data-th]'); if (b) { setTheme(b.dataset.th, true); $('#themeMenu').classList.add('hide') } };
document.addEventListener('click', e => { if (!e.target.closest('.themer')) $('#themeMenu').classList.add('hide') });
document.addEventListener('keydown', e => e.key == 'Escape' && $('#themeMenu').classList.add('hide'));

/* ---------- 3D: node-sphere behind the page + tilt on cards ---------- */
const bg = (() => {
  const cv = $('#bg'), x = cv.getContext('2d'), N = 110, P = [], L = [], still = matchMedia('(prefers-reduced-motion:reduce)').matches;
  let W, H, mx = 0, my = 0, ang = 0, cxr = .27, rgb = '79,70,229';
  const dpr = Math.min(devicePixelRatio || 1, 2);
  for (let i = 0; i < N; i++) { const u = Math.random() * 2 - 1, t = Math.random() * 6.2832, r = Math.sqrt(1 - u * u); P.push([r * Math.cos(t), u, r * Math.sin(t)]) }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]) < .55) L.push([i, j]);
  const size = () => { W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px' };
  const color = () => { rgb = getComputedStyle(document.documentElement).getPropertyValue('--arg').trim() || rgb };
  addEventListener('resize', () => { size(); if (still) draw() });
  addEventListener('pointermove', e => { mx = e.clientX / innerWidth - .5; my = e.clientY / innerHeight - .5 });
  function draw() {
    x.clearRect(0, 0, W, H);
    const target = document.body.classList.contains('authed') ? .86 : innerWidth < 940 ? .5 : .27;
    cxr = still ? target : cxr + (target - cxr) * .04; ang += .003;
    const ay = ang + mx * .6, ax = .35 + my * .4, R = Math.min(W, H) * .4, cx = W * cxr, cy = H * .5,
      cA = Math.cos(ay), sA = Math.sin(ay), cB = Math.cos(ax), sB = Math.sin(ax);
    const Q = P.map(([px, py, pz]) => { const x1 = px * cA + pz * sA, z1 = -px * sA + pz * cA, y2 = py * cB - z1 * sB, z2 = py * sB + z1 * cB, s = 2.4 / (2.4 - z2); return [cx + x1 * R * s, cy + y2 * R * s, z2, s] });
    x.lineWidth = dpr;
    for (const [i, j] of L) { const a = Q[i], b = Q[j], d = ((a[2] + b[2]) / 2 + 1) / 2; x.strokeStyle = `rgba(${rgb},${.05 + d * .32})`; x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke() }
    for (const q of Q) { const d = (q[2] + 1) / 2; x.fillStyle = `rgba(${rgb},${.25 + d * .7})`; x.beginPath(); x.arc(q[0], q[1], (1.2 + d * 2.2) * dpr * q[3], 0, 6.2832); x.fill() }
    if (!still) requestAnimationFrame(draw);
  }
  size(); color(); draw();
  return {color, redraw: () => still && draw()};
})();

setTheme(document.documentElement.dataset.theme || 'light');

let tiltEl = null;
const untilt = el => el && (el.style.setProperty('--rx', '0deg'), el.style.setProperty('--ry', '0deg'));
document.addEventListener('pointermove', e => {
  const el = e.target.closest && e.target.closest('.tilt');
  if (tiltEl && tiltEl != el) untilt(tiltEl);
  if (!(tiltEl = el)) return;
  const r = el.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5, m = +(el.dataset.tilt || 8);
  el.style.setProperty('--ry', px * m + 'deg'); el.style.setProperty('--rx', -py * m + 'deg');
  el.style.setProperty('--gx', (px + .5) * 100 + '%'); el.style.setProperty('--gy', (py + .5) * 100 + '%');
});
document.addEventListener('mouseleave', () => untilt(tiltEl));

/* ---------- small helpers: show/hide password, strength meter ---------- */
document.addEventListener('click', e => { const b = e.target.closest('[data-eye]'); if (b) { const i = $('#' + b.dataset.eye); i.type = i.type == 'password' ? 'text' : 'password' } });
const score = p => p ? Math.max(1, Math.min(4, (p.length >= 8) + (p.length >= 12) + (/[a-z]/.test(p) && /[A-Z]/.test(p)) + (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)))) : 0;
function setMeter(id, p) { const i = $(`#${id} i`), s = score(p); i.style.width = s * 25 + '%'; i.dataset.s = s }
document.addEventListener('input', e => { const m = e.target.dataset && e.target.dataset.meter; if (m) setMeter(m, e.target.value) });

/* ---------- sign in / out ---------- */
const initials = n => (n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
function showErr(m) { const e = $('#lErr'); e.textContent = m || ''; e.classList.toggle('hide', !m) }
function showLogin(msg) {
  S.user = null; S.inited = false; ['pwDlg', 'uploadAckDlg', 'dlg'].forEach(id => { const d = $('#' + id); if (d && d.open) d.close() }); document.body.classList.remove('authed'); $('#app').classList.add('hide'); $('#login').classList.remove('hide'); $('#userMenu').classList.add('hide');
  $('#lPw').value = ''; showErr(msg); bg.redraw(); setTimeout(() => $('#lId').focus(), 60);
}
function showApp() {
  document.body.classList.add('authed'); $('#login').classList.add('hide'); $('#app').classList.remove('hide'); bg.redraw();
  $('#uIni').textContent = initials(S.user.name); $('#uName').textContent = S.user.name; $('#uId').textContent = 'Employee ID ' + S.user.id;
  const admin = !!S.user.admin;                                   // only administrators see Team / Login history / New table
  $$('#mainNav button').forEach(b => b.classList.toggle('hide', b.dataset.v != 'vData' && !admin));
  $('#newTable').classList.toggle('hide', !admin);
  $('#pwWarn').classList.add('hide'); S.inited = false; go('vData');
  if (S.user.default_pw) forcePw(); else init();
}
function forcePw() {                                              // the built-in password is public knowledge: replace it first
  $('#pwForm').reset(); setMeter('pMeter', ''); $('#pCancel').textContent = 'Sign out';
  if (!$('#pwDlg').open) $('#pwDlg').showModal();
  toast('Please set a new password to continue');
}
$('#loginForm').onsubmit = async e => {
  e.preventDefault(); const b = $('#lBtn'), f = $('#loginForm'); b.classList.add('busy'); showErr('');
  try {
    const res = await post('/api/login', {id: $('#lId').value.trim(), password: $('#lPw').value});
    if (res && res.token) setToken(res.token);
    S.user = res.user;
    showApp();
  }
  catch (x) { showErr(x.message); f.classList.remove('shake'); void f.offsetWidth; f.classList.add('shake'); $('#lPw').select() }
  finally { b.classList.remove('busy') }
};
$('#userBtn').onclick = e => { e.stopPropagation(); $('#userMenu').classList.toggle('hide') };
document.addEventListener('click', e => { if (!e.target.closest('.user')) $('#userMenu').classList.add('hide') });
document.addEventListener('keydown', e => e.key == 'Escape' && $('#userMenu').classList.add('hide'));
$('#logout').onclick = async () => { try { await post('/api/logout') } catch (e) {} setToken(''); showLogin() };

$('#chgPw').onclick = $('#pwWarnBtn').onclick = () => { $('#userMenu').classList.add('hide'); $('#pwForm').reset(); setMeter('pMeter', ''); $('#pCancel').textContent = 'Cancel'; $('#pwDlg').showModal() };
$('#pCancel').onclick = async () => {
  if (S.user && S.user.default_pw) { try { await post('/api/logout') } catch (e) {} setToken(''); showLogin() } else $('#pwDlg').close()
};
$('#pwDlg').addEventListener('cancel', e => { if (S.user && S.user.default_pw) e.preventDefault() });
$('#pwForm').onsubmit = async e => {
  e.preventDefault();
  if ($('#pNew').value != $('#pNew2').value) return toast('The two new passwords do not match', 1);
  try { await post('/api/password', {current: $('#pCur').value, new: $('#pNew').value}); $('#pwDlg').close(); S.user.default_pw = false; $('#pCancel').textContent = 'Cancel'; toast('Password changed ✔'); if (!S.inited) init() }
  catch (x) { fail(x) }
};

/* ---------- main tabs ---------- */
function go(v) {
  if (v != 'vData' && S.user && !S.user.admin) v = 'vData';
  $$('#mainNav button').forEach(b => b.classList.toggle('on', b.dataset.v == v));
  ['vData', 'vTeam', 'vLogs'].forEach(id => $('#' + id).classList.toggle('hide', id != v));
  if (v == 'vTeam') loadMembers(); if (v == 'vLogs') loadLogs();
}
$$('#mainNav button').forEach(b => b.onclick = () => go(b.dataset.v));

/* ---------- team (only reachable when signed in) ---------- */
async function loadMembers() {
  try {
    const d = await api('/api/members'); $('#mCount').textContent = d.members.length;
    $('#mBody').innerHTML = d.members.map(m => { const me = m.emp_id.toLowerCase() == S.user.id.toLowerCase();
      return `<tr><td><b>${esc(m.emp_id)}</b> ${me ? '<span class="tag">you</span>' : ''} ${m.is_admin ? '<span class="tag good">admin</span>' : ''}</td><td>${esc(m.name)}</td><td>${esc(m.added_by || '—')}</td><td>${esc(m.last_login || 'never')}</td>
      <td class="num">${me ? '' : `<button class="btn ghost sm" data-rm="${esc(m.emp_id)}">Remove</button>`}</td></tr>` }).join('');
  } catch (e) { fail(e) }
}
$('#mBody').onclick = async e => {
  const id = e.target.dataset.rm; if (!id || !confirm(`Remove employee ${id}? They will be signed out and can no longer sign in.`)) return;
  try { await api('/api/members/' + enc(id), {method: 'DELETE'}); toast(`Removed ${id}`); loadMembers() } catch (x) { fail(x) }
};
$('#memberForm').onsubmit = async e => {
  e.preventDefault();
  try { await post('/api/members', {id: $('#mId').value.trim(), name: $('#mName').value.trim(), password: $('#mPw').value, admin: $('#mAdmin').checked});
    toast(`${$('#mName').value.trim()} added ✔`); e.target.reset(); setMeter('mMeter', ''); loadMembers() } catch (x) { fail(x) }
};

/* ---------- login history ---------- */
let LOGS = [];
const ACTS = {login: 'Signed in', logout: 'Signed out', password_change: 'Changed password', member_added: 'Added a member', member_removed: 'Removed a member', bulk_upload: 'Bulk upload'};
const device = ua => !ua ? '—' : (/Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser')
  + (/Windows/.test(ua) ? ' on Windows' : /iPhone|iPad/.test(ua) ? ' on iOS' : /Android/.test(ua) ? ' on Android' : /Mac OS/.test(ua) ? ' on macOS' : /Linux/.test(ua) ? ' on Linux' : '');
async function loadLogs() { try { LOGS = (await api('/api/logins')).logs; renderLogs() } catch (e) { fail(e) } }
function renderLogs() {
  const f = $('#lgFilter').value, rows = LOGS.filter(r => !f || (f == 'fail' ? !r.ok : r.ok && r.action == f));
  $('#lgBody').innerHTML = rows.map(r => `<tr><td>${esc(r.ts)}</td><td><b>${esc(r.emp_id)}</b></td><td>${esc(r.emp_name || '—')}</td>
    <td><span class="tag ${r.ok ? 'good' : 'bad'}">${r.ok ? esc(ACTS[r.action] || r.action) : 'Failed sign-in'}</span></td><td>${esc(r.note || '')}</td><td>${esc(r.ip || '')}</td><td>${esc(device(r.device))}</td></tr>`).join('')
    || '<tr><td colspan="7">Nothing recorded for this filter.</td></tr>';
  $('#lgInfo').textContent = rows.length + ' entries';
}
$('#lgFilter').onchange = renderLogs; $('#lgRefresh').onclick = loadLogs;

/* ---------- start-up: connection, database, providers ---------- */
function banner(msg) { const b = $('#banner'); b.textContent = msg || ''; b.classList.toggle('hide', !msg) }
async function init() {
  S.inited = true;
  let st;
  try { st = await api('/api/status') } catch (e) { if (e.silent) return; st = {connected: false, error: e.message, databases: [], database: ''} }
  $('#conn').textContent = st.connected ? 'MySQL connected' : 'MySQL not connected';
  $('#conn').className = 'pill' + (st.connected ? ' ok' : '');
  if (!st.connected) { banner('Cannot connect to MySQL:\n' + st.error + '\n\nCheck user / password / port in config.py and that MySQL is running, then reload.'); showWork(false); return }
  if (!st.database) { banner(st.configured ? `The database "${st.configured}" set in config.py was not found on this MySQL server.` : 'No database is set. Open config.py and put your schema name in "database", then restart.'); S.tables = []; renderChips(); showWork(false); return }
  banner('');
  try { await loadTables() } catch (e) { fail(e) }
}
function showWork(on) { $('#work').classList.toggle('hide', !on); $('#noTables').classList.add('hide') }
async function loadTables(select) {
  S.tables = await api('/api/tables');
  if (select) S.cur = select;
  if (!S.cur || !S.tables.find(t => t.name == S.cur)) {
    const custTable = S.tables.find(t => t.name.toLowerCase() == 'customer_data');
    S.cur = custTable ? custTable.name : (S.tables[0]?.name || '');
  }
  await loadProviders();
  renderChips();
  if (S.cur) { showWork(true); await selectTable(S.cur) } else { showWork(false); $('#noTables').classList.remove('hide') }
}

async function loadProviders() {
  try {
    const d = await api('/api/providers?table=' + enc(S.cur || 'customer_data'));
    S.providers = d.summary || DEFAULT_PROVIDERS.map(p => ({provider: p, count: 0}));
  } catch (e) {
    S.providers = DEFAULT_PROVIDERS.map(p => ({provider: p, count: 0}));
  }
}

function renderChips() {
  const curTable = S.tables.find(t => t.name == S.cur);
  const totalRows = curTable ? curTable.rows : 0;
  const provMap = Object.fromEntries((S.providers || []).map(p => [(p.provider || '').toLowerCase(), p.count || 0]));
  let html = `<button class="chip ${!S.prov ? 'on' : ''}" data-prov="">🌐 All Data<small>${fmt(totalRows)}</small></button>`;
  html += provNames().map(p => {
    const count = provMap[p.toLowerCase()] || 0;
    return `<button class="chip ${S.prov == p ? 'on' : ''}" data-prov="${esc(p)}">${esc(p)}<small>${fmt(count)}</small></button>`;
  }).join('');
  if (S.tables.length > 1) {
    html += '<span style="border-left:1px solid var(--line);margin:0 6px;height:24px;align-self:center"></span>';
    html += S.tables.filter(t => t.name != S.cur).map(t => `<button class="chip ghost" data-t="${esc(t.name)}" title="Switch table">📁 ${esc(t.name)}</button>`).join('');
  }
  $('#chips').innerHTML = html;
}

const pick = async e => {
  const pBtn = e.target.closest('[data-prov]');
  if (pBtn) {
    S.prov = pBtn.dataset.prov || '';
    if ($('#fProv')) $('#fProv').value = S.prov;
    renderChips();
    S.off = 0;
    await load();
    return;
  }
  const tBtn = e.target.closest('[data-t]');
  if (tBtn && tBtn.dataset.t && tBtn.dataset.t != S.cur) {
    S.cur = tBtn.dataset.t;
    S.prov = '';
    await loadProviders();
    renderChips();
    await selectTable(S.cur);
  }
};
$('#chips').onclick = pick; $('#addPick').onclick = pick;
async function refreshCounts() { S.tables = await api('/api/tables'); await loadProviders(); renderChips() }
$$('.subnav button').forEach(b => b.onclick = () => {
  $$('.subnav button').forEach(x => x.classList.toggle('on', x == b));
  ['fetch', 'add'].forEach(id => $('#' + id).classList.toggle('hide', id != b.dataset.t)) });

/* ---------- one provider (or all): columns are read from MySQL ---------- */
async function selectTable(name) {
  const all = name == ALL;
  S.cols = await api(rowsUrl(name) + '/columns');
  S.allColNames = S.cols.map(c => c.name);

  // Restore stored visible columns or default to all
  const stored = getStoredCols();
  if (stored && Array.isArray(stored) && stored.length > 0) {
    const valid = stored.filter(c => S.allColNames.includes(c));
    S.visibleCols = valid.length ? new Set(valid) : new Set(S.allColNames);
  } else {
    S.visibleCols = new Set(S.allColNames);
  }

  S.pcol = all ? (S.cols.find(c => c.provider) || {}).name || '' : '';
  S.sort = ''; S.desc = true; S.off = 0;
  S.dcol = S.cols.find(c => ['date', 'datetime', 'date_text'].includes(c.kind)) || null;
  $('#addAll').classList.toggle('hide', !all); $('#form').classList.toggle('hide', all);
  if (all) $('#addPick').innerHTML = S.tables.map(t => `<button class="chip" data-t="${esc(t.name)}">${esc(t.name)}</button>`).join('');
  buildFilters();
  renderColPickerUI();
  await Promise.all([load(), all ? 0 : buildForm()]);
}

/* ---------- COLUMN PICKER UI & SELECTION ---------- */
function updateColBadge() {
  const badge = $('#colBadge');
  if (!badge) return;
  const total = S.allColNames ? S.allColNames.length : 0;
  const count = S.visibleCols ? S.visibleCols.size : total;
  if (!total || count >= total) {
    badge.textContent = 'All (' + total + ')';
    badge.className = 'tag good';
  } else {
    badge.textContent = `${count}/${total}`;
    badge.className = 'tag';
  }
}

function renderColPickerUI() {
  const list = $('#colPickerList');
  if (!list) return;
  const allCols = S.allColNames || [];
  if (!allCols.length) {
    list.innerHTML = '<p class="hint" style="margin:8px">No columns available</p>';
    updateColBadge();
    return;
  }
  const isChecked = c => !S.visibleCols || S.visibleCols.has(c);
  list.innerHTML = allCols.map(c => `
    <label class="col-picker-item">
      <input type="checkbox" data-col="${esc(c)}" ${isChecked(c) ? 'checked' : ''}>
      <span title="${esc(c)}">${esc(c)}</span>
    </label>
  `).join('');
  updateColBadge();
}

function initColPicker() {
  const btn = $('#colPickerBtn'), menu = $('#colPickerMenu'), closeBtn = $('#colCloseBtn');
  const selAll = $('#colSelectAll'), selDef = $('#colSelectDefault'), clearAll = $('#colClearAll');
  const list = $('#colPickerList');

  if (btn && menu) {
    btn.onclick = e => {
      e.stopPropagation();
      menu.classList.toggle('hide');
      btn.setAttribute('aria-expanded', !menu.classList.contains('hide'));
    };
  }

  if (closeBtn && menu) {
    closeBtn.onclick = e => {
      e.stopPropagation();
      menu.classList.add('hide');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    };
  }

  document.addEventListener('click', e => {
    if (menu && !menu.classList.contains('hide') && !e.target.closest('.col-picker-wrap')) {
      menu.classList.add('hide');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }
  });

  if (selAll) {
    selAll.onclick = () => {
      S.visibleCols = new Set(S.allColNames);
      saveStoredCols([...S.visibleCols]);
      renderColPickerUI();
      renderCurrentTable();
    };
  }

  if (selDef) {
    selDef.onclick = () => {
      const defCandidates = ['customer', 'provider', 'date', 'plan', 'qty', 'quantity', 'amount', 'status', 'mobile_number', 'sim_number', 'product'];
      const defCols = S.allColNames.filter(c => defCandidates.includes(c.toLowerCase()));
      S.visibleCols = new Set(defCols.length ? defCols : S.allColNames);
      saveStoredCols([...S.visibleCols]);
      renderColPickerUI();
      renderCurrentTable();
    };
  }

  if (clearAll) {
    clearAll.onclick = () => {
      const minCols = S.allColNames.filter(c => ['customer', 'provider'].includes(c.toLowerCase()));
      S.visibleCols = new Set(minCols.length ? minCols : S.allColNames.slice(0, 2));
      saveStoredCols([...S.visibleCols]);
      renderColPickerUI();
      renderCurrentTable();
    };
  }

  if (list) {
    list.onchange = e => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const colName = cb.dataset.col;
      if (!S.visibleCols) S.visibleCols = new Set(S.allColNames);
      if (cb.checked) {
        S.visibleCols.add(colName);
      } else {
        if (S.visibleCols.size > 1) {
          S.visibleCols.delete(colName);
        } else {
          cb.checked = true;
          toast('At least one column must remain visible', 1);
          return;
        }
      }
      saveStoredCols([...S.visibleCols]);
      updateColBadge();
      renderCurrentTable();
    };
  }

  const pSize = $('#pageSize');
  if (pSize) {
    pSize.onchange = () => {
      S.pageSize = parseInt(pSize.value) || 100;
      S.off = 0;
      load();
    };
  }
}
initColPicker();

/* ---------- FETCH ---------- */
function buildFilters() {
  $('#filters').innerHTML = `<label>Search<input id="fQ" placeholder="Search every column…"></label>` +
    `<label>Provider<select id="fProv">
      <option value="">All Data</option>
      ${provNames().map(p => `<option value="${esc(p)}" ${S.prov == p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
    </select></label>` +
    (S.dcol ? `<label>${esc(S.dcol.name)} from<input type="date" id="fFrom"></label><label>${esc(S.dcol.name)} to<input type="date" id="fTo"></label>` : '') +
    `<label>Requested by<input id="fReqBy" list="dlReqBy" placeholder="Filter by requested by…"><datalist id="dlReqBy"></datalist></label>` +
    `<label>Raised by<input id="fRaisedBy" list="dlRaisedBy" placeholder="Filter by raised by…"><datalist id="dlRaisedBy"></datalist></label>`;
  if ($('#fProv')) {
    $('#fProv').onchange = () => { S.prov = $('#fProv').value; S.off = 0; renderChips(); load() };
  }
  loadFilterDatalists();

  let searchDebounceTimer = null;
  const triggerDebounce = () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      S.off = 0;
      load();
    }, 350);
  };

  const fQ = $('#fQ');
  if (fQ) fQ.oninput = triggerDebounce;

  const fReqBy = $('#fReqBy');
  if (fReqBy) {
    fReqBy.oninput = triggerDebounce;
    fReqBy.onchange = () => { S.off = 0; load(); };
  }

  const fRaisedBy = $('#fRaisedBy');
  if (fRaisedBy) {
    fRaisedBy.oninput = triggerDebounce;
    fRaisedBy.onchange = () => { S.off = 0; load(); };
  }

  if ($('#fFrom')) $('#fFrom').onchange = () => { S.off = 0; load(); };
  if ($('#fTo')) $('#fTo').onchange = () => { S.off = 0; load(); };

  $$('#filters input,#filters select').forEach(i => i.onkeydown = e => {
    if (e.key == 'Enter') {
      clearTimeout(searchDebounceTimer);
      $('#go').click();
    }
  });
}

async function loadFilterDatalists() {
  try {
    const r = await api(`${rowsUrl(S.cur)}/values?column=${enc('REQUESTED BY')}`).catch(() => ({values: []}));
    if ($('#dlReqBy') && r.values) {
      $('#dlReqBy').innerHTML = r.values.map(v => `<option value="${esc(v)}">`).join('');
    }
  } catch (e) {}
  try {
    const r = await api(`${rowsUrl(S.cur)}/values?column=${enc('RAISED BY')}`).catch(() => ({values: []}));
    if ($('#dlRaisedBy') && r.values) {
      $('#dlRaisedBy').innerHTML = r.values.map(v => `<option value="${esc(v)}">`).join('');
    }
  } catch (e) {}
}

function params(paging = true) {
  const p = {q: $('#fQ').value.trim(), sort: S.sort, desc: S.desc};
  const provVal = $('#fProv') ? $('#fProv').value : S.prov;
  if (provVal && provVal.trim().toLowerCase() != 'all data') p.provider = provVal.trim();
  if (S.dcol && $('#fFrom') && $('#fTo')) {
    p.date_col = S.dcol.name;
    p.date_from = $('#fFrom').value;
    p.date_to = $('#fTo').value;
  }
  if ($('#fReqBy') && $('#fReqBy').value.trim()) {
    p.requested_by = $('#fReqBy').value.trim();
  }
  if ($('#fRaisedBy') && $('#fRaisedBy').value.trim()) {
    p.raised_by = $('#fRaisedBy').value.trim();
  }
  const limit = S.pageSize || PAGE;
  if (paging) { p.limit = limit; p.offset = S.off }
  if (S.visibleCols && S.allColNames && S.visibleCols.size < S.allColNames.length) {
    p.cols = [...S.visibleCols].join(',');
  }
  return new URLSearchParams(Object.entries(p).filter(([, v]) => v !== '' && v !== undefined)).toString();
}

function renderCurrentTable() {
  if (!S.lastData) return;
  const d = S.lastData;
  const allCols = d.columns || S.allColNames || [];
  const activeCols = allCols.filter(c => !S.visibleCols || S.visibleCols.has(c));
  const colsToRender = activeCols.length > 0 ? activeCols : allCols;

  const num = c => ['int', 'decimal'].includes((S.cols.find(x => x.name == c) || {}).kind) || NUMCOL.test(c);
  $('#head').innerHTML = '<tr>' + colsToRender.map(c => `<th data-k="${esc(c)}" class="${num(c) ? 'num' : ''}">${esc(c)}${c == (S.sort || d.pk) ? (S.desc ? ' ↓' : ' ↑') : ''}</th>`).join('') + '</tr>';
  const cell = (c, v) => (S.cur == ALL && c == S.pcol) || ['customer', 'provider'].includes(c.toLowerCase()) ? `<span class="tag">${esc(v)}</span>` : esc(v);
  $('#body').innerHTML = d.rows.map(r => '<tr>' + colsToRender.map(c => `<td class="${num(c) ? 'num' : ''}">${cell(c, r[c])}</td>`).join('') + '</tr>').join('')
    || `<tr><td colspan="${colsToRender.length || 1}">No records match these filters.</td></tr>`;

  updateColBadge();
}

async function load() {
  const my = S.reqId = (S.reqId || 0) + 1;                       // a slower, older response must not overwrite a newer one
  $('#body').style.opacity = .45;
  try {
    const d = await api(`${rowsUrl(S.cur)}/rows?${params()}`);
    if (my != S.reqId) return;
    S.lastData = d;
    S.total = d.total;
    if (d.columns && d.columns.length && (!S.allColNames || !S.allColNames.length)) {
      S.allColNames = d.columns;
      if (!S.visibleCols) S.visibleCols = new Set(S.allColNames);
      renderColPickerUI();
    }
    const label = S.prov ? `Records (${S.prov})` : 'All Data Records';
    $('#stats').innerHTML = [[label, d.total], ...d.sums.map(s => [`Total ${s.column}`, s.sum])]
      .map(([l, v]) => `<div class="card stat tilt" data-tilt="12"><b>${fmt(v)}</b><span>${esc(l)}</span></div>`).join('');
    $('#stats').style.gridTemplateColumns = `repeat(${Math.min(d.sums.length + 1, 4)},1fr)`;

    renderCurrentTable();

    const limit = S.pageSize || PAGE;
    $('#info').textContent = d.total ? `Showing ${S.off + 1}–${Math.min(S.off + limit, d.total)} of ${fmt(d.total)}` : '';
    $('#prev').disabled = S.off == 0;
    $('#next').disabled = S.off + limit >= d.total;
  } catch (e) { fail(e) }
  $('#body').style.opacity = 1;
}

$('#head').onclick = e => { const k = e.target.dataset.k; if (!k) return; S.desc = k == S.sort ? !S.desc : true; S.sort = k; S.off = 0; load() };
$('#body').onclick = e => {
  const tag = e.target.closest('.tag');
  if (!tag) return;
  const tr = tag.closest('tr'), td = tag.closest('td');
  if (!td || !tr) return;
  const colIdx = [...tr.children].indexOf(td);
  const th = $('#head').querySelectorAll('th')[colIdx];
  if (!th) return;
  const colName = (th.dataset.k || '').toLowerCase(), val = tag.textContent.trim();
  if (colName == 'provider') {
    S.prov = val; if ($('#fProv')) $('#fProv').value = val; renderChips(); S.off = 0; load();
  } else if (colName == 'customer') {
    $('#fQ').value = val; S.off = 0; load();
  }
};
$('#go').onclick = () => { S.off = 0; load() };
$('#prev').onclick = () => { const limit = S.pageSize || PAGE; S.off = Math.max(0, S.off - limit); load() };
$('#next').onclick = () => { const limit = S.pageSize || PAGE; S.off += limit; load() };
$('#reset').onclick = () => {
  $$('#filters input').forEach(i => i.value = '');
  if ($('#fProv')) $('#fProv').value = '';
  if ($('#fReqBy')) $('#fReqBy').value = '';
  if ($('#fRaisedBy')) $('#fRaisedBy').value = '';
  S.prov = '';
  S.cust = '';
  S.off = 0;
  S.sort = '';
  S.desc = true;
  renderChips();
  load();
};
$('#dl').onclick = async () => {
  const btn = $('#dl'); btn.disabled = true;
  try {
    const token = getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(apiUrl(`${rowsUrl(S.cur)}/export?${params(false)}`), {credentials: 'include', headers});
    if (r.status == 401) { setToken(''); showLogin('Your session ended. Please sign in again.'); return }
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw Error(typeof d.detail == 'string' ? d.detail : 'Download failed') }
    const blob = await r.blob(), a = document.createElement('a'), m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
    a.href = URL.createObjectURL(blob); a.download = m ? m[1] : (S.cur + '.xlsx');
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { fail(e) } finally { btn.disabled = false }
};

/* ---------- BULK UPLOAD (Excel file: each sheet name = a provider, each row = a customer entry) ---------- */
const bulkInput = $('#bulkFile'), bulkBtn = $('#bulkUploadBtn'), uploadDlg = $('#uploadAckDlg');
const uploadSection = which => ['uploadProgressSection', 'uploadAckSection', 'uploadErrorSection'].forEach(id => $('#' + id).classList.toggle('hide', id != which));
function uploadDone() { bulkInput.value = ''; bulkBtn.disabled = false; bulkBtn.classList.remove('busy') }
function uploadFail(msg) {
  uploadDone(); uploadSection('uploadErrorSection'); $('#uploadErrorMsg').textContent = msg;
  $('#ackErrCloseBtn').onclick = () => uploadDlg.close();
}
function showUploadResult(data) {
  uploadSection('uploadAckSection');
  $('#ackTotalRows').textContent = fmt(data.rows_inserted || 0);
  $('#ackSheetsCount').textContent = fmt(data.sheets_count || 0);
  $('#ackCustomersCount').textContent = fmt(data.customers_count || 0);
  const w = data.warnings || [];
  $('#ackWarnings').innerHTML = w.map(x => `<li>${esc(x)}</li>`).join('');
  $('#ackWarnings').classList.toggle('hide', !w.length);
  $('#ackBreakdownBody').innerHTML = (data.sheets || []).map(s => {
    const known = (s.provider || '').split(', ').every(p => DEFAULT_PROVIDERS.includes(p));
    return `<tr>
      <td><b>📶 ${esc(s.sheet_name)}</b> <span class="tag">${esc(s.provider)}</span></td>
      <td class="num"><b>${fmt(s.rows_count)}</b> entries</td>
      <td><small style="color:var(--mut)">${(s.customers_sample || []).map(esc).join(', ')}${s.customers_count > 5 ? '…' : ''}</small></td>
      <td><span class="tag ${known ? 'good' : ''}">${known ? '✔ Imported' : '⚠ New provider'}</span></td></tr>`;
  }).join('') || '<tr><td colspan="4">No entries found.</td></tr>';
  $('#ackCloseBtn').onclick = async () => {
    uploadDlg.close();
    toast(`Imported ${data.rows_inserted} entries across ${data.sheets_count} sheet(s) ✔` + (w.length ? ` (${w.length} warning${w.length > 1 ? 's' : ''})` : ''));
    await loadTables(data.table || S.cur);
  };
}
function sendUpload(file, force) {
  uploadSection('uploadProgressSection');
  $('#uploadFileMeta').textContent = `File: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  $('#uploadProgressBar').style.width = '0%'; $('#uploadPercent').textContent = '0%'; $('#uploadStageText').textContent = 'Uploading Excel file…';
  $('#step1').className = 'ustep active'; $('#step2').className = 'ustep'; $('#step3').className = 'ustep';
  bulkBtn.disabled = true; bulkBtn.classList.add('busy');
  if (!uploadDlg.open) { try { uploadDlg.showModal() } catch (e) {} }

  const fd = new FormData(); fd.append('file', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', apiUrl('/api/upload?table=' + enc(S.cur || 'customer_data') + (force ? '&force=true' : '')));
  xhr.withCredentials = true;
  const token = getToken();
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = e => {
    if (!e.lengthComputable || e.total <= 0) return;
    const pct = Math.min(Math.round(e.loaded / e.total * 90), 90);
    $('#uploadProgressBar').style.width = pct + '%'; $('#uploadPercent').textContent = pct + '%';
    if (pct >= 85) { $('#step1').className = 'ustep done'; $('#step2').className = 'ustep active'; $('#uploadStageText').textContent = 'Processing sheet names as SIM Providers…' }
  };
  xhr.onload = () => {
    let d = {}; try { d = JSON.parse(xhr.responseText) } catch (e) {}
    if (xhr.status >= 200 && xhr.status < 300) {
      uploadDone();
      $('#uploadProgressBar').style.width = '100%'; $('#uploadPercent').textContent = '100%';
      ['#step1', '#step2', '#step3'].forEach(i => $(i).className = 'ustep done'); $('#uploadStageText').textContent = 'Import complete!';
      setTimeout(() => showUploadResult(d), 350);
    } else if (xhr.status == 401) {
      uploadDone(); uploadDlg.close(); showLogin('Your session ended. Please sign in again.');
    } else if (xhr.status == 409) {                                     // this exact file was imported before
      uploadDone(); uploadDlg.close();
      if (confirm((d.detail || 'This file was already imported.') + '\n\nImport it anyway?')) sendUpload(file, true);
    } else uploadFail(typeof d.detail == 'string' ? d.detail : (xhr.statusText || 'Upload failed'));
  };
  xhr.onerror = () => uploadFail('Network or connection error during upload.');
  xhr.send(fd);
}
if (bulkBtn && bulkInput) {
  bulkBtn.onclick = () => bulkInput.click();
  bulkInput.onchange = () => {
    const file = bulkInput.files[0];
    if (!file) return;
    if (!/\.(xlsx|xlsm)$/i.test(file.name || '')) { toast('Please choose a valid Excel workbook (.xlsx)', 1); bulkInput.value = ''; return }
    sendUpload(file, false);
  };
}

/* ---------- INSERT: Add new entry with exact guided fields ---------- */
async function buildForm() {
  const today = new Date().toLocaleDateString('en-CA');
  const curP = S.prov && provNames().includes(S.prov.toLowerCase()) ? S.prov.toLowerCase() : (provNames()[0] || 'sensorise');

  const primaryHtml = `
    <!-- 1. Provider -->
    <label>Provider *
      <select id="insProvider" required>
        ${provNames().map(p => `<option value="${esc(p)}" ${p == curP ? 'selected' : ''}>${esc(p)}</option>`).join('')}
      </select>
    </label>

    <!-- 2. Date -->
    <label>Date *
      <input type="date" id="insDate" value="${today}" required>
    </label>

    <!-- 3. Customer Name -->
    <label>Customer Name *
      <input type="text" id="insCustomer" placeholder="Enter customer name" required>
    </label>

    <!-- 4. Request ID -->
    <label>Request ID
      <input type="text" id="insReqId" placeholder="e.g. REQ-1002">
    </label>

    <!-- 5. Quantity -->
    <label>Quantity *
      <input type="number" id="insQty" min="1" step="1" value="1" required>
    </label>

    <!-- 6. Plan -->
    <label>Plan *
      <select id="insPlanType" required>
        <option value="">-- Select Plan --</option>
        <option value="Renewal">Renewal</option>
        <option value="Reactivation">Reactivation</option>
        <option value="Operational">Operational</option>
        <option value="TopUp">TopUp</option>
      </select>
    </label>

    <!-- Dynamic Plan Sub-options -->
    <div id="insPlanSubWrap" class="form-subbox hide"></div>

    <!-- 7. Profile -->
    <label>Profile
      <select id="insProfileType">
        <option value="">-- Select Profile --</option>
        <option value="Single Profile">Single Profile</option>
        <option value="Dual Profile">Dual Profile</option>
      </select>
    </label>

    <!-- Dynamic Dual Profile Sub-options -->
    <div id="insProfileDualWrap" class="hide">
      <label>Dual Profile Type
        <select id="insProfileDualType">
          <option value="A+B">A+B</option>
          <option value="V+B">V+B</option>
          <option value="A+V">A+V</option>
        </select>
      </label>
    </div>

    <!-- 8. Product -->
    <label>Product
      <select id="insProduct">
        <option value="">-- Select Product --</option>
        <option value="ALPHA">ALPHA</option>
        <option value="AIRTELSP">AIRTELSP</option>
        <option value="taisys (airtel )">taisys (airtel )</option>
        <option value="taisys(airtel+bsnl)">taisys(airtel+bsnl)</option>
        <option value="vi">vi</option>
      </select>
    </label>

    <!-- 9. Requested By -->
    <label>Requested By
      <input type="text" id="insReqBy" placeholder="Enter name">
    </label>

    <!-- 10. Raised By -->
    <label>Raised By
      <input type="text" id="insRaisedBy" placeholder="Enter name">
    </label>
  `;

  // Remaining optional columns from the table
  const knownCols = [
    'id', 'created_at', 'provider', 'date', 'customer', 'request id',
    'qty', 'quantity', 'plan', 'month', 'months', 'profile', 'product',
    'requested by', 'raised by'
  ];
  const moreCols = S.cols.filter(c => !knownCols.includes(c.name.trim().toLowerCase()) && !c.hide);

  let moreHtml = '';
  if (moreCols.length) {
    moreHtml = `
      <div class="wide" style="margin-top:10px">
        <button type="button" class="btn ghost sm" id="insMoreBtn">➕ More Details (SIM, Amount, Remarks...)</button>
        <div id="insMoreWrap" class="grid hide" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
          ${moreCols.map(c => {
            const isNum = ['int', 'decimal'].includes(c.kind);
            return `<label>${esc(c.name)}<input type="${isNum ? 'number' : 'text'}" name="${esc(c.name)}" placeholder="Enter ${esc(c.name)}"></label>`;
          }).join('')}
        </div>
      </div>
    `;
  }

  $('#fields').innerHTML = primaryHtml + moreHtml;

  // Plan dropdown change handler
  const planSel = $('#insPlanType');
  const subWrap = $('#insPlanSubWrap');
  if (planSel && subWrap) {
    planSel.onchange = () => {
      const val = planSel.value;
      if (!val) {
        subWrap.classList.add('hide');
        subWrap.innerHTML = '';
        return;
      }
      subWrap.classList.remove('hide');

      if (val == 'Renewal') {
        subWrap.innerHTML = `
          <h4>Renewal Details</h4>
          <div class="grid">
            <label>Duration
              <select id="insRenewDuration">
                <option value="1 yr">1 yr</option>
                <option value="2 yr">2 yr</option>
                <option value="Custom">Custom</option>
              </select>
            </label>
            <label>Months (manual)
              <input type="text" id="insRenewMonths" placeholder="e.g. 12 or 6">
            </label>
            <label>Days (manual)
              <input type="text" id="insRenewDays" placeholder="e.g. 30 or 15">
            </label>
          </div>
        `;
      } else if (val == 'Reactivation') {
        subWrap.innerHTML = `
          <h4>Reactivation Details</h4>
          <div class="grid">
            <label>Duration
              <select id="insReactDuration">
                <option value="1 yr">1 yr</option>
                <option value="2 yr">2 yr</option>
                <option value="Custom">Custom</option>
              </select>
            </label>
            <label>Months (manual)
              <input type="text" id="insReactMonths" placeholder="e.g. 12 or 6">
            </label>
            <label>Days (manual)
              <input type="text" id="insReactDays" placeholder="e.g. 30 or 15">
            </label>
          </div>
        `;
      } else if (val == 'Operational') {
        subWrap.innerHTML = `
          <h4>Operational Activation</h4>
          <div class="grid">
            <label>Activation Duration
              <select id="insOperDuration">
                <option value="1 yr">1 yr</option>
                <option value="2 yr">2 yr</option>
                <option value="Custom">Custom</option>
              </select>
            </label>
            <label>Months (manual)
              <input type="text" id="insOperMonths" placeholder="e.g. 12 or 6">
            </label>
            <label>Days (manual)
              <input type="text" id="insOperDays" placeholder="e.g. 30 or 15">
            </label>
          </div>
        `;
      } else if (val == 'TopUp') {
        const topupOpts = Array.from({length: 24}, (_, i) => {
          const num = i + 1;
          const label = num === 1 ? '1 month' : `${num} months`;
          return `<option value="${label}">${label}</option>`;
        }).join('');
        subWrap.innerHTML = `
          <h4>TopUp Duration (1–24 Months)</h4>
          <div class="grid">
            <label>Duration (Months)
              <select id="insTopupDuration">
                ${topupOpts}
              </select>
            </label>
            <label>Days (manual / optional)
              <input type="text" id="insTopupDays" placeholder="e.g. 15">
            </label>
          </div>
        `;
      }
    };
  }

  // Profile dropdown change handler
  const profSel = $('#insProfileType');
  const dualWrap = $('#insProfileDualWrap');
  if (profSel && dualWrap) {
    profSel.onchange = () => {
      dualWrap.classList.toggle('hide', profSel.value != 'Dual Profile');
    };
  }

  // More Details toggle
  const moreBtn = $('#insMoreBtn');
  const moreWrap = $('#insMoreWrap');
  if (moreBtn && moreWrap) {
    moreBtn.onclick = () => {
      const isHidden = moreWrap.classList.contains('hide');
      moreWrap.classList.toggle('hide', !isHidden);
      moreBtn.textContent = isHidden ? '➖ Hide Additional Details' : '➕ More Details (SIM, Amount, Remarks...)';
    };
  }
}

$('#clear').onclick = () => setTimeout(buildForm, 0);
$('#form').onsubmit = async e => {
  e.preventDefault();

  const provider = ($('#insProvider') ? $('#insProvider').value : S.prov || 'sensorise').trim();
  const date = ($('#insDate') ? $('#insDate').value : '').trim();
  const customer = ($('#insCustomer') ? $('#insCustomer').value : '').trim();
  if (!customer) return toast('Please enter customer name', 1);

  const reqId = ($('#insReqId') ? $('#insReqId').value : '').trim();
  const qty = parseInt($('#insQty') ? $('#insQty').value : 1) || 1;

  // Plan composition
  const planType = $('#insPlanType') ? $('#insPlanType').value : '';
  let plan = planType;
  let durationStr = '';
  let monthsVal = '';

  if (planType == 'Renewal') {
    const dur = $('#insRenewDuration') ? $('#insRenewDuration').value : '';
    monthsVal = $('#insRenewMonths') ? $('#insRenewMonths').value.trim() : '';
    const daysVal = $('#insRenewDays') ? $('#insRenewDays').value.trim() : '';
    const parts = [];
    if (dur && dur != 'Custom') parts.push(dur);
    if (monthsVal) parts.push(monthsVal + (monthsVal.toLowerCase().includes('m') ? '' : ' months'));
    if (daysVal) parts.push(daysVal + (daysVal.toLowerCase().includes('d') ? '' : ' days'));
    plan = 'Renewal' + (parts.length ? ` (${parts.join(', ')})` : '');
    durationStr = dur && dur != 'Custom' ? dur : (monthsVal ? `${monthsVal} months` : '');
  } else if (planType == 'Reactivation') {
    const dur = $('#insReactDuration') ? $('#insReactDuration').value : '';
    monthsVal = $('#insReactMonths') ? $('#insReactMonths').value.trim() : '';
    const daysVal = $('#insReactDays') ? $('#insReactDays').value.trim() : '';
    const parts = [];
    if (dur && dur != 'Custom') parts.push(dur);
    if (monthsVal) parts.push(monthsVal + (monthsVal.toLowerCase().includes('m') ? '' : ' months'));
    if (daysVal) parts.push(daysVal + (daysVal.toLowerCase().includes('d') ? '' : ' days'));
    plan = 'Reactivation' + (parts.length ? ` (${parts.join(', ')})` : '');
    durationStr = dur && dur != 'Custom' ? dur : (monthsVal ? `${monthsVal} months` : '');
  } else if (planType == 'Operational') {
    const dur = $('#insOperDuration') ? $('#insOperDuration').value : '';
    monthsVal = $('#insOperMonths') ? $('#insOperMonths').value.trim() : '';
    const daysVal = $('#insOperDays') ? $('#insOperDays').value.trim() : '';
    const parts = ['Activation'];
    if (dur && dur != 'Custom') parts.push(dur);
    if (monthsVal) parts.push(monthsVal + (monthsVal.toLowerCase().includes('m') ? '' : ' months'));
    if (daysVal) parts.push(daysVal + (daysVal.toLowerCase().includes('d') ? '' : ' days'));
    plan = `Operational (${parts.join(' - ')})`;
    durationStr = dur && dur != 'Custom' ? dur : (monthsVal ? `${monthsVal} months` : '');
  } else if (planType == 'TopUp') {
    const dur = $('#insTopupDuration') ? $('#insTopupDuration').value : '';
    const daysVal = $('#insTopupDays') ? $('#insTopupDays').value.trim() : '';
    const parts = [];
    if (dur) parts.push(dur);
    if (daysVal) parts.push(daysVal + (daysVal.toLowerCase().includes('d') ? '' : ' days'));
    plan = 'TopUp' + (parts.length ? ` (${parts.join(', ')})` : '');
    durationStr = dur;
  }

  // Profile composition
  const profType = $('#insProfileType') ? $('#insProfileType').value : '';
  let profile = profType;
  if (profType == 'Dual Profile') {
    const dualSub = $('#insProfileDualType') ? $('#insProfileDualType').value : '';
    profile = dualSub ? `Dual Profile (${dualSub})` : 'Dual Profile';
  }

  // Product
  const product = $('#insProduct') ? $('#insProduct').value : '';

  // Requested by & Raised by
  const reqBy = $('#insReqBy') ? $('#insReqBy').value.trim() : '';
  const raisedBy = $('#insRaisedBy') ? $('#insRaisedBy').value.trim() : '';

  const body = {
    provider,
    date,
    customer,
    'Request ID': reqId,
    qty,
    Quantity: qty,
    plan,
    PROFILE: profile,
    Product: product,
    'REQUESTED BY': reqBy,
    'RAISED BY': raisedBy,
    Month: durationStr,
    MONTHS: monthsVal || durationStr
  };

  // Additional optional fields
  if ($('#insMoreWrap')) {
    $$('#insMoreWrap input, #insMoreWrap select, #insMoreWrap textarea').forEach(inp => {
      if (inp.name && inp.value.trim() !== '') {
        body[inp.name] = inp.value.trim();
      }
    });
  }

  try {
    const res = await post(`${rowsUrl(S.cur)}/rows`, body), lost = (res && res.ignored) || [];
    toast(lost.length ? `Entry added for ${customer}, but "${S.cur}" has no column for: ${lost.join(', ')} - those were not saved` : `Entry added for ${customer} (${provider}) ✔`, !!lost.length);
    S.off = 0;
    await Promise.all([buildForm(), load(), refreshCounts()]);
  } catch (x) {
    fail(x);
  }
};

/* ---------- CREATE TABLE ---------- */
const colRow = (n = '', t = 'text') => `<div class="crow"><label>Column name<input class="cn" value="${esc(n)}" placeholder="e.g. CUSTOMER NAME"></label>
  <label>Type<select class="ct">${Object.entries(TYPES).map(([k, l]) => `<option value="${k}" ${k == t ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
  <button type="button" class="btn ghost rm" title="Remove" aria-label="Remove column">✕</button></div>`;
$('#newTable').onclick = () => { $('#tName').value = ''; $('#cols').innerHTML = colRow('DATE', 'date') + colRow('CUSTOMER NAME') + colRow('QTY', 'int'); $('#dlg').showModal() };
$('#addCol').onclick = () => $('#cols').insertAdjacentHTML('beforeend', colRow());
$('#cols').onclick = e => e.target.classList.contains('rm') && e.target.closest('.crow').remove();
$('#cancel').onclick = () => $('#dlg').close();
$('#create').onclick = async () => {
  const name = $('#tName').value.trim(), columns = $$('.crow').map(r => ({name: r.querySelector('.cn').value.trim(), type: r.querySelector('.ct').value})).filter(c => c.name);
  try {
    await post('/api/tables', {name, columns});
    $('#dlg').close(); toast(`Table ${name} created ✔`); await loadTables(name);
  } catch (x) { fail(x) }
};

/* ---------- boot: already signed in? ---------- */
(async () => {
  try {
    const d = await api('/api/me');
    if (d.user) { S.user = d.user; showApp(); }
    else showLogin();
  } catch (e) {
    // If checking session on initial boot encounters a network delay/cold-start,
    // show login form cleanly without an alarming "Failed to fetch" banner
    showLogin();
  }
})();
