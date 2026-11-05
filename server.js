const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { generateMCQs, aiAvailable } = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const nul = (v) => (v === undefined || v === '' ? null : v);
const nowISO = () => new Date().toISOString();
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const httpError = (status, msg) => Object.assign(new Error(msg), { status });

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
const setSetting = (k, v) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const newInviteCode = () => crypto.randomBytes(4).toString('hex').toUpperCase(); // e.g. 9F3A1C0B
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 64), Buffer.from(hash, 'hex'));
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires.toISOString());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', expires });
}
function auth(req, res, next) {
  const token = req.cookies.sid;
  const row = token && db.prepare(`SELECT u.id, u.name, u.email, u.role, u.section_id, s.name AS section_name
    FROM sessions x JOIN users u ON u.id = x.user_id LEFT JOIN sections s ON s.id = u.section_id
    WHERE x.token = ? AND x.expires_at > ?`).get(token, nowISO());
  if (!row) return res.status(401).json({ error: 'Not signed in' });
  req.user = row;
  next();
}
function admin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only class reps/admins can do this' });
  next();
}
const A = [auth, admin];
function checkCourse(courseId) {
  if (courseId == null || courseId === '') return null;
  const c = db.prepare('SELECT id FROM courses WHERE id = ?').get(Number(courseId));
  if (!c) throw httpError(400, 'Course not found');
  return c.id;
}
function checkSection(sectionId) {
  const s = db.prepare('SELECT id FROM sections WHERE id = ?').get(Number(sectionId));
  if (!s) throw httpError(400, 'Please choose your section');
  return s.id;
}

// Task rows as seen by a given student: due date for their section + their own status/grade
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
// Public: is the class set up yet, and what's its name?
app.get('/api/class/status', (req, res) => {
  res.json({ setup_done: userCount() > 0, name: getSetting('class_name') });
});
// Public: check an invite code and list the sections to choose from
app.get('/api/class/join-info', (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!code || code !== getSetting('invite_code')) return res.status(404).json({ error: 'That invite code is not valid' });
  res.json({ name: getSetting('class_name'), sections: db.prepare('SELECT id, name FROM sections ORDER BY name').all() });
});

// First user sets up the class and becomes its admin
app.post('/api/setup', (req, res) => {
  if (userCount() > 0) return res.status(409).json({ error: 'The class is already set up. Join with an invite code.' });
  const { class_name, sections, name, email, password } = req.body || {};
  if (!class_name || !name || !email || !password) return res.status(400).json({ error: 'Class name, your name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const names = [...new Set(String(sections || '').split(',').map((s) => s.trim()).filter(Boolean))];
  if (!names.length) return res.status(400).json({ error: 'Add at least one section' });
  setSetting('class_name', class_name.trim());
  setSetting('invite_code', newInviteCode());
  const ins = db.prepare('INSERT INTO sections (name) VALUES (?)');
  const ids = names.map((n) => Number(ins.run(n).lastInsertRowid));
  const r = db.prepare("INSERT INTO users (name, email, pass_hash, role, section_id) VALUES (?, ?, ?, 'admin', ?)")
    .run(name.trim(), email.toLowerCase().trim(), hashPassword(password), ids[0]);
  startSession(res, Number(r.lastInsertRowid));
  res.json({ ok: true });
});

// Students join with the invite code and pick their section
app.post('/api/register', (req, res) => {
  const { name, email, password, code, section_id } = req.body || {};
  if (userCount() === 0) return res.status(400).json({ error: 'The class has not been set up yet' });
  if (String(code || '').trim().toUpperCase() !== getSetting('invite_code')) return res.status(403).json({ error: 'That invite code is not valid' });
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const sid = checkSection(section_id);
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim())) return res.status(409).json({ error: 'An account with this email already exists' });
  const r = db.prepare('INSERT INTO users (name, email, pass_hash, section_id) VALUES (?, ?, ?, ?)')
    .run(name.trim(), email.toLowerCase().trim(), hashPassword(password), sid);
  startSession(res, Number(r.lastInsertRowid));
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user || !verifyPassword(password || '', user.pass_hash)) return res.status(401).json({ error: 'Wrong email or password' });
  startSession(res, user.id);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ ...req.user, class_name: getSetting('class_name'), ai: aiAvailable() }));
