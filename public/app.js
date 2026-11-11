/* StudyHub frontend — vanilla JS single-page app */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
let ME = null;
let COURSES = [];

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- speed: pages open instantly from the last copy of their data, then refresh quietly ----------
const apiCache = new Map();   // url -> JSON text of the last answer
let cacheMode = null;         // while a page is drawing: { used: Set } of urls it took from the cache
const NO_CACHE = /\/api\/(practice\/next|me$|push\/|admin\/pending-count|reminders|class\/)/; // always live
const QUIET = /\/api\/(notifications\/seen|study-sessions|push\/|login|register|setup)/;       // changes that don't affect other pages
const SAVE_KEY = 'ejust-saved';
let saveTimer;
// keep a small copy on this device so the app opens instantly next time (cleared on sign-out)
function saveLater() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!ME) return;
    try {
      const cache = {};
      let size = 0;
      for (const [u, t] of apiCache) { if (t.length < 60000 && (size += t.length) < 400000) cache[u] = t; }
      localStorage.setItem(SAVE_KEY, JSON.stringify({ me: ME, cache, at: Date.now() }));
    } catch {}
  }, 800);
}
function loadSaved() {
  try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); return s && s.me && Date.now() - s.at < 14 * 86400000 ? s : null; } catch { return null; }
}
function forgetSaved() { clearTimeout(saveTimer); localStorage.removeItem(SAVE_KEY); apiCache.clear(); }

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.match(/login|register/)) { ME = null; forgetSaved(); stopReminders(); showAuth(); throw new Error('Not signed in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  // something changed on the server: drop the cached copies so no page shows old data, then warm them up again
  if (method !== 'GET' && !QUIET.test(url)) { apiCache.clear(); prefetch(600); }
  return data;
}
async function GET(u) {
  const cacheable = !NO_CACHE.test(u);
  if (cacheable && cacheMode && apiCache.has(u)) { cacheMode.used.add(u); return JSON.parse(apiCache.get(u)); }
  const data = await api('GET', u);
  if (cacheable) { apiCache.set(u, JSON.stringify(data)); saveLater(); }
  return data;
}
const POST = (u, b) => api('POST', u, b ?? {}), PUT = (u, b) => api('PUT', u, b),
  PATCH = (u, b) => api('PATCH', u, b), DEL = (u) => api('DELETE', u);
// fetch fresh copies of what a page used; true if anything was different
async function revalidate(urls) {
  let changed = false;
  await Promise.all([...urls].map(async (u) => {
    try { const txt = JSON.stringify(await api('GET', u)); if (apiCache.get(u) !== txt) { apiCache.set(u, txt); changed = true; } } catch {}
  }));
  if (changed) saveLater();
  return changed;
}
// load the main pages' data in the background so the first tap on each tab is instant
const dashUrl = () => `/api/dashboard?today=${ymd(new Date())}&tz_offset=${new Date().getTimezoneOffset()}`;
let prefetchTimer;
function prefetch(delay = 300) {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    if (!ME) return;
    for (const u of [dashUrl(), '/api/courses', '/api/courses/overview', '/api/tasks', '/api/timetable', '/api/sections', '/api/materials', '/api/notifications']) {
      if (!apiCache.has(u)) GET(u).catch(() => {});
    }
  }, delay);
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}
const fail = (e) => toast(e.message, true);

function openModal(html, onMount) {
  $('#modal-card').innerHTML = html; $('#modal').classList.remove('hidden');
  onMount && onMount($('#modal-card'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').innerHTML = ''; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
function fmtDue(iso) {
  if (!iso) return '<span class="muted">No due date</span>';
  const d = new Date(iso); const diff = d - Date.now(); const days = diff / 86400000;
  const when = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  let rel;
  if (diff < 0) rel = `<span class="muted">${humanDur(-diff)} ago</span>`;
  else if (days < 2) rel = `<span class="due-soon">in ${humanDur(diff)}</span>`;
  else rel = `<span class="muted">in ${Math.round(days)} days</span>`;
  return `${when} — ${rel}`;
}
function humanDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`; const h = Math.round(m / 60);
  if (h < 48) return `${h} h`; return `${Math.round(h / 24)} days`;
}
const courseOpts = (sel, blank = 'No course') =>
  `<option value="">${blank}</option>` + COURSES.map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
const courseTag = (name, color) => (name ? `<span class="row small" style="gap:5px"><span class="dot" style="background:${esc(color)}"></span>${esc(name)}</span>` : '');
const bar = (pct, cls = '') => `<div class="bar ${cls}"><span style="width:${Math.max(0, Math.min(100, pct || 0))}%"></span></div>`;
async function loadCourses() { COURSES = await GET('/api/courses'); }
let SECTIONS = [];
async function loadSections() { SECTIONS = await GET('/api/sections'); return SECTIONS; }

// ---------- timetable helpers ----------
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KIND_LABEL = { lecture: 'Lecture', tutorial: 'Tutorial', lab: 'Lab', other: 'Other' };
// weeks alternate A, B, A, B… A week runs Saturday → Friday (the Egyptian study week)
const weekStart = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); return x; };
function weekType(date, weekA) {
  const ref = weekStart(weekA ? new Date(weekA + 'T12:00') : new Date(2026, 0, 3));
  const n = Math.round((weekStart(date) - ref) / (7 * 86400000));
  return ((n % 2) + 2) % 2 === 0 ? 'a' : 'b';
}
// does this class happen on that date? (right weekday, and the right week for alternating classes)
const slotOn = (s, date, weekA) => s.day === date.getDay() && (s.weeks === 'all' || s.weeks === weekType(date, weekA));
// the next time a class starts after `from`
function nextOccurrence(slot, weekA, from = new Date()) {
  for (let i = 0; i < 22; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    if (!slotOn(slot, d, weekA)) continue;
    const [h, m] = slot.start.split(':').map(Number); d.setHours(h, m, 0, 0);
    if (d > from) return d;
  }
  return null;
}

// ---------- line icons (used instead of emoji) ----------
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  check: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3"/><path d="M4 4v4h4M20 20v-4h-4"/>',
  grid: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 4v16"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  tick: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
};
const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
function renderIcons(root = document) { $$('i[data-icon]', root).forEach((el) => { el.outerHTML = icon(el.dataset.icon); }); }
renderIcons();

const BRAND ='<span class="brand-logo"><img src="/icons/emblem-64.png" alt=""></span>E-JUST';
const isAdmin = () => ME?.role === 'admin';
const can = (perm) => !!ME?.perms?.includes(perm);

// ---------- auth: set up class (first user), join with invite code, or sign in ----------
async function showAuth(mode) {
  $('#shell').classList.add('hidden');
  const a = $('#auth'); a.classList.remove('hidden');
  const status = await fetch('/api/class/status').then((r) => r.json()).catch(() => ({ setup_done: true }));
  if (!status.setup_done) mode = 'setup';
  mode = mode || 'login';
  const head = (sub) => `<img src="/logo.png" alt="E-JUST" class="auth-logo"><p class="muted" style="text-align:center">${sub}</p>`;
  const creds = (newPw) => `<div><label>Username</label><input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false"
      ${newPw ? 'pattern="[A-Za-z0-9._\\-]{3,30}" title="3–30 characters: letters, numbers, dots, dashes or underscores (no spaces)" placeholder="e.g. ahmed.ali"' : ''}>
      ${newPw ? '<div class="small muted" style="margin-top:4px">3–30 characters, no spaces. You\'ll use it to sign in.</div>' : ''}</div>
    <div><label>Password</label><input name="password" type="password" required minlength="6" autocomplete="${newPw ? 'new-password' : 'current-password'}"></div>`;
  const submit = async (url, body) => { try { await POST(url, body); await boot(); } catch (err) { fail(err); } };

  if (mode === 'setup') {
    a.innerHTML = `<div class="card">${head('Set up your class. You will be its first admin (class rep).')}
      <form class="form" id="auth-form">
        <div><label>Class name</label><input name="class_name" required placeholder="e.g. Computer Engineering — Year 2"></div>
        <div><label>Sections (comma separated)</label><input name="sections" required placeholder="e.g. Section 1, Section 2, Section 3"></div>
        <div><label>Your name</label><input name="name" required autocomplete="name"></div>${creds(true)}
        <button class="btn big">Create class</button></form></div>`;
    $('#auth-form').onsubmit = (e) => { e.preventDefault(); submit('/api/setup', Object.fromEntries(new FormData(e.target))); };
    return;
  }
  if (mode === 'join') {
    a.innerHTML = `<div class="card">${head(`Join ${esc(status.name || 'the class')}`)}
      <form class="form" id="auth-form">
        <div><label>Invite code (ask your class rep)</label><div class="row" style="flex-wrap:nowrap">
          <input name="code" required placeholder="e.g. 9F3A1C0B" style="text-transform:uppercase"><button type="button" class="btn soft" id="check">Check</button></div></div>
        <div id="join-rest" class="form hidden">
          <div><label>Your section</label><select name="section_id" id="sec" required></select>
            <div class="small muted" style="margin-top:4px">Choose carefully — after joining, only an admin can change your section.</div></div>
          <div><label>Your name</label><input name="name" required autocomplete="name"></div>${creds(true)}
          <button class="btn big">Send join request</button>
          <div class="small muted" style="text-align:center">An admin has to approve your request before you can sign in.</div></div>
        <p class="small muted" style="text-align:center;margin:0">Already have an account? <a href="#" id="auth-switch">Sign in</a></p></form></div>`;
    const check = async () => {
      try {
        const info = await GET('/api/class/join-info?code=' + encodeURIComponent($('[name=code]').value.trim()));
        $('#sec').innerHTML = '<option value="">Choose…</option>' + info.sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
        $('#join-rest').classList.remove('hidden');
      } catch (err) { fail(err); $('#join-rest').classList.add('hidden'); }
    };
    $('#check').onclick = check;
    $('[name=code]').onchange = check;
    $('#auth-switch').onclick = (e) => { e.preventDefault(); showAuth('login'); };
    $('#auth-form').onsubmit = (e) => {
      e.preventDefault();
      if ($('#join-rest').classList.contains('hidden')) return check();
      const body = Object.fromEntries(new FormData(e.target));
      POST('/api/register', body).then(() => showAuth('requested')).catch(fail);
    };
    return;
  }
  if (mode === 'requested') {
    a.innerHTML = `<div class="card">${head('Request sent ✅')}
      <p>Your request to join <b>${esc(status.name || 'the class')}</b> was sent.</p>
      <p class="muted">An admin needs to approve it. Once they do, sign in with your <b>username</b> and <b>password</b>. You won't need the invite code again.</p>
      <button class="btn big" id="to-login" style="width:100%;justify-content:center">Go to sign in</button></div>`;
    $('#to-login').onclick = () => showAuth('login');
    return;
  }
  a.innerHTML = `<div class="card">${head(`Sign in to ${esc(status.name || 'your class')}`)}
    <form class="form" id="auth-form">${creds(false)}<button class="btn big">Sign in</button>
      <p class="small muted" style="text-align:center;margin:0">New here? <a href="#" id="auth-switch">Join with an invite code</a></p></form></div>`;
  $('#auth-switch').onclick = (e) => { e.preventDefault(); showAuth('join'); };
  $('#auth-form').onsubmit = (e) => { e.preventDefault(); submit('/api/login', Object.fromEntries(new FormData(e.target))); };
}
// signing out reloads the app so nothing from this account (filters, saved pages) is left for the next person
$('#logout').onclick = async () => {
  await POST('/api/logout').catch(() => {});
  ME = null; forgetSaved(); stopReminders();
  history.replaceState(null, '', location.pathname); location.reload();
};

// show the app frame for the signed-in person (name, which menu items they may see)
function showShell() {
  $('#auth').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $('.brand').innerHTML = BRAND + (ME.class_name ? `<div class="brand-sub">${esc(ME.class_name)}</div>` : '');
  $('#me').innerHTML = `<b>${esc(ME.name)}</b>${isAdmin() ? ' <span class="badge">admin</span>' : ''}`;
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
  $$('[data-perm]').forEach((el) => el.classList.toggle('hidden', !el.dataset.perm.split(',').some(can)));
}

async function boot() {
  // 1) open instantly from the copy saved on this device (if any)…
  let instant = false;
  const saved = !ME && loadSaved();
  if (saved) {
    ME = saved.me;
    for (const [u, t] of Object.entries(saved.cache || {})) apiCache.set(u, t);
    try { COURSES = JSON.parse(apiCache.get('/api/courses') || '[]'); } catch { COURSES = []; }
    showShell(); route(); instant = true;
  }
  // 2) …then check the sign-in and refresh in the background
  let me, courses;
  try {
    [me, courses] = await Promise.all([api('GET', '/api/me'), fetch('/api/courses').then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
  } catch (e) { if (!ME) return; if (e.message === 'Not signed in') return; me = ME; } // offline: keep showing the saved copy
  const changed = JSON.stringify(me) !== JSON.stringify(ME);
  ME = me;
  if (courses) { COURSES = courses; apiCache.set('/api/courses', JSON.stringify(courses)); }
  showShell(); saveLater();
  startReminders();
  if (!instant || changed) route();
  prefetch();
  if (!ME.section_id) sectionDialog();
}

async function sectionDialog() {
  if (!isAdmin()) {
    // students can't pick their own section — only an admin can place them
    return openModal(`<h2>No section yet</h2><p class="muted">You're not in a section right now, so due dates show the class default.
      Ask an admin to put you in your section.</p>
      <div class="row" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">OK</button></div>`);
  }
  const secs = await GET('/api/sections');
  openModal(`<h2>Your section</h2><p class="muted">Due dates are shown for your section's timetable.</p>
    <div class="form"><select id="sec-pick">${secs.map((s) => `<option value="${s.id}" ${s.id === ME.section_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="sec-save">Save</button></div></div>`, (m) => {
    $('#sec-save', m).onclick = async () => {
      try { await PATCH('/api/me/section', { section_id: $('#sec-pick', m).value }); closeModal(); toast('Section updated'); await boot(); } catch (e) { fail(e); }
    };
  });
}

// ---------- router ----------
const routes = { dashboard, tasks, timetable: timetablePage, materials, practice, questions, planner, focus, courses, add: addPage, users: usersPage, notifications: notificationsPage };
const adminRoutes = ['users'];
const OLD_ROUTES = { class: 'users', permissions: 'users/permissions', connections: 'users/connections' }; // links from before the Users tab
const LIVE_PAGES = new Set(['practice', 'focus', 'add']); // pages holding your work in progress: never redrawn behind your back
let routeSeq = 0, needsReload = false, lastRoute = '', activePage = '';
// true when the user has moved to another page: a late refresh must not draw over it
const away = (page) => activePage !== page;
const canRedraw = () => $('#modal').classList.contains('hidden') && !(view.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
async function route() {
  if (!ME) return;
  if (needsReload) { needsReload = false; location.reload(); return; } // a newer version of the app was downloaded
  const seq = ++routeSeq;
  let path = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  if (OLD_ROUTES[path.split('/')[0]]) path = OLD_ROUTES[path.split('/')[0]];
  let [name, ...args] = path.split('/');
  if (adminRoutes.includes(name) && !isAdmin()) name = 'dashboard';
  if (name === 'questions' && !can('questions')) name = 'dashboard';
  if (name === 'add' && !can('tasks') && !can('sheets')) name = 'dashboard';
  const fn = routes[name] || dashboard;
  const active = routes[name] ? name : 'dashboard';
  activePage = active;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === active));
  const link = $(`#nav a[data-route="${active}"]`);
  $('#top-title').textContent = link ? link.textContent.replace(/\s*\d+\s*$/, '').trim() : 'E-JUST';
  closeMenu();
  const isNav = lastRoute !== location.hash; lastRoute = location.hash;
  // the previous page stays on screen until the new one is ready (a thin bar shows if that takes a moment)
  const mode = { used: new Set() }; cacheMode = mode;
  const slow = setTimeout(() => $('#progress').classList.add('on'), 120);
  let ok = true;
  try { await fn(...args); }
  catch (e) { ok = false; if (e.message !== 'Not signed in' && seq === routeSeq) view.innerHTML = `<div class="banner red">${esc(e.message)}</div>`; }
  finally { if (cacheMode === mode) cacheMode = null; clearTimeout(slow); $('#progress').classList.remove('on'); }
  if (seq !== routeSeq) return;
  if (isNav) { window.scrollTo(0, 0); view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); }
  // it was drawn from saved data: fetch fresh copies and redraw only if something actually changed
  if (ok && mode.used.size && await revalidate(mode.used) && seq === routeSeq && !LIVE_PAGES.has(name) && !(name === 'materials' && args[0]) && canRedraw()) {
    const again = { used: new Set() }; cacheMode = again;
    try { await fn(...args); } catch {} finally { if (cacheMode === again) cacheMode = null; }
  }
}
window.addEventListener('hashchange', route);
// the service worker tells us when it has downloaded a newer version; it's applied on the next page change
navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'app-updated') needsReload = true; });

