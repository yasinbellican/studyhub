# 📚 E-JUST (StudyHub)

A study web app for one class. The class is split into **sections** by timetable. Everyone studies the same material, and each section can have its own due dates.

**Who does what**
- **Class reps (admins)** add the shared courses, assignments, quizzes, exams, study sheets and MCQs. They can set a different due date for each section, and they manage the invite code, sections and members.
- **Students** join with the invite code and pick their section. They see due dates for their own section. Their status and grades are private to them.

**Features**
- **Track assignments, quizzes and exams**: due dates per section, plus your own status and grades, with course averages.
- **Study sheets**: PDFs, photos of notes or text, which you read inside the app.
- **Practice MCQs (MCQ Drill)**: members with the MCQ permission upload question sets (a `.txt` file or pasted text, e.g. an AI's reply) that the whole class shares. Everyone taps a set to practise it: you answer every question, and the ones you miss come back next round until none are left.
- **Plan**: a calendar shows deadlines and study sessions. "Make study plan" spreads daily sessions from today until an exam's date.
- **Get reminders** as browser notifications for items due within 24 hours, within 1 hour, or overdue, and when reviews are waiting.
- **Use a focus timer** (Pomodoro). Each finished focus session is logged as study time, and that feeds the study streak.

## Run it

Requires Node.js 22.9 or newer. Locally the data is kept in a `studyhub.db` file.

```bash
npm install
npm start
```

Then open http://localhost:3000.

1. **The first person to open the app sets up the class.** They enter the class name, the sections (for example `Section 1, Section 2, Section 3`), and their own name, **username** and password. They become the first admin.
2. Go to **Class & Sections** and copy the **invite code**. Share it with classmates.
3. Classmates choose **"Join with an invite code"**, enter the code, pick their section and choose a username and password. This only **sends a request**.
4. An admin approves (or rejects) the request under **Class & Sections → Join requests**. Until then the person cannot sign in. After approval they sign in with their username and password; the code is only needed once.
5. Admins control what each member may do on the **Permissions** page.

## Put it online for free

StudyHub runs on **Vercel** (free Hobby plan), and its data is stored in **Turso** (free database, 5 GB). Neither needs a credit card. Uploaded sheets are stored in the database too, so nothing is lost between requests.

1. **Create the database (Turso)**
   1. Sign up at https://turso.tech.
   2. Create a database, for example `studyhub`.
   3. Copy its **URL**, which starts with `libsql://`.
   4. Create a **token** and copy it.
2. **Deploy the app (Vercel)**
   1. Sign up at https://vercel.com with GitHub.
   2. Choose **Add New → Project**, then import this repository. Vercel detects the Express app on its own.
   3. Under **Environment Variables**, add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` with the values from Turso.
   4. `ANTHROPIC_API_KEY` is optional.
   5. Click **Deploy**. The app goes live at `https://<project>.vercel.app`.
3. Open that link and set up the class. **Do this first**, because the first person to sign up becomes the admin. Then share the link and the invite code.

Every push to `main` redeploys automatically.

Free-plan limits:
- Each uploaded sheet can be at most **4 MB**, because Vercel limits the size of a request.
- Reminders only appear while the app is open in a browser tab.

## Turn on AI question generation

1. Copy `.env.example` to `.env`.
2. Set `ANTHROPIC_API_KEY=` to your key from https://console.anthropic.com/.
3. Restart with `npm start`. Online, set `ANTHROPIC_API_KEY` in the Vercel project's **Settings → Environment Variables** instead, then redeploy.

The Anthropic API is paid per use. Everything else in StudyHub works without it.

Generation uses `claude-opus-5-5` by default. You can change it with `CLAUDE_MODEL`. To test without a key, set `MOCK_AI=1` to get placeholder questions.

## Files

| File | What it does |
|---|---|
| `server.js` | Express API: auth, courses, tasks, sheets, questions, spaced repetition, planner, dashboard |
| `db.js` | Database layer (libSQL): a local file, or Turso when `TURSO_DATABASE_URL` is set. Uploaded files are stored in it too |
| `ai.js` | Generates MCQs with Claude from a PDF, image or text |
| `public/` | Frontend (`index.html`, `app.js`, `styles.css`) in plain JS with no build step |

## Sections, timetable and class emails

- **Section-only homework**: an assignment can be for everyone or for one section only. Each section can also have its own due date.
- **Past items**: quizzes and exams are deleted once their date has passed. Assignments move to the **Past** tab.
- **Timetable**: weekly classes per section. Classes that alternate (for example physics lab one week, chemistry lab the next) are marked Week A or Week B. When adding homework, "Fill in" sets each section's date to its next tutorial, lecture or lab.
- **Add content**: one tab for adding assignments, quizzes, exams and study sheets.
- **Users** (admins): members and sections, permissions, and connections in one tab.
- **Class emails**: emails from a lecture, lab or Moodle class go to the whole class. Emails from a tutorial class go in full only to the section the Gmail belongs to; other sections get a short note. Other emails stay private.
