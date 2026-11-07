// Turns a raw email (subject, sender, plain text) into something short and useful:
// what it is, which class, who posted it, the due date, a to-do list and the cleaned message.
// Works especially well with Google Classroom and Moodle notification emails.

// lines that are never useful (buttons, footers, legal text, unsubscribe…)
const JUNK = [
  /^open$/i, /^view (assignment|announcement|material|question|post|in classroom)/i, /^reply$/i, /^mark as done$/i,
  /^google (llc|classroom)/i, /1600 amphitheatre/i, /^this email was sent to/i, /^you received this (email|message)/i,
  /unsubscribe/i, /notification settings/i, /manage (your )?(email )?(notification|preferences)/i, /don.t want these emails/i,
  /^if you (no longer|don.t) want/i, /^©/, /^copyright/i, /^privacy/i, /^terms of service/i, /^logo/i,
  /^go to (the )?(course|forum|post|activity)/i, /^change your (forum|notification|email) (digest )?preferences/i,
  /^this is a copy of a message posted/i, /^see this post in context/i, /^reply to this email/i, /^-{2,}$/, /^_{2,}$/, /^\[image/i,
];
const ACTION = /\b(submit|upload|hand in|turn in|deadline|due|bring|attend|prepare|read|solve|complete|finish|study|review|revise|exam|midterm|final|quiz|test|presentation|present|register|deliver|send|don.t forget|remember|must|required|mandatory|until|till|before|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|today|\d))/i;

function cleanText(raw) {
  let t = String(raw || '').replace(/\r/g, '');
  t = t.replace(/<https?:\/\/[^>]+>/g, '')            // <link> after a word
       .replace(/\[https?:\/\/[^\]]+\]/g, '')          // [link]
       .replace(/https?:\/\/\S+/g, '')                 // bare links
       .replace(/[​-‏­]/g, '')
       .replace(/[ \t]+/g, ' ');
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && !JUNK.some((re) => re.test(l)));
  // drop repeated lines and stop at quoted replies / signatures
  const out = [];
  for (const l of lines) {
    if (/^on .+ wrote:$/i.test(l) || /^-- ?$/.test(l) || /^sent from my/i.test(l)) break;
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out;
}

function splitSentences(lines) {
  return lines.join('\n').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
}

function parseEmail({ subject = '', from = '', body = '', snippet = '' }) {
  const sender = String(from).replace(/<.*>/, '').replace(/"/g, '').trim();
  const lines = cleanText(body || snippet);
  const subj = String(subject).trim();
  const info = { sender, kind: 'email', title: subj || '(no subject)', className: null, poster: null, due: null, todo: [], text: '' };

  // Google Classroom: subject 'New assignment: "X"' / 'New announcement: "X"' / 'New material…' / 'New question…'
  const cls = subj.match(/^(new|updated|due soon|missing|returned)?\s*(assignment|announcement|material|question|quiz assignment|comment)s?:?\s*[“"']?(.+?)[”"']?\s*$/i);
  const isClassroom = /classroom/i.test(from) || /classroom/i.test(body) || !!cls;
  if (cls) { info.kind = cls[2].toLowerCase().replace('quiz assignment', 'quiz'); info.title = cls[3]; }

  // "<Teacher> posted a new assignment in <Class>"
  const postedIdx = lines.findIndex((l) => /\bposted (a |an )?(new )?(assignment|announcement|material|question|quiz)/i.test(l));
  if (postedIdx >= 0) {
    const m = lines[postedIdx].match(/^(.+?)\s+posted .*?\bin\s+(.+?)\.?$/i);
    if (m) { info.poster = m[1]; info.className = m[2]; }
    lines.splice(postedIdx, 1);
  }
  // Moodle: "COURSE » Forum » Topic" breadcrumbs
  const crumb = lines.findIndex((l) => /\s[»>]\s/.test(l) && l.length < 160);
  if (crumb >= 0 && !info.className) { info.className = lines[crumb].split(/\s[»>]\s/)[0]; lines.splice(crumb, 1); }

  // Moodle: "by Dr. X - Thursday, 6 November 2026"
  const byIdx = lines.findIndex((l) => /^by .{2,60} - \w+day/i.test(l));
  if (byIdx >= 0) { if (!info.poster) info.poster = lines[byIdx].replace(/^by /i, '').split(' - ')[0]; lines.splice(byIdx, 1); }

  // due date line ("Due Nov 10, 11:59 PM", "Due: tomorrow", "Deadline: …")
  const dueIdx = lines.findIndex((l) => /^(due|deadline|closes|due date)\b[:\s]/i.test(l) || /^due (today|tomorrow)/i.test(l));
  if (dueIdx >= 0) { info.due = lines[dueIdx].replace(/^(due date|due|deadline|closes)\s*:?\s*/i, '').trim(); lines.splice(dueIdx, 1); }

  // remove a line that just repeats the title
  const tIdx = lines.findIndex((l) => l.replace(/[“”"']/g, '').toLowerCase() === info.title.replace(/[“”"']/g, '').toLowerCase());
  if (tIdx >= 0) lines.splice(tIdx, 1);
  if (isClassroom && info.poster == null && lines[0] && /^[A-Z][\p{L} .'-]{2,60}$/u.test(lines[0]) && lines.length > 1 && !ACTION.test(lines[0])) {
    // first line is often the teacher's name on its own
    info.poster = lines.shift();
  }

  info.text = lines.join('\n').slice(0, 3000);
  // to-do: sentences that ask for something or mention a deadline (max 5)
  const seen = new Set();
  for (const s of splitSentences(lines)) {
    if (!ACTION.test(s)) continue;
    const k = s.toLowerCase();
    if (seen.has(k) || s.length > 220) continue;
    // drop greetings like "Dear students," at the start of a to-do item
    const item = s.replace(/\s+/g, ' ').replace(/^(dear (all|students|everyone|class)|hello( all| everyone)?|hi( all| everyone)?)[,!:]?\s*/i, '');
    if (!item) continue;
    seen.add(k); info.todo.push(item.charAt(0).toUpperCase() + item.slice(1));
    if (info.todo.length >= 5) break;
  }
  if (!info.todo.length && info.kind === 'assignment') info.todo.push(`Complete and submit “${info.title}”${info.due ? ` by ${info.due}` : ''}.`);
  return info;
}

// one-line summary used for the notification text / phone alert
function summarize(info) {
  const parts = [];
  if (info.className) parts.push(info.className);
  if (info.due) parts.push('Due ' + info.due);
  const lead = info.todo[0] || info.text.split('\n')[0] || '';
  return [parts.join(' · '), lead].filter(Boolean).join(' — ').slice(0, 300);
}

function titleFor(info) {
  const label = { assignment: 'Assignment', announcement: 'Announcement', material: 'New material', question: 'Question', quiz: 'Quiz', comment: 'Comment' }[info.kind];
  return (label ? `${label}: ${info.title}` : info.title).slice(0, 200);
}

module.exports = { parseEmail, summarize, titleFor, cleanText };
