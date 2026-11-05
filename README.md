# 📚 StudyHub

A study web app where each student has their own account to:

- **Track assignments, quizzes and exams**: due dates, priority, status, grades and per-course averages.
- **Study their sheets**: upload PDFs, photos of notes or text, and read them in the app.
- **Master MCQs**: Claude AI turns a sheet into multiple-choice questions, or students write their own. Practice uses **spaced repetition**. A wrong answer comes back in about 3 minutes. Each correct answer pushes the question further out (1 day, then 3 days, then longer). After 4 correct answers in a row, the question counts as *mastered*.
- **See mastery and weak spots** per course and per topic, and practise a weak topic with one click.
- **Plan**: a calendar shows deadlines and study sessions. "Make study plan" spreads daily sessions from today until an exam's date.
- **Get reminders** as browser notifications for items due within 24 hours, within 1 hour, or overdue, and when reviews are waiting.
- **Use a focus timer** (Pomodoro). Each finished focus session is logged as study time, and that feeds the study streak.

## Run it

Requires Node.js 22.5 or newer, because it uses the built-in `node:sqlite`.

```bash
npm install
npm start
```

Then open http://localhost:3000 and create an account.

## Turn on AI question generation

1. Copy `.env.example` to `.env`.
2. Set `ANTHROPIC_API_KEY=` to your key from https://console.anthropic.com/.
3. Restart with `npm start`.

Generation uses `claude-opus-5-5` by default. You can change it with `CLAUDE_MODEL`. To test without a key, set `MOCK_AI=1` to get placeholder questions.

## Files

| File | What it does |
|---|---|
| `server.js` | Express API: auth, courses, tasks, sheets, questions, spaced repetition, planner, dashboard |
| `db.js` | SQLite schema (`studyhub.db` is created automatically) |
| `ai.js` | Generates MCQs with Claude from a PDF, image or text |
| `public/` | Frontend (`index.html`, `app.js`, `styles.css`) in plain JS with no build step |
| `uploads/` | Uploaded study sheets |
