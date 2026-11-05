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

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires.toISOString());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', expires });
}
function auth(req, res, next) {
  const token = req.cookies.sid;
  const row = token && db.prepare(
    'SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?'
  ).get(token, nowISO());
  if (!row) return res.status(401).json({ error: 'Not signed in' });
  req.user = row;
  next();
}
// make sure a referenced course belongs to the user
function ownCourse(uid, courseId) {
  if (courseId == null || courseId === '') return null;
  const c = db.prepare('SELECT id FROM courses WHERE id = ? AND user_id = ?').get(Number(courseId), uid);
  if (!c) { const e = new Error('Course not found'); e.status = 400; throw e; }
  return c.id;
}

// ---------- auth ----------
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (exists) return res.status(409).json({ error: 'An account with this email already exists' });
  const r = db.prepare('INSERT INTO users (name, email, pass_hash) VALUES (?, ?, ?)')
    .run(name.trim(), email.toLowerCase().trim(), hashPassword(password));
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

app.get('/api/me', auth, (req, res) => res.json({ ...req.user, ai: aiAvailable() }));

// ---------- courses ----------
app.get('/api/courses', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM courses WHERE user_id = ? ORDER BY name').all(req.user.id));
});
app.post('/api/courses', auth, (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO courses (user_id, name, color) VALUES (?, ?, ?)').run(req.user.id, name, color || '#6366f1');
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/courses/:id', auth, (req, res) => {
  const { name, color } = req.body;
  db.prepare('UPDATE courses SET name = ?, color = ? WHERE id = ? AND user_id = ?').run(name, color, req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/courses/:id', auth, (req, res) => {
  db.prepare('DELETE FROM courses WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- tasks (assignments / quizzes / exams) ----------
app.get('/api/tasks', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT t.*, c.name AS course_name, c.color AS course_color FROM tasks t
    LEFT JOIN courses c ON c.id = t.course_id
    WHERE t.user_id = ? ORDER BY (t.status = 'done'), t.due_at IS NULL, t.due_at`).all(req.user.id));
});
function taskFields(b, uid) {
  return [b.title, b.type || 'assignment', nul(b.due_at), b.status || 'todo', b.priority || 'medium',
    b.notes || '', nul(b.grade), nul(b.max_grade), ownCourse(uid, b.course_id)];
}
app.post('/api/tasks', auth, (req, res) => {
  if (!req.body.title) return res.status(400).json({ error: 'Title required' });
  const r = db.prepare(`INSERT INTO tasks (title, type, due_at, status, priority, notes, grade, max_grade, course_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...taskFields(req.body, req.user.id), req.user.id);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/tasks/:id', auth, (req, res) => {
  db.prepare(`UPDATE tasks SET title=?, type=?, due_at=?, status=?, priority=?, notes=?, grade=?, max_grade=?, course_id=?
    WHERE id = ? AND user_id = ?`).run(...taskFields(req.body, req.user.id), req.params.id, req.user.id);
  res.json({ ok: true });
});
app.patch('/api/tasks/:id/status', auth, (req, res) => {
  db.prepare('UPDATE tasks SET status = ? WHERE id = ? AND user_id = ?').run(req.body.status, req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/tasks/:id', auth, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
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
    cb(ok ? null : Object.assign(new Error('Only PDF, image (png/jpg/webp/gif) or text files are supported'), { status: 400 }), ok);
  },
});

app.get('/api/materials', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT m.id, m.title, m.kind, m.course_id, m.created_at, c.name AS course_name, c.color AS course_color,
      (SELECT COUNT(*) FROM questions q WHERE q.material_id = m.id) AS question_count
    FROM materials m LEFT JOIN courses c ON c.id = m.course_id
    WHERE m.user_id = ? ORDER BY m.created_at DESC`).all(req.user.id));
});
app.get('/api/materials/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json(m);
});
app.get('/api/materials/:id/file', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!m || !m.filename) return res.status(404).end();
  res.type(m.mime).sendFile(path.join(UPLOAD_DIR, m.filename));
});
app.post('/api/materials', auth, upload.single('file'), (req, res) => {
  const { title, course_id, body } = req.body;
  const courseId = ownCourse(req.user.id, course_id);
  let kind = 'text', filename = null, mime = null, text = body || '';
  if (req.file) {
    filename = req.file.filename; mime = req.file.mimetype;
    if (mime === 'application/pdf') kind = 'pdf';
    else if (mime.startsWith('image/')) kind = 'image';
    else { kind = 'text'; text = fs.readFileSync(req.file.path, 'utf8'); fs.unlinkSync(req.file.path); filename = null; }
  } else if (!text.trim()) {
    return res.status(400).json({ error: 'Upload a file or paste some notes' });
  }
  const r = db.prepare('INSERT INTO materials (user_id, course_id, title, kind, filename, mime, body) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, courseId, title || req.file?.originalname || 'Untitled notes', kind, filename, mime, text);
  res.json({ id: Number(r.lastInsertRowid) });
});
app.delete('/api/materials/:id', auth, (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (m) {
    if (m.filename) fs.rmSync(path.join(UPLOAD_DIR, m.filename), { force: true });
    db.prepare('DELETE FROM questions WHERE material_id = ? AND user_id = ?').run(m.id, req.user.id);
    db.prepare('DELETE FROM materials WHERE id = ?').run(m.id);
  }
  res.json({ ok: true });
});

// AI: generate MCQs from a material
app.post('/api/materials/:id/generate', auth, wrap(async (req, res) => {
  const m = db.prepare('SELECT * FROM materials WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const count = Math.min(Math.max(parseInt(req.body.count) || 10, 1), 30);
  const existing = db.prepare('SELECT question FROM questions WHERE material_id = ?').all(m.id).map((q) => q.question);
  const qs = await generateMCQs({
    material: m, filePath: m.filename ? path.join(UPLOAD_DIR, m.filename) : null,
    count, difficulty: req.body.difficulty || 'mixed', focus: req.body.focus || '', existing,
  });
  const ins = db.prepare(`INSERT INTO questions (user_id, course_id, material_id, topic, question, choices, answer_index, explanation, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai')`);
  for (const q of qs) ins.run(req.user.id, m.course_id, m.id, q.topic || 'General', q.question, JSON.stringify(q.choices), q.answer_index, q.explanation || '');
  res.json({ added: qs.length });
}));

// ---------- question bank ----------
function parseQ(q) { return { ...q, choices: JSON.parse(q.choices) }; }
const MASTERED_REPS = 4;

app.get('/api/questions', auth, (req, res) => {
  const where = ['q.user_id = ?']; const args = [req.user.id];
  if (req.query.course_id) { where.push('q.course_id = ?'); args.push(req.query.course_id); }
  if (req.query.material_id) { where.push('q.material_id = ?'); args.push(req.query.material_id); }
  res.json(db.prepare(`SELECT q.*, c.name AS course_name, m.title AS material_title FROM questions q
    LEFT JOIN courses c ON c.id = q.course_id LEFT JOIN materials m ON m.id = q.material_id
    WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC, q.id DESC`).all(...args).map(parseQ));
});
function validQ(b) {
  const choices = (b.choices || []).map((c) => String(c).trim()).filter(Boolean);
  const ai = Number(b.answer_index);
  if (!b.question || choices.length < 2 || !(ai >= 0 && ai < choices.length)) {
    const e = new Error('A question needs text, at least 2 choices and a correct answer'); e.status = 400; throw e;
  }
  return { choices, ai };
}
app.post('/api/questions', auth, (req, res) => {
  const b = req.body; const { choices, ai } = validQ(b);
  const r = db.prepare(`INSERT INTO questions (user_id, course_id, material_id, topic, question, choices, answer_index, explanation, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`).run(req.user.id, ownCourse(req.user.id, b.course_id), nul(b.material_id),
    b.topic || 'General', b.question, JSON.stringify(choices), ai, b.explanation || '');
  res.json({ id: Number(r.lastInsertRowid) });
});
app.put('/api/questions/:id', auth, (req, res) => {
  const b = req.body; const { choices, ai } = validQ(b);
  db.prepare(`UPDATE questions SET course_id=?, topic=?, question=?, choices=?, answer_index=?, explanation=? WHERE id=? AND user_id=?`)
    .run(ownCourse(req.user.id, b.course_id), b.topic || 'General', b.question, JSON.stringify(choices), ai, b.explanation || '', req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete('/api/questions/:id', auth, (req, res) => {
  db.prepare('DELETE FROM questions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});
app.post('/api/questions/:id/reset', auth, (req, res) => {
  db.prepare('UPDATE questions SET ease=2.5, interval_days=0, reps=0, due_at=NULL WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- practice (spaced repetition) ----------
function scopeFilter(req) {
  const where = ['user_id = ?']; const args = [req.user.id];
  if (req.query.course_id) { where.push('course_id = ?'); args.push(Number(req.query.course_id)); }
  if (req.query.material_id) { where.push('material_id = ?'); args.push(Number(req.query.material_id)); }
  if (req.query.topic) { where.push('topic = ?'); args.push(req.query.topic); }
  return { where: where.join(' AND '), args };
}

app.get('/api/practice/next', auth, (req, res) => {
  const { where, args } = scopeFilter(req);
  const now = nowISO();
  const exclude = String(req.query.exclude || '').split(',').map(Number).filter(Boolean).slice(-50);
  const exSql = exclude.length ? ` AND id NOT IN (${exclude.map(() => '?').join(',')})` : '';
  const counts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(due_at IS NOT NULL AND due_at <= ?) AS due,
      SUM(due_at IS NULL) AS fresh,
      SUM(reps >= ${MASTERED_REPS}) AS mastered
    FROM questions WHERE ${where}`).get(now, ...args);

  let q;
  // 1. questions that are due for review (wrong answers come back after a few minutes)
  q = db.prepare(`SELECT * FROM questions WHERE ${where} AND due_at IS NOT NULL AND due_at <= ?${exSql} ORDER BY due_at LIMIT 1`).get(...args, now, ...exclude);
  // 2. new, never-seen questions
  if (!q) q = db.prepare(`SELECT * FROM questions WHERE ${where} AND due_at IS NULL${exSql} ORDER BY id LIMIT 1`).get(...args, ...exclude);
  // 3. "keep going" mode: weakest questions even if not due yet
  if (!q && req.query.mode === 'cram') {
    q = db.prepare(`SELECT * FROM questions WHERE ${where}${exSql}
      ORDER BY reps, (wrong_count - correct_count) DESC, RANDOM() LIMIT 1`).get(...args, ...exclude);
  }
  const nextDue = db.prepare(`SELECT MIN(due_at) AS d FROM questions WHERE ${where} AND due_at > ?`).get(...args, now).d;
  if (!q) return res.json({ question: null, counts, next_due: nextDue });
  const { answer_index, explanation, ...safe } = parseQ(q);
  res.json({ question: safe, counts, next_due: nextDue });
});

app.post('/api/questions/:id/answer', auth, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const correct = Number(req.body.choice) === q.answer_index;
  let { ease, interval_days: interval, reps } = q;
  let dueMs;
  if (correct) {
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 3 : Math.round(interval * ease * 10) / 10;
    ease = Math.min(3.0, ease + 0.05);
    dueMs = Date.now() + interval * 86400000;
  } else {
    reps = 0; interval = 0;
    ease = Math.max(1.3, ease - 0.2);
    dueMs = Date.now() + 3 * 60000; // see it again in ~3 minutes
  }
  db.prepare(`UPDATE questions SET ease=?, interval_days=?, reps=?, due_at=?,
    correct_count = correct_count + ?, wrong_count = wrong_count + ? WHERE id = ?`)
    .run(ease, interval, reps, new Date(dueMs).toISOString(), correct ? 1 : 0, correct ? 0 : 1, q.id);
  db.prepare('INSERT INTO reviews (user_id, question_id, correct) VALUES (?, ?, ?)').run(req.user.id, q.id, correct ? 1 : 0);
  res.json({ correct, answer_index: q.answer_index, explanation: q.explanation, interval_days: interval, mastered: reps >= MASTERED_REPS });
});

// mastery per course and per topic
app.get('/api/mastery', auth, (req, res) => {
  const rows = db.prepare(`SELECT q.course_id, COALESCE(c.name, 'No course') AS course_name, c.color, q.topic,
      COUNT(*) AS total, SUM(MIN(q.reps, ${MASTERED_REPS})) AS rep_sum, SUM(q.reps >= ${MASTERED_REPS}) AS mastered,
      SUM(q.correct_count) AS correct, SUM(q.wrong_count) AS wrong
    FROM questions q LEFT JOIN courses c ON c.id = q.course_id WHERE q.user_id = ?
    GROUP BY q.course_id, q.topic ORDER BY course_name, q.topic`).all(req.user.id);
  const courses = {};
  for (const r of rows) {
    const key = r.course_id ?? 0;
    const c = (courses[key] ||= { course_id: r.course_id, course_name: r.course_name, color: r.color, total: 0, rep_sum: 0, mastered: 0, topics: [] });
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
  db.prepare('INSERT INTO study_sessions (user_id, course_id, minutes) VALUES (?, ?, ?)').run(req.user.id, ownCourse(req.user.id, req.body.course_id), minutes);
  res.json({ ok: true });
});

// ---------- planner ----------
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
    .run(req.user.id, ownCourse(req.user.id, course_id), date, title, parseInt(minutes) || 45);
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

// Build a study plan that spreads sessions from today until the task's due date
app.post('/api/tasks/:id/plan', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!t.due_at) return res.status(400).json({ error: 'Set a due date first' });
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
    const last = i === days.length - 1;
    const step = last ? (isTest ? 'Final review: practice all MCQs in cram mode' : 'Final check & submit') : steps[i % steps.length];
    ins.run(req.user.id, t.id, t.course_id, day, `${t.title} — ${step}`, minutes);
  });
  res.json({ created: days.length });
});

// ---------- dashboard & reminders ----------
function streak(uid) {
  const days = new Set(
    db.prepare(`SELECT at FROM reviews WHERE user_id = ? UNION ALL SELECT at FROM study_sessions WHERE user_id = ?`)
      .all(uid, uid).map((r) => localDate(new Date(r.at.replace(' ', 'T') + 'Z')))
  );
  let n = 0; const d = new Date();
  if (!days.has(localDate(d))) d.setDate(d.getDate() - 1); // streak still alive if you studied yesterday
  while (days.has(localDate(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

app.get('/api/dashboard', auth, (req, res) => {
  const uid = req.user.id; const now = nowISO();
  const in3 = new Date(Date.now() + 3 * 86400000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const taskSel = `SELECT t.*, c.name AS course_name, c.color AS course_color FROM tasks t LEFT JOIN courses c ON c.id = t.course_id`;
  res.json({
    overdue: db.prepare(`${taskSel} WHERE t.user_id = ? AND t.status != 'done' AND t.due_at < ? ORDER BY t.due_at`).all(uid, now),
    upcoming: db.prepare(`${taskSel} WHERE t.user_id = ? AND t.status != 'done' AND t.due_at >= ? ORDER BY t.due_at LIMIT 8`).all(uid, now),
    due_soon_count: db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND status != 'done' AND due_at BETWEEN ? AND ?`).get(uid, now, in3).n,
    today_plan: db.prepare(`SELECT p.*, c.name AS course_name, c.color AS course_color FROM plan_items p LEFT JOIN courses c ON c.id = p.course_id
      WHERE p.user_id = ? AND p.date = ? ORDER BY p.id`).all(uid, localDate()),
    reviews_due: db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE user_id = ? AND due_at IS NOT NULL AND due_at <= ?`).get(uid, now).n,
    new_questions: db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE user_id = ? AND due_at IS NULL`).get(uid).n,
    minutes_week: db.prepare(`SELECT COALESCE(SUM(minutes),0) AS m FROM study_sessions WHERE user_id = ? AND at >= ?`).get(uid, weekAgo).m,
    answered_week: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(correct),0) AS c FROM reviews WHERE user_id = ? AND at >= ?`).get(uid, weekAgo),
    streak: streak(uid),
    grades: db.prepare(`SELECT COALESCE(c.name,'No course') AS course_name, c.color,
        ROUND(100.0 * SUM(t.grade) / SUM(t.max_grade), 1) AS pct, COUNT(*) AS n
      FROM tasks t LEFT JOIN courses c ON c.id = t.course_id
      WHERE t.user_id = ? AND t.grade IS NOT NULL AND t.max_grade > 0 GROUP BY t.course_id`).all(uid),
  });
});

// lightweight endpoint the browser polls to show notifications
app.get('/api/reminders', auth, (req, res) => {
  const now = Date.now();
  const tasks = db.prepare(`SELECT id, title, type, due_at FROM tasks WHERE user_id = ? AND status != 'done' AND due_at IS NOT NULL AND due_at <= ?`)
    .all(req.user.id, new Date(now + 86400000).toISOString());
  const reviews = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE user_id = ? AND due_at IS NOT NULL AND due_at <= ?`).get(req.user.id, nowISO()).n;
  res.json({ tasks, reviews_due: reviews });
});

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || (err instanceof multer.MulterError ? 400 : 500)).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`StudyHub running at http://localhost:${PORT}  (AI ${aiAvailable() ? 'enabled' : 'disabled — add ANTHROPIC_API_KEY to .env'})`));
