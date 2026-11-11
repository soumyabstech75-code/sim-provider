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
  providers: [],
  filters: {}
};

/* Core 10 columns requested by user for the Excel data view */
const CORE_COLUMNS = [
  { key: 'provider', label: 'Provider *', dbCols: ['provider'], kind: 'provider' },
  { key: 'date', label: 'Date *', dbCols: ['date'], kind: 'date' },
  { key: 'customer', label: 'Customer Name *', dbCols: ['customer', 'customer name'], kind: 'customer' },
  { key: 'Request ID', label: 'Request ID', dbCols: ['Request ID', 'request_id', 'Request_ID'], kind: 'text' },
  { key: 'Quantity', label: 'Quantity *', dbCols: ['Quantity', 'qty', 'QUANTITY'], kind: 'number' },
  { key: 'plan', label: 'Plan *(months / time duration)', dbCols: ['plan', 'PLAN'], durationCols: ['MONTHS', 'Month', 'months'], kind: 'text' },
  { key: 'PROFILE', label: 'Profile', dbCols: ['PROFILE', 'profile'], kind: 'text' },
  { key: 'Product', label: 'Product', dbCols: ['Product', 'product'], kind: 'text' },
  { key: 'REQUESTED BY', label: 'Requested By', dbCols: ['REQUESTED BY', 'requested_by', 'Requested By'], kind: 'text' },
  { key: 'RAISED BY', label: 'Raised By', dbCols: ['RAISED BY', 'raised_by', 'Raised By'], kind: 'text' }
];
const CORE_COL_KEYS = CORE_COLUMNS.map(c => c.key);

const colsKey = () => 'sim-visible-cols:' + (S.cur || '');
function getStoredCols() {
  try { const v = localStorage.getItem(colsKey()); return v ? JSON.parse(v) : null } catch (e) { return null }
}
function saveStoredCols(cols) {
  try { if (cols && cols.length) localStorage.setItem(colsKey(), JSON.stringify(cols)); else localStorage.removeItem(colsKey()) } catch (e) {}
}
const provNames = () => { const list = (S.providers || []).map(p => p.provider).filter(Boolean); return list.length ? list : DEFAULT_PROVIDERS; };
const TYPES = {text: 'Text', longtext: 'Long text', int: 'Whole number', decimal: 'Decimal / amount', date: 'Date'};
const CUST = /customer/i, LIST = /plan|product|profile|requested|raised|provider|status|type/i, NUMCOL = /^(qty|quantity|amount|total|price|cost)$/i;
const rowsUrl = t => t == ALL ? '/api/all' : `/api/tables/${enc(t)}`;

/* ---------- backend URL detection (Netlify + Render support) ---------- */
const RENDER_BACKEND_URL = 'https://sim-provider-1f4c.onrender.com';
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
// On Netlify (*.netlify.app) or external domain, connect directly to the live Render backend URL.
// This completely bypasses Netlify's 26-second proxy timeout, eliminating Netlify 504 "Request ID: 01M..." errors.
const API_BASE = window.API_BASE !== undefined ? window.API_BASE : (isLocal ? '' : RENDER_BACKEND_URL);
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

  // Show waking-up notice if request takes > 3.5 seconds (Render free tier spin-up)
  let wakeNoticeTimer = setTimeout(() => {
    const banner = $('#serverWarmBanner');
    if (banner) banner.classList.remove('hide');
    else toast('⏳ Cloud server is waking up (takes ~30s on first load). Please wait…');
  }, 3500);

  let r, d = {};
  try {
    r = await fetch(apiUrl(u), {credentials: 'include', ...o, headers});
    clearTimeout(wakeNoticeTimer);
    const banner = $('#serverWarmBanner');
    if (banner) banner.classList.add('hide');
    d = await r.json().catch(() => ({}));
  } catch (err) {
    clearTimeout(wakeNoticeTimer);
    const banner = $('#serverWarmBanner');
    if (banner) banner.classList.add('hide');

    // Auto-retry once after 4 seconds if server was cold-starting
    if (!o._retried && (!u.includes('/export') && !u.includes('/upload'))) {
      await new Promise(res => setTimeout(res, 4000));
      return api(u, {...o, _retried: true});
    }

    if (err && err.message && err.message.toLowerCase().includes('fetch')) {
      throw Error('Cannot connect to cloud backend. The server may still be booting up from sleep, please wait a moment and try again.');
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
const del = (u, body) => api(u, {method: 'DELETE', body});
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
function initDraggableThemer() {
  const themer = $('#themer') || $('.themer');
  const btn = $('#themeBtn');
  if (!themer || !btn) return;

  btn.style.cursor = 'grab';

  // Restore saved position if present
  try {
    const saved = localStorage.getItem('themer-pos');
    if (saved) {
      const {left, top} = JSON.parse(saved);
      const maxL = window.innerWidth - themer.offsetWidth - 10;
      const maxT = window.innerHeight - themer.offsetHeight - 10;
      themer.style.left = Math.max(10, Math.min(maxL, left)) + 'px';
      themer.style.top = Math.max(10, Math.min(maxT, top)) + 'px';
      themer.style.right = 'auto';
      themer.style.bottom = 'auto';
    }
  } catch (e) {}

  let isDragging = false, hasMoved = false;
  let startX = 0, startY = 0, initL = 0, initT = 0;

  btn.onpointerdown = e => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    const r = themer.getBoundingClientRect();
    initL = r.left;
    initT = r.top;
    btn.setPointerCapture(e.pointerId);
    btn.style.cursor = 'grabbing';
  };

  btn.onpointermove = e => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!hasMoved && Math.hypot(dx, dy) > 4) {
      hasMoved = true;
      themer.classList.add('dragging');
      $('#themeMenu').classList.add('hide');
    }
    if (hasMoved) {
      const maxL = window.innerWidth - themer.offsetWidth - 10;
      const maxT = window.innerHeight - themer.offsetHeight - 10;
      const newL = Math.max(10, Math.min(maxL, initL + dx));
      const newT = Math.max(10, Math.min(maxT, initT + dy));
      themer.style.left = newL + 'px';
      themer.style.top = newT + 'px';
      themer.style.right = 'auto';
      themer.style.bottom = 'auto';
    }
  };

  const endDrag = e => {
    if (!isDragging) return;
    isDragging = false;
    btn.style.cursor = 'grab';
    themer.classList.remove('dragging');
    try { btn.releasePointerCapture(e.pointerId); } catch (err) {}
    if (hasMoved) {
      const r = themer.getBoundingClientRect();
      try {
        localStorage.setItem('themer-pos', JSON.stringify({left: r.left, top: r.top}));
      } catch (err) {}
    }
  };

  btn.onpointerup = endDrag;
  btn.onpointercancel = endDrag;

  btn.onclick = e => {
    e.stopPropagation();
    if (hasMoved) {
      hasMoved = false;
      return;
    }
    $('#themeMenu').classList.toggle('hide');
  };
}
initDraggableThemer();
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
  const totalRows = (S.total !== undefined && S.total !== null) ? S.total : (curTable ? curTable.rows : 0);
  const provList = provNames();
  const provMap = Object.fromEntries((S.providers || []).map(p => [(p.provider || '').toLowerCase(), p.count || 0]));
  let html = `<button class="chip ${!S.prov ? 'on' : ''}" data-prov="">🌐 All Data<small>${fmt(totalRows)}</small></button>`;
  html += provList.map(p => {
    const count = provMap[p.toLowerCase()] || 0;
    const isOn = S.prov && S.prov.toLowerCase() === p.toLowerCase();
    return `<button class="chip ${isOn ? 'on' : ''}" data-prov="${esc(p)}">${esc(p)}<small>${fmt(count)}</small></button>`;
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
    const p = pBtn.dataset.prov || '';
    S.prov = p;
    if (p) S.filters.provider = p;
    else delete S.filters.provider;
    renderChips();
    renderFilterPills();
    renderHead();
    S.off = 0;
    await load();
    return;
  }
  const tBtn = e.target.closest('[data-t]');
  if (tBtn && tBtn.dataset.t && tBtn.dataset.t != S.cur) {
    S.cur = tBtn.dataset.t;
    S.prov = '';
    S.filters = {};
    await loadProviders();
    renderChips();
    renderFilterPills();
    await selectTable(S.cur);
  }
};
$('#chips').onclick = pick; $('#addPick').onclick = pick;
async function refreshCounts() { S.tables = await api('/api/tables'); await loadProviders(); renderChips() }
$$('.subnav button').forEach(b => b.onclick = () => {
  $$('.subnav button').forEach(x => x.classList.toggle('on', x == b));
  ['fetch', 'add'].forEach(id => $('#' + id).classList.toggle('hide', id != b.dataset.t)) });