// ---------- ☰ menu (phones & tablets) ----------
function openMenu() { document.body.classList.add('nav-open'); $('#menu-btn').setAttribute('aria-expanded', 'true'); }
function closeMenu() { document.body.classList.remove('nav-open'); $('#menu-btn').setAttribute('aria-expanded', 'false'); }
$('#menu-btn').onclick = openMenu;
$('#menu-close').onclick = closeMenu;
$('#scrim').onclick = closeMenu;
$('#nav').addEventListener('click', (e) => { if (e.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
// swipe left on the open menu to close it
let touchX = null;
$('#sidebar').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$('#sidebar').addEventListener('touchend', (e) => { if (touchX !== null && touchX - e.changedTouches[0].clientX > 60) closeMenu(); touchX = null; });

// =====================================================================
// DASHBOARD
// =====================================================================
async function dashboard() {
  const [d, overview, tt] = await Promise.all([GET(dashUrl()), GET('/api/courses/overview'), GET('/api/timetable')]);
  const todayClasses = tt.slots.filter((s) => s.section_id === ME.section_id && slotOn(s, new Date(), tt.week_a));
  const notifBtn = pushState() === 'off'
    ? `<button class="btn soft small" id="notif">${icon('bell')}Turn on notifications</button>` : '';

  if (away('dashboard')) return;
  view.innerHTML = `
    <div class="page-head"><div><h1>Hi ${esc(ME.name.split(' ')[0])}</h1>
      <div class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      <div class="row">${notifBtn}<a class="btn" href="#/practice">${icon('target')}Start practising</a></div></div>
    <div id="install-card" class="card install-card hidden"><div class="row spread">
      <div class="row" style="flex-wrap:nowrap"><img src="/icons/icon-192.png" alt="" width="44" height="44" style="border-radius:10px">
        <div><b>Install E-JUST</b><div class="small muted">Get it on your home screen or desktop. Opens in its own window, no browser bar.</div></div></div>
      <div class="row"><button class="btn small" id="install-card-btn">${icon('download')}Install</button><button class="btn ghost small" id="install-card-x">Not now</button></div></div></div>
    ${isAdmin() ? `<a id="pending-banner" class="banner ${PENDING ? '' : 'hidden'}" href="#/users" style="display:block;text-decoration:none"><b id="pending-count">${PENDING}</b> join request(s) waiting for your approval — review</a>` : ''}
    ${d.due_soon_count ? `<div class="banner"><b>${d.due_soon_count}</b> item${d.due_soon_count > 1 ? 's are' : ' is'} due in the next 3 days.</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="num">${d.streak}</div><div class="lbl">day study streak</div></div>
      <div class="stat ${d.reviews_due ? 'alert' : ''}"><div class="num">${d.reviews_due}</div><div class="lbl">MCQs due for review</div></div>
      <div class="stat"><div class="num">${d.new_questions}</div><div class="lbl">new questions waiting</div></div>
      <div class="stat"><div class="num">${Math.round(d.minutes_week / 6) / 10}h</div><div class="lbl">focused study this week</div></div>
    </div>
    <div class="grid g2">
      <div class="card"><div class="row spread"><h2>Coming up</h2><a href="#/tasks" class="small">All tasks →</a></div>
        <div class="list">${d.upcoming.length ? d.upcoming.map(taskRowSimple).join('') : '<div class="empty">Nothing coming up.</div>'}</div></div>
      <div class="card"><div class="row spread"><h2>Today's classes</h2><a href="#/timetable" class="small">Timetable →</a></div>
        <div class="list">${todayClasses.length ? todayClasses.map((s) => `<div class="row" style="gap:10px;flex-wrap:nowrap">
          <span class="tt-time">${s.start}–${s.end}</span>
          <div style="flex:1;min-width:0"><b>${esc(s.course_name || 'Class')}</b> <span class="src-chip ${s.kind === 'tutorial' ? 'section' : s.kind}"><b>${KIND_LABEL[s.kind] || s.kind}</b></span>
            ${s.location ? `<div class="small muted">${esc(s.location)}</div>` : ''}</div></div>`).join('')
          : `<div class="empty">${tt.slots.some((s) => s.section_id === ME.section_id) ? 'No classes today.' : 'No timetable for your section yet.'}</div>`}</div></div>
      <div class="card"><div class="row spread"><h2>Today's study plan</h2><a href="#/planner" class="small">Planner →</a></div>
        <div class="list" id="today-plan">${d.today_plan.length ? d.today_plan.map(planRow).join('') : '<div class="empty">No sessions planned today.<br><span class="small">Open an exam or quiz in the Planner and click “Make study plan”.</span></div>'}</div></div>
      <div class="card"><div class="row spread"><h2>Courses</h2><a href="#/courses" class="small">All courses →</a></div>
        ${overview.courses.length ? `<div class="list">${overview.courses.map((c) => `<a class="course-link" href="#/courses/${c.id}">
          <span class="dot" style="background:${esc(c.color)}"></span><b>${esc(c.name)}</b>
          <span class="small muted">${courseCounts(c)}</span></a>`).join('')}</div>`
          : `<div class="empty">No courses yet.${can('courses') ? ' Add one on the Courses page.' : ''}</div>`}</div>
      ${d.grades.length ? `<div class="card"><h2>Grade averages</h2>${d.grades.map((g) => `<div class="row spread small" style="margin-bottom:6px"><span>${courseTag(g.course_name, g.color || '#999')}</span><b>${g.pct}%</b></div>`).join('')}</div>` : ''}
    </div>`;
  bindPlanRows($('#today-plan'), dashboard);
  $('#install-card-btn').onclick = installApp;
  $('#install-card-x').onclick = () => { localStorage.setItem('installCardHidden', '1'); refreshInstallUI(); };
  refreshInstallUI();
  $('#notif')?.addEventListener('click', async () => { await enablePush(); dashboard(); });
}
const taskRowSimple = (t) => `<div class="row" style="gap:10px"><span class="badge ${t.type}">${t.type}</span>
  <div class="grow" style="flex:1"><b>${esc(t.title)}</b> ${courseTag(t.course_name, t.course_color)}<div class="small">${fmtDue(t.due_at)}</div></div></div>`;
const planRow = (p) => `<label class="item ${p.done ? 'done' : ''}" style="cursor:pointer;margin:0;color:inherit;font-weight:400">
  <input type="checkbox" class="check" data-plan="${p.id}" ${p.done ? 'checked' : ''}>
  <div class="grow"><div class="title">${esc(p.title)}</div><div class="small muted">${p.minutes} min ${p.course_name ? '· ' + esc(p.course_name) : ''}</div></div></label>`;
function bindPlanRows(root, refresh) {
  $$('[data-plan]', root).forEach((cb) => cb.addEventListener('change', async () => {
    await PATCH(`/api/plan/${cb.dataset.plan}`, { done: cb.checked }).catch(fail); refresh();
  }));
}

// =====================================================================
// TASKS — assignments, quizzes, exams
// =====================================================================
let taskFilter = { tab: 'todo', type: '', course: '' };
const isPast = (t) => !!t.due_at && new Date(t.due_at) < new Date();
async function tasks() {
  const all = await GET('/api/tasks');
  const match = (t) => (!taskFilter.type || t.type === taskFilter.type) && (!taskFilter.course || String(t.course_id) === taskFilter.course);
  // Past only ever holds assignments: quizzes and exams are removed once their date has passed
  const groups = {
    todo: all.filter((t) => t.status !== 'done' && !isPast(t)),
    done: all.filter((t) => t.status === 'done' && !isPast(t)),
    past: all.filter(isPast).sort((a, b) => (a.due_at < b.due_at ? 1 : -1)),
  };
  const list = groups[taskFilter.tab].filter(match);
  const empty = { todo: 'Nothing to do — you\'re all caught up.', done: 'Nothing ticked off yet.', past: 'No past assignments.' }[taskFilter.tab];
  if (away('tasks')) return;
  view.innerHTML = `
    <div class="page-head"><div><h1>Assignments & Quizzes</h1><div class="muted">Due dates are for <b>${esc(ME.section_name || 'your section')}</b>. Tap the circle to tick something off — only you see that.</div></div>
      ${can('tasks') ? `<a class="btn" href="#/add">${icon('plus')}Add</a>` : ''}</div>
    <div class="seg" role="tablist">${[['todo', 'To do'], ['done', 'Done'], ['past', 'Past']].map(([k, label]) =>
      `<button role="tab" data-tab="${k}" class="${taskFilter.tab === k ? 'active' : ''}">${label}<span class="seg-n">${groups[k].filter(match).length}</span></button>`).join('')}</div>
    <div class="filters">
      <select id="f-type"><option value="">All types</option>${['assignment', 'quiz', 'exam'].map((t) => `<option ${taskFilter.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select id="f-course">${courseOpts(taskFilter.course, 'All courses')}</select>
    </div>
    <div class="list">${list.length ? list.map(taskRow).join('') : `<div class="empty">${empty}</div>`}</div>
    ${taskFilter.tab === 'past' ? '<p class="small muted" style="margin-top:12px">Assignments move here after their due date. Quizzes and exams are removed completely once their date has passed.</p>' : ''}`;
  $$('[data-tab]').forEach((b) => (b.onclick = () => { taskFilter.tab = b.dataset.tab; tasks(); }));
  $('#f-type').onchange = (e) => { taskFilter.type = e.target.value; tasks(); };
  $('#f-course').onchange = (e) => { taskFilter.course = e.target.value; tasks(); };
  bindTaskRows(view, all, tasks);
}
// wires up the buttons inside task rows (tick, grade, plan, edit)
function bindTaskRows(root, all, refresh) {
  const find = (id) => all.find((t) => t.id == id);
  $$('[data-toggle]', root).forEach((b) => (b.onclick = async () => {
    const t = find(b.dataset.toggle); const next = t.status === 'done' ? 'todo' : 'done';
    // show the result straight away, then save
    t.status = next; b.classList.toggle('on', next === 'done'); b.closest('.task').classList.toggle('done', next === 'done');
    try { await PATCH(`/api/tasks/${t.id}/mine`, { status: next }); } catch (e) { fail(e); }
    refresh();
  }));
  $$('[data-grade]', root).forEach((b) => (b.onclick = () => gradeDialog(find(b.dataset.grade))));
  $$('[data-edit]', root).forEach((b) => (b.onclick = () => taskForm(find(b.dataset.edit))));
  $$('[data-plan-task]', root).forEach((b) => (b.onclick = () => planTaskDialog(find(b.dataset.planTask))));
}
const noCoursesYet = () => `<div class="banner">Add a course first — every item belongs to a course. ${can('courses') ? '<a href="#/courses" onclick="closeModal()">Go to Courses →</a>' : 'Ask an admin to add one.'}</div>`;
const taskRow = (t) => {
  const done = t.status === 'done', past = isPast(t);
  return `<div class="task ${done ? 'done' : ''} ${past ? 'past' : ''}">
    <button class="tick ${done ? 'on' : ''}" data-toggle="${t.id}" aria-pressed="${done}" title="${done ? 'Mark as not done' : 'Mark as done'}">${icon('tick')}</button>
    <div class="grow">
      <div class="title">${esc(t.title)}</div>
      <div class="task-meta"><span class="badge ${t.type}">${t.type}</span>
        ${t.priority === 'high' ? '<span class="badge high">high</span>' : ''}
        ${t.only_section_name ? `<span class="badge gray">${esc(t.only_section_name)} only</span>` : ''}
        ${past && !done ? '<span class="badge high">missed</span>' : ''}
        ${courseTag(t.course_name, t.course_color)} <span>${fmtDue(t.due_at)}</span>
        ${t.grade != null ? `<span class="badge green">${t.grade}${t.max_grade ? ' / ' + t.max_grade : ''}</span>` : ''}</div>
      ${t.notes ? `<div class="small muted task-notes">${esc(t.notes)}</div>` : ''}
    </div>
    <div class="task-actions">
      ${t.due_at && !done && !past ? `<button class="icon-btn" data-plan-task="${t.id}" title="Make a study plan up to the due date">${icon('calendar')}</button>` : ''}
      ${t.type === 'assignment' && (done || past) ? `<button class="btn ghost small" data-grade="${t.id}" title="Enter the grade you got">Grade</button>` : ''}
      ${can('tasks') ? `<button class="icon-btn" data-edit="${t.id}" title="Edit">${icon('edit')}</button>` : ''}
    </div></div>`;
};

function gradeDialog(t) {
  openModal(`<h2>My grade — ${esc(t.title)}</h2><p class="muted small">Only you can see this. It's used for your course averages.</p>
    <form class="form" id="gf"><div class="two"><div><label>Grade</label><input type="number" step="any" name="grade" value="${t.grade ?? ''}"></div>
      <div><label>Out of</label><input disabled value="${t.max_grade ?? '—'}"></div></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div></form>`, (m) => {
    $('#gf', m).onsubmit = async (e) => {
      e.preventDefault();
      try { await PATCH(`/api/tasks/${t.id}/mine`, { grade: e.target.grade.value }); closeModal(); toast('Saved'); route(); } catch (err) { fail(err); }
    };
  });
}

// The assignment / quiz / exam form. Used inside the Add tab (inline) and in the Edit pop-up.
function taskFormHTML(t = {}, { inline = false } = {}) {
  const dues = t.section_dues || {};
  const type = t.type || 'assignment';
  return `${COURSES.length ? '' : noCoursesYet()}
    <form class="form" id="tf">
      <div><label>Title</label><input name="title" required value="${esc(t.title)}" placeholder="e.g. Physics Lab Report 3"></div>
      <div class="two">
        ${inline ? `<input type="hidden" name="type" value="${type}">` : `<div><label>Type</label><select name="type">${['assignment', 'quiz', 'exam'].map((x) => `<option ${type === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>`}
        <div><label>Course</label><select name="course_id" ${t.id && !t.course_id ? '' : 'required'}>${courseOpts(t.course_id, 'Choose a course…')}</select></div>
        ${inline ? `<div><label>Who is it for</label><select name="section_id">${forOpts(t.only_section_id)}</select></div>` : ''}
      </div>
      <div class="two">
        ${inline ? '' : `<div><label>Who is it for</label><select name="section_id">${forOpts(t.only_section_id)}</select></div>`}
        <div><label>${type === 'assignment' ? 'Due date' : 'Date & time'} (default)</label><input type="datetime-local" name="due_at" value="${toLocalInput(t.default_due_at)}"></div>
        <div><label>Priority</label><select name="priority">${['low', 'medium', 'high'].map((x) => `<option ${(t.priority || 'medium') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      </div>
      <div class="sec-dues">
        <label>Different date for a section (leave empty to use the default)</label>
        <div class="row tt-fill"><span class="small muted">Set from timetable: each section's next</span>
          <select id="tt-kind" style="width:auto"><option value="tutorial">tutorial</option><option value="lecture">lecture</option><option value="lab">lab</option></select>
          <button type="button" class="btn soft small" id="tt-fill">Fill in</button></div>
        ${SECTIONS.map((s) => `<div class="row" style="margin-bottom:6px"><span style="min-width:110px" class="small">${esc(s.name)}</span>
          <input type="datetime-local" data-sec="${s.id}" value="${toLocalInput(dues[s.id])}"></div>`).join('')}</div>
      <div><label>Notes</label><textarea name="notes" placeholder="Chapters covered, requirements…">${esc(t.notes)}</textarea></div>
      <div data-only="assignment" class="${type === 'assignment' ? '' : 'hidden'}"><label>Graded out of (optional)</label><input type="number" step="any" name="max_grade" value="${t.max_grade ?? ''}"></div>
      <div data-only="test" class="small muted ${type === 'assignment' ? 'hidden' : ''}">Quizzes and exams disappear by themselves once their date has passed.</div>
      <div class="row spread">
        <div>${t.id ? `<button type="button" class="btn danger" id="tf-del">${icon('trash')}Delete</button>` : ''}</div>
        <div class="row">${inline ? '' : '<button type="button" class="btn ghost" onclick="closeModal()">Cancel</button>'}<button class="btn">${t.id ? 'Save' : 'Add for the class'}</button></div></div>
    </form>`;
}
const forOpts = (sel) => `<option value="">Everyone (all sections)</option>` + SECTIONS.map((s) => `<option value="${s.id}" ${String(sel) === String(s.id) ? 'selected' : ''}>Only ${esc(s.name)}</option>`).join('');
function bindTaskForm(root, t, onSaved) {
  const form = $('#tf', root);
  form.type?.addEventListener?.('change', () => {
    const a = form.type.value === 'assignment';
    $('[data-only="assignment"]', root).classList.toggle('hidden', !a); $('[data-only="test"]', root).classList.toggle('hidden', a);
  });
  // "Fill in": each section's next tutorial / lecture / lab of the chosen course becomes its date
  $('#tt-fill', root).onclick = async () => {
    const courseId = form.course_id.value; const kind = $('#tt-kind', root).value;
    if (!courseId) return toast('Choose the course first', true);
    const tt = await GET('/api/timetable').catch(() => null); if (!tt) return;
    let n = 0;
    for (const input of $$('[data-sec]', root)) {
      const times = tt.slots.filter((s) => String(s.section_id) === input.dataset.sec && String(s.course_id) === String(courseId) && s.kind === kind)
        .map((s) => nextOccurrence(s, tt.week_a)).filter(Boolean).sort((a, b) => a - b);
      if (times[0]) { input.value = toLocalInput(times[0].toISOString()); n++; }
    }
    toast(n ? `Filled in ${n} section${n === 1 ? '' : 's'} from the timetable` : `The timetable has no ${kind} for this course yet`, !n);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = Object.fromEntries(new FormData(form));
    b.due_at = fromLocalInput(b.due_at);
    b.section_dues = Object.fromEntries($$('[data-sec]', root).filter((i) => i.value).map((i) => [i.dataset.sec, fromLocalInput(i.value)]));
    try { t.id ? await PUT(`/api/tasks/${t.id}`, b) : await POST('/api/tasks', b); toast(t.id ? 'Saved' : 'Added — the class has been notified'); onSaved(); } catch (err) { fail(err); }
  };
  $('#tf-del', root)?.addEventListener('click', async () => {
    if (!confirm('Delete this item for the whole class?')) return;
    try { await DEL(`/api/tasks/${t.id}`); toast('Deleted'); onSaved(); } catch (err) { fail(err); }
  });
}
async function taskForm(t = {}) {
  await loadSections();
  openModal(`<h2>Edit ${esc(t.type || 'item')}</h2>${taskFormHTML(t)}`, (m) => bindTaskForm(m, t, () => { closeModal(); route(); }));
}

// =====================================================================
// ADD CONTENT — one place to add assignments, quizzes, exams and study sheets
// =====================================================================
let addType = 'assignment';
async function addPage() {
  await Promise.all([loadCourses(), loadSections()]);
  const p = hashParams();
  if (p.get('type')) addType = p.get('type');
  const types = [can('tasks') && ['assignment', 'Assignment', 'check'], can('tasks') && ['quiz', 'Quiz', 'target'], can('tasks') && ['exam', 'Exam', 'calendar'],
    can('sheets') && ['sheet', 'Study sheet', 'file']].filter(Boolean);
  if (!types.some(([k]) => k === addType)) addType = types[0][0];
  if (away('add')) return;
  view.innerHTML = `<div class="practice">
    <div class="page-head"><div><h1>Add content</h1><div class="muted">Add something for the class. Everyone it's meant for gets a notification.</div></div></div>
    <div class="type-pick">${types.map(([k, label, ic]) => `<button data-type="${k}">${icon(ic)}<span>${label}</span></button>`).join('')}</div>
    <div class="card" id="add-form"></div></div>`;
  const draw = () => {
    $$('[data-type]').forEach((b) => b.classList.toggle('active', b.dataset.type === addType));
    const box = $('#add-form');
    if (addType === 'sheet') {
      box.innerHTML = materialFormHTML(p.get('course_id') || '');
      bindMaterialForm(box, (r) => { location.hash = `#/materials/${r.id}`; });
    } else {
      const t = { type: addType, course_id: p.get('course_id') || '' };
      box.innerHTML = taskFormHTML(t, { inline: true });
      bindTaskForm(box, t, draw);
    }
  };
  $$('[data-type]').forEach((b) => (b.onclick = () => { addType = b.dataset.type; draw(); }));
  draw();
}

function planTaskDialog(t) {
  openModal(`<h2>Make a study plan</h2>
    <p class="muted">Creates one study session per day from today until <b>${esc(t.title)}</b> is due (${fmtDue(t.due_at)}). Any earlier plan for this item is replaced.</p>
    <div class="form"><div><label>Minutes per session</label><input type="number" id="pm" value="45" min="10" max="240"></div>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="go">Create plan</button></div></div>`, (m) => {
    $('#go', m).onclick = async () => {
      try { const r = await POST(`/api/tasks/${t.id}/plan`, { minutes: $('#pm', m).value, tz_offset: new Date().getTimezoneOffset() }); closeModal(); toast(`Planned ${r.created} study sessions`); location.hash = '#/planner'; }
      catch (e) { fail(e); }
    };
  });
}

// =====================================================================
// MATERIALS — study sheets
// =====================================================================
async function materials(id) {
  if (id) return materialReader(id);
  const list = await GET('/api/materials');
  if (away('materials')) return;
  view.innerHTML = `
    <div class="page-head"><div><h1>Study Sheets</h1><div class="muted">The class's shared sheets — read them, then practise their MCQs until you master them.</div></div>
      ${can('sheets') ? `<a class="btn" href="#/add?type=sheet">${icon('plus')}Add sheet</a>` : ''}</div>
    <div class="grid g3">${list.length ? list.map((m) => `<div class="card">
      <div class="row spread"><span class="badge gray">${m.kind.toUpperCase()}</span>${courseTag(m.course_name, m.course_color)}</div>
      <h3 style="margin-top:10px">${esc(m.title)}</h3>
      <div class="small muted">${m.question_count} questions · added ${new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}</div>
      <div class="row" style="margin-top:12px"><a class="btn small" href="#/materials/${m.id}">Open</a>
        ${m.question_count ? `<a class="btn soft small" href="#/practice?material_id=${m.id}">Practice</a>` : ''}
        ${can('sheets') ? `<button class="btn danger small" data-del="${m.id}">✕</button>` : ''}</div>
      ${m.question_count ? `<div class="small muted" style="margin-top:10px">You've mastered ${m.mastered}/${m.question_count}</div>${bar((m.mastered / m.question_count) * 100, 'green')}` : ''}</div>`).join('')
      : `<div class="card empty" style="grid-column:1/-1">No study sheets yet.${can('sheets') ? ' Use “Add sheet” to upload the first one for the class.' : ' Your class reps will add them here.'}</div>`}</div>`;
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    if (confirm('Delete this sheet and all questions generated from it?')) { await DEL(`/api/materials/${b.dataset.del}`); materials(); }
  }));
}

// The study-sheet form (shown inside the Add tab)
function materialFormHTML(courseId = '') {
  return `${COURSES.length ? '' : noCoursesYet()}
    <form class="form" id="mf">
      <div><label>Title</label><input name="title" placeholder="e.g. Chapter 4 – Cell Biology"></div>
      <div><label>Course</label><select name="course_id" required>${courseOpts(courseId, 'Choose a course…')}</select></div>
      <div><label>Upload a file (PDF, image or .txt, up to 4 MB)</label><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md"></div>
      <div class="muted small" style="text-align:center">— or —</div>
      <div><label>Paste notes</label><textarea name="body" rows="7" placeholder="Paste or type your notes here…"></textarea></div>
      <div class="row" style="justify-content:flex-end"><button class="btn">Add for the class</button></div>
    </form>`;
}
function bindMaterialForm(root, onSaved) {
  $('#mf', root).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('file')?.size) fd.delete('file');
    else if (fd.get('file').size > 4 * 1024 * 1024) return toast('That file is too big — sheets can be up to 4 MB. Try compressing the PDF or splitting it.', true);
    const btn = $('button.btn', e.target); btn.disabled = true;
    try { const r = await POST('/api/materials', fd); toast('Study sheet added'); onSaved(r); } catch (err) { fail(err); btn.disabled = false; }
  };
}

async function materialReader(id) {
  const m = await GET(`/api/materials/${id}`);
  const content = m.kind === 'pdf' ? `<iframe src="/api/materials/${m.id}/file"></iframe>`
    : m.kind === 'image' ? `<img src="/api/materials/${m.id}/file" alt="">` : `<div class="text">${esc(m.body)}</div>`;
  const total = m.question_count, mastered = m.mastered;
  if (away('materials')) return;
  view.innerHTML = `
    <div class="page-head"><div><a href="#/materials" class="small">← All sheets</a><h1>${esc(m.title)}</h1></div></div>
    <div class="split">
      <div class="reader card">${content}</div>
      <div class="grid">
        <div class="card"><h3>Master this sheet</h3>
          <div class="small muted">${total} questions · you've mastered ${mastered}</div>${bar(total ? (mastered / total) * 100 : 0, 'green')}
          <div class="row" style="margin-top:12px">${total ? `<a class="btn" href="#/practice?material_id=${m.id}">Practice now</a>` : '<span class="small muted">No questions for this sheet yet.</span>'}
            ${can('questions') ? `<a class="btn ghost small" href="#/questions?material_id=${m.id}">Edit questions</a>` : ''}</div></div>
        ${can('questions') ? `<div class="card"><h3>Generate MCQs with AI</h3>
          ${ME.ai ? '' : '<div class="banner small">AI is not set up yet. Add <code>ANTHROPIC_API_KEY</code> to the <code>.env</code> file and restart the server.</div>'}
          <div class="form">
            <div class="two"><div><label>How many</label><input type="number" id="g-count" value="10" min="1" max="30"></div>
              <div><label>Difficulty</label><select id="g-diff"><option>mixed</option><option>easy</option><option>medium</option><option>hard</option></select></div></div>
            <div><label>Focus on (optional)</label><input id="g-focus" placeholder="e.g. formulas, definitions, chapter 2"></div>
            <button class="btn" id="gen" ${ME.ai ? '' : 'disabled'}>Generate questions</button>
            <div class="small muted">New questions avoid repeating the ones you already have.</div>
          </div></div>
        <div class="card"><h3>Add your own</h3><button class="btn soft small" id="manual">+ Write a question</button></div>` : ''}
      </div></div>`;
  if (!can('questions')) return;
  $('#manual').onclick = () => questionForm({ material_id: m.id, course_id: m.course_id }, () => materialReader(id));
  $('#gen').onclick = async (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = 'Generating… (can take up to a minute)';
    try {
      const r = await POST(`/api/materials/${m.id}/generate`, { count: $('#g-count').value, difficulty: $('#g-diff').value, focus: $('#g-focus').value });
      toast(`Added ${r.added} questions`); materialReader(id);
    } catch (err) { fail(err); btn.disabled = false; btn.textContent = 'Generate questions'; }
  };
}

// =====================================================================
// PRACTICE — spaced-repetition MCQs
// =====================================================================
function hashParams() { return new URLSearchParams(location.hash.split('?')[1] || ''); }
let session = { answered: 0, correct: 0, seen: [] };

async function practice() {
  const p = hashParams();
  const [mats, topics] = await Promise.all([GET('/api/materials'), GET('/api/topics' + (p.get('course_id') ? `?course_id=${p.get('course_id')}` : ''))]);
  session = { answered: 0, correct: 0, seen: [] };
  const mode = p.get('mode') || 'scheduled';
  if (away('practice')) return;
  view.innerHTML = `<div class="practice">
    <div class="page-head"><div><h1>Practice MCQs</h1><div class="muted">Wrong answers come back in a few minutes; correct ones come back later and later until you master them.</div></div></div>
    <div class="filters">
      <select id="p-course">${courseOpts(p.get('course_id') || '', 'All courses')}</select>
      <select id="p-mat"><option value="">All sheets</option>${mats.filter((m) => !p.get('course_id') || String(m.course_id) === p.get('course_id')).map((m) => `<option value="${m.id}" ${p.get('material_id') == m.id ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select>
      <select id="p-topic"><option value="">All topics</option>${topics.map((t) => `<option ${p.get('topic') === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="p-mode"><option value="scheduled" ${mode === 'scheduled' ? 'selected' : ''}>Smart (due + new)</option><option value="cram" ${mode === 'cram' ? 'selected' : ''}>Keep going (cram)</option></select>
    </div>
    <div id="p-progress" class="card" style="margin-bottom:14px"></div>
    <div id="p-area"></div></div>`;
  const setParam = (k, v) => { const q = hashParams(); v ? q.set(k, v) : q.delete(k); if (k === 'course_id') { q.delete('material_id'); q.delete('topic'); } location.hash = '#/practice?' + q; };
  $('#p-course').onchange = (e) => setParam('course_id', e.target.value);
  $('#p-mat').onchange = (e) => setParam('material_id', e.target.value);
  $('#p-topic').onchange = (e) => setParam('topic', e.target.value);
  $('#p-mode').onchange = (e) => setParam('mode', e.target.value);
  nextQuestion();
}

let keyHandler = null;
function setKeys(fn) { if (keyHandler) document.removeEventListener('keydown', keyHandler); keyHandler = fn; if (fn) document.addEventListener('keydown', fn); }
window.addEventListener('hashchange', () => setKeys(null));

async function nextQuestion() {
  const p = hashParams(); const q = new URLSearchParams();
  for (const k of ['course_id', 'material_id', 'topic', 'mode']) if (p.get(k)) q.set(k, p.get(k));
  if (p.get('mode') === 'cram') q.set('exclude', session.seen.slice(-Math.max(1, Math.min(5, session.seen.length))).join(','));
  const r = await GET('/api/practice/next?' + q);
  if (away('practice') || !$('#p-area')) return;
  const c = r.counts; const pctM = c.total ? Math.round((c.mastered / c.total) * 100) : 0;
  $('#p-progress').innerHTML = `<div class="row spread small"><span><b>${c.mastered}</b>/${c.total} mastered · <b>${c.due || 0}</b> due · <b>${c.fresh || 0}</b> new</span>
    <span>This session: <b>${session.correct}</b>/${session.answered} correct</span></div>${bar(pctM, 'green')}`;
  const area = $('#p-area');
  if (!r.question) {
    setKeys(null);
    if (!c.total) {
      area.innerHTML = `<div class="card empty">No questions here yet.${can('questions') ? '<br><br><a class="btn" href="#/materials">Upload a sheet & generate MCQs</a> <a class="btn ghost" href="#/questions">Write questions</a>' : '<br>Your class reps will add questions for this.'}</div>`;
    } else {
      area.innerHTML = `<div class="card empty"><h2>🎉 All caught up!</h2>
        <p>You've answered everything that's due.${r.next_due ? ` Next review: <b>${new Date(r.next_due).toLocaleString()}</b>.` : ''}</p>
        <button class="btn" id="cram">Keep practising anyway</button></div>`;
      $('#cram').onclick = () => { const q = hashParams(); q.set('mode', 'cram'); location.hash = '#/practice?' + q; };
    }
    return;
  }
  const Q = r.question; const letters = 'ABCDEFGH';
  area.innerHTML = `<div class="card qcard">
    <div class="row spread small"><span class="badge">${esc(Q.topic)}</span><span class="muted">${Q.due_at ? (Q.reps ? `streak ${Q.reps}` : 'review') : 'new'} · ${Q.source === 'ai' ? 'AI' : 'manual'}</span></div>
    <div class="qtext">${esc(Q.question)}</div>
    <div id="choices">${Q.choices.map((ch, i) => `<button class="choice" data-i="${i}"><span class="key">${letters[i]}</span><span>${esc(ch)}</span></button>`).join('')}</div>
    <div id="after"></div>
    <div class="small muted kbd-tip" style="margin-top:10px">Tip: press 1–${Q.choices.length} to answer, Enter for next.</div></div>`;
  let answered = false;
  const answer = async (i) => {
    if (answered) return; answered = true;
    const res = await POST(`/api/questions/${Q.id}/answer`, { choice: i }).catch((e) => { fail(e); answered = false; });
    if (!res) return;
    session.answered++; if (res.correct) session.correct++; session.seen.push(Q.id);
    $$('.choice').forEach((b) => { b.disabled = true; const bi = +b.dataset.i; if (bi === res.answer_index) b.classList.add('right'); else if (bi === i) b.classList.add('wrong'); });
    $('#after').innerHTML = `<div class="explain"><div class="feedback ${res.correct ? 'ok' : 'no'}">${res.correct ? (res.mastered ? '✅ Correct — mastered! 🏆' : '✅ Correct!') : '❌ Not quite'}</div>
      ${res.explanation ? `<div style="margin-top:6px">${esc(res.explanation)}</div>` : ''}
      <div class="small muted" style="margin-top:6px">${res.correct ? `You'll see this again in ${res.interval_days} day${res.interval_days == 1 ? '' : 's'}.` : 'This one will come back in a few minutes.'}</div></div>
      <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn big" id="next">Next →</button></div>`;
    $('#next').onclick = nextQuestion; $('#next').focus();
  };
  $$('.choice').forEach((b) => (b.onclick = () => answer(+b.dataset.i)));
  setKeys((e) => {
    if (!$('#modal').classList.contains('hidden') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const n = parseInt(e.key);
    if (!answered && n >= 1 && n <= Q.choices.length) answer(n - 1);
    else if (answered && e.key === 'Enter' && document.activeElement.id !== 'next') nextQuestion();
  });
}

// =====================================================================
// QUESTION BANK
// =====================================================================
async function questions() {
  const p = hashParams();
  const q = new URLSearchParams(); if (p.get('course_id')) q.set('course_id', p.get('course_id')); if (p.get('material_id')) q.set('material_id', p.get('material_id'));
  const [list, mats] = await Promise.all([GET('/api/questions?' + q), GET('/api/materials')]);
  const status = (x) => (x.reps >= 4 ? '<span class="badge green">mastered</span>' : x.due_at ? `<span class="badge">learning · ${x.reps}/4</span>` : '<span class="badge gray">new</span>');
  if (away('questions')) return;
  view.innerHTML = `
    <div class="page-head"><div><h1>Question Bank</h1><div class="muted">${list.length} questions. Write your own or edit AI-generated ones.</div></div>
      <button class="btn" id="add">+ New question</button></div>
    <div class="filters">
      <select id="q-course">${courseOpts(p.get('course_id') || '', 'All courses')}</select>
      <select id="q-mat"><option value="">All sheets</option>${mats.map((m) => `<option value="${m.id}" ${p.get('material_id') == m.id ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select>
      <input id="q-search" placeholder="Search…">
    </div>
    <div class="list" id="q-list">${list.length ? list.map((x) => `<div class="item" data-text="${esc((x.question + ' ' + x.topic).toLowerCase())}">
      <div class="grow"><div class="title">${esc(x.question)}</div>
        <div class="row small muted"><span class="badge gray">${esc(x.topic)}</span> ${status(x)} <span>✓ ${x.correct_count} · ✗ ${x.wrong_count}</span>
        ${x.material_title ? `<span>${esc(x.material_title)}</span>` : ''} ${x.source === 'ai' ? '<span>AI</span>' : ''}</div>
        <div class="small" style="margin-top:4px">Answer: <b>${esc(x.choices[x.answer_index])}</b></div></div>
      <button class="btn ghost small" data-edit="${x.id}">Edit</button>
      <button class="btn danger small" data-del="${x.id}">✕</button></div>`).join('') : '<div class="empty">No questions yet.</div>'}</div>`;
  const setP = (k, v) => { const n = hashParams(); v ? n.set(k, v) : n.delete(k); location.hash = '#/questions?' + n; };
  $('#q-course').onchange = (e) => setP('course_id', e.target.value);
  $('#q-mat').onchange = (e) => setP('material_id', e.target.value);
  $('#q-search').oninput = (e) => { const s = e.target.value.toLowerCase(); $$('#q-list .item').forEach((it) => it.classList.toggle('hidden', !it.dataset.text.includes(s))); };
  $('#add').onclick = () => questionForm({ material_id: p.get('material_id'), course_id: p.get('course_id') }, questions);
  $$('[data-edit]').forEach((b) => (b.onclick = () => questionForm(list.find((x) => x.id == b.dataset.edit), questions)));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete this question?')) { await DEL(`/api/questions/${b.dataset.del}`); questions(); } }));
}

function questionForm(q = {}, after) {
  const choices = q.choices?.length ? [...q.choices] : ['', '', '', ''];
  while (choices.length < 4) choices.push('');
  const ai = q.answer_index ?? 0;
  openModal(`<h2>${q.id ? 'Edit' : 'New'} question</h2>
    <form class="form" id="qf">
      <div><label>Question</label><textarea name="question" required rows="3">${esc(q.question)}</textarea></div>
      <div class="two"><div><label>Topic</label><input name="topic" value="${esc(q.topic || '')}" placeholder="e.g. Chapter 2 – Mitosis"></div>
        <div><label>Course</label><select name="course_id">${courseOpts(q.course_id)}</select></div></div>
      <div><label>Choices — select the correct one</label>
        ${choices.map((c, i) => `<div class="row" style="margin-bottom:6px;flex-wrap:nowrap"><input type="radio" class="check" name="answer_index" value="${i}" ${i === ai ? 'checked' : ''}>
          <input name="choice" value="${esc(c)}" placeholder="Choice ${'ABCD'[i] || i + 1}${i < 2 ? '' : ' (optional)'}"></div>`).join('')}</div>
      <div><label>Explanation (shown after answering)</label><textarea name="explanation" rows="2">${esc(q.explanation)}</textarea></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div>
    </form>`, (m) => {
    $('#qf', m).onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const raw = fd.getAll('choice'); const sel = +fd.get('answer_index');
      if (!raw[sel]?.trim()) return toast('The correct choice cannot be empty', true);
      // drop empty choices while keeping the correct index aligned
      const kept = raw.map((c, i) => ({ c: c.trim(), i })).filter((x) => x.c);
      const body = { question: fd.get('question'), topic: fd.get('topic'), course_id: fd.get('course_id'), explanation: fd.get('explanation'),
        choices: kept.map((x) => x.c), answer_index: kept.findIndex((x) => x.i === sel), material_id: q.material_id || null };
      try { q.id ? await PUT(`/api/questions/${q.id}`, body) : await POST('/api/questions', body); closeModal(); toast('Saved'); after && after(); }
      catch (err) { fail(err); }
    };
  });
}

// =====================================================================
// PLANNER — calendar
// =====================================================================
let calMonth = new Date(); calMonth.setDate(1);
async function planner() {
  const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // Monday start
  const end = new Date(start); end.setDate(start.getDate() + 41);
  const [items, all] = await Promise.all([GET(`/api/plan?from=${ymd(start)}&to=${ymd(end)}`), GET('/api/tasks')]);
  const byDay = {};
  for (const t of all) if (t.due_at) (byDay[ymd(new Date(t.due_at))] ||= { tasks: [], plans: [] }).tasks.push(t);
  for (const p of items) (byDay[p.date] ||= { tasks: [], plans: [] }).plans.push(p);
  const tests = all.filter((t) => t.status !== 'done' && t.due_at && new Date(t.due_at) > Date.now()).slice(0, 8);
  const today = ymd(new Date());
  const cells = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = ymd(d); const e = byDay[k] || { tasks: [], plans: [] };
    cells.push(`<div class="day ${d.getMonth() !== calMonth.getMonth() ? 'other' : ''} ${k === today ? 'today' : ''}" data-day="${k}">
      <div class="num">${d.getDate()}</div>
      ${e.tasks.map((t) => `<div class="ev" style="background:${esc(t.course_color || '#5b5bd6')}" title="${esc(t.title)}">${t.type === 'exam' ? '🔴' : t.type === 'quiz' ? '🟡' : '📝'} ${esc(t.title)}</div>`).join('')}
      ${e.plans.map((p) => `<div class="ev plan ${p.done ? 'done' : ''}" title="${esc(p.title)}">${esc(p.title)}</div>`).join('')}</div>`);
  }
  if (away('planner')) return;
  view.innerHTML = `
    <div class="page-head"><div><h1>Planner</h1><div class="muted">Deadlines and study sessions in one calendar. Click a day to add a session.</div></div>
      <div class="row"><button class="btn ghost" id="prev">‹</button><b style="min-width:150px;text-align:center">${calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>
      <button class="btn ghost" id="next">›</button><button class="btn ghost small" id="today">Today</button></div></div>
    <div class="split">
      <div class="cal-wrap"><div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div></div>
      <div class="card"><h3>Upcoming deadlines</h3><div class="small muted" style="margin-bottom:10px">Auto-plan study sessions until the due date.</div>
        <div class="list">${tests.length ? tests.map((t) => `<div><div class="row spread"><span class="badge ${t.type}">${t.type}</span><button class="btn soft small" data-plan-task="${t.id}">Make study plan</button></div>
          <div style="margin-top:4px"><b>${esc(t.title)}</b></div><div class="small">${fmtDue(t.due_at)}</div></div>`).join('<hr style="border:0;border-top:1px solid var(--line);width:100%">')
          : '<div class="muted small">No upcoming deadlines.</div>'}</div></div></div>`;
  $('#prev').onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); planner(); };
  $('#next').onclick = () => { calMonth.setMonth(calMonth.getMonth() + 1); planner(); };
  $('#today').onclick = () => { calMonth = new Date(); calMonth.setDate(1); planner(); };
  $$('[data-plan-task]').forEach((b) => (b.onclick = () => planTaskDialog(all.find((t) => t.id == b.dataset.planTask))));
  $$('[data-day]').forEach((c) => (c.onclick = () => dayDialog(c.dataset.day, byDay[c.dataset.day] || { tasks: [], plans: [] })));
}

function dayDialog(day, e) {
  const label = new Date(day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  openModal(`<h2>${label}</h2>
    ${e.tasks.length ? `<h3>Due</h3><div class="list" style="margin-bottom:14px">${e.tasks.map(taskRowSimple).join('')}</div>` : ''}
    <h3>Study sessions</h3>
    <div class="list" id="day-plans" style="margin-bottom:14px">${e.plans.length ? e.plans.map((p) => `<div class="row" style="flex-wrap:nowrap">${planRow(p)}<button class="btn danger small" data-pdel="${p.id}">✕</button></div>`).join('') : '<div class="muted small">None yet.</div>'}</div>
    <form class="form" id="pf"><div><label>Add session</label><input name="title" required placeholder="e.g. Review chapter 3 + practice MCQs"></div>
      <div class="two"><div><label>Course</label><select name="course_id">${courseOpts('')}</select></div><div><label>Minutes</label><input type="number" name="minutes" value="45"></div></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" onclick="closeModal()">Close</button><button class="btn">Add</button></div></form>`, (m) => {
    const refresh = async () => { closeModal(); await planner(); };
    bindPlanRows(m, refresh);
    $$('[data-pdel]', m).forEach((b) => (b.onclick = async () => { await DEL(`/api/plan/${b.dataset.pdel}`); refresh(); }));
    $('#pf', m).onsubmit = async (ev) => {
      ev.preventDefault();
      try { await POST('/api/plan', { ...Object.fromEntries(new FormData(ev.target)), date: day }); refresh(); } catch (err) { fail(err); }
    };
  });
}

// =====================================================================
// FOCUS TIMER (Pomodoro) — keeps running while you switch pages
// =====================================================================
const T = JSON.parse(localStorage.getItem('timer') || 'null') || { phase: 'focus', running: false, endAt: 0, remaining: 25 * 60, focusMin: 25, breakMin: 5, course: '', rounds: 0 };
const saveT = () => localStorage.setItem('timer', JSON.stringify(T));
const fmtClock = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
const timeLeft = () => (T.running ? Math.max(0, (T.endAt - Date.now()) / 1000) : T.remaining);

setInterval(async () => {
  const mini = $('#timer-mini');
  if (T.running && timeLeft() <= 0) {
    const finished = T.phase;
    if (finished === 'focus') {
      T.rounds++;
      if (ME) POST('/api/study-sessions', { minutes: T.focusMin, course_id: T.course || null }).catch(() => {});
      notify('Focus session done! 🎉', `Logged ${T.focusMin} minutes. Take a ${T.breakMin}-minute break.`);
      T.phase = 'break'; T.remaining = T.breakMin * 60;
    } else {
      notify('Break over', 'Ready for another focus session?');
      T.phase = 'focus'; T.remaining = T.focusMin * 60;
    }
    T.running = false; saveT();
    if (location.hash.startsWith('#/focus')) focus();
  }
  const top = $('#top-timer');
  if (T.running || T.remaining !== T.focusMin * 60 || T.phase === 'break') {
    mini.classList.remove('hidden');
    mini.textContent = `${T.phase === 'focus' ? 'Focus' : 'Break'} ${fmtClock(timeLeft())}${T.running ? '' : ' (paused)'}`;
    top.classList.remove('hidden');
    top.textContent = `${fmtClock(timeLeft())}${T.running ? '' : ' (paused)'}`;
  } else { mini.classList.add('hidden'); top.classList.add('hidden'); }
  const clock = $('#clock'); if (clock) clock.textContent = fmtClock(timeLeft());
}, 500);
$('#timer-mini').onclick = () => (location.hash = '#/focus');
$('#top-timer').onclick = () => (location.hash = '#/focus');

function focus() {
  view.innerHTML = `<div class="practice">
    <div class="page-head"><div><h1>Focus Timer</h1><div class="muted">Pomodoro sessions are logged to your study time automatically.</div></div></div>
    <div class="card timer">
      <div class="phase ${T.phase === 'break' ? 'break' : ''}">${T.phase === 'focus' ? 'Focus' : 'Break'}</div>
      <div class="clock" id="clock">${fmtClock(timeLeft())}</div>
      <div class="row" style="justify-content:center;margin:14px 0">
        <button class="btn big" id="start">${T.running ? '⏸ Pause' : '▶ Start'}</button>
        <button class="btn ghost big" id="reset">↺ Reset</button>
        <button class="btn ghost big" id="skip">⏭ Skip</button></div>
      <div class="muted small">Completed focus rounds: <b>${T.rounds}</b></div></div>
    <div class="card form" style="margin-top:16px">
      <div class="two"><div><label>Studying for</label><select id="t-course">${courseOpts(T.course, 'General')}</select></div>
        <div class="two"><div><label>Focus (min)</label><input type="number" id="t-focus" value="${T.focusMin}" min="1" max="180"></div>
        <div><label>Break (min)</label><input type="number" id="t-break" value="${T.breakMin}" min="1" max="60"></div></div></div></div></div>`;
  $('#start').onclick = () => {
    if (T.running) { T.remaining = timeLeft(); T.running = false; }
    else { T.endAt = Date.now() + timeLeft() * 1000; T.running = true; if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }
    saveT(); focus();
  };
  $('#reset').onclick = () => { T.running = false; T.phase = 'focus'; T.remaining = T.focusMin * 60; saveT(); focus(); };
  $('#skip').onclick = () => { T.running = false; T.phase = T.phase === 'focus' ? 'break' : 'focus'; T.remaining = (T.phase === 'focus' ? T.focusMin : T.breakMin) * 60; saveT(); focus(); };
  $('#t-course').onchange = (e) => { T.course = e.target.value; saveT(); };
  const setLen = () => {
    T.focusMin = Math.max(1, +$('#t-focus').value || 25); T.breakMin = Math.max(1, +$('#t-break').value || 5);
    if (!T.running) T.remaining = (T.phase === 'focus' ? T.focusMin : T.breakMin) * 60;
    saveT(); $('#clock').textContent = fmtClock(timeLeft());
  };
  $('#t-focus').onchange = setLen; $('#t-break').onchange = setLen;
}

// =====================================================================
// COURSES
// =====================================================================
// linked Moodle course / Classroom classes
const SRC_LABEL = { moodle: 'Moodle', lecture: 'Lecture', section: 'Section', lab: 'Lab' };
const srcChip = (s) => `<span class="src-chip ${esc(s.type)}"><b>${SRC_LABEL[s.type] || s.type}</b> ${esc(s.name)}</span>`;
const srcRow = (s) => `<div class="row src-row" style="flex-wrap:nowrap;margin-bottom:6px">
  <select style="width:auto">${Object.entries(SRC_LABEL).map(([k, v]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
  <input value="${esc(s.name)}" placeholder="e.g. FOE_PHY111_ Fall 2026">
  <button type="button" class="btn danger small" data-src-del>✕</button></div>`;

// short summary like "2 assignments · 1 quiz · 3 sheets"
function courseCounts(c) {
  const parts = [[c.assignments, 'assignment'], [c.quizzes, 'quiz'], [c.exams, 'exam'], [c.sheets, 'sheet']]
    .filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : w === 'quiz' ? 'zes' : 's'}`);
  return parts.length ? parts.join(' · ') : 'Empty';
}

async function courses(id) {
  if (id) return courseDetail(id);
  await loadCourses();
  const o = await GET('/api/courses/overview');
  const u = o.uncategorized;
  const hasLoose = u.assignments + u.quizzes + u.exams + u.sheets > 0;
  if (away('courses')) return;
  view.innerHTML = `
    <div class="page-head"><div><h1>Courses</h1><div class="muted">Every assignment, quiz, exam and study sheet lives inside its course. Open one to see everything.</div></div></div>
    ${can('courses') ? `<form class="card row" id="cf" style="margin-bottom:16px;flex-wrap:nowrap">
      <input name="name" required placeholder="New course name, e.g. Organic Chemistry">
      <input type="color" name="color" value="#5b5bd6" style="width:54px;padding:3px" title="Course colour">
      <button class="btn">Add</button></form>` : ''}
    <div class="grid g3">${o.courses.map((c) => `<a class="card course-card" href="#/courses/${c.id}" style="border-top:4px solid ${esc(c.color)}">
      <div class="row spread"><h3 style="margin:0">${esc(c.name)}</h3><span class="muted">›</span></div>
      ${c.code || c.sources?.length ? `<div class="small muted" style="margin-top:4px">${[c.code, ...(c.sources || []).filter((s) => s.type !== 'moodle').map((s) => SRC_LABEL[s.type])].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      <div class="course-chips">
        <span class="chip">${c.assignments} assignment${c.assignments === 1 ? '' : 's'}</span>
        <span class="chip">${c.quizzes} quiz${c.quizzes === 1 ? '' : 'zes'}</span>
        <span class="chip">${c.exams} exam${c.exams === 1 ? '' : 's'}</span>
        <span class="chip">${c.sheets} sheet${c.sheets === 1 ? '' : 's'}</span>
      </div>
      ${c.questions ? `<div class="small muted" style="margin-top:8px">${c.mastered}/${c.questions} MCQs mastered</div>${bar((c.mastered / c.questions) * 100, 'green')}` : ''}
    </a>`).join('')
      || `<div class="card empty" style="grid-column:1/-1">${can('courses') ? 'Add the first course above.' : 'No courses yet.'}</div>`}
    ${hasLoose ? `<a class="card course-card" href="#/courses/none" style="border-top:4px solid #9ca3af">
      <div class="row spread"><h3 style="margin:0">Not in a course</h3><span class="muted">›</span></div>
      <div class="small muted" style="margin-top:8px">${courseCounts(u)}. ${can('tasks') || can('sheets') ? 'Open to move them into a course.' : ''}</div></a>` : ''}</div>`;
  $('#cf')?.addEventListener('submit', async (e) => { e.preventDefault(); try { await POST('/api/courses', Object.fromEntries(new FormData(e.target))); await loadCourses(); courses(); } catch (err) { fail(err); } });
}

let courseTab = 'all';
async function courseDetail(id) {
  await loadCourses();
  const d = await GET(`/api/courses/${id}/content`);
  const c = d.course, loose = id === 'none';
  const by = (type) => d.tasks.filter((t) => t.type === type);
  const groups = [
    { key: 'assignment', icon: '📝', title: 'Assignments', items: by('assignment') },
    { key: 'quiz', icon: '❓', title: 'Quizzes', items: by('quiz') },
    { key: 'exam', icon: '🎓', title: 'Exams', items: by('exam') },
  ];
  const tabs = [['all', 'All', d.tasks.length + d.materials.length], ...groups.map((g) => [g.key, g.title, g.items.length]), ['sheets', 'Study sheets', d.materials.length]];
  if (!tabs.some(([k]) => k === courseTab)) courseTab = 'all';
  const show = (k) => courseTab === 'all' || courseTab === k;
  const sheetCard = (m) => `<div class="item">
    <span class="badge gray">${m.kind.toUpperCase()}</span>
    <div class="grow"><div class="title">${esc(m.title)}</div>
      <div class="small muted">${m.question_count} MCQs${m.question_count ? ` · you've mastered ${m.mastered}` : ''} · added ${new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}</div></div>
    <a class="btn small" href="#/materials/${m.id}">Open</a>
    ${m.question_count ? `<a class="btn soft small" href="#/practice?material_id=${m.id}">Practice</a>` : ''}
    ${can('sheets') ? `<button class="btn ghost small" data-move-sheet="${m.id}" title="Move to another course">Move</button><button class="btn danger small" data-del-sheet="${m.id}">✕</button>` : ''}</div>`;

  if (away('courses')) return;
  view.innerHTML = `
    <div class="page-head"><div><a href="#/courses" class="small">← All courses</a>
      <h1 class="row" style="gap:10px"><span class="dot" style="background:${esc(c.color)};width:16px;height:16px"></span>${esc(c.name)}${c.code ? ` <span class="code-chip">${esc(c.code)}</span>` : ''}</h1>
      <div class="muted small">${d.tasks.length} item${d.tasks.length === 1 ? '' : 's'} · ${d.materials.length} study sheet${d.materials.length === 1 ? '' : 's'}${d.questions.total ? ` · ${d.questions.mastered}/${d.questions.total} MCQs mastered` : ''}</div>
      ${c.sources?.length ? `<div class="src-list">${c.sources.map(srcChip).join('')}</div>` : ''}</div>
      <div class="row">${!loose && d.questions.total ? `<a class="btn" href="#/practice?course_id=${c.id}">Practice this course</a>` : ''}
        ${can('courses') && !loose ? `<button class="btn ghost" id="edit-course">Edit</button>` : ''}</div></div>
    <div class="tabs">${tabs.map(([k, label, n]) => `<button data-ctab="${k}" class="${courseTab === k ? 'active' : ''}">${label} <span class="muted">${n}</span></button>`).join('')}</div>
    ${groups.map((g) => (show(g.key) ? `<section class="course-section">
      <div class="row spread"><h2>${g.title} <span class="muted small">${g.items.length}</span></h2></div>
      <div class="list">${g.items.length ? g.items.map(taskRow).join('') : `<div class="empty small">No ${g.title.toLowerCase()} yet.</div>`}</div></section>` : '')).join('')}
    ${show('sheets') ? `<section class="course-section">
      <div class="row spread"><h2>Study sheets <span class="muted small">${d.materials.length}</span></h2></div>
      <div class="list">${d.materials.length ? d.materials.map(sheetCard).join('') : '<div class="empty small">No study sheets yet.</div>'}</div></section>` : ''}`;

  const refresh = () => courseDetail(id);
  $$('[data-ctab]').forEach((b) => (b.onclick = () => { courseTab = b.dataset.ctab; refresh(); }));
  bindTaskRows(view, d.tasks, refresh);
  $$('[data-del-sheet]').forEach((b) => (b.onclick = async () => {
    if (confirm('Delete this sheet and all questions generated from it?')) { await DEL(`/api/materials/${b.dataset.delSheet}`).catch(fail); refresh(); }
  }));
  $$('[data-move-sheet]').forEach((b) => (b.onclick = () => openModal(`<h2>Move sheet to…</h2>
    <div class="form"><select id="mv">${courseOpts(loose ? '' : c.id, 'Choose a course…')}</select>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn" id="mv-go">Move</button></div></div>`, (m) => {
    $('#mv-go', m).onclick = async () => {
      if (!$('#mv', m).value) return toast('Choose a course', true);
      try { await PATCH(`/api/materials/${b.dataset.moveSheet}`, { course_id: $('#mv', m).value }); closeModal(); toast('Sheet moved'); refresh(); } catch (e) { fail(e); }
    };
  })));
  $('#edit-course')?.addEventListener('click', () => openModal(`<h2>Edit course</h2>
    <form class="form" id="ecf">
      <div class="two"><div><label>Name</label><input name="name" required value="${esc(c.name)}"></div>
        <div><label>Code</label><input name="code" value="${esc(c.code || '')}" placeholder="e.g. PHY-111"></div></div>
      <div><label>Colour</label><input type="color" name="color" value="${esc(c.color)}" style="width:70px;padding:3px"></div>
      <div><label>Linked Moodle course & Classroom classes</label>
        <div class="small muted" style="margin-bottom:6px">Moodle items and Classroom emails with these names are filed under this course. Use the exact name shown in Moodle/Classroom.</div>
        <div id="src-rows">${(c.sources || []).map(srcRow).join('')}</div>
        <button type="button" class="btn ghost small" id="src-add">+ Add linked class</button></div>
      <div class="row spread"><button type="button" class="btn danger" id="del-course">Delete course</button>
        <div class="row"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div></div></form>`, (m) => {
    const bindRows = () => $$('[data-src-del]', m).forEach((b) => (b.onclick = () => b.closest('.src-row').remove()));
    bindRows();
    $('#src-add', m).onclick = () => { $('#src-rows', m).insertAdjacentHTML('beforeend', srcRow({ type: 'lecture', name: '' })); bindRows(); };
    $('#ecf', m).onsubmit = async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.sources = $$('.src-row', m).map((r) => ({ type: $('select', r).value, name: $('input', r).value.trim() })).filter((s) => s.name);
      try { await PUT(`/api/courses/${c.id}`, b); closeModal(); toast('Saved'); refresh(); } catch (err) { fail(err); }
    };
    $('#del-course', m).onclick = async () => {
      if (!confirm('Delete this course? Its assignments, quizzes, exams and sheets are kept, but move to “Not in a course”.')) return;
      try { await DEL(`/api/courses/${c.id}`); closeModal(); toast('Course deleted'); location.hash = '#/courses'; } catch (err) { fail(err); }
    };
  }));
}

// =====================================================================
// TIMETABLE — weekly classes per section; alternating classes (e.g. labs) use Week A / Week B
// =====================================================================
let ttSection = null;
async function timetablePage() {
  const [tt] = await Promise.all([GET('/api/timetable'), loadSections(), loadCourses()]);
  if (!SECTIONS.some((x) => x.id == ttSection)) ttSection = ME.section_id || SECTIONS[0]?.id;
  const now = new Date(), wk = weekType(now, tt.week_a), other = wk === 'a' ? 'b' : 'a';
  const slots = tt.slots.filter((x) => x.section_id == ttSection);
  const days = [6, 0, 1, 2, 3, 4, 5].filter((d) => (d >= 0 && d <= 4) || slots.some((x) => x.day === d)); // Sun–Thu always; Fri/Sat only if used
  const alt = (w) => [...new Set(slots.filter((x) => x.weeks === w).map((x) => `${x.course_name || 'Class'} (${KIND_LABEL[x.kind].toLowerCase()})`))].join(', ');
  const hasAlt = slots.some((x) => x.weeks !== 'all');
  const slotCard = (x) => `<div class="tt-slot ${x.weeks !== 'all' && x.weeks !== wk ? 'off' : ''}" style="border-left-color:${esc(x.course_color || '#5b5bd6')}" ${isAdmin() ? `data-slot="${x.id}" title="Edit"` : ''}>
      <div class="tt-time">${x.start}–${x.end}</div>
      <div class="tt-name">${esc(x.course_name || 'Class')}</div>
      <div class="tt-sub"><span class="src-chip ${x.kind === 'tutorial' ? 'section' : x.kind}"><b>${KIND_LABEL[x.kind] || x.kind}</b></span>
        ${x.weeks !== 'all' ? `<span class="badge gray">Week ${x.weeks.toUpperCase()}</span>` : ''} ${x.location ? `<span class="muted">${esc(x.location)}</span>` : ''}</div></div>`;
  if (away('timetable')) return;
  view.innerHTML = `
    <div class="page-head"><div><h1>Timetable</h1><div class="muted">Weekly classes for each section.</div></div>
      <div class="row">${SECTIONS.length > 1 ? `<select id="tt-sec" style="width:auto">${SECTIONS.map((x) => `<option value="${x.id}" ${x.id == ttSection ? 'selected' : ''}>${esc(x.name)}${x.id === ME.section_id ? ' (mine)' : ''}</option>`).join('')}</select>` : ''}
        ${isAdmin() ? `<button class="btn" id="tt-add">${icon('plus')}Add class</button>` : ''}</div></div>
    ${hasAlt || isAdmin() ? `<div class="card week-card"><div class="row spread">
      <div><b>This week is Week ${wk.toUpperCase()}</b>${alt(wk) ? ` — ${esc(alt(wk))}` : ''}
        <div class="small muted">Next week is Week ${other.toUpperCase()}${alt(other) ? ` — ${esc(alt(other))}` : ''}. Classes that alternate (like labs) are marked Week A or Week B.</div></div>
      ${isAdmin() ? '<button class="btn ghost small" id="tt-swap" title="Use this if the weeks are the wrong way round">Swap A/B</button>' : ''}</div></div>` : ''}
    <div class="tt-grid">${days.map((d) => { const list = slots.filter((x) => x.day === d);
      return `<div class="tt-day ${d === now.getDay() ? 'today' : ''}"><h3>${DAYS[d]}${d === now.getDay() ? ' <span class="badge">today</span>' : ''}</h3>
        ${list.length ? list.map(slotCard).join('') : '<div class="tt-none">No classes</div>'}</div>`; }).join('')}</div>
    ${slots.length ? '' : `<p class="muted small" style="margin-top:12px">No classes added for this section yet.${isAdmin() ? ' Use “Add class” — you can add one class to several sections at once.' : ' An admin can add them.'}</p>`}`;
  const tsec = $('#tt-sec'); if (tsec) tsec.onchange = () => { ttSection = Number(tsec.value); timetablePage(); };
  $('#tt-add')?.addEventListener('click', () => slotForm({ section_id: ttSection }));
  $$('[data-slot]').forEach((el) => (el.onclick = () => slotForm(tt.slots.find((x) => x.id == el.dataset.slot))));
  $('#tt-swap')?.addEventListener('click', async () => {
    // make the current week the other type by moving the "week A" reference
    const ref = weekStart(now); if (wk === 'a') ref.setDate(ref.getDate() + 7);
    try { await PUT('/api/timetable/week', { week_a: ymd(ref) }); toast(`This week is now Week ${other.toUpperCase()}`); timetablePage(); } catch (e) { fail(e); }
  });
}

function slotForm(x = {}) {
  const edit = !!x.id;
  openModal(`<h2>${edit ? 'Edit class' : 'Add class'}</h2>
    ${COURSES.length ? '' : noCoursesYet()}
    <form class="form" id="sf2">
      <div class="two"><div><label>Course</label><select name="course_id" required>${courseOpts(x.course_id, 'Choose a course…')}</select></div>
        <div><label>Type</label><select name="kind">${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}" ${x.kind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div></div>
      <div class="two"><div><label>Day</label><select name="day">${[6, 0, 1, 2, 3, 4, 5].map((d) => `<option value="${d}" ${(x.day ?? 0) === d ? 'selected' : ''}>${DAYS[d]}</option>`).join('')}</select></div>
        <div class="two"><div><label>Starts</label><input type="time" name="start" required value="${esc(x.start || '09:00')}"></div>
          <div><label>Ends</label><input type="time" name="end" required value="${esc(x.end || '10:30')}"></div></div></div>
      <div class="two"><div><label>Room (optional)</label><input name="location" value="${esc(x.location || '')}" placeholder="e.g. Hall B2"></div>
        <div><label>How often</label><select name="weeks"><option value="all" ${(x.weeks || 'all') === 'all' ? 'selected' : ''}>Every week</option>
          <option value="a" ${x.weeks === 'a' ? 'selected' : ''}>Week A only (alternating)</option><option value="b" ${x.weeks === 'b' ? 'selected' : ''}>Week B only (alternating)</option></select></div></div>
      ${edit ? '' : `<div><label>For which sections</label><div class="row">${SECTIONS.map((sec) => `<label class="perm-opt" style="flex:0 1 auto"><input type="checkbox" class="check" name="sec" value="${sec.id}" ${sec.id == x.section_id ? 'checked' : ''}> ${esc(sec.name)}</label>`).join('')}</div></div>`}
      <div class="row spread"><div>${edit ? `<button type="button" class="btn danger" id="sf2-del">${icon('trash')}Delete</button>` : ''}</div>
        <div class="row"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div></div>
    </form>`, (m) => {
    $('#sf2', m).onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target); const b = Object.fromEntries(fd);
      b.section_ids = fd.getAll('sec'); delete b.sec;
      if (!edit && !b.section_ids.length) return toast('Choose at least one section', true);
      try { edit ? await PUT(`/api/timetable/${x.id}`, b) : await POST('/api/timetable', b); closeModal(); toast('Saved'); timetablePage(); } catch (err) { fail(err); }
    };
    $('#sf2-del', m)?.addEventListener('click', async () => {
      if (!confirm('Remove this class from the timetable?')) return;
      try { await DEL(`/api/timetable/${x.id}`); closeModal(); timetablePage(); } catch (err) { fail(err); }
    });
  });
}

// =====================================================================
// USERS (admins) — members & sections, permissions, connections in one tab
// =====================================================================
const USER_TABS = [['members', 'Members & sections'], ['permissions', 'Permissions'], ['connections', 'Connections']];
const usersTabs = (active) => `
  <div class="page-head"><div><h1>Users</h1><div class="muted">Members, sections, permissions and connections. Only admins see this tab.</div></div></div>
  <div class="seg">${USER_TABS.map(([k, label]) => `<a href="#/users/${k}" class="${active === k ? 'active' : ''}">${label}${k === 'members' && PENDING ? `<span class="seg-n alert">${PENDING}</span>` : ''}</a>`).join('')}</div>`;
function usersPage(sub) { return sub === 'permissions' ? permissionsPage() : sub === 'connections' ? connectionsPage() : classPage(); }

// =====================================================================
// MEMBERS & SECTIONS
// =====================================================================
async function classPage() {
  const c = await GET('/api/admin/class');
  const secOpts = (sel) => c.sections.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  if (away('users')) return;
  view.innerHTML = `
    ${usersTabs('members')}
    <div class="card requests-card" style="margin-bottom:16px" id="requests">
      <h2>Join requests ${c.pending.length ? `<span class="badge high">${c.pending.length}</span>` : ''}</h2>
      ${c.pending.length ? `<p class="small muted">These people used the invite code. They can't sign in until you approve them. Check the section before approving.</p>
        <div class="list">${c.pending.map((p) => `<div class="row request-row">
          <div style="flex:1;min-width:160px"><b>${esc(p.name)}</b><div class="small muted">@${esc(p.username)} · asked ${new Date(p.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</div></div>
          <select data-req-sec="${p.id}" style="width:auto" title="Section">${secOpts(p.section_id)}</select>
          <button class="btn small" data-approve="${p.id}">✓ Approve</button>
          <button class="btn danger small" data-reject="${p.id}">✕ Reject</button></div>`).join('')}</div>`
        : '<div class="small muted">No one is waiting. New join requests will appear here.</div>'}
    </div>
    <div class="grid g2" style="margin-bottom:16px">
      <div class="card"><h2>Invite classmates</h2>
        <p class="small muted">Share this code. New students enter it on the sign-in page (“Join with an invite code”), pick their section and choose a username. You then approve them in <b>Join requests</b> above.</p>
        <div class="row"><code style="font-size:24px;font-weight:800;letter-spacing:3px">${esc(c.invite_code)}</code>
          <button class="btn soft small" id="copy">Copy</button><button class="btn ghost small" id="regen" title="Old code stops working">New code</button></div>
        <h3 style="margin-top:18px">Class name</h3>
        <form class="row" id="cn" style="flex-wrap:nowrap"><input name="name" value="${esc(c.name)}"><button class="btn small">Save</button></form></div>
      <div class="card"><h2>Sections</h2>
        <div class="list">${c.sections.map((s) => `<div class="row" style="flex-wrap:nowrap"><input value="${esc(s.name)}" data-sname="${s.id}">
          <span class="small muted" style="white-space:nowrap">${s.members} members</span>
          <button class="btn danger small" data-sdel="${s.id}">✕</button></div>`).join('')}</div>
        <form class="row" id="sf" style="margin-top:10px;flex-wrap:nowrap"><input name="name" required placeholder="New section, e.g. Section 4"><button class="btn small">Add</button></form></div>
    </div>
    <div class="card"><div class="row spread"><h2 style="margin:0">Members (${c.members.length})</h2><a class="btn soft small" href="#/users/permissions">Roles & permissions →</a></div>
      <div class="list" style="margin-top:12px">${c.members.map((m) => `<div class="row" style="border-bottom:1px solid var(--line);padding-bottom:8px">
        <div style="flex:1;min-width:0"><b>${esc(m.name)}</b> ${m.id === ME.id ? '<span class="small muted">(you)</span>' : ''} ${m.role === 'admin' ? '<span class="badge">admin</span>' : ''}<div class="small muted">@${esc(m.username)}</div></div>
        <select data-msec="${m.id}" style="width:auto">${secOpts(m.section_id)}</select>
        ${m.id === ME.id ? '' : `<button class="btn danger small" data-mdel="${m.id}" title="Remove from class">✕</button>`}</div>`).join('')}</div></div>`;
  const run = async (p, msg) => { try { await p; if (msg) toast(msg); } catch (e) { fail(e); } classPage(); };
  $('#copy').onclick = () => navigator.clipboard.writeText(c.invite_code).then(() => toast('Code copied'));
  $('#regen').onclick = () => confirm('Make a new invite code? The old one will stop working.') && run(POST('/api/admin/invite-code'), 'New code created');
  $('#cn').onsubmit = (e) => { e.preventDefault(); run(PUT('/api/admin/class', { name: e.target.name.value }).then(boot), 'Saved'); };
  $('#sf').onsubmit = (e) => { e.preventDefault(); run(POST('/api/admin/sections', { name: e.target.name.value }), 'Section added'); };
  $$('[data-sname]').forEach((i) => (i.onchange = () => run(PUT(`/api/admin/sections/${i.dataset.sname}`, { name: i.value }), 'Renamed')));
  $$('[data-sdel]').forEach((b) => (b.onclick = () => confirm('Delete this section? Its members will need to pick a new one, and its due dates are removed.') && run(DEL(`/api/admin/sections/${b.dataset.sdel}`), 'Section deleted')));
  $$('[data-msec]').forEach((s) => (s.onchange = () => run(PATCH(`/api/admin/members/${s.dataset.msec}`, { section_id: s.value }), 'Section changed')));
  $$('[data-mdel]').forEach((b) => (b.onclick = () => confirm('Remove this member from the class? Their account and progress are deleted.') && run(DEL(`/api/admin/members/${b.dataset.mdel}`), 'Member removed')));
  $$('[data-approve]').forEach((b) => (b.onclick = () => run(POST(`/api/admin/members/${b.dataset.approve}/approve`, { section_id: $(`[data-req-sec="${b.dataset.approve}"]`).value }).then(updatePendingBadge), 'Approved — they can sign in now')));
  $$('[data-reject]').forEach((b) => (b.onclick = () => confirm('Reject this join request? Their request is deleted; they would need the invite code to ask again.') && run(DEL(`/api/admin/members/${b.dataset.reject}`).then(updatePendingBadge), 'Request rejected')));
}

// =====================================================================
// PERMISSIONS (admins only) — who can upload, add tasks, write questions…
// =====================================================================
const PERM_ICONS = {};
const PRESETS = {
  student: { label: 'Student', perms: [] },
  uploader: { label: 'Uploader', perms: ['sheets', 'questions'] },
  editor: { label: 'Editor', perms: ['sheets', 'questions', 'tasks', 'courses'] },
};
let permFilter = '';
async function permissionsPage() {
  const c = await GET('/api/admin/class');
  const keys = Object.keys(c.permission_list);
  const q = permFilter.toLowerCase();
  const members = c.members.filter((m) => !q || (m.name + ' ' + m.username + ' ' + (m.section_name || '')).toLowerCase().includes(q));
  const counts = Object.fromEntries(keys.map((k) => [k, c.members.filter((m) => m.perms.includes(k)).length]));
  if (away('users')) return;
  view.innerHTML = `
    ${usersTabs('permissions')}
    <div class="card" style="margin-bottom:16px">
      <h3>What each permission allows</h3>
      <div class="perm-legend">${keys.map((k) => `<div><span class="perm-ico">${PERM_ICONS[k] || '•'}</span><b>${esc(c.permission_list[k])}</b> <span class="small muted">· ${counts[k]} member${counts[k] === 1 ? '' : 's'}</span></div>`).join('')}
        <div><span class="perm-ico">⭐</span><b>Admin</b> <span class="small muted">— everything above, plus managing members, sections, the invite code and this page</span></div></div>
      <div class="small muted" style="margin-top:10px">Everyone can always read sheets, practise MCQs, track their own tasks and use the planner.</div>
    </div>
    <div class="filters"><input id="pf-search" placeholder="Search members…" value="${esc(permFilter)}"></div>
    <div class="list">${members.map((m) => {
      const isMe = m.id === ME.id, adm = m.role === 'admin';
      return `<div class="card perm-card">
        <div class="row spread" style="align-items:flex-start">
          <div style="min-width:0"><b>${esc(m.name)}</b> ${isMe ? '<span class="small muted">(you)</span>' : ''} ${adm ? '<span class="badge">⭐ admin</span>' : ''}
            <div class="small muted">@${esc(m.username)} · ${esc(m.section_name || 'No section')}</div></div>
          <label class="switch-row"><input type="checkbox" class="check" data-admin="${m.id}" ${adm ? 'checked' : ''} ${isMe ? 'disabled title="You can\'t remove your own admin role"' : ''}> Admin</label>
        </div>
        <div class="perm-grid">${keys.map((k) => `<label class="perm-opt ${adm ? 'locked' : ''}">
          <input type="checkbox" class="check" data-perm-user="${m.id}" data-perm-key="${k}" ${m.perms.includes(k) ? 'checked' : ''} ${adm ? 'disabled' : ''}>
          <span>${PERM_ICONS[k] || ''} ${esc(c.permission_list[k])}</span></label>`).join('')}</div>
        ${adm ? '<div class="small muted">Admins have every permission.</div>' : `<div class="row small" style="margin-top:8px">Quick set:
          ${Object.entries(PRESETS).map(([id, p]) => `<button class="btn ghost small" data-preset="${id}" data-uid="${m.id}">${p.label}</button>`).join('')}</div>`}
      </div>`; }).join('') || '<div class="empty">No members match.</div>'}</div>`;

  const save = async (uid, body, msg) => {
    try { await PATCH(`/api/admin/members/${uid}`, body); toast(msg); } catch (e) { fail(e); }
    if (uid == ME.id) await boot(); else permissionsPage();
  };
  $('#pf-search').oninput = (e) => { permFilter = e.target.value; clearTimeout(permissionsPage.t); permissionsPage.t = setTimeout(async () => { await permissionsPage(); const i = $('#pf-search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
  $$('[data-perm-user]').forEach((cb) => (cb.onchange = () => {
    const uid = cb.dataset.permUser;
    const perms = $$(`[data-perm-user="${uid}"]`).filter((x) => x.checked).map((x) => x.dataset.permKey);
    save(uid, { permissions: perms }, 'Permissions saved');
  }));
  $$('[data-preset]').forEach((b) => (b.onclick = () => save(b.dataset.uid, { permissions: PRESETS[b.dataset.preset].perms }, `Set to ${PRESETS[b.dataset.preset].label}`)));
  $$('[data-admin]').forEach((cb) => (cb.onchange = () => {
    if (cb.checked && !confirm('Make this member an admin? Admins can manage members, sections, the invite code and permissions.')) { cb.checked = false; return; }
    save(cb.dataset.admin, { role: cb.checked ? 'admin' : 'student' }, cb.checked ? 'Now an admin' : 'Admin role removed');
  }));
}

// =====================================================================
// REMINDERS — browser notifications while the app is open
// =====================================================================
// in-app pop-up only; real phone/PC notifications come from the server via push
function notify(title, body) { toast(`${title} — ${body}`); }
let remTimer = null;
async function checkReminders() {
  try {
    const r = await GET('/api/reminders');
    const sent = JSON.parse(localStorage.getItem('reminded') || '{}');
    for (const t of r.tasks) {
      const ms = new Date(t.due_at) - Date.now();
      const level = ms < 0 ? 'overdue' : ms < 3600000 ? '1h' : '24h';
      const key = `${t.id}:${level}:${t.due_at}`;
      if (sent[key]) continue;
      sent[key] = 1;
      notify(level === 'overdue' ? `Overdue: ${t.title}` : `Due ${level === '1h' ? 'within the hour' : 'within 24 hours'}: ${t.title}`,
        `${t.type} · ${new Date(t.due_at).toLocaleString()}`);
    }
    const today = ymd(new Date());
    if (r.reviews_due >= 5 && sent['reviews'] !== today) {
      sent['reviews'] = today; notify('Time to review', `${r.reviews_due} questions are due for review.`);
    }
    localStorage.setItem('reminded', JSON.stringify(sent));
  } catch {}
}
// admins: badge + notification when people are waiting for approval
let PENDING = 0;
async function updatePendingBadge() {
  if (!isAdmin()) return;
  try {
    const { n } = await GET('/api/admin/pending-count');
    PENDING = n;
    const link = $('#nav a[data-route="users"]');
    link.querySelector('.nav-badge')?.remove();
    if (n) link.insertAdjacentHTML('beforeend', ` <span class="nav-badge">${n}</span>`);
    $('#pending-banner')?.classList.toggle('hidden', !n);
    const pc = $('#pending-count'); if (pc) pc.textContent = n;
  } catch {}
}
function startReminders() {
  stopReminders(); checkReminders(); updatePendingBadge(); pollNotifications(true);
  remTimer = setInterval(() => { checkReminders(); updatePendingBadge(); pollNotifications(); }, 60000);
}
function stopReminders() { clearInterval(remTimer); }

// =====================================================================
// NOTIFICATIONS — bell, list page, push to phone/PC
// =====================================================================
let lastNotifId = 0;
const NOTIF_ICON = { task: 'check', sheet: 'file', due: 'clock', email: 'mail', moodle: 'link', join: 'users', info: 'bell' };
async function pollNotifications(first = false) {
  try {
    const { items, unread } = await GET('/api/notifications');
    $$('.bell-count').forEach((b) => { b.textContent = unread > 99 ? '99+' : unread; b.classList.toggle('hidden', !unread); });
    const newest = items[0]?.id || 0;
    // pop-up for things that arrived while the app is open (push shows them when it's closed)
    if (!first && newest > lastNotifId) items.filter((n) => n.id > lastNotifId && n.unread).slice(0, 3).reverse().forEach((n) => toast(n.title));
    lastNotifId = Math.max(lastNotifId, newest);
    if (location.hash.startsWith('#/notifications') && !first && newest > lastNotifId) notificationsPage();
  } catch {}
}
$$('[data-bell]').forEach((b) => (b.onclick = () => { location.hash = '#/notifications'; }));

const timeAgo = (s) => {
  const ms = Date.now() - new Date(s.replace(' ', 'T') + 'Z').getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

async function notificationsPage() {
  const { items } = await GET('/api/notifications');
  const state = pushState();
  if (away('notifications')) return;
  view.innerHTML = `
    <div class="page-head"><div><h1>Notifications</h1><div class="muted">New assignments, deadlines, Moodle updates and emails.</div></div>
      <div class="row">${state === 'on' ? `<button class="btn ghost small" id="push-test">Send a test</button><button class="btn ghost small" id="push-off">Turn off on this device</button>`
        : state === 'off' ? `<button class="btn" id="push-on">${icon('bell')}Turn on notifications</button>` : ''}
        ${items.length ? '<button class="btn ghost small" id="notif-clear">Clear all</button>' : ''}</div></div>
    ${state === 'off' ? '<div class="banner">Turn on notifications to get alerts on this phone or computer even when E-JUST is closed.</div>' : ''}
    ${state === 'blocked' ? '<div class="banner red">Notifications are blocked for this site in your browser settings. Allow them for this site, then reload.</div>' : ''}
    ${state === 'ios' ? '<div class="banner">On iPhone/iPad, first install E-JUST (Share → Add to Home Screen) and open it from the home screen — then you can turn on notifications here.</div>' : ''}
    ${state === 'unsupported' ? '<div class="banner">This browser can\'t show notifications when the app is closed. You\'ll still see them here.</div>' : ''}
    <div class="list">${items.length ? items.map((n) => {
      const d = n.details;
      // emails open inside E-JUST (details), app items go to their page; never link out to Gmail
      const href = d || /^https?:/.test(n.url) ? '#/notifications' : n.url || '#/notifications';
      return `<a class="notif ${n.unread ? 'unread' : ''}" href="${esc(href)}" ${d ? `data-detail="${n.id}"` : ''}>
        <span class="n-ic ${esc(n.kind)}">${icon(NOTIF_ICON[n.kind] || 'bell')}</span>
        <span class="n-body"><span class="n-title">${esc(n.title)}</span>
          ${d ? `<div class="n-meta">${[d.className, d.poster].filter(Boolean).map(esc).join(' · ')}</div>
            ${d.due ? `<div class="n-due">${icon('clock')}Due ${esc(d.due)}</div>` : ''}
            ${d.todo?.length ? `<ul class="n-todo">${d.todo.slice(0, 3).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : n.body ? `<div class="n-text">${esc(n.body)}</div>` : ''}`
            : n.body ? `<div class="n-text">${esc(n.body)}</div>` : ''}</span>
        <span class="n-side"><span class="n-time">${timeAgo(n.created_at)}</span>
          <button class="n-del" data-del-notif="${n.id}" title="Delete" aria-label="Delete notification">✕</button></span></a>`; }).join('')
      : '<div class="card empty">No notifications yet.</div>'}</div>`;
  $$('[data-detail]').forEach((a) => (a.onclick = (e) => { if (e.target.closest('[data-del-notif]')) return; e.preventDefault(); showMessage(items.find((n) => n.id == a.dataset.detail)); }));
  // delete one (only from my list) — removed from the page straight away
  $$('[data-del-notif]').forEach((b) => (b.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    const row = b.closest('.notif'); row.style.opacity = '.4';
    try { await DEL(`/api/notifications/${b.dataset.delNotif}`); row.remove(); if (!$('.notif')) notificationsPage(); }
    catch (err) { row.style.opacity = ''; fail(err); }
  }));
  $('#notif-clear')?.addEventListener('click', async () => {
    if (!confirm(`Delete all ${items.length} notifications from your list? (Classmates keep theirs.)`)) return;
    try { await DEL('/api/notifications/all'); toast('Notifications cleared'); notificationsPage(); } catch (err) { fail(err); }
  });
  await POST('/api/notifications/seen').catch(() => {});
  $$('.bell-count').forEach((b) => b.classList.add('hidden'));
  $('#push-on')?.addEventListener('click', async () => { await enablePush(); notificationsPage(); });
  $('#push-off')?.addEventListener('click', async () => { await disablePush(); notificationsPage(); });
  $('#push-test')?.addEventListener('click', async () => { await POST('/api/push/test').catch(fail); toast('Test sent — it should pop up in a few seconds'); });
}

// full message shown inside the app: what it says + what to do
function showMessage(n) {
  const d = n.details || {};
  openModal(`<div class="msg">
    ${d.courseName ? `<div class="msg-course">${icon('folder')}<b>${esc(d.courseName)}</b>${d.sourceType && SRC_LABEL[d.sourceType] ? ` <span class="src-chip ${esc(d.sourceType)}"><b>${SRC_LABEL[d.sourceType]}</b></span>` : ''}</div>` : ''}
    <div class="small muted">${[d.className, d.poster || d.sender].filter(Boolean).map(esc).join(' · ')} · ${timeAgo(n.created_at)}</div>
    <h2 style="margin:6px 0 10px">${esc(n.title)}</h2>
    ${d.due ? `<div class="msg-due">${icon('clock')}<b>Due:</b> ${esc(d.due)}</div>` : ''}
    ${d.todo?.length ? `<div class="msg-box"><h3>What to do</h3><ul>${d.todo.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : ''}
    ${d.text ? `<h3 style="margin-top:14px">Message</h3><div class="msg-text">${esc(d.text)}</div>` : ''}
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      ${d.courseId ? `<a class="btn ghost" href="#/courses/${d.courseId}" onclick="closeModal()">Open course</a>` : ''}
      <button class="btn" onclick="closeModal()">Close</button></div></div>`);
}

// ---- push subscription ----
function pushState() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return isIOS() && !isStandalone() ? 'ios' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return localStorage.getItem('pushOn') === '1' && Notification.permission === 'granted' ? 'on' : 'off';
}
const b64ToBytes = (b64) => { const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
async function enablePush() {
  try {
    if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications were not allowed', true);
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { key } = await GET('/api/push/key');
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    await POST('/api/push/subscribe', sub.toJSON());
    localStorage.setItem('pushOn', '1');
    toast('Notifications are on for this device');
    POST('/api/push/test').catch(() => {});
  } catch (e) { fail(new Error('Could not turn on notifications: ' + e.message)); }
}
async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await POST('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
  localStorage.removeItem('pushOn');
  toast('Notifications turned off on this device');
}

// =====================================================================
// CONNECTIONS (admins) — Moodle calendar + Gmail
// =====================================================================
function gmailScript(hookUrl, secret) {
  return `// E-JUST — forwards new university/Moodle emails to your E-JUST web app.
// Version 2 — sends the message text so E-JUST can show what it says and what to do.
// Runs inside YOUR Gmail account on Google's servers. Only emails matching SEARCH
// are sent (subject, sender and text — no attachments).
const WEBAPP = '${hookUrl}';
const KEY = '${secret}';
// Which emails to forward (Gmail search). Change it to match your university:
const SEARCH = 'newer_than:2d (from:moodle OR from:ejust.edu.eg OR subject:(assignment OR quiz OR exam OR deadline))';

function checkEmails() {
  const props = PropertiesService.getScriptProperties();
  const seen = JSON.parse(props.getProperty('seen2') || '[]');
  const messages = [];
  GmailApp.search(SEARCH, 0, 30).forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      const id = m.getId();
      if (seen.indexOf(id) !== -1) return;
      messages.push({ id: id, from: m.getFrom(), subject: m.getSubject(), date: m.getDate().toISOString(),
        body: m.getPlainBody().slice(0, 6000) });
      seen.push(id);
    });
  });
  // also wakes the web app so Moodle sync and deadline reminders run
  UrlFetchApp.fetch(WEBAPP, { method: 'post', contentType: 'application/json',
    headers: { 'X-EJUST-Key': KEY }, payload: JSON.stringify({ messages: messages }), muteHttpExceptions: true });
  props.setProperty('seen2', JSON.stringify(seen.slice(-500)));
}

// Run this ONCE: it makes checkEmails run every 10 minutes.
function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('checkEmails').timeBased().everyMinutes(10).create();
  checkEmails();
}`;
}

async function connectionsPage() {
  const c = await GET('/api/admin/connections');
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
  const script = gmailScript(c.email.hook_url, c.email.secret);
  if (away('users')) return;
  view.innerHTML = `
    ${usersTabs('connections')}

    <div class="card" style="margin-bottom:16px">
      <div class="row spread"><h2 style="margin:0">${icon('link')} Moodle</h2>
        <span class="badge ${c.moodle.connected ? 'green' : 'gray'}">${c.moodle.connected ? 'Connected' : 'Not connected'}</span></div>
      <p class="small muted">E-JUST reads your Moodle calendar and adds every assignment, quiz and exam deadline to the right course (courses are created automatically). Everyone in the class gets notified about new items and changed due dates.</p>
      <ol class="steps small">
        <li>Open Moodle and go to <b>Calendar</b> (or <b>Dashboard → Calendar</b>).</li>
        <li>Click <b>Import or export calendars</b> → <b>Export calendar</b>.</li>
        <li>Choose <b>Events to export: All courses</b> and <b>Time period: Recent and next 60 days</b>.</li>
        <li>Click <b>Get calendar URL</b>, copy the link and paste it here.</li>
      </ol>
      <form class="row" id="moodle-form" style="flex-wrap:nowrap">
        <input name="url" placeholder="${c.moodle.connected ? 'Paste a new link to replace the current one' : 'https://moodle…/calendar/export_execute.php?…'}">
        <button class="btn">Save</button></form>
      ${c.moodle.connected ? `<div class="small muted" style="margin-top:8px">Current link: <code>${esc(c.moodle.url_hint)}</code></div>
        <div class="small" style="margin-top:6px">Last sync: <b>${when(c.moodle.last_sync)}</b> — ${esc(c.moodle.last_status || '')}</div>
        <div class="row" style="margin-top:10px"><button class="btn soft small" id="moodle-sync">${icon('refresh')}Sync now</button>
          <button class="btn ghost small" id="moodle-off">Disconnect</button></div>` : ''}
    </div>

    <div class="card">
      <div class="row spread"><h2 style="margin:0">${icon('mail')} Gmail</h2>
        <span class="badge ${c.email.last ? 'green' : 'gray'}">${c.email.last ? 'Last check ' + when(c.email.last) : 'Not set up yet'}</span></div>
      <p class="small muted">A small script runs in your Gmail (on Google's servers, free) every 10 minutes. It sends new university/Moodle emails to E-JUST as notifications, and also keeps the Moodle sync and deadline reminders running.</p>
      <div class="msg-box" style="margin:10px 0">
        <h3>Who sees these emails</h3>
        <label class="switch-row" style="margin:6px 0;white-space:normal"><input type="checkbox" class="check" id="email-share" ${c.email.share ? 'checked' : ''}>
          Share class emails with classmates (off = only ${c.email.owner ? esc(c.email.owner) : 'you'})</label>
        <div class="row" style="margin-top:8px"><span class="small">This Gmail's <b>tutorial</b> classes belong to</span>
          <select id="email-section" style="width:auto"><option value="">— not set —</option>${c.sections.map((x) => `<option value="${x.id}" ${x.id === c.email.section_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
        <ul class="small muted" style="margin:8px 0 0;padding-left:18px">
          <li><b>Lecture / lab / Moodle</b> emails go to the whole class.</li>
          <li><b>Tutorial</b> emails (classes linked as “Section” in a course) go in full only to the section chosen here. Other sections just get a short note that homework was posted, because their own tutorial may differ.</li>
          <li>Emails that don't belong to a linked class always stay private to you.</li></ul>
      </div>
      <ol class="steps small">
        <li>Open <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com</a> while signed in to the Gmail you want to use, and create a <b>New project</b>.</li>
        <li>Delete what's there, then paste the script below (<b>Copy script</b>). Click <b>Save</b>.</li>
        <li>In the function menu at the top choose <b>setup</b> and click <b>Run</b>. Google asks for permission — click <b>Review permissions</b>, choose your account, then <b>Advanced → Go to project → Allow</b>.</li>
        <li>Done. Within 10 minutes this page shows "Last check". Change <code>SEARCH</code> in the script to pick which emails count.</li>
      </ol>
      <div class="row" style="margin-bottom:8px"><button class="btn small" id="copy-script">Copy script</button>
        <button class="btn ghost small" id="new-secret" title="Old scripts stop working">Make a new key</button></div>
      <textarea class="code-box" id="script-box" readonly spellcheck="false" rows="14" style="width:100%;resize:vertical">${esc(script)}</textarea>
      <div class="small muted" style="margin-top:4px">If Copy doesn't work: click inside the box, press <b>Ctrl+A</b> then <b>Ctrl+C</b>.</div>
      <p class="small muted" style="margin-top:8px">The script contains a private key for your class — don't share it.</p>
    </div>`;
  const run = async (p, msg) => { try { const r = await p; if (msg) toast(typeof msg === 'function' ? msg(r) : msg); } catch (e) { fail(e); } connectionsPage(); };
  $('#moodle-form').onsubmit = (e) => { e.preventDefault(); const url = e.target.url.value.trim(); if (!url) return;
    run(PUT('/api/admin/connections', { moodle_ical_url: url }).then(() => POST('/api/admin/connections/moodle-sync')),
      (r) => (r.error ? 'Moodle: ' + r.error : `Moodle connected — ${r.added} new item(s) added`)); };
  $('#moodle-sync')?.addEventListener('click', () => run(POST('/api/admin/connections/moodle-sync'), (r) => (r.error ? 'Moodle: ' + r.error : `Synced — ${r.added} new, ${r.updated} updated`)));
  $('#moodle-off')?.addEventListener('click', () => confirm('Disconnect Moodle? Items already imported stay.') && run(PUT('/api/admin/connections', { moodle_ical_url: '' }), 'Moodle disconnected'));
  $('#email-share').onchange = (e) => run(PUT('/api/admin/connections', { email_share: e.target.checked, claim_email: !e.target.checked }), 'Saved');
  $('#email-section').onchange = (e) => run(PUT('/api/admin/connections', { email_section_id: e.target.value || null }), 'Saved');
  $('#copy-script').onclick = () => {
    // copy right away (inside the click) — some browsers only allow copying during the click itself
    const box = $('#script-box');
    box.focus(); box.select(); box.setSelectionRange(0, box.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    if (!ok && navigator.clipboard) navigator.clipboard.writeText(script).then(() => toast('Script copied — paste it into script.google.com')).catch(() => toast('Press Ctrl+C now to copy the selected script', true));
    else if (ok) toast('Script copied — paste it into script.google.com');
    PUT('/api/admin/connections', { claim_email: true }).catch(() => {}); // email alerts go to you
  };
  $('#new-secret').onclick = () => confirm('Make a new key? You will need to paste the new script into Google again.') && run(POST('/api/admin/connections/new-secret'), 'New key made — copy the script again');
}

// =====================================================================
// INSTALL AS AN APP (phones & computers)
// =====================================================================
let installPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const canInstall = () => !isStandalone() && (installPrompt || isIOS());
function refreshInstallUI() {
  $('#install-btn').classList.toggle('hidden', !canInstall());
  $('#install-card')?.classList.toggle('hidden', !canInstall() || localStorage.getItem('installCardHidden') === '1');
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; refreshInstallUI(); });
window.addEventListener('appinstalled', () => { installPrompt = null; refreshInstallUI(); toast('E-JUST installed 🎉 Open it from your home screen or apps list.'); });

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null; refreshInstallUI();
    return;
  }
  // iPhone / iPad Safari has no install button — show the steps
  openModal(`<h2>📲 Install E-JUST</h2>
    <p class="muted">Add E-JUST to your home screen and it opens like a normal app.</p>
    <ol class="install-steps">
      <li>Open this page in <b>Safari</b>.</li>
      <li>Tap the <b>Share</b> button <span class="kbd">⬆︎</span> (bottom of the screen, or top on iPad).</li>
      <li>Scroll down and tap <b>Add to Home Screen</b> <span class="kbd">＋</span>.</li>
      <li>Tap <b>Add</b>. E-JUST now appears on your home screen.</li>
    </ol>
    <div class="row" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Got it</button></div>`);
}
$('#install-btn').onclick = installApp;
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

window.closeModal = closeModal;
boot().then(() => { if (!ME) showAuth(); });