app.get('/api/sections', auth, (req, res) => res.json(db.prepare('SELECT id, name FROM sections ORDER BY name').all()));
app.patch('/api/me/section', auth, (req, res) => {
  db.prepare('UPDATE users SET section_id = ? WHERE id = ?').run(checkSection(req.body.section_id), req.user.id);
  res.json({ ok: true });
});

// ---------- class admin ----------
app.get('/api/admin/class', ...A, (req, res) => {
  res.json({
    name: getSetting('class_name'),
    invite_code: getSetting('invite_code'),
    sections: db.prepare(`SELECT s.id, s.name, (SELECT COUNT(*) FROM users u WHERE u.section_id = s.id) AS members
      FROM sections s ORDER BY s.name`).all(),
    members: db.prepare(`SELECT u.id, u.name, u.email, u.role, u.section_id, s.name AS section_name, u.created_at
      FROM users u LEFT JOIN sections s ON s.id = u.section_id ORDER BY u.role, u.name`).all(),
  });
});
app.put('/api/admin/class', ...A, (req, res) => {
  if (req.body.name) setSetting('class_name', String(req.body.name).trim());
  res.json({ ok: true });
});
app.post('/api/admin/invite-code', ...A, (req, res) => {
  const code = newInviteCode(); setSetting('invite_code', code); res.json({ invite_code: code });
});
app.post('/api/admin/sections', ...A, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  try { db.prepare('INSERT INTO sections (name) VALUES (?)').run(name); } catch { return res.status(409).json({ error: 'A section with that name already exists' }); }
  res.json({ ok: true });
});
app.put('/api/admin/sections/:id', ...A, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  try { db.prepare('UPDATE sections SET name = ? WHERE id = ?').run(name, req.params.id); } catch { return res.status(409).json({ error: 'A section with that name already exists' }); }
  res.json({ ok: true });
});
app.delete('/api/admin/sections/:id', ...A, (req, res) => {
  if (db.prepare('SELECT COUNT(*) AS n FROM sections').get().n <= 1) return res.status(400).json({ error: 'The class needs at least one section' });
  db.prepare('DELETE FROM sections WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.patch('/api/admin/members/:id', ...A, (req, res) => {
  const m = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (req.body.role) {
    if (!['admin', 'student'].includes(req.body.role)) return res.status(400).json({ error: 'Bad role' });
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
    if (m.role === 'admin' && req.body.role !== 'admin' && admins <= 1) return res.status(400).json({ error: 'The class needs at least one admin' });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, m.id);
  }
  if (req.body.section_id !== undefined) db.prepare('UPDATE users SET section_id = ? WHERE id = ?').run(checkSection(req.body.section_id), m.id);
  res.json({ ok: true });
});
app.delete('/api/admin/members/:id', ...A, (req, res) => {
  const m = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!m) return res.json({ ok: true });
  if (m.id === req.user.id) return res.status(400).json({ error: "You can't remove yourself" });
  db.prepare('DELETE FROM users WHERE id = ?').run(m.id);
  res.json({ ok: true });
});

