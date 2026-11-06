// Notifications: stored in the database (shown in the app's bell / Notifications page)
// and pushed to phones & computers that turned on notifications (works when the app is closed).
const webpush = require('web-push');
const db = require('./db');

// audience: 'all' | 'admins' | 'section' (target_id = section id) | 'user' (target_id = user id)
const VISIBLE = `(n.audience = 'all' OR (n.audience = 'admins' AND u.role = 'admin')
  OR (n.audience = 'section' AND n.target_id = u.section_id) OR (n.audience = 'user' AND n.target_id = u.id))`;

const getSetting = async (k) => (await db.get('SELECT value FROM settings WHERE key = ?', k))?.value ?? null;
const setSetting = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);

// VAPID keys identify this app to the push services; created once and kept in the database
let vapid = null;
async function vapidKeys() {
  if (vapid) return vapid;
  let pub = await getSetting('vapid_public'), priv = await getSetting('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    await setSetting('vapid_public', k.publicKey); await setSetting('vapid_private', k.privateKey);
    pub = k.publicKey; priv = k.privateKey;
  }
  webpush.setVapidDetails('mailto:noreply@e-just-study.app', pub, priv);
  vapid = { publicKey: pub };
  return vapid;
}

async function sendPush(id, audience, targetId, payload) {
  await vapidKeys();
  const subs = await db.all(`SELECT p.endpoint, p.p256dh, p.auth FROM push_subs p JOIN users u ON u.id = p.user_id
    JOIN (SELECT ? AS audience, ? AS target_id) n
    WHERE u.status = 'approved' AND ${VISIBLE}`, audience, targetId);
  const body = JSON.stringify({ ...payload, id });
  await Promise.all(subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 24 * 3600 })
    .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) return db.run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint); })));
}

/** Create a notification and push it. kind: task | sheet | due | email | moodle | join | info */
async function notify({ audience = 'all', targetId = null, kind = 'info', title, body = '', url = '#/dashboard' }) {
  const r = await db.run('INSERT INTO notifications (audience, target_id, kind, title, body, url) VALUES (?, ?, ?, ?, ?, ?)',
    audience, targetId, kind, String(title).slice(0, 200), String(body || '').slice(0, 600), url);
  try { await sendPush(r.lastInsertRowid, audience, targetId, { title, body, url }); } catch (e) { console.error('push failed:', e.message); }
  return r.lastInsertRowid;
}

async function listFor(user, limit = 60) {
  const u = await db.get('SELECT id, role, section_id, notif_seen_at FROM users WHERE id = ?', user.id);
  const rows = await db.all(`SELECT n.* FROM notifications n JOIN (SELECT ? AS id, ? AS role, ? AS section_id) u
    WHERE ${VISIBLE} ORDER BY n.id DESC LIMIT ?`, u.id, u.role, u.section_id ?? -1, limit);
  const seen = u.notif_seen_at || '';
  for (const n of rows) n.unread = n.created_at > seen;
  return { items: rows, unread: rows.filter((n) => n.unread).length };
}

module.exports = { notify, listFor, vapidKeys, getSetting, setSetting };
