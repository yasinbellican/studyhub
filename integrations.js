// Connections to outside services:
//  • Moodle  — reads the Moodle calendar export (iCal link) and adds assignments/quizzes/exams to the right course
//  • Gmail   — a Google Apps Script in the admin's Gmail posts new matching emails here
//  • Reminders — "due in 24 hours / 2 hours" notifications for every section
// tick() runs all of it; it's called by the Gmail script every few minutes and by Vercel's daily cron.
const crypto = require('crypto');
const db = require('./db');
const { notify, getSetting, setSetting } = require('./notify');

const COLORS = ['#0ea5e9', '#f59e0b', '#16a34a', '#db2777', '#7c3aed', '#dc2626', '#0d9488', '#ea580c', '#4f46e5', '#65a30d'];
const once = async (key) => {
  try { await db.run('INSERT INTO sent_once (key) VALUES (?)', key); return true; } catch { return false; } // false = already done
};
const fmt = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: process.env.APP_TZ || 'Africa/Cairo' });

// ---------------- iCal (Moodle calendar export) ----------------
function parseICal(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const unfolded = [];
  for (const l of lines) { if (/^[ \t]/.test(l) && unfolded.length) unfolded[unfolded.length - 1] += l.slice(1); else unfolded.push(l); }
  const events = []; let ev = null;
  const unescape = (v) => v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(';');
    ev[name.toUpperCase()] = { value: unescape(line.slice(i + 1)), params: params.join(';') };
  }
  return events;
}
function icalDate(p) {
  if (!p) return null;
  const m = p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '23', mi = '59', s = '00', z] = m;
  // times without "Z" are local Moodle time; treat them as the app's timezone (Cairo, UTC+2/+3) approximately via UTC offset env
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : (process.env.APP_TZ_OFFSET || '+02:00')}`;
  const t = new Date(iso);
  return isNaN(t) ? null : t.toISOString();
}
function classify(summary) {
  const s = summary.toLowerCase();
  if (/\b(opens|starts)\b/.test(s)) return null; // only keep deadlines ("closes" / "is due")
  if (/midterm|final|exam/.test(s)) return 'exam';
  if (/quiz|test\b/.test(s)) return 'quiz';
  return 'assignment';
}
const cleanTitle = (s) => s.replace(/\s+(is due|closes|deadline|due)\.?$/i, '').replace(/\s+should be completed\.?$/i, '').trim();

async function courseFor(name) {
  if (!name) return null;
  const c = await db.get('SELECT id FROM courses WHERE lower(name) = lower(?)', name.trim());
  if (c) return c.id;
  const n = (await db.get('SELECT COUNT(*) AS n FROM courses')).n;
  return (await db.run('INSERT INTO courses (name, color) VALUES (?, ?)', name.trim().slice(0, 80), COLORS[n % COLORS.length])).lastInsertRowid;
}

async function moodleSync({ force = false } = {}) {
  const url = await getSetting('moodle_ical_url');
  if (!url) return { skipped: 'not connected' };
  const last = await getSetting('moodle_last_sync');
  if (!force && last && Date.now() - new Date(last).getTime() < 10 * 60000) return { skipped: 'synced recently' };
  await setSetting('moodle_last_sync', new Date().toISOString());
  let text;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'E-JUST-StudyHub/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Moodle answered ${r.status}`);
    text = await r.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error("That link didn't return a calendar — copy the full export URL from Moodle");
  } catch (e) {
    await setSetting('moodle_last_status', 'error: ' + e.message);
    return { error: e.message };
  }
  const events = parseICal(text);
  const cutoff = Date.now() - 2 * 86400000;
  let added = 0, updated = 0;
  for (const ev of events) {
    const summary = ev.SUMMARY?.value || ''; const uid = ev.UID?.value; const due = icalDate(ev.DTEND || ev.DTSTART);
    const type = classify(summary);
    if (!uid || !due || !type || new Date(due).getTime() < cutoff) continue;
    const title = cleanTitle(summary).slice(0, 200);
    const courseName = (ev.CATEGORIES?.value || '').split(',')[0];
    const notes = (ev.DESCRIPTION?.value || '').replace(/<[^>]+>/g, '').trim().slice(0, 1000);
    const ext = 'moodle:' + uid;
    const existing = await db.get('SELECT id, title, due_at FROM tasks WHERE external_id = ?', ext);
    if (existing) {
      // compare to the minute so tiny clock differences never count as a change
      const moved = (existing.due_at || '').slice(0, 16) !== due.slice(0, 16);
      if (moved || existing.title !== title) {
        await db.run('UPDATE tasks SET title = ?, due_at = ? WHERE id = ?', title, due, existing.id);
        updated++;
        if (moved) await notify({ kind: 'moodle', title: `Due date changed: ${title}`, body: `Now due ${fmt(due)} (from Moodle)`, url: '#/tasks' });
      }
      continue;
    }
    const courseId = await courseFor(courseName);
    await db.run(`INSERT INTO tasks (title, type, due_at, priority, notes, course_id, source, external_id)
      VALUES (?, ?, ?, ?, ?, ?, 'moodle', ?)`, title, type, due, type === 'exam' ? 'high' : 'medium', notes, courseId, ext);
    added++;
    await notify({ kind: 'moodle', title: `New ${type} from Moodle: ${title}`, body: `${courseName ? courseName + ' · ' : ''}due ${fmt(due)}`, url: courseId ? `#/courses/${courseId}` : '#/tasks' });
  }
  await setSetting('moodle_last_status', `ok: ${events.length} calendar events read, ${added} added, ${updated} updated`);
  return { events: events.length, added, updated };
}

