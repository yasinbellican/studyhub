// Database layer — libSQL (SQLite-compatible).
// Locally it uses the file studyhub.db. Online it uses a free Turso database:
// set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
//
// One shared class. Admins (class reps) add courses, assignments/quizzes/exams,
// study sheets and questions; everyone studies the same material.
// Students belong to a section (timetable group); a task can have a different
// due date per section. Progress (task status, grades, MCQ mastery) is personal.
// Uploaded files are stored inside the database (in chunks), so nothing is lost
// when a free host restarts.
const { createClient } = require('@libsql/client');
const path = require('path');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:' + path.join(__dirname, 'studyhub.db'),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- used to sign in (no email)
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',           -- admin | student
  status TEXT NOT NULL DEFAULT 'pending',         -- pending (waiting for an admin) | approved
  section_id INTEGER,
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL);

-- shared class content (admins edit)
CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#6366f1');
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'assignment',        -- assignment | quiz | exam
  due_at TEXT,                                     -- default due date, used when a section has no override
  priority TEXT NOT NULL DEFAULT 'medium',
  notes TEXT DEFAULT '',
  max_grade REAL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_due (               -- per-section due dates
  task_id INTEGER NOT NULL, section_id INTEGER NOT NULL, due_at TEXT NOT NULL,
  PRIMARY KEY (task_id, section_id)
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,                              -- pdf | image | text
  file_id INTEGER,
  mime TEXT,
  body TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY AUTOINCREMENT, mime TEXT, size INTEGER);
CREATE TABLE IF NOT EXISTS file_chunks (file_id INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (file_id, idx));
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER,
  material_id INTEGER,
  topic TEXT DEFAULT 'General',
  question TEXT NOT NULL,
  choices TEXT NOT NULL,                           -- JSON array
  answer_index INTEGER NOT NULL,
  explanation TEXT DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- personal progress
CREATE TABLE IF NOT EXISTS user_tasks (
  user_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo', grade REAL,
  PRIMARY KEY (user_id, task_id)
);
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER NOT NULL, question_id INTEGER NOT NULL,
  ease REAL NOT NULL DEFAULT 2.5, interval_days REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
  due_at TEXT, correct_count INTEGER NOT NULL DEFAULT 0, wrong_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, question_id)
);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, question_id INTEGER NOT NULL, correct INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS study_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, course_id INTEGER, minutes INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, task_id INTEGER, course_id INTEGER,
  date TEXT NOT NULL, title TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 45, done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_progress_due ON progress(user_id, due_at);
CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id, at);
`;

// Older versions signed in with email. Rebuild the users table with usernames
// (taken from the part of the email before "@") and mark everyone already in
// the class as approved. Runs once, inside one transaction.
async function migrateToUsernames(cols) {
  const rows = (await client.execute('SELECT * FROM users ORDER BY id')).rows;
  const taken = new Set();
  const stmts = [{ sql: `CREATE TABLE users_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'student', status TEXT NOT NULL DEFAULT 'pending',
    section_id INTEGER, permissions TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')))` }];
  for (const r of rows) {
    let base = String(r.email || r.name || 'user').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'user';
    let u = base, n = 2;
    while (taken.has(u)) u = `${base}${n++}`;
    taken.add(u);
    stmts.push({ sql: `INSERT INTO users_new (id, name, username, pass_hash, role, status, section_id, permissions, created_at)
      VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
    args: [r.id, r.name, u, r.pass_hash, r.role, r.section_id ?? null, cols.includes('permissions') ? r.permissions : '[]', r.created_at] });
  }
  stmts.push({ sql: 'DROP TABLE users' }, { sql: 'ALTER TABLE users_new RENAME TO users' });
  await client.batch(stmts, 'write');
  console.log(`Migrated ${rows.length} account(s) from email to username sign-in`);
}

// Accepts positional args (a, b, c) or one named-args object ({ $uid: 1 } or { uid: 1 })
function normArgs(args) {
  const one = args[0];
  if (args.length === 1 && one && typeof one === 'object' && !Array.isArray(one) && !ArrayBuffer.isView(one) && !(one instanceof ArrayBuffer)) {
    const o = {};
    for (const [k, v] of Object.entries(one)) o[k.replace(/^[$:@]/, '')] = v === undefined ? null : v;
    return o;
  }
  return args.map((v) => (v === undefined ? null : v));
}
const plain = (rs, row) => Object.fromEntries(rs.columns.map((c, i) => [c, row[i]]));

const db = {
  async all(sql, ...args) {
    const rs = await client.execute({ sql, args: normArgs(args) });
    return rs.rows.map((r) => plain(rs, r));
  },
  async get(sql, ...args) { return (await db.all(sql, ...args))[0]; },
  async run(sql, ...args) {
    const rs = await client.execute({ sql, args: normArgs(args) });
    return { lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid), changes: rs.rowsAffected };
  },
  // several statements in one transaction: [[sql, ...args], ...]
  async batch(stmts) {
    await client.batch(stmts.map(([sql, ...args]) => ({ sql, args: normArgs(args) })), 'write');
  },
  async init() {
    await client.executeMultiple(SCHEMA);
    // migrations for databases created by older versions
    const cols = (await db.all('PRAGMA table_info(users)')).map((c) => c.name);
    if (!cols.includes('username')) await migrateToUsernames(cols);
  },

  // ---- files, stored in 512 KB chunks ----
  CHUNK: 512 * 1024,
  async saveFile(buffer, mime) {
    const { lastInsertRowid: id } = await db.run('INSERT INTO files (mime, size) VALUES (?, ?)', mime, buffer.length);
    const stmts = [];
    for (let i = 0, idx = 0; i < buffer.length; i += db.CHUNK, idx++) {
      stmts.push(['INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)', id, idx, buffer.subarray(i, i + db.CHUNK)]);
    }
    for (let i = 0; i < stmts.length; i += 8) await db.batch(stmts.slice(i, i + 8)); // keep each request small
    return id;
  },
  async readFile(id) {
    const rows = await db.all('SELECT data FROM file_chunks WHERE file_id = ? ORDER BY idx', id);
    return Buffer.concat(rows.map((r) => Buffer.from(r.data)));
  },
  async deleteFile(id) {
    if (id == null) return;
    await db.batch([['DELETE FROM file_chunks WHERE file_id = ?', id], ['DELETE FROM files WHERE id = ?', id]]);
  },
};

module.exports = db;