/* ---------- one provider (or all): columns are read from MySQL ---------- */
function getDefaultCoreCols() {
  const allCols = S.allColNames || [];
  const matches = [];
  CORE_COLUMNS.forEach(c => {
    const found = allCols.find(col => 
      c.dbCols.some(dbCol => dbCol.toLowerCase() === col.toLowerCase()) || 
      c.key.toLowerCase() === col.toLowerCase()
    );
    if (found && !matches.includes(found)) matches.push(found);
  });
  return matches.length >= 4 ? matches : allCols;
}

async function selectTable(name) {
  const all = name == ALL;
  S.cols = await api(rowsUrl(name) + '/columns');
  S.allColNames = S.cols.map(c => c.name);

  // Restore stored visible columns or default to the 10 Core columns
  const stored = getStoredCols();
  if (stored && Array.isArray(stored) && stored.length > 0) {
    const valid = stored.filter(c => S.allColNames.includes(c));
    S.visibleCols = valid.length ? new Set(valid) : new Set(getDefaultCoreCols());
  } else {
    S.visibleCols = new Set(getDefaultCoreCols());
  }

  S.pcol = all ? (S.cols.find(c => c.provider) || {}).name || '' : '';
  S.sort = ''; S.desc = true; S.off = 0;
  S.dcol = S.cols.find(c => ['date', 'datetime', 'date_text'].includes(c.kind)) || null;
  $('#addAll').classList.toggle('hide', !all); $('#form').classList.toggle('hide', all);
  if (all) $('#addPick').innerHTML = S.tables.map(t => `<button class="chip" data-t="${esc(t.name)}">${esc(t.name)}</button>`).join('');
  renderFilterPills();
  renderColPickerUI();
  checkDeleteAllStatus(name);
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
  list.innerHTML = allCols.map(c => {
    const label = getColLabel(c);
    return `
      <label class="col-picker-item">
        <input type="checkbox" data-col="${esc(c)}" ${isChecked(c) ? 'checked' : ''}>
        <span title="${esc(c)}">${esc(label)} ${label !== c ? `<small style="color:var(--mut)">(${esc(c)})</small>` : ''}</span>
      </label>
    `;
  }).join('');
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
      const coreCols = getDefaultCoreCols();
      S.visibleCols = new Set(coreCols);
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

/* ---------- COLUMN HELPERS & LABELS ---------- */
function getColLabel(colName) {
  const match = CORE_COLUMNS.find(c => 
    c.key.toLowerCase() === colName.toLowerCase() || 
    c.dbCols.some(dbCol => dbCol.toLowerCase() === colName.toLowerCase())
  );
  return match ? match.label : colName;
}

function isColFiltered(colName) {
  const cn = colName.toLowerCase();
  if (cn === 'provider') return !!(S.filters.provider || S.prov);
  if (cn === 'date') return !!(S.filters.date_from || S.filters.date_to);
  if (cn === 'customer' || cn === 'customer name') return !!S.filters.customer;
  if (cn === 'requested by' || cn === 'requested_by') return !!(S.filters['REQUESTED BY'] || S.filters.requested_by);
  if (cn === 'raised by' || cn === 'raised_by') return !!(S.filters['RAISED BY'] || S.filters.raised_by);
  return !!S.filters[colName];
}

function isNumericCol(colName) {
  const kind = (S.cols.find(x => x.name.toLowerCase() === colName.toLowerCase()) || {}).kind;
  return ['int', 'decimal'].includes(kind) || NUMCOL.test(colName);
}

function getColsToRender() {
  const allCols = S.allColNames || [];
  if (!S.visibleCols || S.visibleCols.size === 0) return allCols;
  const visible = [];
  CORE_COLUMNS.forEach(c => {
    const found = allCols.find(col => 
      S.visibleCols.has(col) && (
        c.dbCols.some(dbCol => dbCol.toLowerCase() === col.toLowerCase()) || 
        c.key.toLowerCase() === col.toLowerCase()
      )
    );
    if (found && !visible.includes(found)) visible.push(found);
  });
  allCols.forEach(col => {
    if (S.visibleCols.has(col) && !visible.includes(col)) {
      visible.push(col);
    }
  });
  return visible.length > 0 ? visible : allCols;
}

function renderCellValue(r, colKey) {
  const cn = colKey.toLowerCase();
  if (cn === 'provider') {
    const val = r.provider || r.PROVIDER || '';
    return val ? `<span class="tag" style="font-weight:600">${esc(val)}</span>` : '—';
  }
  if (cn === 'date') {
    const val = r.date || r.DATE || '';
    return esc(val ? String(val).substring(0, 10) : '—');
  }
  if (cn === 'customer' || cn === 'customer name') {
    const val = r.customer || r.CUSTOMER || r['customer name'] || '';
    return val ? `<span class="tag" style="background:rgba(var(--arg),.1);color:var(--tx)">${esc(val)}</span>` : '—';
  }
  if (cn === 'request id' || cn === 'request_id') {
    return esc(r['Request ID'] ?? r['request_id'] ?? r.request_id ?? '—');
  }
  if (cn === 'quantity' || cn === 'qty') {
    const q = r.Quantity ?? r.qty ?? r.QUANTITY ?? r.Qty;
    return q !== null && q !== undefined ? `<b>${fmt(q)}</b>` : '—';
  }
  if (cn === 'plan' || cn.startsWith('plan')) {
    const p = r.plan ?? r.PLAN ?? '';
    const dur = r.MONTHS ?? r.Month ?? r.months ?? '';
    if (p && dur && !String(p).toLowerCase().includes(String(dur).toLowerCase())) {
      return `${esc(p)} <span class="tag" style="font-size:10px">${esc(dur)} mo</span>`;
    }
    return esc(p || dur || '—');
  }
  if (cn === 'profile') {
    return esc(r.PROFILE ?? r.profile ?? '—');
  }
  if (cn === 'product') {
    return esc(r.Product ?? r.product ?? '—');
  }
  if (cn === 'requested by' || cn === 'requested_by') {
    return esc(r['REQUESTED BY'] ?? r.requested_by ?? '—');
  }
  if (cn === 'raised by' || cn === 'raised_by') {
    return esc(r['RAISED BY'] ?? r.raised_by ?? '—');
  }

  const val = r[colKey];
  if (val === null || val === undefined || val === '') return '—';
  if (['amount', 'total', 'price', 'cost'].includes(cn)) {
    return '₹ 0';
  }
  return esc(val);
}

/* ---------- ACTIVE FILTER PILLS ---------- */
function renderFilterPills() {
  const pillsEl = $('#filterPills');
  if (!pillsEl) return;
  const pills = [];

  const pVal = S.filters.provider || S.prov;
  if (pVal && pVal.toLowerCase() !== 'all data' && pVal !== '') {
    pills.push(`
      <span class="filter-pill">
        <span>📶 Provider: <b>${esc(pVal)}</b></span>
        <button type="button" data-clear-pill="provider" title="Clear provider filter">✕</button>
      </span>
    `);
  }

  if (S.filters.customer) {
    pills.push(`
      <span class="filter-pill">
        <span>👤 Customer: <b>${esc(S.filters.customer)}</b></span>
        <button type="button" data-clear-pill="customer" title="Clear customer filter">✕</button>
      </span>
    `);
  }

  if (S.filters.date_from || S.filters.date_to) {
    const rangeText = (S.filters.date_from || '…') + ' to ' + (S.filters.date_to || '…');
    pills.push(`
      <span class="filter-pill">
        <span>📅 Date: <b>${esc(rangeText)}</b></span>
        <button type="button" data-clear-pill="date" title="Clear date filter">✕</button>
      </span>
    `);
  }

  for (const [k, v] of Object.entries(S.filters)) {
    if (!v || ['provider', 'customer', 'date_from', 'date_to'].includes(k)) continue;
    const label = getColLabel(k);
    pills.push(`
      <span class="filter-pill">
        <span>${esc(label)}: <b>${esc(v)}</b></span>
        <button type="button" data-clear-pill="${esc(k)}" title="Clear ${esc(label)} filter">✕</button>
      </span>
    `);
  }

  pillsEl.innerHTML = pills.join('');
}

if ($('#filterPills')) {
  $('#filterPills').onclick = e => {
    const btn = e.target.closest('[data-clear-pill]');
    if (!btn) return;
    const key = btn.dataset.clearPill;
    if (key === 'provider') {
      delete S.filters.provider;
      S.prov = '';
      renderChips();
    } else if (key === 'date') {
      delete S.filters.date_from;
      delete S.filters.date_to;
    } else {
      delete S.filters[key];
    }
    S.off = 0;
    renderFilterPills();
    renderHead();
    load();
  };
}

/* ---------- QUERY PARAMETERS ---------- */
function params(paging = true) {
  const p = { sort: S.sort, desc: S.desc };

  const provVal = S.filters.provider || S.prov;
  if (provVal && provVal.trim().toLowerCase() !== 'all data' && provVal.trim() !== '') {
    p.provider = provVal.trim();
  }

  if (S.filters.customer) {
    p.customer = S.filters.customer.trim();
  }

  if (S.filters.date_from || S.filters.date_to) {
    p.date_col = (S.dcol ? S.dcol.name : 'date');
    if (S.filters.date_from) p.date_from = S.filters.date_from;
    if (S.filters.date_to) p.date_to = S.filters.date_to;
  }

  const reqBy = S.filters['REQUESTED BY'] || S.filters.requested_by;
  if (reqBy) p.requested_by = reqBy.trim();

  const raisedBy = S.filters['RAISED BY'] || S.filters.raised_by;
  if (raisedBy) p.raised_by = raisedBy.trim();

  for (const [k, v] of Object.entries(S.filters)) {
    if (v === '' || v === undefined || v === null) continue;
    const lk = k.toLowerCase();
    if (['provider', 'customer', 'date_from', 'date_to', 'requested by', 'requested_by', 'raised by', 'raised_by'].includes(lk)) continue;
    p['cf_' + k] = String(v).trim();
  }

  const limit = S.pageSize || PAGE;
  if (paging) {
    p.limit = limit;
    p.offset = S.off;
  }

  return new URLSearchParams(Object.entries(p).filter(([, v]) => v !== '' && v !== undefined)).toString();
}

/* ---------- TABLE HEADER & BODY RENDERING ---------- */
function renderHead() {
  const cols = getColsToRender();
  const html = cols.map(c => {
    const label = getColLabel(c);
    const filtered = isColFiltered(c);
    const sorted = S.sort && S.sort.toLowerCase() === c.toLowerCase();
    const sortIcon = sorted ? (S.desc ? ' ↓' : ' ↑') : '';
    const num = isNumericCol(c);

    return `
      <th class="excel-th ${filtered ? 'col-filtered' : ''} ${sorted ? 'sorted' : ''} ${num ? 'num' : ''}" data-k="${esc(c)}">
        <div class="excel-th-wrap">
          <span class="excel-th-text" data-sort-col="${esc(c)}" title="Click to sort by ${esc(label)}">${esc(label)}</span>
          <span class="excel-th-sort" data-sort-col="${esc(c)}">${sortIcon}</span>
          <button type="button" class="excel-filter-btn ${filtered ? 'active' : ''}" data-filter-col="${esc(c)}" title="Filter column ${esc(label)}" aria-label="Filter ${esc(label)}">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor">
              <path d="M1.5 2h13l-5.2 6.2v4.8l-2.6 1.5v-6.3L1.5 2z"/>
            </svg>
          </button>
        </div>
      </th>
    `;
  }).join('');

  const actTh = `<th class="excel-th" style="width:48px;text-align:center" title="Actions"></th>`;
  $('#head').innerHTML = `<tr>${html}${actTh}</tr>`;
}

function renderBody(d) {
  const cols = getColsToRender();
  if (!d.rows || d.rows.length === 0) {
    $('#body').innerHTML = `<tr><td colspan="${cols.length + 1}" style="text-align:center;padding:36px;color:var(--mut)">No records match the current filters.</td></tr>`;
    return;
  }
  const html = d.rows.map(r => {
    const rowId = r.id ?? r._row_id ?? r.ID ?? '';
    const cells = cols.map(c => {
      const num = isNumericCol(c);
      return `<td class="${num ? 'num' : ''}" data-col-key="${esc(c.toLowerCase())}">${renderCellValue(r, c)}</td>`;
    }).join('');
    const actTd = `
      <td class="tbl-action-cell" style="text-align:center">
        <button type="button" class="tbl-del-btn" data-del-id="${esc(rowId)}" title="Delete record #${esc(rowId)}" aria-label="Delete record #${esc(rowId)}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </td>
    `;
    return `<tr data-row-id="${esc(rowId)}">${cells}${actTd}</tr>`;
  }).join('');
  $('#body').innerHTML = html;
}

function renderStats(d) {
  const statsEl = $('#stats');
  if (!statsEl) return;

  let totalQty = 0;
  (d.sums || []).forEach(s => {
    const col = (s.column || '').toLowerCase();
    const val = Number(s.sum || 0);
    if (col === 'qty' || col === 'quantity') {
      totalQty += val;
    }
  });

  const cards = [];
  const todayStr = new Date().toLocaleDateString('en-IN', {day: 'numeric', month: 'short', year: 'numeric'});

  // 1. Total Records Count (Live count updated from today)
  const countLabel = S.prov ? `Filtered Records (${S.prov})` : 'Total Records (Count)';
  cards.push(`
    <div class="card stat tilt" data-tilt="10" style="border-top:3px solid var(--a)">
      <b>${fmt(d.total)}</b>
      <span>📊 ${esc(countLabel)}</span>
      <small style="display:block;font-size:11px;color:var(--mut);margin-top:4px">🟢 Count updated from today (${todayStr})</small>
    </div>
  `);

  // 2. Today's Activations Count
  const todayCount = d.today_count ?? 0;
  cards.push(`
    <div class="card stat tilt" data-tilt="10" style="border-top:3px solid #f59e0b">
      <b style="color:#d97706">${fmt(todayCount)}</b>
      <span>📅 Today's Activations</span>
      <small style="display:block;font-size:11px;color:var(--mut);margin-top:4px">New entries added today</small>
    </div>
  `);

  // 3. Total Amount: STRICTLY 0 as requested by user ("the amount should be 0 Total Amount should be 0")
  cards.push(`
    <div class="card stat tilt" data-tilt="10" style="border-top:3px solid #10b981">
      <b style="color:#059669">₹ 0</b>
      <span>💰 Total Amount</span>
      <small style="display:block;font-size:11px;color:var(--mut);margin-top:4px">Fixed at 0 per configuration</small>
    </div>
  `);

  // 4. Total Quantity
  cards.push(`
    <div class="card stat tilt" data-tilt="10" style="border-top:3px solid #6366f1">
      <b style="color:#4f46e5">${fmt(totalQty)}</b>
      <span>📶 Total Quantity</span>
      <small style="display:block;font-size:11px;color:var(--mut);margin-top:4px">Active SIM cards</small>
    </div>
  `);

  statsEl.innerHTML = cards.join('');
  statsEl.style.gridTemplateColumns = `repeat(4, 1fr)`;
}

/* ---------- INTERACTIVE PIE CHARTS (ACTIVATION % PER MONTH & PROFILE RATIO) ---------- */
const PIE_COLORS = [
  '#4f46e5', '#0284c7', '#10b981', '#f59e0b', '#ec4899',
  '#8b5cf6', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#e11d48', '#3b82f6', '#a855f7'
];

/* ---------- RESET PIE CHARTS TO DEFAULT REPRESENTATION ---------- */
function goDefaultMonth() {
  delete S.filters.date_from;
  delete S.filters.date_to;
  S.off = 0;
  renderFilterPills();
  renderHead();
  load();
  toast('Returned monthly chart to default representation as at login ✔');
}

function goDefaultProfile() {
  delete S.filters.PROFILE;
  delete S.filters.profile;
  S.off = 0;
  renderFilterPills();
  renderHead();
  load();
  toast('Returned profile chart to default representation as at login ✔');
}

function goDefaultAllCharts() {
  delete S.filters.date_from;
  delete S.filters.date_to;
  delete S.filters.PROFILE;
  delete S.filters.profile;
  S.off = 0;
  renderFilterPills();
  renderHead();
  load();
  toast('Returned all charts to default representation as at login ✔');
}

function drawDonutChart(svgEl, data, centerLabelEl, centerSubEl, totalCenterText, centerSubText, activeKey, onSelect) {
  if (!svgEl) return;
  const total = data.reduce((acc, d) => acc + (d.count || 0), 0);
  if (!total || data.length === 0) {
    svgEl.innerHTML = `<circle cx="100" cy="100" r="62" fill="none" stroke="var(--line)" stroke-width="26"/>`;
    if (centerLabelEl) centerLabelEl.textContent = '0';
    if (centerSubEl) centerSubEl.textContent = 'None';
    return;
  }

  const cx = 100, cy = 100, r = 74, innerR = 48;
  const rad = Math.PI / 180;
  let curAngle = -90;
  let paths = [];

  data.forEach((item, idx) => {
    const sliceAngle = (item.count / total) * 360;
    const startAngle = curAngle;
    const endAngle = curAngle + sliceAngle;
    curAngle = endAngle;

    const color = item.color || PIE_COLORS[idx % PIE_COLORS.length];
    const itemKey = String(item.key || item.ym || item.label || item.type || '');
    const isSelected = !!(activeKey && (
      itemKey.toLowerCase() === String(activeKey).toLowerCase() ||
      (item.label && item.label.toLowerCase() === String(activeKey).toLowerCase()) ||
      (item.type && item.type.toLowerCase() === String(activeKey).toLowerCase()) ||
      (item.ym && item.ym === String(activeKey))
    ));
    const titleText = `${item.label || item.type}: ${fmt(item.count)} (${item.pct}%)${isSelected ? ' [Active Filter - Click to Go Default]' : ' (Click to filter)'}`;

    if (sliceAngle >= 359.9) {
      paths.push(`
        <circle cx="${cx}" cy="${cy}" r="${(r + innerR) / 2}" fill="none" stroke="${color}" stroke-width="${r - innerR}" class="pie-slice ${isSelected ? 'selected-slice' : ''}" data-pie-key="${esc(itemKey)}">
          <title>${esc(titleText)}</title>
        </circle>
      `);
      return;
    }

    const x1 = cx + r * Math.cos(startAngle * rad);
    const y1 = cy + r * Math.sin(startAngle * rad);
    const x2 = cx + r * Math.cos(endAngle * rad);
    const y2 = cy + r * Math.sin(endAngle * rad);

    const x3 = cx + innerR * Math.cos(endAngle * rad);
    const y3 = cy + innerR * Math.sin(endAngle * rad);
    const x4 = cx + innerR * Math.cos(startAngle * rad);
    const y4 = cy + innerR * Math.sin(startAngle * rad);

    const largeArc = sliceAngle > 180 ? 1 : 0;
    const pathD = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerR} ${innerR} 0 ${largeArc} 0 ${x4} ${y4} Z`;

    paths.push(`
      <path d="${pathD}" fill="${color}" stroke="var(--card)" stroke-width="2" class="pie-slice ${isSelected ? 'selected-slice' : ''}" data-pie-key="${esc(itemKey)}">
        <title>${esc(titleText)}</title>
      </path>
    `);
  });

  svgEl.innerHTML = paths.join('');
  if (centerLabelEl) centerLabelEl.textContent = totalCenterText || fmt(total);
  if (centerSubEl) centerSubEl.textContent = centerSubText || 'Total';

  if (onSelect) {
    svgEl.onclick = e => {
      const el = e.target.closest('[data-pie-key]');
      if (!el) return;
      onSelect(el.dataset.pieKey);
    };
  }

  const centerWrap = centerLabelEl ? centerLabelEl.closest('.pie-center-label') : null;
  if (centerWrap) {
    if (activeKey) {
      centerWrap.classList.add('clickable');
      centerWrap.title = 'Active filter: click to go default';
      centerWrap.onclick = () => {
        if (onSelect) onSelect(activeKey);
      };
    } else {
      centerWrap.classList.remove('clickable');
      centerWrap.title = '';
      centerWrap.onclick = null;
    }
  }
}

function renderPieLegend(legendEl, data, onSelect, activeKey) {
  if (!legendEl) return;
  if (!data || !data.length) {
    legendEl.innerHTML = '<div style="font-size:12px;color:var(--mut);padding:8px">No data available</div>';
    return;
  }

  legendEl.innerHTML = data.map((item, idx) => {
    const color = item.color || PIE_COLORS[idx % PIE_COLORS.length];
    const label = item.label || item.type;
    const itemKey = String(item.key || item.ym || label);
    const isSelected = !!(activeKey && (
      itemKey.toLowerCase() === String(activeKey).toLowerCase() ||
      label.toLowerCase() === String(activeKey).toLowerCase() ||
      (item.type && item.type.toLowerCase() === String(activeKey).toLowerCase()) ||
      (item.ym && item.ym === String(activeKey))
    ));

    return `
      <div class="pie-leg-item ${isSelected ? 'active-pie-item' : ''}" data-pie-key="${esc(itemKey)}" title="${isSelected ? 'Active filter: click to go default' : 'Click to filter by ' + esc(label)}">
        <div class="pie-leg-left">
          <span class="pie-dot" style="background:${color}"></span>
          <span class="pie-leg-title">${esc(label)}</span>
        </div>
        <div class="pie-leg-right">
          <span class="pie-leg-pct">${item.pct}%</span>
          <span class="pie-leg-cnt">${fmt(item.count)}</span>
        </div>
      </div>
    `;
  }).join('');

  if (onSelect) {
    legendEl.onclick = e => {
      const item = e.target.closest('[data-pie-key]');
      if (!item) return;
      onSelect(item.dataset.pieKey);
    };
  }
}

async function loadAnalytics() {
  try {
    // Baseline distribution without date & profile filters to preserve full login representation
    const bp = {};
    const provVal = S.filters.provider || S.prov;
    if (provVal && provVal.trim().toLowerCase() !== 'all data' && provVal.trim() !== '') {
      bp.provider = provVal.trim();
    }
    if (S.filters.customer) {
      bp.customer = S.filters.customer.trim();
    }
    const baseQuery = new URLSearchParams(bp).toString();
    const d = await api(`${rowsUrl(S.cur)}/analytics?${baseQuery}`).catch(() => null);
    if (!d) return;

    // Detect active month filter
    let activeMonthKey = '';
    let activeMonthLabel = '';
    if (S.filters.date_from && S.filters.date_to) {
      const fromYm = S.filters.date_from.slice(0, 7);
      const toYm = S.filters.date_to.slice(0, 7);
      if (fromYm === toYm) {
        activeMonthKey = fromYm;
      }
    }

    // Detect active profile filter
    const rawProfile = S.filters.PROFILE || S.filters.profile || '';
    let activeProfileKey = '';
    if (rawProfile) {
      if (rawProfile.toLowerCase().includes('single')) activeProfileKey = 'Single Profile';
      else if (rawProfile.toLowerCase().includes('dual')) activeProfileKey = 'Dual Profile';
      else activeProfileKey = rawProfile;
    }

    // 1. Activation Percentage per Month Pie Chart
    const monthlyData = (d.monthly || []).map((m, idx) => ({
      ...m,
      key: m.ym || m.key,
      color: PIE_COLORS[idx % PIE_COLORS.length]
    }));
    const totalMonthActivations = monthlyData.reduce((acc, m) => acc + m.count, 0);

    const monthBadge = $('#monthChartBadge');
    const monthDefaultBtn = $('#goDefaultMonthBtn');
    let monthCenterNumber = fmt(totalMonthActivations);
    let monthCenterSub = 'Activated';

    if (activeMonthKey) {
      const matched = monthlyData.find(m => m.key === activeMonthKey || m.ym === activeMonthKey);
      activeMonthLabel = matched ? (matched.label || activeMonthKey) : activeMonthKey;
      if (monthBadge) {
        monthBadge.textContent = 'Filtered: ' + activeMonthLabel;
        monthBadge.className = 'tag active-pill';
      }
      if (monthDefaultBtn) monthDefaultBtn.classList.remove('hide');
      if (matched) {
        monthCenterNumber = fmt(matched.count);
        monthCenterSub = `${activeMonthLabel} · ↩ Default`;
      }
    } else {
      if (monthBadge) {
        monthBadge.textContent = 'Monthly Share';
        monthBadge.className = 'tag';
      }
      if (monthDefaultBtn) monthDefaultBtn.classList.add('hide');
    }

    const onMonthSelect = monthKey => {
      if (activeMonthKey && (monthKey === activeMonthKey || activeMonthKey.includes(monthKey))) {
        // Toggle back to default
        goDefaultMonth();
        return;
      }
      if (monthKey && monthKey.includes('-')) {
        const [y, m] = monthKey.split('-');
        const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
        S.filters.date_from = `${monthKey}-01`;
        S.filters.date_to = `${monthKey}-${String(lastDay).padStart(2, '0')}`;
        S.off = 0;
        renderFilterPills();
        renderHead();
        load();
        toast(`Filtered to ${monthKey}. Click '↩ Go Default' anytime to restore default view.`);
      }
    };

    drawDonutChart(
      $('#monthPieSvg'),
      monthlyData,
      $('#monthPieTotal'),
      $('#monthPieCenter span'),
      monthCenterNumber,
      monthCenterSub,
      activeMonthKey,
      onMonthSelect
    );
    renderPieLegend($('#monthPieLegend'), monthlyData, onMonthSelect, activeMonthKey);

    // 2. Single vs Dual Profile Pie Chart
    const profiles = (d.profiles || []).map(p => ({
      ...p,
      key: p.type
    }));
    const singleProfile = profiles.find(p => p.type.toLowerCase().includes('single'));
    const dualProfile = profiles.find(p => p.type.toLowerCase().includes('dual'));
    const identifiedTotal = (singleProfile ? singleProfile.count : 0) + (dualProfile ? dualProfile.count : 0);
    let singleRatioText = '0%';
    if (identifiedTotal > 0 && singleProfile) {
      singleRatioText = `${Math.round(singleProfile.count / identifiedTotal * 100)}%`;
    }

    const profBadge = $('#profileChartBadge');
    const profDefaultBtn = $('#goDefaultProfileBtn');
    let profCenterNumber = singleRatioText;
    let profCenterSub = 'Single Share';

    if (activeProfileKey) {
      if (profBadge) {
        profBadge.textContent = 'Filtered: ' + activeProfileKey;
        profBadge.className = 'tag active-pill';
      }
      if (profDefaultBtn) profDefaultBtn.classList.remove('hide');

      const isSingle = activeProfileKey.toLowerCase().includes('single');
      const matchedP = isSingle ? singleProfile : dualProfile;
      if (matchedP) {
        profCenterNumber = fmt(matchedP.count);
        profCenterSub = `${isSingle ? 'Single' : 'Dual'} · ↩ Default`;
      }
    } else {
      if (profBadge) {
        profBadge.textContent = 'Profile Types';
        profBadge.className = 'tag';
      }
      if (profDefaultBtn) profDefaultBtn.classList.add('hide');
    }

    const onProfileSelect = profileType => {
      const isSingle = (profileType || '').toLowerCase().includes('single');
      const isDual = (profileType || '').toLowerCase().includes('dual');
      const targetVal = isSingle ? 'Single Profile' : isDual ? 'Dual Profile' : profileType;

      if (activeProfileKey && activeProfileKey.toLowerCase() === targetVal.toLowerCase()) {
        // Toggle back to default
        goDefaultProfile();
        return;
      }
      S.filters.PROFILE = targetVal;
      S.off = 0;
      renderFilterPills();
      renderHead();
      load();
      toast(`Filtered to ${targetVal}. Click '↩ Go Default' anytime to restore default view.`);
    };

    drawDonutChart(
      $('#profilePieSvg'),
      profiles,
      $('#profilePieRatio'),
      $('#profilePieCenter span'),
      profCenterNumber,
      profCenterSub,
      activeProfileKey,
      onProfileSelect
    );
    renderPieLegend($('#profilePieLegend'), profiles, onProfileSelect, activeProfileKey);

    // 3. Overall "Go Default" button in section header
    const allDefaultBtn = $('#goDefaultAllBtn');
    if (allDefaultBtn) {
      allDefaultBtn.classList.toggle('hide', !activeMonthKey && !activeProfileKey);
    }
  } catch (e) {
    console.warn('Analytics error:', e);
  }
}

function initChartsToggle() {
  const btn = $('#toggleChartsBtn');
  const grid = $('#chartsGrid');
  const text = $('#toggleChartsText');
  if (btn && grid && text) {
    btn.onclick = () => {
      const isHidden = grid.classList.toggle('hide');
      text.textContent = isHidden ? 'Show Charts ▼' : 'Hide Charts ▲';
    };
  }

  const defMonthBtn = $('#goDefaultMonthBtn');
  if (defMonthBtn) defMonthBtn.onclick = goDefaultMonth;

  const defProfBtn = $('#goDefaultProfileBtn');
  if (defProfBtn) defProfBtn.onclick = goDefaultProfile;

  const defAllBtn = $('#goDefaultAllBtn');
  if (defAllBtn) defAllBtn.onclick = goDefaultAllCharts;
}
initChartsToggle();

function renderCurrentTable() {
  if (!S.lastData) return;
  renderHead();
  renderBody(S.lastData);
  updateColBadge();
}

/* ---------- MICROSOFT EXCEL FILTER POPOVER ---------- */
let activeFilterCol = null;

async function openExcelFilter(colKey, btnEl) {
  const menu = $('#excelFilterMenu');
  if (!menu) return;

  if (activeFilterCol === colKey && !menu.classList.contains('hide')) {
    menu.classList.add('hide');
    activeFilterCol = null;
    return;
  }

  activeFilterCol = colKey;
  const colLabel = getColLabel(colKey);
  const isDate = colKey.toLowerCase() === 'date' || (S.dcol && S.dcol.name.toLowerCase() === colKey.toLowerCase());
  const isProv = colKey.toLowerCase() === 'provider';
  const isNum = isNumericCol(colKey);

  const rect = btnEl.getBoundingClientRect();
  menu.classList.remove('hide');

  const menuWidth = Math.min(320, window.innerWidth - 20);
  let left = rect.right - menuWidth;
  if (left < 10) left = 10;
  if (left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;
  let top = rect.bottom + 6;
  if (top + 340 > window.innerHeight) {
    top = Math.max(10, rect.top - 340);
  }
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';

  let contentHtml = `
    <div class="excel-fm-head">
      <strong>Filter: ${esc(colLabel)}</strong>
      <button type="button" class="btn ghost sm" id="efCloseBtn" style="padding:2px 8px">✕</button>
    </div>

    <!-- Excel Sort Options -->
    <div class="excel-fm-sort">
      <button type="button" id="efSortAsc">
        <span>${isDate ? '📅 Sort Oldest to Newest' : isNum ? '🔢 Sort Smallest to Largest' : '🔤 Sort A to Z'}</span>
      </button>
      <button type="button" id="efSortDesc">
        <span>${isDate ? '📅 Sort Newest to Oldest' : isNum ? '🔢 Sort Largest to Smallest' : '🔤 Sort Z to A'}</span>
      </button>
    </div>

    <div class="excel-fm-divider"></div>
  `;

  if (isDate) {
    const curFrom = S.filters.date_from || '';
    const curTo = S.filters.date_to || '';
    contentHtml += `
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
        <label style="font-size:12px;margin:0">From date:
          <input type="date" id="efDateFrom" value="${esc(curFrom)}" style="width:100%;margin-top:2px">
        </label>
        <label style="font-size:12px;margin:0">To date:
          <input type="date" id="efDateTo" value="${esc(curTo)}" style="width:100%;margin-top:2px">
        </label>
      </div>
    `;
  } else if (isProv) {
    const curProv = S.filters.provider || S.prov || '';
    const provs = provNames();
    contentHtml += `
      <div class="excel-fm-list" style="max-height:160px">
        <label class="excel-fm-item">
          <input type="radio" name="efProvRadio" value="" ${!curProv ? 'checked' : ''}>
          <span>🌐 All Data</span>
        </label>
        ${provs.length ? provs.map(p => `
          <label class="excel-fm-item">
            <input type="radio" name="efProvRadio" value="${esc(p)}" ${curProv.toLowerCase() === p.toLowerCase() ? 'checked' : ''}>
            <span>${esc(p)}</span>
          </label>
        `).join('') : '<div style="font-size:11px;color:var(--mut);padding:8px">No SIM providers found</div>'}
      </div>
    `;
  } else {
    let curVal = '';
    if (colKey.toLowerCase() === 'customer' || colKey.toLowerCase() === 'customer name') curVal = S.filters.customer || '';
    else if (colKey.toLowerCase() === 'requested by' || colKey.toLowerCase() === 'requested_by') curVal = S.filters['REQUESTED BY'] || '';
    else if (colKey.toLowerCase() === 'raised by' || colKey.toLowerCase() === 'raised_by') curVal = S.filters['RAISED BY'] || '';
    else curVal = S.filters[colKey] || '';

    contentHtml += `
      <div class="excel-fm-search">
        <input type="text" id="efSearchInput" placeholder="Filter by ${esc(colLabel)}…" value="${esc(curVal)}">
      </div>
      <div class="excel-fm-list" id="efValuesList">
        <div style="font-size:11px;color:var(--mut);padding:8px">Loading distinct values…</div>
      </div>
    `;
  }

  contentHtml += `
    <div class="excel-fm-actions">
      <button type="button" class="btn ghost sm" id="efClearBtn">Clear Filter</button>
      <button type="button" class="btn sm" id="efApplyBtn" style="background:var(--a);color:var(--on)">Apply</button>
    </div>
  `;

  menu.innerHTML = contentHtml;

  $('#efCloseBtn').onclick = () => {
    menu.classList.add('hide');
    activeFilterCol = null;
  };

  $('#efSortAsc').onclick = () => {
    S.sort = colKey;
    S.desc = false;
    S.off = 0;
    menu.classList.add('hide');
    activeFilterCol = null;
    load();
  };
  $('#efSortDesc').onclick = () => {
    S.sort = colKey;
    S.desc = true;
    S.off = 0;
    menu.classList.add('hide');
    activeFilterCol = null;
    load();
  };

  $('#efClearBtn').onclick = () => {
    if (isDate) {
      delete S.filters.date_from;
      delete S.filters.date_to;
    } else if (isProv) {
      delete S.filters.provider;
      S.prov = '';
      renderChips();
    } else if (colKey.toLowerCase() === 'customer' || colKey.toLowerCase() === 'customer name') {
      delete S.filters.customer;
    } else if (colKey.toLowerCase() === 'requested by' || colKey.toLowerCase() === 'requested_by') {
      delete S.filters['REQUESTED BY'];
      delete S.filters.requested_by;
    } else if (colKey.toLowerCase() === 'raised by' || colKey.toLowerCase() === 'raised_by') {
      delete S.filters['RAISED BY'];
      delete S.filters.raised_by;
    } else {
      delete S.filters[colKey];
    }
    menu.classList.add('hide');
    activeFilterCol = null;
    S.off = 0;
    renderFilterPills();
    renderHead();
    load();
  };

  $('#efApplyBtn').onclick = () => {
    if (isDate) {
      const fromVal = $('#efDateFrom').value;
      const toVal = $('#efDateTo').value;
      if (fromVal) S.filters.date_from = fromVal; else delete S.filters.date_from;
      if (toVal) S.filters.date_to = toVal; else delete S.filters.date_to;
    } else if (isProv) {
      const selRadio = menu.querySelector('input[name="efProvRadio"]:checked');
      const provVal = selRadio ? selRadio.value : '';
      if (provVal) {
        S.filters.provider = provVal;
        S.prov = provVal;
      } else {
        delete S.filters.provider;
        S.prov = '';
      }
      renderChips();
    } else {
      const checkedBoxes = [...menu.querySelectorAll('.ef-val-check:checked')];
      const allBoxes = [...menu.querySelectorAll('.ef-val-check')];
      const searchVal = $('#efSearchInput') ? $('#efSearchInput').value.trim() : '';

      let finalVal = '';
      if (checkedBoxes.length > 0 && checkedBoxes.length < allBoxes.length) {
        finalVal = checkedBoxes.map(cb => cb.value).join(',');
      } else if (searchVal) {
        finalVal = searchVal;
      }

      const cn = colKey.toLowerCase();
      if (cn === 'customer' || cn === 'customer name') {
        if (finalVal) S.filters.customer = finalVal; else delete S.filters.customer;
      } else if (cn === 'requested by' || cn === 'requested_by') {
        if (finalVal) S.filters['REQUESTED BY'] = finalVal; else delete S.filters['REQUESTED BY'];
      } else if (cn === 'raised by' || cn === 'raised_by') {
        if (finalVal) S.filters['RAISED BY'] = finalVal; else delete S.filters['RAISED BY'];
      } else {
        if (finalVal) S.filters[colKey] = finalVal; else delete S.filters[colKey];
      }
    }

    menu.classList.add('hide');
    activeFilterCol = null;
    S.off = 0;
    renderFilterPills();
    renderHead();
    load();
  };

  if (!isDate && !isProv) {
    const listEl = $('#efValuesList');
    const searchInput = $('#efSearchInput');

    try {
      const realCol = S.cols.find(c => c.name.toLowerCase() === colKey.toLowerCase())?.name || colKey;
      const resp = await api(`${rowsUrl(S.cur)}/values?column=${enc(realCol)}`).catch(() => ({values: []}));
      const distinctVals = resp.values || [];

      function renderDistinctList(filterTerm = '') {
        const filteredVals = distinctVals.filter(v => 
          !filterTerm || String(v).toLowerCase().includes(filterTerm.toLowerCase())
        );
        if (!filteredVals.length) {
          listEl.innerHTML = '<div style="font-size:11px;color:var(--mut);padding:8px">No matching values found</div>';
          return;
        }
        let listHtml = `
          <label class="excel-fm-item" style="font-weight:600;border-bottom:1px solid var(--line);margin-bottom:4px">
            <input type="checkbox" id="efSelectAllVals" checked>
            <span>(Select All)</span>
          </label>
        `;
        listHtml += filteredVals.slice(0, 100).map(v => `
          <label class="excel-fm-item">
            <input type="checkbox" class="ef-val-check" value="${esc(v)}" checked>
            <span title="${esc(v)}">${esc(v)}</span>
          </label>
        `).join('');
        listEl.innerHTML = listHtml;

        const selectAllCb = $('#efSelectAllVals');
        if (selectAllCb) {
          selectAllCb.onchange = () => {
            menu.querySelectorAll('.ef-val-check').forEach(cb => cb.checked = selectAllCb.checked);
          };
        }
      }

      renderDistinctList(searchInput ? searchInput.value.trim() : '');

      if (searchInput) {
        searchInput.oninput = () => renderDistinctList(searchInput.value.trim());
        searchInput.onkeydown = e => {
          if (e.key === 'Enter') {
            $('#efApplyBtn').click();
          }
        };
      }
    } catch (e) {
      if (listEl) listEl.innerHTML = '<div style="font-size:11px;color:var(--mut);padding:8px">Type filter above and click Apply</div>';
    }
  }
}

document.addEventListener('click', e => {
  const menu = $('#excelFilterMenu');
  if (menu && !menu.classList.contains('hide')) {
    if (!e.target.closest('#excelFilterMenu') && !e.target.closest('.excel-filter-btn')) {
      menu.classList.add('hide');
      activeFilterCol = null;
    }
  }
});

/* ---------- LOAD DATA ---------- */
async function load() {
  const my = S.reqId = (S.reqId || 0) + 1;
  $('#body').style.opacity = .45;
  try {
    const d = await api(`${rowsUrl(S.cur)}/rows?${params()}`);
    if (my != S.reqId) return;
    S.lastData = d;
    S.total = d.total;
    if (d.columns && d.columns.length && (!S.allColNames || !S.allColNames.length)) {
      S.allColNames = d.columns;
      if (!S.visibleCols) S.visibleCols = new Set(getDefaultCoreCols());
      renderColPickerUI();
    }

    renderStats(d);
    renderHead();
    renderBody(d);
    renderFilterPills();
    loadAnalytics();

    const limit = S.pageSize || PAGE;
    $('#info').textContent = d.total ? `Showing ${S.off + 1}–${Math.min(S.off + limit, d.total)} of ${fmt(d.total)}` : '';
    $('#prev').disabled = S.off == 0;
    $('#next').disabled = S.off + limit >= d.total;
  } catch (e) { fail(e) }
  $('#body').style.opacity = 1;
}

$('#head').onclick = e => {
  const filterBtn = e.target.closest('.excel-filter-btn');
  if (filterBtn) {
    e.stopPropagation();
    const colKey = filterBtn.dataset.filterCol;
    openExcelFilter(colKey, filterBtn);
    return;
  }

  const sortEl = e.target.closest('[data-sort-col]');
  if (sortEl) {
    const k = sortEl.dataset.sortCol;
    if (!k) return;
    S.desc = k === S.sort ? !S.desc : true;
    S.sort = k;
    S.off = 0;
    load();
    return;
  }
};

$('#body').onclick = e => {
  // 1. Delete single entry clicked
  const delBtn = e.target.closest('.tbl-del-btn');
  if (delBtn) {
    e.stopPropagation();
    const rowId = delBtn.dataset.delId;
    const tr = delBtn.closest('tr');
    openDeleteModal(rowId, tr);
    return;
  }

  // 2. Tag filter clicked
  const tag = e.target.closest('.tag');
  if (!tag) return;
  const tr = tag.closest('tr'), td = tag.closest('td');
  if (!td || !tr) return;
  const colKey = (td.dataset.colKey || '').toLowerCase();
  const val = tag.textContent.trim();
  if (colKey === 'provider') {
    S.prov = val;
    S.filters.provider = val;
    renderChips();
    renderFilterPills();
    S.off = 0;
    load();
  } else if (colKey === 'customer' || colKey === 'customer name') {
    S.filters.customer = val;
    renderFilterPills();
    S.off = 0;
    load();
  }
};

$('#prev').onclick = () => { const limit = S.pageSize || PAGE; S.off = Math.max(0, S.off - limit); load(); };
$('#next').onclick = () => { const limit = S.pageSize || PAGE; S.off += limit; load(); };

$('#reset').onclick = () => {
  S.filters = {};
  S.prov = '';
  S.cust = '';
  S.sort = '';
  S.desc = true;
  S.off = 0;
  const menu = $('#excelFilterMenu');
  if (menu) menu.classList.add('hide');
  activeFilterCol = null;
  renderChips();
  renderFilterPills();
  renderHead();
  load();
};

$('#dl').onclick = async () => {
  const btn = $('#dl');
  btn.disabled = true;
  const origText = btn.innerHTML;
  btn.innerHTML = '<span>⏳ Preparing Excel…</span>';
  try {
    const token = getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const r = await fetch(apiUrl(`${rowsUrl(S.cur)}/export?${params(false)}`), {credentials: 'include', headers});
    if (r.status == 401) { setToken(''); showLogin('Your session ended. Please sign in again.'); return; }
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw Error(typeof d.detail == 'string' ? d.detail : 'Download failed'); }
    const blob = await r.blob(), a = document.createElement('a'), m = /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : (S.cur + '.xlsx');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('Excel spreadsheet downloaded ✔');
  } catch (e) {
    fail(e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = origText;
  }
};

/* ---------- ONE-TIME DELETE ALL DATA ---------- */
async function checkDeleteAllStatus(tableName) {
  const btn = $('#deleteAllBtn');
  if (!btn) return;
  const targetTable = (!tableName || tableName === ALL) ? 'customer_data' : tableName;

  if (localStorage.getItem('delete_all_used_' + targetTable) === 'true') {
    btn.disabled = true;
    btn.classList.add('disabled');
    btn.title = 'Delete All has already been executed for this table and is permanently locked.';
    btn.innerHTML = '<span>🔒 Delete All (Used)</span>';
    return;
  }

  try {
    const res = await api(`/api/tables/${enc(targetTable)}/delete-all-status`);
    if (res && res.used) {
      localStorage.setItem('delete_all_used_' + targetTable, 'true');
      btn.disabled = true;
      btn.classList.add('disabled');
      btn.title = 'Delete All has already been executed for this table and is permanently locked.';
      btn.innerHTML = '<span>🔒 Delete All (Used)</span>';
    } else {
      btn.disabled = false;
      btn.classList.remove('disabled');
      btn.title = 'Permanently delete all records in this table (Can only be executed once)';
      btn.innerHTML = '<span>🗑️ Delete All</span>';
    }
  } catch (e) {
    // Keep quiet on auth error or network glitch
  }
}

function initDeleteAll() {
  const btn = $('#deleteAllBtn');
  const modal = $('#deleteAllModal');
  const cancelBtn = $('#delAllCancelBtn');
  const confirmBtn = $('#delAllConfirmBtn');
  const confirmInput = $('#delAllConfirmInput');
  if (!btn || !modal) return;

  btn.onclick = () => {
    const targetTable = (!S.cur || S.cur === ALL) ? 'customer_data' : S.cur;
    if (localStorage.getItem('delete_all_used_' + targetTable) === 'true' || btn.disabled) {
      toast('Delete All has already been executed once and is permanently locked.', 1);
      return;
    }

    if (confirmInput) confirmInput.value = '';
    if (confirmBtn) confirmBtn.disabled = true;

    try {
      modal.showModal();
    } catch (e) {
      modal.setAttribute('open', '');
    }
    if (confirmInput) confirmInput.focus();
  };

  if (confirmInput && confirmBtn) {
    confirmInput.oninput = () => {
      confirmBtn.disabled = confirmInput.value.trim().toUpperCase() !== 'DELETE';
    };
    confirmInput.onkeydown = e => {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        confirmBtn.click();
      }
    };
  }

  if (cancelBtn) {
    cancelBtn.onclick = () => {
      try { modal.close(); } catch (e) { modal.removeAttribute('open'); }
    };
  }

  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const targetTable = (!S.cur || S.cur === ALL) ? 'customer_data' : S.cur;
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<span>⏳ Deleting…</span>';

      try {
        const res = await post(`/api/tables/${enc(targetTable)}/delete-all`, {});
        localStorage.setItem('delete_all_used_' + targetTable, 'true');

        btn.disabled = true;
        btn.classList.add('disabled');
        btn.innerHTML = '<span>🔒 Delete All (Used)</span>';
        btn.title = 'Delete All has already been executed for this table and is permanently locked.';

        try { modal.close(); } catch (e) { modal.removeAttribute('open'); }
        toast((res && res.message) || 'All records and SIM providers successfully deleted.');

        S.off = 0;
        S.prov = '';
        delete S.filters.provider;
        await Promise.all([load(), refreshCounts(), loadProviders()]);
        renderChips();
      } catch (err) {
        fail(err);
        const msg = String(err.message || err);
        if (msg.includes('already been executed') || msg.includes('only once')) {
          localStorage.setItem('delete_all_used_' + targetTable, 'true');
          btn.disabled = true;
          btn.classList.add('disabled');
          btn.innerHTML = '<span>🔒 Delete All (Used)</span>';
          btn.title = 'Delete All has already been executed for this table and is permanently locked.';
          try { modal.close(); } catch (e) { modal.removeAttribute('open'); }
        } else {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = '<span>Delete All Data</span>';
        }
      }
    };
  }
}
initDeleteAll();

/* ---------- INDIVIDUAL ROW DELETE (PROFESSIONAL MODAL CONFIRMATION) ---------- */
let pendingDeleteRow = { id: null, tr: null };

function openDeleteModal(rowId, tr) {
  if (!rowId) {
    toast('Cannot determine record ID to delete', 1);
    return;
  }
  const modal = $('#deleteRowDlg');
  if (!modal) return;

  pendingDeleteRow = { id: rowId, tr: tr };

  let cust = '—', prov = '—', date = '—', plan = '—';
  if (tr) {
    const custEl = tr.querySelector('[data-col-key="customer"]') || tr.querySelector('[data-col-key="customer name"]');
    if (custEl && custEl.textContent.trim()) cust = custEl.textContent.trim();

    const provEl = tr.querySelector('[data-col-key="provider"]');
    if (provEl && provEl.textContent.trim()) prov = provEl.textContent.trim();

    const dateEl = tr.querySelector('[data-col-key="date"]');
    if (dateEl && dateEl.textContent.trim()) date = dateEl.textContent.trim();

    const planEl = tr.querySelector('[data-col-key="plan"]') || tr.querySelector('[data-col-key="plan *(months / time duration)"]');
    const qtyEl = tr.querySelector('[data-col-key="quantity"]');
    const pText = planEl ? planEl.textContent.trim() : '';
    const qText = qtyEl ? qtyEl.textContent.trim() : '';
    if (pText || qText) {
      plan = [pText, qText ? `Qty: ${qText}` : ''].filter(Boolean).join(' · ');
    }
  }

  const cSpan = $('#delRowCustomer'); if (cSpan) cSpan.textContent = cust;
  const pSpan = $('#delRowProvider'); if (pSpan) pSpan.textContent = prov;
  const dSpan = $('#delRowDate'); if (dSpan) dSpan.textContent = date;
  const plSpan = $('#delRowPlan'); if (plSpan) plSpan.textContent = plan;

  const confirmBtn = $('#delRowConfirmBtn');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '<span>Delete Record</span>';
  }

  try {
    modal.showModal();
  } catch (e) {
    modal.setAttribute('open', '');
  }
}

function initDeleteRowModal() {
  const modal = $('#deleteRowDlg');
  const cancelBtn = $('#delRowCancelBtn');
  const confirmBtn = $('#delRowConfirmBtn');
  if (!modal) return;

  if (cancelBtn) {
    cancelBtn.onclick = () => {
      try { modal.close(); } catch (e) { modal.removeAttribute('open'); }
      pendingDeleteRow = { id: null, tr: null };
    };
  }

  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const { id: rowId, tr } = pendingDeleteRow;
      if (!rowId) {
        try { modal.close(); } catch (e) { modal.removeAttribute('open'); }
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<span>⏳ Deleting…</span>';

      if (tr) {
        tr.style.opacity = '0.35';
      }

      try {
        const targetTable = (!S.cur || S.cur === ALL) ? 'customer_data' : S.cur;
        await del(`${rowsUrl(targetTable)}/rows/${enc(rowId)}`);

        try { modal.close(); } catch (e) { modal.removeAttribute('open'); }

        if (tr) {
          tr.classList.add('row-deleted');
          setTimeout(() => { if (tr.parentElement) tr.remove(); }, 350);
        }

        const custName = $('#delRowCustomer') ? $('#delRowCustomer').textContent : '';
        toast(custName && custName !== '—' ? `Record for "${custName}" permanently deleted ✔` : `Record #${rowId} deleted ✔`);

        S.total = Math.max(0, (S.total || 1) - 1);
        await Promise.all([load(), refreshCounts()]);
      } catch (err) {
        if (tr) {
          tr.style.opacity = '1';
        }
        fail(err);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<span>Delete Record</span>';
        pendingDeleteRow = { id: null, tr: null };
      }
    };
  }
}
initDeleteRowModal();

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
  const availableProvs = provNames().length ? provNames() : ['sensorise', 'iotivity', 'vi', 'growspace', 'taisys'];
  const curP = S.prov && availableProvs.includes(S.prov.toLowerCase()) ? S.prov.toLowerCase() : availableProvs[0];

  const primaryHtml = `
    <!-- 1. Provider -->
    <label>Provider *
      <select id="insProvider" required>
        ${availableProvs.map(p => `<option value="${esc(p)}" ${p == curP ? 'selected' : ''}>${esc(p)}</option>`).join('')}
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