// ---------- courses ----------
app.get('/api/courses', auth, (req, res) => res.json(db.prepare('SELECT * FROM courses ORDER BY name').all()));
app.post('/api/courses', ...A, (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO courses (name, color) VALUES (?, ?)').run(req.body.name, req.body.color || '#6366f1');
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/courses/:id', ...A, (req, res) => {
  db.prepare('UPDATE courses SET name = ?, color = ? WHERE id = ?').run(req.body.name, req.body.color, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/courses/:id', ...A, (req, res) => {
  db.prepare('DELETE FROM courses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- tasks (assignments / quizzes / exams) ----------
app.get('/api/tasks', auth, (req, res) => {
  const rows = db.prepare(taskQuery() + ` ORDER BY (COALESCE(ut.status,'todo') = 'done'), COALESCE(td.due_at, t.due_at) IS NULL, COALESCE(td.due_at, t.due_at)`).all(tp(req));
  if (req.user.role === 'admin') {
    const dues = db.prepare('SELECT task_id, section_id, due_at FROM task_due').all();
    for (const t of rows) t.section_dues = Object.fromEntries(dues.filter((d) => d.task_id === t.id).map((d) => [d.section_id, d.due_at]));
  }
  res.json(rows);
});
function saveSectionDues(taskId, dues) {
  db.prepare('DELETE FROM task_due WHERE task_id = ?').run(taskId);
  const ins = db.prepare('INSERT INTO task_due (task_id, section_id, due_at) VALUES (?, ?, ?)');
  for (const [sid, due] of Object.entries(dues || {})) if (due) ins.run(taskId, checkSection(sid), due);
}
function taskFields(b) {
  if (!b.title) throw httpError(400, 'Title required');
  return [b.title, b.type || 'assignment', nul(b.due_at), b.priority || 'medium', b.notes || '', nul(b.max_grade), checkCourse(b.course_id)];
}
app.post('/api/tasks', ...A, (req, res) => {
  const r = db.prepare(`INSERT INTO tasks (title, type, due_at, priority, notes, max_grade, course_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...taskFields(req.body), req.user.id);
  const id = Number(r.lastInsertRowid);
  saveSectionDues(id, req.body.section_dues);
  res.json({ id });
});
app.put('/api/tasks/:id', ...A, (req, res) => {
  db.prepare('UPDATE tasks SET title=?, type=?, due_at=?, priority=?, notes=?, max_grade=?, course_id=? WHERE id = ?')
    .run(...taskFields(req.body), req.params.id);
  saveSectionDues(Number(req.params.id), req.body.section_dues);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', ...A, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
// each student tracks their own status and grade
app.patch('/api/tasks/:id/mine', auth, (req, res) => {
  const t = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const cur = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND task_id = ?').get(req.user.id, t.id) || { status: 'todo', grade: null };
  const status = req.body.status ?? cur.status;
  if (!['todo', 'doing', 'done'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  const grade = 'grade' in req.body ? nul(req.body.grade) : cur.grade;
  db.prepare(`INSERT INTO user_tasks (user_id, task_id, status, grade) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, task_id) DO UPDATE SET status = excluded.status, grade = excluded.grade`).run(req.user.id, t.id, status, grade);
  res.json({ ok: true });
});

// ---------- study materials (sheets) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(file.mimetype) || file.mimetype.startsWith('text/');
    cb(ok ? null : httpError(400, 'Only PDF, image (png/jpg/webp/gif) or text files are supported'), ok);
  },
});

app.get('/api/materials', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.title, m.kind, m.course_id, m.created_at, c.name AS course_name, c.color AS course_color,
      (SELECT COUNT(*) FROM questions q WHERE q.material_id = m.id) AS question_count,
      (SELECT COUNT(*) FROM questions q JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE q.material_id = m.id AND p.reps >= 4) AS mastered
    FROM materials m LEFT JOIN courses c ON c.id = m.course_id ORDER BY m.created_at DESC`).all(req.user.id));
});
app.get('/api/materials/:id', auth, (req, res) => {
  const m = db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM questions q WHERE q.material_id = m.id) AS question_count,
      (SELECT COUNT(*) FROM questions q JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE q.material_id = m.id AND p.reps >= 4) AS mastered
    FROM materials m WHERE m.id = ?`).get(req.user.id, req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(m);
});
app.get('/api/materials/:id/file', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m || !m.filename) return res.status(404).end();
  res.type(m.mime).sendFile(path.join(UPLOAD_DIR, m.filename));
});
app.post('/api/materials', ...A, upload.single('file'), (req, res) => {
  const { title, course_id, body } = req.body;
  const courseId = checkCourse(course_id);
  let kind = 'text', filename = null, mime = null, text = body || '';
  if (req.file) {
    filename = req.file.filename; mime = req.file.mimetype;
    if (mime === 'application/pdf') kind = 'pdf';
    else if (mime.startsWith('image/')) kind = 'image';
    else { text = fs.readFileSync(req.file.path, 'utf8'); fs.unlinkSync(req.file.path); filename = null; }
  } else if (!text.trim()) {
    return res.status(400).json({ error: 'Upload a file or paste some notes' });
  }
  const r = db.prepare('INSERT INTO materials (course_id, title, kind, filename, mime, body, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(courseId, title || req.file?.originalname || 'Untitled notes', kind, filename, mime, text, req.user.id);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.delete('/api/materials/:id', ...A, (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (m) {
    if (m.filename) fs.rmSync(path.join(UPLOAD_DIR, m.filename), { force: true });
    db.prepare('DELETE FROM questions WHERE material_id = ?').run(m.id);
    db.prepare('DELETE FROM materials WHERE id = ?').run(m.id);
  }
  res.json({ ok: true });
});

app.post('/api/materials/:id/generate', ...A, wrap(async (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const count = Math.min(Math.max(parseInt(req.body.count) || 10, 1), 30);
  const existing = db.prepare('SELECT question FROM questions WHERE material_id = ?').all(m.id).map((q) => q.question);
  const qs = await generateMCQs({
    material: m, filePath: m.filename ? path.join(UPLOAD_DIR, m.filename) : null,
    count, difficulty: req.body.difficulty || 'mixed', focus: req.body.focus || '', existing,
  });
  const ins = db.prepare(`INSERT INTO questions (course_id, material_id, topic, question, choices, answer_index, explanation, source, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ai', ?)`);
  for (const q of qs) ins.run(m.course_id, m.id, q.topic || 'General', q.question, JSON.stringify(q.choices), q.answer_index, q.explanation || '', req.user.id);
  res.json({ added: qs.length });
}));

// ---------- question bank (admins) ----------
const parseQ = (q) => ({ ...q, choices: JSON.parse(q.choices) });
const MASTERED_REPS = 4;

app.get('/api/questions', ...A, (req, res) => {
  const where = ['1=1']; const args = [req.user.id];
  if (req.query.course_id) { where.push('q.course_id = ?'); args.push(req.query.course_id); }
  if (req.query.material_id) { where.push('q.material_id = ?'); args.push(req.query.material_id); }
  res.json(db.prepare(`SELECT q.*, c.name AS course_name, m.title AS material_title,
      COALESCE(p.reps, 0) AS reps, p.due_at, COALESCE(p.correct_count, 0) AS correct_count, COALESCE(p.wrong_count, 0) AS wrong_count
    FROM questions q LEFT JOIN courses c ON c.id = q.course_id LEFT JOIN materials m ON m.id = q.material_id
    LEFT JOIN progress p ON p.question_id = q.id AND p.user_id = ?
    WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC, q.id DESC`).all(...args).map(parseQ));
});
function validQ(b) {
  const choices = (b.choices || []).map((c) => String(c).trim()).filter(Boolean);
  const ai = Number(b.answer_index);
  if (!b.question || choices.length < 2 || !(ai >= 0 && ai < choices.length)) throw httpError(400, 'A question needs text, at least 2 choices and a correct answer');
  return { choices, ai };
}
app.post('/api/questions', ...A, (req, res) => {
  const b = req.body; const { choices, ai } = validQ(b);
  const r = db.prepare(`INSERT INTO questions (course_id, material_id, topic, question, choices, answer_index, explanation, source, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?)`).run(checkCourse(b.course_id), nul(b.material_id),
    b.topic || 'General', b.question, JSON.stringify(choices), ai, b.explanation || '', req.user.id);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/questions/:id', ...A, (req, res) => {
  const b = req.body; const { choices, ai } = validQ(b);
  db.prepare('UPDATE questions SET course_id=?, topic=?, question=?, choices=?, answer_index=?, explanation=? WHERE id=?')
    .run(checkCourse(b.course_id), b.topic || 'General', b.question, JSON.stringify(choices), ai, b.explanation || '', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/questions/:id', ...A, (req, res) => {
  db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/topics', auth, (req, res) => {
  const rows = req.query.course_id
    ? db.prepare('SELECT DISTINCT topic FROM questions WHERE course_id = ? ORDER BY topic').all(Number(req.query.course_id))
    : db.prepare('SELECT DISTINCT topic FROM questions ORDER BY topic').all();
  res.json(rows.map((r) => r.topic));
});

// ---------- practice (personal spaced repetition) ----------
function scopeFilter(req) {
  const where = ['1=1']; const args = [];
  if (req.query.course_id) { where.push('q.course_id = ?'); args.push(Number(req.query.course_id)); }
  if (req.query.material_id) { where.push('q.material_id = ?'); args.push(Number(req.query.material_id)); }
  if (req.query.topic) { where.push('q.topic = ?'); args.push(req.query.topic); }
  return { where: where.join(' AND '), args };
}
const QP = 'FROM questions q LEFT JOIN progress p ON p.question_id = q.id AND p.user_id = ?';

app.get('/api/practice/next', auth, (req, res) => {
  const { where, args } = scopeFilter(req);
  const uid = req.user.id; const now = nowISO();
  const exclude = String(req.query.exclude || '').split(',').map(Number).filter(Boolean).slice(-50);
  const exSql = exclude.length ? ` AND q.id NOT IN (${exclude.map(() => '?').join(',')})` : '';
  const counts = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(p.due_at IS NOT NULL AND p.due_at <= ?), 0) AS due,
      COALESCE(SUM(p.due_at IS NULL), 0) AS fresh,
      COALESCE(SUM(p.reps >= ${MASTERED_REPS}), 0) AS mastered
    ${QP} WHERE ${where}`).get(now, uid, ...args);
  const sel = `SELECT q.id, q.topic, q.question, q.choices, q.source, COALESCE(p.reps, 0) AS reps, p.due_at ${QP}`;
  let q = db.prepare(`${sel} WHERE ${where} AND p.due_at IS NOT NULL AND p.due_at <= ?${exSql} ORDER BY p.due_at LIMIT 1`).get(uid, ...args, now, ...exclude);
  if (!q) q = db.prepare(`${sel} WHERE ${where} AND p.due_at IS NULL${exSql} ORDER BY q.id LIMIT 1`).get(uid, ...args, ...exclude);
  if (!q && req.query.mode === 'cram') {
    q = db.prepare(`${sel} WHERE ${where}${exSql}
      ORDER BY COALESCE(p.reps, 0), (COALESCE(p.wrong_count, 0) - COALESCE(p.correct_count, 0)) DESC, RANDOM() LIMIT 1`).get(uid, ...args, ...exclude);
  }
  const nextDue = db.prepare(`SELECT MIN(p.due_at) AS d ${QP} WHERE ${where} AND p.due_at > ?`).get(uid, ...args, now).d;
  res.json({ question: q ? parseQ(q) : null, counts, next_due: nextDue });
});

app.post('/api/questions/:id/answer', auth, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const p = db.prepare('SELECT * FROM progress WHERE user_id = ? AND question_id = ?').get(req.user.id, q.id) || { ease: 2.5, interval_days: 0, reps: 0 };
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
  db.prepare(`INSERT INTO progress (user_id, question_id, ease, interval_days, reps, due_at, correct_count, wrong_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, question_id) DO UPDATE SET ease = excluded.ease, interval_days = excluded.interval_days, reps = excluded.reps,
      due_at = excluded.due_at, correct_count = correct_count + excluded.correct_count, wrong_count = wrong_count + excluded.wrong_count`)
    .run(req.user.id, q.id, ease, interval, reps, new Date(dueMs).toISOString(), correct ? 1 : 0, correct ? 0 : 1);
  db.prepare('INSERT INTO reviews (user_id, question_id, correct) VALUES (?, ?, ?)').run(req.user.id, q.id, correct ? 1 : 0);
  res.json({ correct, answer_index: q.answer_index, explanation: q.explanation, interval_days: interval, mastered: reps >= MASTERED_REPS });
});

app.get('/api/mastery', auth, (req, res) => {
  const rows = db.prepare(`SELECT q.course_id, COALESCE(c.name, 'No course') AS course_name, c.color, q.topic,
      COUNT(*) AS total, SUM(MIN(COALESCE(p.reps, 0), ${MASTERED_REPS})) AS rep_sum, SUM(COALESCE(p.reps, 0) >= ${MASTERED_REPS}) AS mastered,
      SUM(COALESCE(p.correct_count, 0)) AS correct, SUM(COALESCE(p.wrong_count, 0)) AS wrong
    ${QP} LEFT JOIN courses c ON c.id = q.course_id
    GROUP BY q.course_id, q.topic ORDER BY course_name, q.topic`).all(req.user.id);
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
app.post('/api/study-sessions', auth, (req, res) => {
  const minutes = Math.max(1, Math.min(600, parseInt(req.body.minutes) || 0));
  db.prepare('INSERT INTO study_sessions (user_id, course_id, minutes) VALUES (?, ?, ?)').run(req.user.id, checkCourse(req.body.course_id), minutes);
  res.json({ ok: true });
});

// ---------- personal planner ----------
app.get('/api/plan', auth, (req, res) => {
  const from = req.query.from || '0000-01-01', to = req.query.to || '9999-12-31';
  res.json(db.prepare(`SELECT p.*, c.name AS course_name, c.color AS course_color FROM plan_items p
    LEFT JOIN courses c ON c.id = p.course_id WHERE p.user_id = ? AND p.date BETWEEN ? AND ? ORDER BY p.date, p.id`)
    .all(req.user.id, from, to));
});
app.post('/api/plan', auth, (req, res) => {
  const { date, title, minutes, course_id } = req.body;
  if (!date || !title) return res.status(400).json({ error: 'Date and title required' });
  db.prepare('INSERT INTO plan_items (user_id, course_id, date, title, minutes) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, checkCourse(course_id), date, title, parseInt(minutes) || 45);
  res.json({ ok: true });
});
app.patch('/api/plan/:id', auth, (req, res) => {
  db.prepare('UPDATE plan_items SET done = ? WHERE id = ? AND user_id = ?').run(req.body.done ? 1 : 0, req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/plan/:id', auth, (req, res) => {
  db.prepare('DELETE FROM plan_items WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});
// spread study sessions from today until the task's due date (for *my* section)
app.post('/api/tasks/:id/plan', auth, (req, res) => {
  const t = db.prepare(taskQuery('t.id = $id')).get(tp(req, { $id: Number(req.params.id) }));
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!t.due_at) return res.status(400).json({ error: 'This item has no due date for your section yet' });
  const minutes = parseInt(req.body.minutes) || 45;
  const due = new Date(t.due_at);
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = [];
  for (let d = new Date(today); d < dueDay && days.length < 21; d.setDate(d.getDate() + 1)) days.push(localDate(d));
  if (!days.length) return res.status(400).json({ error: 'The due date is today or already passed — no days left to plan' });
  const isTest = t.type === 'quiz' || t.type === 'exam';
  const steps = isTest
    ? ['Read & summarise the sheets', 'Practice MCQs (new questions)', 'Review weak topics', 'Practice MCQs (due reviews)', 'Re-read the hardest parts']
    : ['Understand the requirements & outline', 'Research / gather material', 'Work on the main part', 'Continue working', 'Polish & proofread'];
  db.prepare('DELETE FROM plan_items WHERE task_id = ? AND user_id = ?').run(t.id, req.user.id);
  const ins = db.prepare('INSERT INTO plan_items (user_id, task_id, course_id, date, title, minutes) VALUES (?, ?, ?, ?, ?, ?)');
  days.forEach((day, i) => {
    const step = i === days.length - 1 ? (isTest ? 'Final review: practice all MCQs in cram mode' : 'Final check & submit') : steps[i % steps.length];
    ins.run(req.user.id, t.id, t.course_id, day, `${t.title} — ${step}`, minutes);
  });
  res.json({ created: days.length });
});

// ---------- dashboard & reminders ----------
function streak(uid) {
  const days = new Set(
    db.prepare('SELECT at FROM reviews WHERE user_id = ? UNION ALL SELECT at FROM study_sessions WHERE user_id = ?')
      .all(uid, uid).map((r) => localDate(new Date(r.at.replace(' ', 'T') + 'Z')))
  );
  let n = 0; const d = new Date();
  if (!days.has(localDate(d))) d.setDate(d.getDate() - 1);
  while (days.has(localDate(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

app.get('/api/dashboard', auth, (req, res) => {
  const uid = req.user.id; const now = nowISO();
  const in3 = new Date(Date.now() + 3 * 86400000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const open = `COALESCE(ut.status,'todo') != 'done'`, due = 'COALESCE(td.due_at, t.due_at)';
  res.json({
    overdue: db.prepare(taskQuery(`${open} AND ${due} < $now`) + ` ORDER BY ${due}`).all(tp(req, { $now: now })),
    upcoming: db.prepare(taskQuery(`${open} AND ${due} >= $now`) + ` ORDER BY ${due} LIMIT 8`).all(tp(req, { $now: now })),
    due_soon_count: db.prepare(taskQuery(`${open} AND ${due} BETWEEN $now AND $in3`)).all(tp(req, { $now: now, $in3: in3 })).length,
    today_plan: db.prepare(`SELECT p.*, c.name AS course_name, c.color AS course_color FROM plan_items p LEFT JOIN courses c ON c.id = p.course_id
      WHERE p.user_id = ? AND p.date = ? ORDER BY p.id`).all(uid, localDate()),
    reviews_due: db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND due_at <= ?').get(uid, now).n,
    new_questions: db.prepare('SELECT COUNT(*) AS n FROM questions q LEFT JOIN progress p ON p.question_id = q.id AND p.user_id = ? WHERE p.due_at IS NULL').get(uid).n,
    minutes_week: db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM study_sessions WHERE user_id = ? AND at >= ?').get(uid, weekAgo).m,
    answered_week: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(correct),0) AS c FROM reviews WHERE user_id = ? AND at >= ?').get(uid, weekAgo),
    streak: streak(uid),
    grades: db.prepare(`SELECT COALESCE(c.name,'No course') AS course_name, c.color,
        ROUND(100.0 * SUM(ut.grade) / SUM(t.max_grade), 1) AS pct, COUNT(*) AS n
      FROM user_tasks ut JOIN tasks t ON t.id = ut.task_id LEFT JOIN courses c ON c.id = t.course_id
      WHERE ut.user_id = ? AND ut.grade IS NOT NULL AND t.max_grade > 0 GROUP BY t.course_id`).all(uid),
  });
});

app.get('/api/reminders', auth, (req, res) => {
  const due = 'COALESCE(td.due_at, t.due_at)';
  const tasks = db.prepare(taskQuery(`COALESCE(ut.status,'todo') != 'done' AND ${due} IS NOT NULL AND ${due} <= $soon`))
    .all(tp(req, { $soon: new Date(Date.now() + 86400000).toISOString() }))
    .map(({ id, title, type, due_at }) => ({ id, title, type, due_at }));
  const reviews = db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND due_at <= ?').get(req.user.id, nowISO()).n;
  res.json({ tasks, reviews_due: reviews });
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (!err.status && !(err instanceof multer.MulterError)) console.error(err);
  res.status(err.status || (err instanceof multer.MulterError ? 400 : 500)).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`StudyHub running at http://localhost:${PORT}  (AI ${aiAvailable() ? 'enabled' : 'disabled — add ANTHROPIC_API_KEY to .env'})`));
