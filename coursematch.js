// Finds which E-JUST course a Moodle course name or a Google Classroom class belongs to.
// Each course has a name, an optional code (PHY-111) and "sources": the Moodle course and
// Classroom classes linked to it, each marked as moodle | lecture | section | lab.
const db = require('./db');

const SOURCE_TYPES = ['moodle', 'lecture', 'section', 'lab'];
const norm = (s) => String(s || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9؀-ۿ]+/g, '');

function parseSources(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.filter((x) => x && x.name).map((x) => ({ type: SOURCE_TYPES.includes(x.type) ? x.type : 'lecture', name: String(x.name).slice(0, 120) })) : [];
  } catch { return []; }
}

// all names a course is known by
function namesOf(c) { return [c.name, c.code, ...parseSources(c.sources).map((s) => s.name)].filter(Boolean); }

/** Returns { course, source } for a name like "FoE TUT - sec 9 Sec 9" or "PHY-111-2026/2027-Fall", or null. */
async function matchCourse(name) {
  const n = norm(name);
  if (!n) return null;
  const courses = await db.all('SELECT id, name, code, color, sources FROM courses');
  let best = null;
  for (const c of courses) {
    for (const s of [{ name: c.name, type: null }, { name: c.code, type: 'moodle' }, ...parseSources(c.sources)]) {
      const k = norm(s.name);
      if (!k) continue;
      // exact, or one starts with the other (Classroom adds "Sec 9", Moodle adds "-2026/2027-Fall")
      const score = k === n ? 3 : n.startsWith(k) || k.startsWith(n) ? (Math.min(k.length, n.length) >= 5 ? 2 : 0) : 0;
      if (score && (!best || score > best.score || (score === best.score && k.length > best.len))) best = { score, len: k.length, course: c, source: s };
    }
  }
  return best ? { course: best.course, source: best.source } : null;
}

module.exports = { matchCourse, parseSources, namesOf, SOURCE_TYPES };
