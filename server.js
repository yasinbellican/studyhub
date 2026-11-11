const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { generateMCQs, aiAvailable } = require('./ai');
// Notifications, push, Moodle and Gmail are optional extras: they are loaded on first use and every
// call is guarded, so a problem in them can never stop the rest of the site from working.
const lazy = {};
const N = () => (lazy.n ||= require('./notify'));
const { parseSources } = require('./coursematch');
const integrations = new Proxy({}, { get: (_, fn) => async (...args) => (lazy.i ||= require('./integrations'))[fn](...args) });
async function notify(o) { try { return await N().notify(o); } catch (e) { console.error('notify failed:', e.message); } }
const listFor = (u) => N().listFor(u);
const vapidKeys = () => N().vapidKeys();
// never let a stray async error crash the server process
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

app.set('trust proxy', 1); // behind the host's proxy: lets secure cookies work

// Create tables once per server instance, before handling any API request
if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) console.error('TURSO_DATABASE_URL is not set — add it in the Vercel project settings.');
const ready = db.init();
ready.catch((e) => console.error('Could not open the database:', e.message));
app.use('/api', (req, res, next) => ready.then(() => next(), next));

app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));
// Self-check of every part, so problems online can be found without the host's logs (no secrets shown)
app.get('/healthz/diag', async (req, res) => {
  const check = async (fn) => { try { const v = await fn(); return v === undefined ? 'ok' : v; } catch (e) { return 'ERROR: ' + e.message; } };
  res.json({
    node: process.version,
    vercel: !!process.env.VERCEL,
    database: { https: db.usingHttp, ready: await check(() => ready.then(() => 'ok')), query: await check(async () => (await db.get('SELECT 1 AS ok')).ok === 1 ? 'ok' : 'odd') },
    init_problems: db.initProblems,
    modules: {
      'web-push': await check(async () => { const m = await import('web-push'); if (!(m.default || m).sendNotification) throw new Error('loaded but sendNotification missing'); }),
      notify: await check(() => { N(); }),
      integrations: await check(() => { lazy.i ||= require('./integrations'); }),
    },
    tables: await check(async () => (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('notifications','push_subs','sent_once')")).map((r) => r.name).join(',')),
  });
});
// Database connection check — shows which database address is configured (never the token)
app.get('/healthz/db', async (req, res) => {
  const raw = process.env.TURSO_DATABASE_URL;
  const info = {
    database: raw ? 'turso' : 'local file',
    url: raw ? JSON.stringify(raw.replace(/\?.*$/, '')) : null, // quoted so stray spaces/quotes are visible
    token_set: !!process.env.TURSO_AUTH_TOKEN,
  };
  try { await db.get('SELECT 1 AS ok'); res.json({ ...info, ok: true }); }
  catch (e) { res.status(500).json({ ...info, ok: false, error: e.message, cause: e.cause?.message || e.cause?.code || null }); }
});

// ---------- helpers ----------
const nul = (v) => (v === undefined || v === '' ? null : v);
const nowISO = () => new Date().toISOString();
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

const getSetting = async (k) => (await db.get('SELECT value FROM settings WHERE key = ?', k))?.value ?? null;
const setSetting = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
const newInviteCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const userCount = async () => (await db.get('SELECT COUNT(*) AS n FROM users')).n;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
}
async function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires.toISOString());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: PROD, expires });
}
async function auth(req, res, next) {
  const token = req.cookies.sid;
  const row = token && await db.get(`SELECT u.id, u.name, u.username, u.role, u.section_id, u.permissions, s.name AS section_name
    FROM sessions x JOIN users u ON u.id = x.user_id LEFT JOIN sections s ON s.id = u.section_id
    WHERE x.token = ? AND x.expires_at > ? AND u.status = 'approved'`, token, nowISO());
  if (!row) return res.status(401).json({ error: 'Not signed in' });
  row.perms = effectivePerms(row);
  delete row.permissions;
  req.user = row;
  next();
}
function admin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can do this' });
  next();
}
const A = [auth, admin];

// ---------- permissions ----------
// Admins manage the class (members, sections, invite code, permissions) and can do everything.
// Other members only get the abilities an admin has ticked for them on the Permissions page.
const PERMISSIONS = {
  sheets: 'Upload & delete study sheets',
  questions: 'Write, edit & AI-generate MCQs',
  tasks: 'Add & edit assignments, quizzes & exams',
  courses: 'Add & edit courses',
};
function parsePerms(raw) {
  try { return JSON.parse(raw || '[]').filter((p) => p in PERMISSIONS); } catch { return []; }
}
function effectivePerms(u) { return u.role === 'admin' ? Object.keys(PERMISSIONS) : parsePerms(u.permissions); }
// route guard: signed in + has this permission
const can = (perm) => [auth, (req, res, next) => (req.user.perms.includes(perm) ? next()
  : res.status(403).json({ error: `You don't have the “${PERMISSIONS[perm]}” permission. Ask an admin.` }))];
async function checkCourse(courseId) {
  if (courseId == null || courseId === '') return null;
  const c = await db.get('SELECT id FROM courses WHERE id = ?', Number(courseId));
  if (!c) throw httpError(400, 'Course not found');
  return c.id;
}
async function checkSection(sectionId) {
  const s = sectionId && await db.get('SELECT id FROM sections WHERE id = ?', Number(sectionId));
  if (!s) throw httpError(400, 'Please choose your section');
  return s.id;
}

// Task rows as one student sees them: their section's due date + their own status/grade
function taskQuery(where = '1=1') {
  return `SELECT t.id, t.course_id, t.title, t.type, t.priority, t.notes, t.max_grade, t.created_at,
      t.due_at AS default_due_at, COALESCE(td.due_at, t.due_at) AS due_at,
      COALESCE(ut.status, 'todo') AS status, ut.grade,
      c.name AS course_name, c.color AS course_color
    FROM tasks t
    LEFT JOIN task_due td ON td.task_id = t.id AND td.section_id = $section
    LEFT JOIN user_tasks ut ON ut.task_id = t.id AND ut.user_id = $uid
    LEFT JOIN courses c ON c.id = t.course_id
    WHERE ${where}`;
}
const tp = (req, extra = {}) => ({ $section: req.user.section_id ?? -1, $uid: req.user.id, ...extra });