// ---------------- Gmail (via Google Apps Script) ----------------
async function hookSecret() {
  let s = await getSetting('hook_secret');
  if (!s) { s = crypto.randomBytes(18).toString('base64url'); await setSetting('hook_secret', s); }
  return s;
}
async function receiveEmails(messages = []) {
  const ownerId = Number(await getSetting('email_owner_id')) || null;
  const share = (await getSetting('email_share')) === 'all';
  let created = 0;
  for (const m of messages.slice(0, 50)) {
    if (!m?.id || !(await once('email:' + m.id))) continue;
    const from = String(m.from || '').replace(/<.*>/, '').replace(/"/g, '').trim();
    await notify({
      audience: share ? 'all' : ownerId ? 'user' : 'admins', targetId: share ? null : ownerId,
      kind: 'email', title: String(m.subject || '(no subject)').slice(0, 200),
      body: `${from ? from + ' — ' : ''}${String(m.snippet || '').slice(0, 280)}`,
      url: m.link && /^https:\/\/mail\.google\.com\//.test(m.link) ? m.link : '#/notifications',
    });
    created++;
  }
  return { created };
}

// ---------------- deadline reminders ----------------
async function dueReminders() {
  const now = Date.now(), soon = new Date(now + 24 * 3600000).toISOString(), nowIso = new Date(now).toISOString();
  const sections = await db.all('SELECT id FROM sections');
  const tasks = await db.all(`SELECT t.id, t.title, t.type, t.due_at, t.course_id, c.name AS course FROM tasks t LEFT JOIN courses c ON c.id = t.course_id
    WHERE (t.due_at BETWEEN ? AND ?) OR t.id IN (SELECT task_id FROM task_due WHERE due_at BETWEEN ? AND ?)`, nowIso, soon, nowIso, soon);
  const overrides = await db.all('SELECT task_id, section_id, due_at FROM task_due');
  let sent = 0;
  for (const t of tasks) for (const s of sections) {
    const due = overrides.find((o) => o.task_id === t.id && o.section_id === s.id)?.due_at || t.due_at;
    if (!due) continue;
    const left = new Date(due).getTime() - now;
    if (left <= 0 || left > 24 * 3600000) continue;
    const level = left <= 2 * 3600000 ? '2h' : '24h';
    if (!(await once(`due:${t.id}:${s.id}:${level}:${due}`))) continue;
    await notify({ audience: 'section', targetId: s.id, kind: 'due',
      title: `${level === '2h' ? 'Due in under 2 hours' : 'Due tomorrow'}: ${t.title}`,
      body: `${t.course ? t.course + ' · ' : ''}${t.type} · ${fmt(due)}`, url: t.course_id ? `#/courses/${t.course_id}` : '#/tasks' });
    sent++;
  }
  return { sent };
}

async function tick() {
  const last = await getSetting('tick_last');
  if (last && Date.now() - new Date(last).getTime() < 60000) return { skipped: 'ran less than a minute ago' };
  await setSetting('tick_last', new Date().toISOString());
  const out = { moodle: await moodleSync(), reminders: await dueReminders() };
  await db.run("DELETE FROM notifications WHERE created_at < datetime('now', '-60 days')");
  await db.run("DELETE FROM sent_once WHERE at < datetime('now', '-120 days')");
  return out;
}

module.exports = { moodleSync, receiveEmails, dueReminders, tick, hookSecret, parseICal };
