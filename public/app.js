/* StudyHub frontend — vanilla JS single-page app */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
let ME = null;
let COURSES = [];

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.match(/login|register/)) { showAuth(); throw new Error('Not signed in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const GET = (u) => api('GET', u), POST = (u, b) => api('POST', u, b ?? {}), PUT = (u, b) => api('PUT', u, b),
  PATCH = (u, b) => api('PATCH', u, b), DEL = (u) => api('DELETE', u);

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
  if (diff < 0) rel = `<span class="due-over">overdue ${humanDur(-diff)}</span>`;
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

const isAdmin = () => ME?.role === 'admin';
const can = (perm) => !!ME?.perms?.includes(perm);

// ---------- auth: set up class (first user), join with invite code, or sign in ----------
async function showAuth(mode) {
  $('#shell').classList.add('hidden');
  const a = $('#auth'); a.classList.remove('hidden');
  const status = await fetch('/api/class/status').then((r) => r.json()).catch(() => ({ setup_done: true }));
  if (!status.setup_done) mode = 'setup';
  mode = mode || 'login';
  const head = (sub) => `<h1>📚 StudyHub</h1><p class="muted">${sub}</p>`;
  const creds = (newPw) => `<div><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
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
          <button class="btn big">Join class</button></div>
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
      submit('/api/register', Object.fromEntries(new FormData(e.target)));
    };
    return;
  }
  a.innerHTML = `<div class="card">${head(`Sign in to ${esc(status.name || 'your class')}`)}
    <form class="form" id="auth-form">${creds(false)}<button class="btn big">Sign in</button>
      <p class="small muted" style="text-align:center;margin:0">New here? <a href="#" id="auth-switch">Join with an invite code</a></p></form></div>`;
  $('#auth-switch').onclick = (e) => { e.preventDefault(); showAuth('join'); };
  $('#auth-form').onsubmit = (e) => { e.preventDefault(); submit('/api/login', Object.fromEntries(new FormData(e.target))); };
}
$('#logout').onclick = async () => { await POST('/api/logout'); ME = null; stopReminders(); showAuth(); };

async function boot() {
  try { ME = await GET('/api/me'); } catch { return; }
  $('#auth').classList.add('hidden'); $('#shell').classList.remove('hidden');
  $('.brand').textContent = '📚 ' + (ME.class_name || 'StudyHub');
  // only admins can change sections; students just see theirs
  $('#me').innerHTML = `<b>${esc(ME.name)}</b>${isAdmin() ? ' <span class="badge">admin</span>' : ''}<br>
    ${isAdmin() ? `<a href="#" id="my-section" style="color:#cfd2ef">${esc(ME.section_name || 'No section')} · change</a>`
      : `<span style="color:#cfd2ef">${esc(ME.section_name || 'No section')}</span>`}`;
  $('#my-section')?.addEventListener('click', (e) => { e.preventDefault(); sectionDialog(); });
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
  $$('[data-perm]').forEach((el) => el.classList.toggle('hidden', !can(el.dataset.perm)));
  await loadCourses();
  startReminders();
  route();
  if (!ME.section_id) sectionDialog();
}

async function sectionDialog() {
  if (!isAdmin()) {
    // students can't pick their own section — only an admin can place them
    return openModal(`<h2>No section yet</h2><p class="muted">You're not in a section right now, so due dates show the class default.
      Ask an admin to put you in your section (Class & Sections page).</p>
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
const routes = { dashboard, tasks, materials, practice, questions, planner, focus, courses, class: classPage, permissions: permissionsPage };
const adminRoutes = ['class', 'permissions'];
async function route() {
  if (!ME) return;
  let [name, ...args] = (location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard').split('/');
  if (adminRoutes.includes(name) && !isAdmin()) name = 'dashboard';
  if (name === 'questions' && !can('questions')) name = 'dashboard';
  const fn = routes[name] || dashboard;
  const active = routes[name] ? name : 'dashboard';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === active));
  const link = $(`#nav a[data-route="${active}"]`);
  $('#top-title').textContent = link ? link.textContent.trim() : 'StudyHub';
  closeMenu();
  window.scrollTo(0, 0);
  view.innerHTML = '<p class="muted">Loading…</p>';
  try { await fn(...args); } catch (e) { if (e.message !== 'Not signed in') view.innerHTML = `<div class="banner red">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);

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
  const [d, overview] = await Promise.all([GET(`/api/dashboard?today=${ymd(new Date())}&tz_offset=${new Date().getTimezoneOffset()}`), GET('/api/courses/overview')]);
  const notifBtn = 'Notification' in window && Notification.permission === 'default'
    ? '<button class="btn soft small" id="notif">🔔 Enable reminders</button>' : '';

  view.innerHTML = `
    <div class="page-head"><div><h1>Hi ${esc(ME.name.split(' ')[0])} 👋</h1>
      <div class="muted">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div></div>
      <div class="row">${notifBtn}<a class="btn" href="#/practice">🎯 Start practising</a></div></div>
    <div id="install-card" class="card install-card hidden"><div class="row spread">
      <div class="row" style="flex-wrap:nowrap"><img src="/icons/icon-192.png" alt="" width="44" height="44" style="border-radius:10px">
        <div><b>Install StudyHub</b><div class="small muted">Get it on your home screen or desktop. Opens in its own window, no browser bar.</div></div></div>
      <div class="row"><button class="btn small" id="install-card-btn">📲 Install</button><button class="btn ghost small" id="install-card-x">Not now</button></div></div></div>
    ${d.overdue.length ? `<div class="banner red">⚠️ You have <b>${d.overdue.length}</b> overdue item${d.overdue.length > 1 ? 's' : ''}: ${d.overdue.map((t) => esc(t.title)).join(', ')}</div>` : ''}
    ${d.due_soon_count ? `<div class="banner">⏰ <b>${d.due_soon_count}</b> item${d.due_soon_count > 1 ? 's are' : ' is'} due in the next 3 days.</div>` : ''}
    <div class="stats">
      <div class="stat"><div class="num">🔥 ${d.streak}</div><div class="lbl">day study streak</div></div>
      <div class="stat ${d.reviews_due ? 'alert' : ''}"><div class="num">${d.reviews_due}</div><div class="lbl">MCQs due for review</div></div>
      <div class="stat"><div class="num">${d.new_questions}</div><div class="lbl">new questions waiting</div></div>
      <div class="stat"><div class="num">${Math.round(d.minutes_week / 6) / 10}h</div><div class="lbl">focused study this week</div></div>
    </div>
    <div class="grid g2">
      <div class="card"><div class="row spread"><h2>Coming up</h2><a href="#/tasks" class="small">All tasks →</a></div>
        <div class="list">${d.upcoming.length ? d.upcoming.map(taskRowSimple).join('') : '<div class="empty">Nothing coming up. Add an assignment or quiz.</div>'}</div></div>
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
  $('#notif')?.addEventListener('click', async () => { await Notification.requestPermission(); dashboard(); });
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
let taskFilter = { status: 'open', type: '', course: '' };
async function tasks() {
  const all = await GET('/api/tasks');
  const list = all.filter((t) =>
    (taskFilter.status === 'all' || (taskFilter.status === 'open' ? t.status !== 'done' : t.status === 'done')) &&
    (!taskFilter.type || t.type === taskFilter.type) && (!taskFilter.course || String(t.course_id) === taskFilter.course));
  view.innerHTML = `
    <div class="page-head"><div><h1>Assignments & Quizzes</h1><div class="muted">Due dates shown for <b>${esc(ME.section_name || 'your section')}</b>. Your status and grades are private to you.</div></div>
      ${can('tasks') ? '<button class="btn" id="add">+ Add item</button>' : ''}</div>
    <div class="tabs">${['open', 'done', 'all'].map((s) => `<button data-s="${s}" class="${taskFilter.status === s ? 'active' : ''}">${{ open: 'To do', done: 'Done', all: 'All' }[s]}</button>`).join('')}</div>
    <div class="filters">
      <select id="f-type"><option value="">All types</option>${['assignment', 'quiz', 'exam'].map((t) => `<option ${taskFilter.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <select id="f-course">${courseOpts(taskFilter.course, 'All courses')}</select>
    </div>
    <div class="list">${list.length ? list.map(taskRow).join('') : '<div class="empty">Nothing here yet.</div>'}</div>`;
  $$('.tabs button').forEach((b) => (b.onclick = () => { taskFilter.status = b.dataset.s; tasks(); }));
  $('#f-type').onchange = (e) => { taskFilter.type = e.target.value; tasks(); };
  $('#f-course').onchange = (e) => { taskFilter.course = e.target.value; tasks(); };
  $('#add')?.addEventListener('click', () => taskForm({ course_id: taskFilter.course || undefined }));
  bindTaskRows(view, all, tasks);
}
// wires up the buttons inside task rows (status, grade, plan, edit, delete)
function bindTaskRows(root, all, refresh) {
  const find = (id) => all.find((t) => t.id == id);
  $$('[data-status]', root).forEach((s) => (s.onchange = async () => { await PATCH(`/api/tasks/${s.dataset.status}/mine`, { status: s.value }).catch(fail); refresh(); }));
  $$('[data-grade]', root).forEach((b) => (b.onclick = () => gradeDialog(find(b.dataset.grade))));
  $$('[data-edit]', root).forEach((b) => (b.onclick = () => taskForm(find(b.dataset.edit))));
  $$('[data-del]', root).forEach((b) => (b.onclick = async () => { if (confirm('Delete this item?')) { await DEL(`/api/tasks/${b.dataset.del}`); refresh(); } }));
  $$('[data-plan-task]', root).forEach((b) => (b.onclick = () => planTaskDialog(find(b.dataset.planTask))));
}
const noCoursesYet = () => `<div class="banner">Add a course first — every item belongs to a course. ${can('courses') ? '<a href="#/courses" onclick="closeModal()">Go to Courses →</a>' : 'Ask an admin to add one.'}</div>`;
const taskRow = (t) => `<div class="item ${t.status === 'done' ? 'done' : ''}">
  <span class="badge ${t.type}">${t.type}</span>
  <div class="grow"><div class="title">${esc(t.title)} ${t.priority === 'high' ? '<span class="badge high">high</span>' : ''}</div>
    <div class="row small">${courseTag(t.course_name, t.course_color)} <span>${fmtDue(t.due_at)}</span>
    ${t.grade != null ? `<span class="badge green">${t.grade}${t.max_grade ? ' / ' + t.max_grade : ''}</span>` : ''}</div>
    ${t.notes ? `<div class="small muted">${esc(t.notes)}</div>` : ''}</div>
  <select data-status="${t.id}" style="width:auto">${['todo', 'doing', 'done'].map((s) => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${{ todo: 'To do', doing: 'In progress', done: 'Done' }[s]}</option>`).join('')}</select>
  ${t.due_at && t.status !== 'done' ? `<button class="btn soft small" data-plan-task="${t.id}" title="Spread study sessions until the due date">📅 Plan</button>` : ''}
  <button class="btn ghost small" data-grade="${t.id}" title="Enter the grade you got">My grade</button>
  ${can('tasks') ? `<button class="btn ghost small" data-edit="${t.id}">Edit</button>
  <button class="btn danger small" data-del="${t.id}">✕</button>` : ''}</div>`;

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

async function taskForm(t = {}) {
  const secs = await GET('/api/sections');
  const dues = t.section_dues || {};
  openModal(`<h2>${t.id ? 'Edit' : 'Add'} shared item</h2>
    ${COURSES.length ? '' : noCoursesYet()}
    <form class="form" id="tf">
      <div><label>Title</label><input name="title" required value="${esc(t.title)}" placeholder="e.g. Physics Lab Report 3"></div>
      <div class="two"><div><label>Type</label><select name="type">${['assignment', 'quiz', 'exam'].map((x) => `<option ${t.type === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div><label>Course</label><select name="course_id" ${t.id && !t.course_id ? '' : 'required'}>${courseOpts(t.course_id, 'Choose a course…')}</select></div></div>
      <div class="two"><div><label>Default due date</label><input type="datetime-local" name="due_at" value="${toLocalInput(t.default_due_at)}"></div>
        <div><label>Priority</label><select name="priority">${['low', 'medium', 'high'].map((x) => `<option ${(t.priority || 'medium') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div></div>
      <div><label>Due date per section (leave empty to use the default)</label>
        ${secs.map((s) => `<div class="row" style="margin-bottom:6px"><span style="min-width:110px" class="small">${esc(s.name)}</span>
          <input type="datetime-local" data-sec="${s.id}" value="${toLocalInput(dues[s.id])}"></div>`).join('')}</div>
      <div><label>Notes</label><textarea name="notes" placeholder="Chapters covered, requirements…">${esc(t.notes)}</textarea></div>
      <div><label>Graded out of (optional)</label><input type="number" step="any" name="max_grade" value="${t.max_grade ?? ''}"></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div>
    </form>`, (m) => {
    $('#tf', m).onsubmit = async (e) => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.due_at = fromLocalInput(b.due_at);
      b.section_dues = Object.fromEntries($$('[data-sec]', m).filter((i) => i.value).map((i) => [i.dataset.sec, fromLocalInput(i.value)]));
      try { t.id ? await PUT(`/api/tasks/${t.id}`, b) : await POST('/api/tasks', b); closeModal(); toast('Saved for the whole class'); route(); } catch (err) { fail(err); }
    };
  });
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
  view.innerHTML = `
    <div class="page-head"><div><h1>Study Sheets</h1><div class="muted">The class's shared sheets — read them, then practise their MCQs until you master them.</div></div>
      ${can('sheets') ? '<button class="btn" id="add">+ Add sheet</button>' : ''}</div>
    <div class="grid g3">${list.length ? list.map((m) => `<div class="card">
      <div class="row spread"><span class="badge gray">${m.kind.toUpperCase()}</span>${courseTag(m.course_name, m.course_color)}</div>
      <h3 style="margin-top:10px">${esc(m.title)}</h3>
      <div class="small muted">${m.question_count} questions · added ${new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}</div>
      <div class="row" style="margin-top:12px"><a class="btn small" href="#/materials/${m.id}">📖 Open</a>
        ${m.question_count ? `<a class="btn soft small" href="#/practice?material_id=${m.id}">🎯 Practice</a>` : ''}
        ${can('sheets') ? `<button class="btn danger small" data-del="${m.id}">✕</button>` : ''}</div>
      ${m.question_count ? `<div class="small muted" style="margin-top:10px">You've mastered ${m.mastered}/${m.question_count}</div>${bar((m.mastered / m.question_count) * 100, 'green')}` : ''}</div>`).join('')
      : `<div class="card empty" style="grid-column:1/-1">No study sheets yet.${can('sheets') ? ' Click “Add sheet” to upload the first one for the class.' : ' Your class reps will add them here.'}</div>`}</div>`;
  $('#add')?.addEventListener('click', () => materialForm());
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    if (confirm('Delete this sheet and all questions generated from it?')) { await DEL(`/api/materials/${b.dataset.del}`); materials(); }
  }));
}

function materialForm(courseId = '') {
  openModal(`<h2>Add study sheet</h2>
    ${COURSES.length ? '' : noCoursesYet()}
    <form class="form" id="mf">
      <div><label>Title</label><input name="title" placeholder="e.g. Chapter 4 – Cell Biology"></div>
      <div><label>Course</label><select name="course_id" required>${courseOpts(courseId, 'Choose a course…')}</select></div>
      <div><label>Upload a file (PDF, image or .txt, up to 4 MB)</label><input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md"></div>
      <div class="muted small" style="text-align:center">— or —</div>
      <div><label>Paste notes</label><textarea name="body" rows="7" placeholder="Paste or type your notes here…"></textarea></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div>
    </form>`, (m) => {
    $('#mf', m).onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (!fd.get('file')?.size) fd.delete('file');
      else if (fd.get('file').size > 4 * 1024 * 1024) return toast('That file is too big — sheets can be up to 4 MB. Try compressing the PDF or splitting it.', true);
      try { const r = await POST('/api/materials', fd); closeModal(); location.hash = `#/materials/${r.id}`; } catch (err) { fail(err); }
    };
  });
}

async function materialReader(id) {
  const m = await GET(`/api/materials/${id}`);
  const content = m.kind === 'pdf' ? `<iframe src="/api/materials/${m.id}/file"></iframe>`
    : m.kind === 'image' ? `<img src="/api/materials/${m.id}/file" alt="">` : `<div class="text">${esc(m.body)}</div>`;
  const total = m.question_count, mastered = m.mastered;
  view.innerHTML = `
    <div class="page-head"><div><a href="#/materials" class="small">← All sheets</a><h1>${esc(m.title)}</h1></div></div>
    <div class="split">
      <div class="reader card">${content}</div>
      <div class="grid">
        <div class="card"><h3>🎯 Master this sheet</h3>
          <div class="small muted">${total} questions · you've mastered ${mastered}</div>${bar(total ? (mastered / total) * 100 : 0, 'green')}
          <div class="row" style="margin-top:12px">${total ? `<a class="btn" href="#/practice?material_id=${m.id}">Practice now</a>` : '<span class="small muted">No questions for this sheet yet.</span>'}
            ${can('questions') ? `<a class="btn ghost small" href="#/questions?material_id=${m.id}">Edit questions</a>` : ''}</div></div>
        ${can('questions') ? `<div class="card"><h3>✨ Generate MCQs with AI</h3>
          ${ME.ai ? '' : '<div class="banner small">AI is not set up yet. Add <code>ANTHROPIC_API_KEY</code> to the <code>.env</code> file and restart the server.</div>'}
          <div class="form">
            <div class="two"><div><label>How many</label><input type="number" id="g-count" value="10" min="1" max="30"></div>
              <div><label>Difficulty</label><select id="g-diff"><option>mixed</option><option>easy</option><option>medium</option><option>hard</option></select></div></div>
            <div><label>Focus on (optional)</label><input id="g-focus" placeholder="e.g. formulas, definitions, chapter 2"></div>
            <button class="btn" id="gen" ${ME.ai ? '' : 'disabled'}>Generate questions</button>
            <div class="small muted">New questions avoid repeating the ones you already have.</div>
          </div></div>
        <div class="card"><h3>✍️ Add your own</h3><button class="btn soft small" id="manual">+ Write a question</button></div>` : ''}
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
    <div class="row spread small"><span class="badge">${esc(Q.topic)}</span><span class="muted">${Q.due_at ? (Q.reps ? `streak ${Q.reps}` : 'review') : 'new'} · ${Q.source === 'ai' ? '✨ AI' : '✍️ manual'}</span></div>
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
        ${x.material_title ? `<span>📄 ${esc(x.material_title)}</span>` : ''} ${x.source === 'ai' ? '<span>✨ AI</span>' : ''}</div>
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
  view.innerHTML = `
    <div class="page-head"><div><h1>Planner</h1><div class="muted">Deadlines and study sessions in one calendar. Click a day to add a session.</div></div>
      <div class="row"><button class="btn ghost" id="prev">‹</button><b style="min-width:150px;text-align:center">${calMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>
      <button class="btn ghost" id="next">›</button><button class="btn ghost small" id="today">Today</button></div></div>
    <div class="split">
      <div class="cal-wrap"><div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')}${cells.join('')}</div></div>
      <div class="card"><h3>Upcoming deadlines</h3><div class="small muted" style="margin-bottom:10px">Auto-plan study sessions until the due date.</div>
        <div class="list">${tests.length ? tests.map((t) => `<div><div class="row spread"><span class="badge ${t.type}">${t.type}</span><button class="btn soft small" data-plan-task="${t.id}">📅 Make study plan</button></div>
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
      notify('Break over ⏰', 'Ready for another focus session?');
      T.phase = 'focus'; T.remaining = T.focusMin * 60;
    }
    T.running = false; saveT();
    if (location.hash.startsWith('#/focus')) focus();
  }
  const top = $('#top-timer');
  if (T.running || T.remaining !== T.focusMin * 60 || T.phase === 'break') {
    mini.classList.remove('hidden');
    mini.textContent = `${T.phase === 'focus' ? '🎯 Focus' : '☕ Break'} ${fmtClock(timeLeft())}${T.running ? '' : ' (paused)'}`;
    top.classList.remove('hidden');
    top.textContent = `${T.phase === 'focus' ? '🎯' : '☕'} ${fmtClock(timeLeft())}${T.running ? '' : ' ⏸'}`;
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
  view.innerHTML = `
    <div class="page-head"><div><h1>Courses</h1><div class="muted">Every assignment, quiz, exam and study sheet lives inside its course. Open one to see everything.</div></div></div>
    ${can('courses') ? `<form class="card row" id="cf" style="margin-bottom:16px;flex-wrap:nowrap">
      <input name="name" required placeholder="New course name, e.g. Organic Chemistry">
      <input type="color" name="color" value="#5b5bd6" style="width:54px;padding:3px" title="Course colour">
      <button class="btn">Add</button></form>` : ''}
    <div class="grid g3">${o.courses.map((c) => `<a class="card course-card" href="#/courses/${c.id}" style="border-top:4px solid ${esc(c.color)}">
      <div class="row spread"><h3 style="margin:0">📁 ${esc(c.name)}</h3><span class="muted">›</span></div>
      <div class="course-chips">
        <span class="chip">📝 ${c.assignments} assignment${c.assignments === 1 ? '' : 's'}</span>
        <span class="chip">❓ ${c.quizzes} quiz${c.quizzes === 1 ? '' : 'zes'}</span>
        <span class="chip">🎓 ${c.exams} exam${c.exams === 1 ? '' : 's'}</span>
        <span class="chip">📄 ${c.sheets} sheet${c.sheets === 1 ? '' : 's'}</span>
      </div>
      ${c.questions ? `<div class="small muted" style="margin-top:8px">${c.mastered}/${c.questions} MCQs mastered</div>${bar((c.mastered / c.questions) * 100, 'green')}` : ''}
    </a>`).join('')
      || `<div class="card empty" style="grid-column:1/-1">${can('courses') ? 'Add the first course above.' : 'No courses yet.'}</div>`}
    ${hasLoose ? `<a class="card course-card" href="#/courses/none" style="border-top:4px solid #9ca3af">
      <div class="row spread"><h3 style="margin:0">🗃️ Not in a course</h3><span class="muted">›</span></div>
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
  const addTaskBtn = (type) => (can('tasks') && !loose ? `<button class="btn soft small" data-add-type="${type}">+ Add</button>` : '');
  const sheetCard = (m) => `<div class="item">
    <span class="badge gray">${m.kind.toUpperCase()}</span>
    <div class="grow"><div class="title">${esc(m.title)}</div>
      <div class="small muted">${m.question_count} MCQs${m.question_count ? ` · you've mastered ${m.mastered}` : ''} · added ${new Date(m.created_at.replace(' ', 'T') + 'Z').toLocaleDateString()}</div></div>
    <a class="btn small" href="#/materials/${m.id}">📖 Open</a>
    ${m.question_count ? `<a class="btn soft small" href="#/practice?material_id=${m.id}">🎯 Practice</a>` : ''}
    ${can('sheets') ? `<button class="btn ghost small" data-move-sheet="${m.id}" title="Move to another course">Move</button><button class="btn danger small" data-del-sheet="${m.id}">✕</button>` : ''}</div>`;

  view.innerHTML = `
    <div class="page-head"><div><a href="#/courses" class="small">← All courses</a>
      <h1 class="row" style="gap:10px"><span class="dot" style="background:${esc(c.color)};width:16px;height:16px"></span>${esc(c.name)}</h1>
      <div class="muted small">${d.tasks.length} item${d.tasks.length === 1 ? '' : 's'} · ${d.materials.length} study sheet${d.materials.length === 1 ? '' : 's'}${d.questions.total ? ` · ${d.questions.mastered}/${d.questions.total} MCQs mastered` : ''}</div></div>
      <div class="row">${!loose && d.questions.total ? `<a class="btn" href="#/practice?course_id=${c.id}">🎯 Practice this course</a>` : ''}
        ${can('courses') && !loose ? `<button class="btn ghost" id="edit-course">✏️ Edit</button>` : ''}</div></div>
    <div class="tabs">${tabs.map(([k, label, n]) => `<button data-ctab="${k}" class="${courseTab === k ? 'active' : ''}">${label} <span class="muted">${n}</span></button>`).join('')}</div>
    ${groups.map((g) => (show(g.key) ? `<section class="course-section">
      <div class="row spread"><h2>${g.icon} ${g.title} <span class="muted small">${g.items.length}</span></h2>${addTaskBtn(g.key)}</div>
      <div class="list">${g.items.length ? g.items.map(taskRow).join('') : `<div class="empty small">No ${g.title.toLowerCase()} yet.</div>`}</div></section>` : '')).join('')}
    ${show('sheets') ? `<section class="course-section">
      <div class="row spread"><h2>📄 Study sheets <span class="muted small">${d.materials.length}</span></h2>${can('sheets') && !loose ? '<button class="btn soft small" id="add-sheet">+ Add</button>' : ''}</div>
      <div class="list">${d.materials.length ? d.materials.map(sheetCard).join('') : '<div class="empty small">No study sheets yet.</div>'}</div></section>` : ''}`;

  const refresh = () => courseDetail(id);
  $$('[data-ctab]').forEach((b) => (b.onclick = () => { courseTab = b.dataset.ctab; refresh(); }));
  $$('[data-add-type]').forEach((b) => (b.onclick = () => taskForm({ type: b.dataset.addType, course_id: c.id })));
  $('#add-sheet')?.addEventListener('click', () => materialForm(c.id));
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
    <form class="form" id="ecf"><div><label>Name</label><input name="name" required value="${esc(c.name)}"></div>
      <div><label>Colour</label><input type="color" name="color" value="${esc(c.color)}" style="width:70px;padding:3px"></div>
      <div class="row spread"><button type="button" class="btn danger" id="del-course">Delete course</button>
        <div class="row"><button type="button" class="btn ghost" onclick="closeModal()">Cancel</button><button class="btn">Save</button></div></div></form>`, (m) => {
    $('#ecf', m).onsubmit = async (e) => {
      e.preventDefault();
      try { await PUT(`/api/courses/${c.id}`, Object.fromEntries(new FormData(e.target))); closeModal(); toast('Saved'); refresh(); } catch (err) { fail(err); }
    };
    $('#del-course', m).onclick = async () => {
      if (!confirm('Delete this course? Its assignments, quizzes, exams and sheets are kept, but move to “Not in a course”.')) return;
      try { await DEL(`/api/courses/${c.id}`); closeModal(); toast('Course deleted'); location.hash = '#/courses'; } catch (err) { fail(err); }
    };
  }));
}

// =====================================================================
// CLASS & SECTIONS (admins)
// =====================================================================
async function classPage() {
  const c = await GET('/api/admin/class');
  const secOpts = (sel) => c.sections.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  view.innerHTML = `
    <div class="page-head"><div><h1>Class & Sections</h1><div class="muted">Manage the class, its sections and who can edit shared content.</div></div></div>
    <div class="grid g2" style="margin-bottom:16px">
      <div class="card"><h2>Invite classmates</h2>
        <p class="small muted">Share this code. New students enter it on the sign-in page (“Join with an invite code”) and pick their section.</p>
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
    <div class="card"><div class="row spread"><h2 style="margin:0">Members (${c.members.length})</h2><a class="btn soft small" href="#/permissions">🔐 Roles & permissions →</a></div>
      <div class="list" style="margin-top:12px">${c.members.map((m) => `<div class="row" style="border-bottom:1px solid var(--line);padding-bottom:8px">
        <div style="flex:1;min-width:0"><b>${esc(m.name)}</b> ${m.id === ME.id ? '<span class="small muted">(you)</span>' : ''} ${m.role === 'admin' ? '<span class="badge">admin</span>' : ''}<div class="small muted">${esc(m.email)}</div></div>
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
}

// =====================================================================
// PERMISSIONS (admins only) — who can upload, add tasks, write questions…
// =====================================================================
const PERM_ICONS = { sheets: '📄', questions: '🗂️', tasks: '📝', courses: '🎓' };
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
  const members = c.members.filter((m) => !q || (m.name + ' ' + m.email + ' ' + (m.section_name || '')).toLowerCase().includes(q));
  const counts = Object.fromEntries(keys.map((k) => [k, c.members.filter((m) => m.perms.includes(k)).length]));
  view.innerHTML = `
    <div class="page-head"><div><h1>Permissions</h1><div class="muted">Only admins see this page. Choose what each class member is allowed to do.</div></div></div>
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
            <div class="small muted">${esc(m.email)} · ${esc(m.section_name || 'No section')}</div></div>
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
function notify(title, body) {
  toast(`${title} ${body}`);
  if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
}
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
      sent['reviews'] = today; notify('Time to review 🎯', `${r.reviews_due} questions are due for review.`);
    }
    localStorage.setItem('reminded', JSON.stringify(sent));
  } catch {}
}
function startReminders() { stopReminders(); checkReminders(); remTimer = setInterval(checkReminders, 60000); }
function stopReminders() { clearInterval(remTimer); }

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
window.addEventListener('appinstalled', () => { installPrompt = null; refreshInstallUI(); toast('StudyHub installed 🎉 Open it from your home screen or apps list.'); });

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null; refreshInstallUI();
    return;
  }
  // iPhone / iPad Safari has no install button — show the steps
  openModal(`<h2>📲 Install StudyHub</h2>
    <p class="muted">Add StudyHub to your home screen and it opens like a normal app.</p>
    <ol class="install-steps">
      <li>Open this page in <b>Safari</b>.</li>
      <li>Tap the <b>Share</b> button <span class="kbd">⬆︎</span> (bottom of the screen, or top on iPad).</li>
      <li>Scroll down and tap <b>Add to Home Screen</b> <span class="kbd">＋</span>.</li>
      <li>Tap <b>Add</b>. StudyHub now appears on your home screen.</li>
    </ol>
    <div class="row" style="justify-content:flex-end"><button class="btn" onclick="closeModal()">Got it</button></div>`);
}
$('#install-btn').onclick = installApp;
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

window.closeModal = closeModal;
boot().then(() => { if (!ME) showAuth(); });