// ---------- class info & joining ----------
app.get('/api/class/status', async (req, res) => {
  res.json({ setup_done: (await userCount()) > 0, name: await getSetting('class_name') });
});
app.get('/api/class/join-info', async (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!code || code !== (await getSetting('invite_code'))) return res.status(404).json({ error: 'That invite code is not valid' });
  res.json({ name: await getSetting('class_name'), sections: await db.all('SELECT id, name FROM sections ORDER BY name') });
});

// usernames: 3–30 characters, letters, numbers, dot, dash, underscore (not case-sensitive)
function cleanUsername(u) {
  const v = String(u || '').trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(v)) throw httpError(400, 'Username must be 3–30 characters: letters, numbers, dots, dashes or underscores (no spaces)');
  return v;
}
async function usernameTaken(u) { return !!(await db.get('SELECT id FROM users WHERE username = ?', u)); }

// First user sets up the class and becomes its admin
app.post('/api/setup', async (req, res) => {
  if ((await userCount()) > 0) return res.status(409).json({ error: 'The class is already set up. Join with an invite code.' });
  const { class_name, sections, name, password } = req.body || {};
  if (!class_name || !name || !req.body.username || !password) return res.status(400).json({ error: 'Class name, your name, username and password are required' });
  const username = cleanUsername(req.body.username);
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const names = [...new Set(String(sections || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!names.length) return res.status(400).json({ error: 'Add at least one section' });
  await setSetting('class_name', class_name.trim());
  await setSetting('invite_code', newInviteCode());
  const ids = [];
  for (const n of names) ids.push((await db.run('INSERT INTO sections (name) VALUES (?)', n)).lastInsertRowid);
  const r = await db.run("INSERT INTO users (name, username, pass_hash, role, status, section_id) VALUES (?, ?, ?, 'admin', 'approved', ?)",
    name.trim(), username, hashPassword(password), ids[0]);
  await startSession(res, r.lastInsertRowid);
  res.json({ ok: true });
});

// Students ask to join with the invite code; an admin must approve them before they can sign in
app.post('/api/register', async (req, res) => {
  const { name, password, code, section_id } = req.body || {};
  if ((await userCount()) === 0) return res.status(400).json({ error: 'The class has not been set up yet' });
  if (String(code || '').trim().toUpperCase() !== (await getSetting('invite_code'))) return res.status(403).json({ error: 'That invite code is not valid' });
  if (!name || !req.body.username || !password) return res.status(400).json({ error: 'Name, username and password are required' });
  const username = cleanUsername(req.body.username);
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const sid = await checkSection(section_id);
  if (await usernameTaken(username)) return res.status(409).json({ error: 'That username is already taken — try another one' });
  await db.run("INSERT INTO users (name, username, pass_hash, status, section_id) VALUES (?, ?, ?, 'pending', ?)",
    name.trim(), username, hashPassword(password), sid);
  await notify({ audience: 'admins', kind: 'join', title: `Join request: ${name.trim()}`, body: `@${username} wants to join. Approve or reject it in Class & Sections.`, url: '#/class' });
  res.json({ pending: true });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = username && await db.get('SELECT * FROM users WHERE username = ?', String(username).trim());
  if (!user || !verifyPassword(password || '', user.pass_hash)) return res.status(401).json({ error: 'Wrong username or password' });
  if (user.status !== 'approved') return res.status(403).json({ error: 'Your request to join is waiting for an admin to approve it. Try again later.', pending: true });
  await startSession(res, user.id);
  res.json({ ok: true });
});
app.post('/api/logout', async (req, res) => {
  if (req.cookies.sid) await db.run('DELETE FROM sessions WHERE token = ?', req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, async (req, res) => res.json({ ...req.user, class_name: await getSetting('class_name'), ai: aiAvailable() }));
app.get('/api/sections', auth, async (req, res) => res.json(await db.all('SELECT id, name FROM sections ORDER BY name')));
// only admins may change sections (students keep the section they joined with)
app.patch('/api/me/section', ...A, async (req, res) => {
  await db.run('UPDATE users SET section_id = ? WHERE id = ?', await checkSection(req.body.section_id), req.user.id);
  res.json({ ok: true });
});

// ---------- class admin ----------
app.get('/api/admin/class', ...A, async (req, res) => {
  res.json({
    name: await getSetting('class_name'),
    invite_code: await getSetting('invite_code'),
    sections: await db.all(`SELECT s.id, s.name, (SELECT COUNT(*) FROM users u WHERE u.section_id = s.id AND u.status = 'approved') AS members
      FROM sections s ORDER BY s.name`),
    members: (await db.all(`SELECT u.id, u.name, u.username, u.role, u.section_id, u.permissions, s.name AS section_name, u.created_at
      FROM users u LEFT JOIN sections s ON s.id = u.section_id WHERE u.status = 'approved' ORDER BY u.role, u.name`))
      .map(({ permissions, ...m }) => ({ ...m, permissions: parsePerms(permissions), perms: effectivePerms({ ...m, permissions }) })),
    pending: await db.all(`SELECT u.id, u.name, u.username, u.section_id, s.name AS section_name, u.created_at
      FROM users u LEFT JOIN sections s ON s.id = u.section_id WHERE u.status = 'pending' ORDER BY u.created_at`),
    permission_list: PERMISSIONS,
  });
});
app.put('/api/admin/class', ...A, async (req, res) => {
  if (req.body.name) await setSetting('class_name', String(req.body.name).trim());
  res.json({ ok: true });
});
app.post('/api/admin/invite-code', ...A, async (req, res) => {
  const code = newInviteCode(); await setSetting('invite_code', code); res.json({ invite_code: code });
});
app.post('/api/admin/sections', ...A, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  try { await db.run('INSERT INTO sections (name) VALUES (?)', name); } catch { return res.status(409).json({ error: 'A section with that name already exists' }); }
  res.json({ ok: true });
});
app.put('/api/admin/sections/:id', ...A, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  try { await db.run('UPDATE sections SET name = ? WHERE id = ?', name, req.params.id); } catch { return res.status(409).json({ error: 'A section with that name already exists' }); }
  res.json({ ok: true });
});
app.delete('/api/admin/sections/:id', ...A, async (req, res) => {
  if ((await db.get('SELECT COUNT(*) AS n FROM sections')).n <= 1) return res.status(400).json({ error: 'The class needs at least one section' });
  const id = Number(req.params.id);
  await db.batch([
    ['DELETE FROM task_due WHERE section_id = ?', id],
    ['UPDATE users SET section_id = NULL WHERE section_id = ?', id],
    ['DELETE FROM sections WHERE id = ?', id],
  ]);
  res.json({ ok: true });
});
// approve someone who asked to join (optionally placing them in a different section)
app.post('/api/admin/members/:id/approve', ...A, async (req, res) => {
  const m = await db.get("SELECT * FROM users WHERE id = ? AND status = 'pending'", req.params.id);
  if (!m) return res.status(404).json({ error: 'No pending request found' });
  const sid = req.body?.section_id ? await checkSection(req.body.section_id) : m.section_id;
  await db.run("UPDATE users SET status = 'approved', section_id = ? WHERE id = ?", sid, m.id);
  await notify({ audience: 'user', targetId: m.id, kind: 'info', title: 'Welcome to the class!', body: 'Your join request was approved.', url: '#/dashboard' });
  res.json({ ok: true });
});
app.get('/api/admin/pending-count', ...A, async (req, res) => {
  res.json({ n: (await db.get("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'")).n });
});
app.patch('/api/admin/members/:id', ...A, async (req, res) => {
  const m = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (req.body.role) {
    if (!['admin', 'student'].includes(req.body.role)) return res.status(400).json({ error: 'Bad role' });
    const admins = (await db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")).n;
    if (m.role === 'admin' && req.body.role !== 'admin' && admins <= 1) return res.status(400).json({ error: 'The class needs at least one admin' });
    await db.run('UPDATE users SET role = ? WHERE id = ?', req.body.role, m.id);
  }
  if (Array.isArray(req.body.permissions)) {
    const perms = [...new Set(req.body.permissions.filter((p) => p in PERMISSIONS))];
    await db.run('UPDATE users SET permissions = ? WHERE id = ?', JSON.stringify(perms), m.id);
  }
  if (req.body.section_id !== undefined) await db.run('UPDATE users SET section_id = ? WHERE id = ?', await checkSection(req.body.section_id), m.id);
  res.json({ ok: true });
});
app.delete('/api/admin/members/:id', ...A, async (req, res) => {
  const m = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!m) return res.json({ ok: true });
  if (m.id === req.user.id) return res.status(400).json({ error: "You can't remove yourself" });
  await db.batch(['sessions', 'user_tasks', 'progress', 'reviews', 'study_sessions', 'plan_items']
    .map((t) => [`DELETE FROM ${t} WHERE user_id = ?`, m.id]).concat([['DELETE FROM users WHERE id = ?', m.id]]));
  res.json({ ok: true });
});

// ---------- courses ----------
const withSources = (c) => (c ? { ...c, sources: parseSources(c.sources) } : c);
app.get('/api/courses', auth, async (req, res) => res.json((await db.all('SELECT * FROM courses ORDER BY name')).map(withSources)));

// every course with how many assignments / quizzes / exams / sheets / questions it holds
const COUNTS_SQL = (where) => `
  (SELECT COUNT(*) FROM tasks t WHERE ${where('t')} AND t.type = 'assignment') AS assignments,
  (SELECT COUNT(*) FROM tasks t WHERE ${where('t')} AND t.type = 'quiz') AS quizzes,
  (SELECT COUNT(*) FROM tasks t WHERE ${where('t')} AND t.type = 'exam') AS exams,
  (SELECT COUNT(*) FROM materials m WHERE ${where('m')}) AS sheets,
  (SELECT COUNT(*) FROM questions q WHERE ${where('q')}) AS questions`;
app.get('/api/courses/overview', auth, async (req, res) => {
  const courses = await db.all(`SELECT c.*, ${COUNTS_SQL((a) => `${a}.course_id = c.id`)},
      (SELECT COUNT(*) FROM questions q JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE q.course_id = c.id AND p.reps >= 4) AS mastered
    FROM courses c ORDER BY c.name`, req.user.id);
  const none = await db.get(`SELECT ${COUNTS_SQL((a) => `${a}.course_id IS NULL`)}`);
  res.json({ courses: courses.map(withSources), uncategorized: none });
});

// everything that belongs to one course ('none' = items without a course)
app.get('/api/courses/:id/content', auth, async (req, res) => {
  const none = req.params.id === 'none';
  const cid = none ? null : Number(req.params.id);
  const course = none ? { id: 'none', name: 'No course', color: '#9ca3af' } : await db.get('SELECT * FROM courses WHERE id = ?', cid);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const match = (a) => (none ? `${a}.course_id IS NULL` : `${a}.course_id = ${cid}`);
  const tasks = await db.all(taskQuery(match('t')) + ` ORDER BY (COALESCE(ut.status,'todo') = 'done'), COALESCE(td.due_at, t.due_at) IS NULL, COALESCE(td.due_at, t.due_at)`, tp(req));
  if (req.user.perms.includes('tasks') && tasks.length) {
    const dues = await db.all(`SELECT task_id, section_id, due_at FROM task_due WHERE task_id IN (${tasks.map((t) => t.id).join(',')})`);
    for (const t of tasks) t.section_dues = Object.fromEntries(dues.filter((d) => d.task_id === t.id).map((d) => [d.section_id, d.due_at]));
  }
  const materials = await db.all(`SELECT m.id, m.title, m.kind, m.course_id, m.created_at,
      (SELECT COUNT(*) FROM questions q WHERE q.material_id = m.id) AS question_count,
      (SELECT COUNT(*) FROM questions q JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE q.material_id = m.id AND p.reps >= 4) AS mastered
    FROM materials m WHERE ${match('m')} ORDER BY m.created_at DESC`, req.user.id);
  const qs = await db.get(`SELECT COUNT(*) AS total, COALESCE(SUM(p.reps >= 4), 0) AS mastered
    FROM questions q LEFT JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE ${match('q')}`, req.user.id);
  res.json({ course: none ? course : withSources(course), tasks, materials, questions: qs });
});
// code (e.g. PHY-111) and linked classes: [{ type: moodle|lecture|section|lab, name }]
function courseExtras(b) {
  const code = b.code == null ? null : String(b.code).trim().slice(0, 30) || null;
  const sources = Array.isArray(b.sources) ? JSON.stringify(parseSources(JSON.stringify(b.sources))) : null;
  return { code, sources };
}
app.post('/api/courses', ...can('courses'), async (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required' });
  const { code, sources } = courseExtras(req.body);
  const r = await db.run('INSERT INTO courses (name, color, code, sources) VALUES (?, ?, ?, ?)', String(req.body.name).trim(), req.body.color || '#6366f1', code, sources || '[]');
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/courses/:id', ...can('courses'), async (req, res) => {
  const cur = await db.get('SELECT * FROM courses WHERE id = ?', req.params.id);
  if (!cur) return res.status(404).json({ error: 'Course not found' });
  const { code, sources } = courseExtras(req.body);
  await db.run('UPDATE courses SET name = ?, color = ?, code = ?, sources = ? WHERE id = ?',
    String(req.body.name || cur.name).trim(), req.body.color || cur.color, 'code' in req.body ? code : cur.code, sources ?? cur.sources ?? '[]', cur.id);
  res.json({ ok: true });
});
app.delete('/api/courses/:id', ...can('courses'), async (req, res) => {
  const id = Number(req.params.id);
  await db.batch(['tasks', 'materials', 'questions', 'study_sessions', 'plan_items']
    .map((t) => [`UPDATE ${t} SET course_id = NULL WHERE course_id = ?`, id]).concat([['DELETE FROM courses WHERE id = ?', id]]));
  res.json({ ok: true });
});

// ---------- tasks (assignments / quizzes / exams) ----------
app.get('/api/tasks', auth, async (req, res) => {
  const rows = await db.all(taskQuery() + ` ORDER BY (COALESCE(ut.status,'todo') = 'done'), COALESCE(td.due_at, t.due_at) IS NULL, COALESCE(td.due_at, t.due_at)`, tp(req));
  if (req.user.perms.includes('tasks')) {
    const dues = await db.all('SELECT task_id, section_id, due_at FROM task_due');
    for (const t of rows) t.section_dues = Object.fromEntries(dues.filter((d) => d.task_id === t.id).map((d) => [d.section_id, d.due_at]));
  }
  res.json(rows);
});
async function saveSectionDues(taskId, dues) {
  const stmts = [['DELETE FROM task_due WHERE task_id = ?', taskId]];
  for (const [sid, due] of Object.entries(dues || {})) if (due) stmts.push(['INSERT INTO task_due (task_id, section_id, due_at) VALUES (?, ?, ?)', taskId, await checkSection(sid), due]);
  await db.batch(stmts);
}
// new items must be filed under a course (once the class has any courses)
async function requireCourse(courseId) {
  if ((courseId == null || courseId === '') && (await db.get('SELECT COUNT(*) AS n FROM courses')).n > 0) throw httpError(400, 'Choose a course for this item');
}
async function taskFields(b, isNew = false) {
  if (!b.title) throw httpError(400, 'Title required');
  if (isNew) await requireCourse(b.course_id);
  return [b.title, b.type || 'assignment', nul(b.due_at), b.priority || 'medium', b.notes || '', nul(b.max_grade), await checkCourse(b.course_id)];
}
app.post('/api/tasks', ...can('tasks'), async (req, res) => {
  const r = await db.run(`INSERT INTO tasks (title, type, due_at, priority, notes, max_grade, course_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ...(await taskFields(req.body, true)), req.user.id);
  await saveSectionDues(r.lastInsertRowid, req.body.section_dues);
  const course = req.body.course_id ? (await db.get('SELECT name FROM courses WHERE id = ?', Number(req.body.course_id)))?.name : null;
  await notify({ kind: 'task', title: `New ${req.body.type || 'assignment'}: ${req.body.title}`,
    body: `${course ? course + ' · ' : ''}added by ${req.user.name}. Check your section's due date.`, url: req.body.course_id ? `#/courses/${req.body.course_id}` : '#/tasks' });
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/tasks/:id', ...can('tasks'), async (req, res) => {
  await db.run('UPDATE tasks SET title=?, type=?, due_at=?, priority=?, notes=?, max_grade=?, course_id=? WHERE id = ?',
    ...(await taskFields(req.body)), req.params.id);
  await saveSectionDues(Number(req.params.id), req.body.section_dues);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', ...can('tasks'), async (req, res) => {
  const id = Number(req.params.id);
  await db.batch(['task_due', 'user_tasks', 'plan_items'].map((t) => [`DELETE FROM ${t} WHERE task_id = ?`, id]).concat([['DELETE FROM tasks WHERE id = ?', id]]));
  res.json({ ok: true });
});
app.patch('/api/tasks/:id/mine', auth, async (req, res) => {
  const t = await db.get('SELECT id FROM tasks WHERE id = ?', req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const cur = (await db.get('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?', req.user.id, t.id)) || { status: 'todo', grade: null };
  const status = req.body.status ?? cur.status;
  if (!['todo', 'doing', 'done'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  const grade = 'grade' in req.body ? nul(req.body.grade) : cur.grade;
  await db.run(`INSERT INTO user_tasks (user_id, task_id, status, grade) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, task_id) DO UPDATE SET status = excluded.status, grade = excluded.grade`, req.user.id, t.id, status, grade);
  res.json({ ok: true });
});

// ---------- study materials (sheets) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(file.mimetype) || file.mimetype.startsWith('text/');
    cb(ok ? null : httpError(400, 'Only PDF, image (png/jpg/webp/gif) or text files are supported'), ok);
  },
});

app.get('/api/materials', auth, async (req, res) => {
  res.json(await db.all(`
    SELECT m.id, m.title, m.kind, m.course_id, m.created_at, c.name AS course_name, c.color AS course_color,
      (SELECT COUNT(*) FROM questions q WHERE q.material_id = m.id) AS question_count,
      (SELECT COUNT(*) FROM questions q JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE q.material_id = m.id AND p.reps >= 4) AS mastered
    FROM materials m LEFT JOIN courses c ON c.id = m.course_id ORDER BY m.created_at DESC`, req.user.id));
});
app.get('/api/materials/:id', auth, async (req, res) => {
  const m = await db.get(`SELECT m.*, (SELECT COUNT(*) FROM questions q WHERE q.material_id = m.id) AS question_count,
      (SELECT COUNT(*) FROM questions q JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE q.material_id = m.id AND p.reps >= 4) AS mastered
    FROM materials m WHERE m.id = ?`, req.user.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(m);
});
app.get('/api/materials/:id/file', auth, async (req, res) => {
  const m = await db.get('SELECT file_id, mime FROM materials WHERE id = ?', req.params.id);
  if (!m || m.file_id == null) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400').type(m.mime).send(await db.readFile(m.file_id));
});
app.post('/api/materials', ...can('sheets'), upload.single('file'), async (req, res) => {
  const { title, course_id, body } = req.body;
  await requireCourse(course_id);
  const courseId = await checkCourse(course_id);
  let kind = 'text', fileId = null, mime = null, text = body || '';
  if (req.file) {
    mime = req.file.mimetype;
    if (mime === 'application/pdf' || mime.startsWith('image/')) {
      kind = mime === 'application/pdf' ? 'pdf' : 'image';
      fileId = await db.saveFile(req.file.buffer, mime);
    } else {
      text = req.file.buffer.toString('utf8'); mime = null;
    }
  } else if (!text.trim()) {
    return res.status(400).json({ error: 'Upload a file or paste some notes' });
  }
  const r = await db.run('INSERT INTO materials (course_id, title, kind, file_id, mime, body, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    courseId, title || req.file?.originalname || 'Untitled notes', kind, fileId, mime, text, req.user.id);
  await notify({ kind: 'sheet', title: `New study sheet: ${title || req.file?.originalname || 'Untitled notes'}`, body: `Added by ${req.user.name}.`, url: `#/materials/${r.lastInsertRowid}` });
  res.json({ id: r.lastInsertRowid });
});
async function deleteQuestions(where, arg) {
  const ids = (await db.all(`SELECT id FROM questions WHERE ${where}`, arg)).map((r) => r.id);
  if (!ids.length) return;
  const list = ids.join(',');
  await db.batch([[`DELETE FROM progress WHERE question_id IN (${list})`], [`DELETE FROM reviews WHERE question_id IN (${list})`], [`DELETE FROM questions WHERE id IN (${list})`]]);
}
// rename a sheet or move it to another course (its questions move with it)
app.patch('/api/materials/:id', ...can('sheets'), async (req, res) => {
  const m = await db.get('SELECT * FROM materials WHERE id = ?', req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const stmts = [];
  if (req.body.title) stmts.push(['UPDATE materials SET title = ? WHERE id = ?', String(req.body.title).trim(), m.id]);
  if ('course_id' in req.body) {
    const cid = await checkCourse(req.body.course_id);
    stmts.push(['UPDATE materials SET course_id = ? WHERE id = ?', cid, m.id], ['UPDATE questions SET course_id = ? WHERE material_id = ?', cid, m.id]);
  }
  if (stmts.length) await db.batch(stmts);
  res.json({ ok: true });
});
app.delete('/api/materials/:id', ...can('sheets'), async (req, res) => {
  const m = await db.get('SELECT * FROM materials WHERE id = ?', req.params.id);
  if (m) {
    await deleteQuestions('material_id = ?', m.id);
    await db.deleteFile(m.file_id);
    await db.run('DELETE FROM materials WHERE id = ?', m.id);
  }
  res.json({ ok: true });
});

app.post('/api/materials/:id/generate', ...can('questions'), async (req, res) => {
  const m = await db.get('SELECT * FROM materials WHERE id = ?', req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const count = Math.min(Math.max(parseInt(req.body.count) || 10, 1), 30);
  const existing = (await db.all('SELECT question FROM questions WHERE material_id = ?', m.id)).map((q) => q.question);
  const qs = await generateMCQs({
    material: m, fileData: m.file_id != null ? await db.readFile(m.file_id) : null,
    count, difficulty: req.body.difficulty || 'mixed', focus: req.body.focus || '', existing,
  });
  await db.batch(qs.map((q) => [`INSERT INTO questions (course_id, material_id, topic, question, choices, answer_index, explanation, source, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?)`, m.course_id, m.id, q.topic || 'General', q.question, JSON.stringify(q.choices), q.answer_index, q.explanation || '', req.user.id]));
  res.json({ added: qs.length });
});

// ---------- question bank (admins) ----------
const parseQ = (q) => ({ ...q, choices: JSON.parse(q.choices) });
const MASTERED_REPS = 4;

app.get('/api/questions', ...can('questions'), async (req, res) => {
  const where = ['1=1']; const args = [req.user.id];
  if (req.query.course_id) { where.push('q.course_id = ?'); args.push(Number(req.query.course_id)); }
  if (req.query.material_id) { where.push('q.material_id = ?'); args.push(Number(req.query.material_id)); }
  res.json((await db.all(`SELECT q.*, c.name AS course_name, m.title AS material_title,
      COALESCE(p.reps, 0) AS reps, p.due_at, COALESCE(p.correct_count, 0) AS correct_count, COALESCE(p.wrong_count, 0) AS wrong_count
    FROM questions q LEFT JOIN courses c ON c.id = q.course_id LEFT JOIN materials m ON m.id = q.material_id
    LEFT JOIN progress p ON p.question_id = q.id AND p.user_id = ?
    WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC, q.id DESC`, ...args)).map(parseQ));
});
function validQ(b) {
  const choices = (b.choices || []).map((c) => String(c).trim()).filter(Boolean);
  const ai = Number(b.answer_index);
  if (!b.question || choices.length < 2 || !(ai >= 0 && ai < choices.length)) throw httpError(400, 'A question needs text, at least 2 choices and a correct answer');
  return { choices, ai };
}
app.post('/api/questions', ...can('questions'), async (req, res) => {
  const b = req.body; const { choices, ai } = validQ(b);
  const r = await db.run(`INSERT INTO questions (course_id, material_id, topic, question, choices, answer_index, explanation, source, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)`, await checkCourse(b.course_id), nul(b.material_id),
    b.topic || 'General', b.question, JSON.stringify(choices), ai, b.explanation || '', req.user.id);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/questions/:id', ...can('questions'), async (req, res) => {
  const b = req.body; const { choices, ai } = validQ(b);
  await db.run('UPDATE questions SET course_id=?, topic=?, question=?, choices=?, answer_index=?, explanation=? WHERE id=?',
    await checkCourse(b.course_id), b.topic || 'General', b.question, JSON.stringify(choices), ai, b.explanation || '', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/questions/:id', ...can('questions'), async (req, res) => {
  await deleteQuestions('id = ?', Number(req.params.id));
  res.json({ ok: true });
});
app.get('/api/topics', auth, async (req, res) => {
  const rows = req.query.course_id
    ? await db.all('SELECT DISTINCT topic FROM questions WHERE course_id = ? ORDER BY topic', Number(req.query.course_id))
    : await db.all('SELECT DISTINCT topic FROM questions ORDER BY topic');
  res.json(rows.map((r) => r.topic));
});

// ---------- practice (personal spaced repetition) ----------
function scopeFilter(req) {
  const where = ['1=1']; const args = [];
  if (req.query.course_id) { where.push('q.course_id = ?'); args.push(Number(req.query.course_id)); }
  if (req.query.material_id) { where.push('q.material_id = ?'); args.push(Number(req.query.material_id)); }
  if (req.query.topic) { where.push('q.topic = ?'); args.push(String(req.query.topic)); }
  return { where: where.join(' AND '), args };
}
const QP = 'FROM questions q LEFT JOIN progress p ON p.question_id = q.id AND p.user_id = ?';

app.get('/api/practice/next', auth, async (req, res) => {
  const { where, args } = scopeFilter(req);
  const uid = req.user.id; const now = nowISO();
  const exclude = String(req.query.exclude || '').split(',').map(Number).filter(Boolean).slice(-50);
  const exSql = exclude.length ? ` AND q.id NOT IN (${exclude.join(',')})` : '';
  const counts = await db.get(`SELECT COUNT(*) AS total,
      COALESCE(SUM(p.due_at IS NOT NULL AND p.due_at <= ?), 0) AS due,
      COALESCE(SUM(p.due_at IS NULL), 0) AS fresh,
      COALESCE(SUM(p.reps >= ${MASTERED_REPS}), 0) AS mastered
    ${QP} WHERE ${where}`, now, uid, ...args);
  const sel = `SELECT q.id, q.topic, q.question, q.choices, q.source, COALESCE(p.reps, 0) AS reps, p.due_at ${QP}`;
  let q = await db.get(`${sel} WHERE ${where} AND p.due_at IS NOT NULL AND p.due_at <= ?${exSql} ORDER BY p.due_at LIMIT 1`, uid, ...args, now);
  if (!q) q = await db.get(`${sel} WHERE ${where} AND p.due_at IS NULL${exSql} ORDER BY q.id LIMIT 1`, uid, ...args);
  if (!q && req.query.mode === 'cram') {
    q = await db.get(`${sel} WHERE ${where}${exSql}
      ORDER BY COALESCE(p.reps, 0), (COALESCE(p.wrong_count, 0) - COALESCE(p.correct_count, 0)) DESC, RANDOM() LIMIT 1`, uid, ...args);
  }
  const nextDue = (await db.get(`SELECT MIN(p.due_at) AS d ${QP} WHERE ${where} AND p.due_at > ?`, uid, ...args, now)).d;
  res.json({ question: q ? parseQ(q) : null, counts, next_due: nextDue });
});

app.post('/api/questions/:id/answer', auth, async (req, res) => {
  const q = await db.get('SELECT * FROM questions WHERE id = ?', req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const p = (await db.get('SELECT * FROM progress WHERE user_id = ? AND question_id = ?', req.user.id, q.id)) || { ease: 2.5, interval_days: 0, reps: 0 };
  const correct = Number(req.body.choice) === q.answer_index;
  let { ease, interval_days: interval, reps } = p;
  let dueMs;
  if (correct) {
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.round(interval * ease * 10) / 10;
    ease = Math.min(3.0, ease + 0.05);
    dueMs = Date.now() + interval * 86400000;
  } else {
    reps = 0; interval = 0;
    ease = Math.max(1.3, ease - 0.2);
    dueMs = Date.now() + 3 * 60000; // comes back in ~3 minutes
  }
  await db.batch([
    [`INSERT INTO progress (user_id, question_id, ease, interval_days, reps, due_at, correct_count, wrong_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, question_id) DO UPDATE SET ease = excluded.ease, interval_days = excluded.interval_days, reps = excluded.reps,
        due_at = excluded.due_at, correct_count = correct_count + excluded.correct_count, wrong_count = wrong_count + excluded.wrong_count`,
      req.user.id, q.id, ease, interval, reps, new Date(dueMs).toISOString(), correct ? 1 : 0, correct ? 0 : 1],
    ['INSERT INTO reviews (user_id, question_id, correct) VALUES (?, ?, ?)', req.user.id, q.id, correct ? 1 : 0],
  ]);
  res.json({ correct, answer_index: q.answer_index, explanation: q.explanation, interval_days: interval, mastered: reps >= MASTERED_REPS });
});

app.get('/api/mastery', auth, async (req, res) => {
  const rows = await db.all(`SELECT q.course_id, COALESCE(c.name, 'No course') AS course_name, c.color, q.topic,
      COUNT(*) AS total, SUM(MIN(COALESCE(p.reps, 0), ${MASTERED_REPS})) AS rep_sum, SUM(COALESCE(p.reps, 0) >= ${MASTERED_REPS}) AS mastered,
      SUM(COALESCE(p.correct_count, 0)) AS correct, SUM(COALESCE(p.wrong_count, 0)) AS wrong
    ${QP} LEFT JOIN courses c ON c.id = q.course_id
    GROUP BY q.course_id, q.topic ORDER BY course_name, q.topic`, req.user.id);
  const courses = {};
  for (const r of rows) {
    const c = (courses[r.course_id ?? 0] ||= { course_id: r.course_id, course_name: r.course_name, color: r.color, total: 0, rep_sum: 0, mastered: 0, topics: [] });
    c.total += r.total; c.rep_sum += r.rep_sum; c.mastered += r.mastered;
    const answered = r.correct + r.wrong;
    c.topics.push({ topic: r.topic, total: r.total, mastered: r.mastered,
      mastery: Math.round((r.rep_sum / (r.total * MASTERED_REPS)) * 100),
      accuracy: answered ? Math.round((r.correct / answered) * 100) : null });
  }
  res.json(Object.values(courses).map((c) => ({ ...c, mastery: Math.round((c.rep_sum / (c.total * MASTERED_REPS)) * 100) })));
});

// ---------- study sessions (Pomodoro) ----------
app.post('/api/study-sessions', auth, async (req, res) => {
  const minutes = Math.max(1, Math.min(600, parseInt(req.body.minutes) || 0));
  await db.run('INSERT INTO study_sessions (user_id, course_id, minutes) VALUES (?, ?, ?)', req.user.id, await checkCourse(req.body.course_id), minutes);
  res.json({ ok: true });
});

// ---------- personal planner ----------
app.get('/api/plan', auth, async (req, res) => {
  const from = String(req.query.from || '0000-01-01'), to = String(req.query.to || '9999-12-31');
  res.json(await db.all(`SELECT p.*, c.name AS course_name, c.color AS course_color FROM plan_items p
    LEFT JOIN courses c ON c.id = p.course_id WHERE p.user_id = ? AND p.date BETWEEN ? AND ? ORDER BY p.date, p.id`, req.user.id, from, to));
});
app.post('/api/plan', auth, async (req, res) => {
  const { date, title, minutes, course_id } = req.body;
  if (!date || !title) return res.status(400).json({ error: 'Date and title required' });
  await db.run('INSERT INTO plan_items (user_id, course_id, date, title, minutes) VALUES (?, ?, ?, ?, ?)',
    req.user.id, await checkCourse(course_id), date, title, parseInt(minutes) || 45);
  res.json({ ok: true });
});
app.patch('/api/plan/:id', auth, async (req, res) => {
  await db.run('UPDATE plan_items SET done = ? WHERE id = ? AND user_id = ?', req.body.done ? 1 : 0, req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/plan/:id', auth, async (req, res) => {
  await db.run('DELETE FROM plan_items WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  res.json({ ok: true });
});
// spread study sessions from today until the task's due date (for *my* section)
app.post('/api/tasks/:id/plan', auth, async (req, res) => {
  const t = await db.get(taskQuery('t.id = $id'), tp(req, { $id: Number(req.params.id) }));
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!t.due_at) return res.status(400).json({ error: 'This item has no due date for your section yet' });
  const minutes = parseInt(req.body.minutes) || 45;
  // plan by the student's own calendar days (browser sends its timezone offset)
  const tz = Number(req.body.tz_offset) || 0; // minutes, as from Date.getTimezoneOffset()
  const local = (d) => new Date(d.getTime() - tz * 60000);
  const dayStr = (d) => local(d).toISOString().slice(0, 10);
  const dueDay = dayStr(new Date(t.due_at));
  const days = [];
  for (let d = new Date(); dayStr(d) < dueDay && days.length < 21; d = new Date(d.getTime() + 86400000)) days.push(dayStr(d));
  if (!days.length) return res.status(400).json({ error: 'The due date is today or already passed — no days left to plan' });
  const isTest = t.type === 'quiz' || t.type === 'exam';
  const steps = isTest
    ? ['Read & summarise the sheets', 'Practice MCQs (new questions)', 'Review weak topics', 'Practice MCQs (due reviews)', 'Re-read the hardest parts']
    : ['Understand the requirements & outline', 'Research / gather material', 'Work on the main part', 'Continue working', 'Polish & proofread'];
  await db.batch([['DELETE FROM plan_items WHERE task_id = ? AND user_id = ?', t.id, req.user.id]].concat(days.map((day, i) => {
    const step = i === days.length - 1 ? (isTest ? 'Final review: practice all MCQs in cram mode' : 'Final check & submit') : steps[i % steps.length];
    return ['INSERT INTO plan_items (user_id, task_id, course_id, date, title, minutes) VALUES (?, ?, ?, ?, ?, ?)', req.user.id, t.id, t.course_id, day, `${t.title} — ${step}`, minutes];
  })));
  res.json({ created: days.length });
});

// ---------- dashboard & reminders ----------
async function streak(uid, tz) {
  const dayOf = (d) => new Date(d.getTime() - tz * 60000).toISOString().slice(0, 10);
  const rows = await db.all('SELECT at FROM reviews WHERE user_id = ? UNION ALL SELECT at FROM study_sessions WHERE user_id = ?', uid, uid);
  const days = new Set(rows.map((r) => dayOf(new Date(r.at.replace(' ', 'T') + 'Z'))));
  let n = 0; let d = new Date();
  if (!days.has(dayOf(d))) d = new Date(d.getTime() - 86400000);
  while (days.has(dayOf(d))) { n++; d = new Date(d.getTime() - 86400000); }
  return n;
}

app.get('/api/dashboard', auth, async (req, res) => {
  const uid = req.user.id; const now = nowISO();
  const in3 = new Date(Date.now() + 3 * 86400000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const today = String(req.query.today || localDate());
  const tz = Number(req.query.tz_offset) || 0;
  const open = `COALESCE(ut.status,'todo') != 'done'`, due = 'COALESCE(td.due_at, t.due_at)';
  const [overdue, upcoming, soon, today_plan, rd, nq, mw, aw, st, grades] = await Promise.all([
    db.all(taskQuery(`${open} AND ${due} < $now`) + ` ORDER BY ${due}`, tp(req, { $now: now })),
    db.all(taskQuery(`${open} AND ${due} >= $now`) + ` ORDER BY ${due} LIMIT 8`, tp(req, { $now: now })),
    db.all(taskQuery(`${open} AND ${due} BETWEEN $now AND $in3`), tp(req, { $now: now, $in3: in3 })),
    db.all(`SELECT p.*, c.name AS course_name, c.color AS course_color FROM plan_items p LEFT JOIN courses c ON c.id = p.course_id
      WHERE p.user_id = ? AND p.date = ? ORDER BY p.id`, uid, today),
    db.get('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND due_at <= ?', uid, now),
    db.get('SELECT COUNT(*) AS n FROM questions q LEFT JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE p.due_at IS NULL', uid),
    db.get('SELECT COALESCE(SUM(minutes),0) AS m FROM study_sessions WHERE user_id = ? AND at >= ?', uid, weekAgo),
    db.get('SELECT COUNT(*) AS n, COALESCE(SUM(correct),0) AS c FROM reviews WHERE user_id = ? AND at >= ?', uid, weekAgo),
    streak(uid, tz),
    db.all(`SELECT COALESCE(c.name,'No course') AS course_name, c.color,
        ROUND(100.0 * SUM(ut.grade) / SUM(t.max_grade), 1) AS pct, COUNT(*) AS n
      FROM user_tasks ut JOIN tasks t ON t.id = ut.task_id LEFT JOIN courses c ON c.id = t.course_id
      WHERE ut.user_id = ? AND ut.grade IS NOT NULL AND t.max_grade > 0 GROUP BY t.course_id`, uid),
  ]);
  res.json({ overdue, upcoming, due_soon_count: soon.length, today_plan, reviews_due: rd.n, new_questions: nq.n,
    minutes_week: mw.m, answered_week: aw, streak: st, grades });
});

app.get('/api/reminders', auth, async (req, res) => {
  const due = 'COALESCE(td.due_at, t.due_at)';
  const tasks = (await db.all(taskQuery(`COALESCE(ut.status,'todo') != 'done' AND ${due} IS NOT NULL AND ${due} <= $soon`),
    tp(req, { $soon: new Date(Date.now() + 86400000).toISOString() }))).map(({ id, title, type, due_at }) => ({ id, title, type, due_at }));
  const reviews = (await db.get('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND due_at <= ?', req.user.id, nowISO())).n;
  res.json({ tasks, reviews_due: reviews });
});

// ---------- notifications ----------
app.get('/api/notifications', auth, async (req, res) => res.json(await listFor(req.user)));
// remove from MY list only — classmates keep seeing it
app.delete('/api/notifications/:id', auth, async (req, res) => {
  const n = req.params.id === 'all' ? await N().hideFor(req.user, 'all') : await N().hideFor(req.user, [req.params.id]);
  res.json({ removed: n });
});
app.post('/api/notifications/seen', auth, async (req, res) => {
  await db.run("UPDATE users SET notif_seen_at = datetime('now') WHERE id = ?", req.user.id);
  res.json({ ok: true });
});
// push notifications (phone / computer, works when the app is closed)
app.get('/api/push/key', auth, async (req, res) => res.json({ key: (await vapidKeys()).publicKey }));
app.post('/api/push/subscribe', auth, async (req, res) => {
  const s = req.body || {};
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth || !/^https:\/\//.test(s.endpoint)) return res.status(400).json({ error: 'Bad subscription' });
  await db.run(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`, s.endpoint, req.user.id, s.keys.p256dh, s.keys.auth);
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', auth, async (req, res) => {
  if (req.body?.endpoint) await db.run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', req.body.endpoint, req.user.id);
  res.json({ ok: true });
});
app.post('/api/push/test', auth, async (req, res) => {
  await notify({ audience: 'user', targetId: req.user.id, kind: 'info', title: 'Notifications are working', body: 'You will get alerts for new assignments, deadlines and emails here.', url: '#/notifications' });
  res.json({ ok: true });
});

// ---------- connections: Moodle + Gmail (admins) ----------
const gs = getSetting, ss = setSetting;
const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
app.get('/api/admin/connections', ...A, async (req, res) => {
  const url = await gs('moodle_ical_url');
  const owner = Number(await gs('email_owner_id')) || null;
  res.json({
    moodle: { connected: !!url, url_hint: url ? url.replace(/(authtoken=)[^&]+/i, '$1•••••').slice(0, 120) : null,
      last_sync: await gs('moodle_last_sync'), last_status: await gs('moodle_last_status') },
    email: { hook_url: `${baseUrl(req)}/api/hooks/email`, secret: await integrations.hookSecret(), share: (await gs('email_share')) === 'all',
      owner: owner ? (await db.get('SELECT name FROM users WHERE id = ?', owner))?.name : null, last: await gs('email_last') },
    cron_url: `${baseUrl(req)}/api/cron`,
  });
});
app.put('/api/admin/connections', ...A, async (req, res) => {
  const b = req.body || {};
  if ('moodle_ical_url' in b) {
    const u = String(b.moodle_ical_url || '').trim();
    // real Moodle links are https; plain http is only accepted for localhost (testing)
    if (u && !/^https:\/\/.+/i.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(u)) return res.status(400).json({ error: 'Paste the full https:// calendar link from Moodle' });
    await ss('moodle_ical_url', u);
    if (u) { await ss('moodle_last_sync', ''); }
  }
  if ('email_share' in b) await ss('email_share', b.email_share ? 'all' : 'owner');
  if (b.claim_email) await ss('email_owner_id', String(req.user.id)); // email alerts go to this admin
  res.json({ ok: true });
});
app.post('/api/admin/connections/moodle-sync', ...A, async (req, res) => res.json(await integrations.moodleSync({ force: true })));
app.post('/api/admin/connections/new-secret', ...A, async (req, res) => {
  await ss('hook_secret', ''); res.json({ secret: await integrations.hookSecret() });
});

// Called by the Google Apps Script in Gmail (every ~10 minutes) with new emails
app.post('/api/hooks/email', async (req, res) => {
  const key = req.get('x-ejust-key') || req.query.key;
  if (!key || key !== (await integrations.hookSecret())) return res.status(403).json({ error: 'Bad key' });
  const out = await integrations.receiveEmails(req.body?.messages || []);
  await ss('email_last', new Date().toISOString());
  let tick = null;
  try { tick = await integrations.tick(); } catch (e) { tick = { error: e.message }; }
  res.json({ ...out, tick });
});
// Scheduler: Vercel cron (daily) and the Gmail script call this. Safe to call any time (it throttles itself).
app.all('/api/cron', async (req, res) => {
  try { res.json(await integrations.tick()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE' || err.type === 'entity.too.large') err = httpError(413, 'That file is too big — sheets can be up to 4 MB. Try compressing the PDF or splitting it.');
  if (!err.status && !(err instanceof multer.MulterError)) console.error(err);
  res.status(err.status || (err instanceof multer.MulterError ? 400 : 500)).json({ error: err.message || 'Server error' });
});

// On Vercel the app is exported and run as a serverless function; locally (or on any
// normal host) it listens on a port.
module.exports = app;
if (!process.env.VERCEL) {
  ready.then(() => {
    app.listen(PORT, () => console.log(`StudyHub running at http://localhost:${PORT}  (database: ${process.env.TURSO_DATABASE_URL ? 'Turso' : 'local file'}, AI ${aiAvailable() ? 'enabled' : 'disabled'})`));
  }).catch((e) => { console.error('Could not open the database:', e.message); process.exit(1); });
}
