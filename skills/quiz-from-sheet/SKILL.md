---
name: quiz-from-sheet
description: Scaffold a mobile-first quiz/practice web app linked to a Google Sheet, deployed on GitHub Pages, with Apps Script for auth and cross-device progress sync. Use this when the user has a sheet of multiple-choice questions and wants a low-cost study/exam-prep site for a small group (<50 users). The user does NOT need a full backend — Apps Script + a hidden tab is enough. Mentions like "模擬考", "exam practice", "spreadsheet to website", "quiz app" are good triggers.
---

# Quiz-from-sheet pattern

This skill encodes the architecture and step ordering used to build the
Juliet repo (`github.com/ethansadism/Juliet`). When the user asks for a
similar quiz site, **prefer copying files from that repo over rewriting
from scratch** — it has every sharp edge already smoothed.

## Architecture at a glance

```
[Google Sheet]                     [GitHub Pages]
  ├ question tabs (col A=Q+opts, col B=answer)
  │     │
  │     │ build-time fetch  (scripts/fetch-sheet.mjs)
  │     ▼
  │   public/data/questions.json ──▶ Vue 3 + Pinia SPA ──▶ user browser
  │                                       │
  │                                       │ POST {op, token, ...}
  │                                       ▼
  └ _users (hashed pw)        ◀──── Apps Script Web App
    _progress (settings+active+knownIds)     │
    _exams (one row per finished exam)       │
                                             ▼
                                       Drive: Juliet Backups/
                                       (hourly + post-submit, 24h retention)
```

## Required inputs to ask the user

Before scaffolding, get answers to:
1. **Sheet URL or ID** + confirmation it's "anyone with link can view"
2. **GitHub repo** (URL or "create a new one named X")
3. **Initial admin password**
4. **List of users to seed** (or "I'll add via admin UI later")
5. **Custom domain or default `<user>.github.io/<repo>/`?**

## Step-by-step scaffolding

If the user has a fresh repo:
1. Clone the reference repo to a temp dir; copy everything except `.git/`,
   `node_modules/`, `dist/`, and `public/data/questions.json` into the
   target repo.
2. Update `vite.config.js` default `base` to `/${repo-name}/`.
3. Update `apps-script/Code.gs` `seedAdmin()` literal if you want a
   different default admin name.
4. Walk the user through `SETUP.md` step by step (Apps Script deploy is the
   only part they must do by hand — everything else can be GitHub-CLI'd).

## Sharp edges from previous build (read these first)

These are bugs we already hit and fixed; preserve the fixes:

### Sheet limits
- **Single cell hard cap is 50,000 characters.** Never store both progress
  and exam history in one cell. The Juliet schema splits:
  - `_progress`: per-user JSON cell ≈ activeExam (≤25KB) + settings + knownIds
  - `_exams`: append-only row per finished exam (≤25KB per row)
  Storing per-question stats (`questionStats`) in the cloud would blow the
  limit at scale (~600KB for 3664 questions); **derive them on the client**
  from the immutable `_exams` rows instead.

### Sheet discovery
- `https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid={gid}`
  returns 400 from CI runners without a browser User-Agent header. Always
  set `Mozilla/5.0` UA.
- Auto-discovering gids from the sheet HTML is brittle; the bootstrap
  blob's shape changes. The Juliet fetcher tries multiple regex patterns
  and `/htmlview`, `/preview`, `/edit` endpoints in order.
- Always expose a `SHEET_GIDS` env override as a manual fallback —
  the URL hash `#gid=N` is the user's lookup path.

### Sync correctness
- A stale device whose tab is still open will hold an out-of-date
  `activeExam` in localStorage. Any local mutation that pushes will
  clobber the cloud. Defenses to keep:
  - `pullAndMerge()` on Home mount, on Login post-auth, and on
    `visibilitychange` to visible.
  - `cancelActive()` (discard in-progress exam) MUST `pullAndMerge` first
    and bail if the active exam is already gone server-side.
  - `submitActive()` pushes the exam row immediately (`api.putExam`),
    not via the debounced progress channel — completed exams must
    survive even if a later stale push overwrites the progress cell.
- Exam merge is union-by-id; the "with finishedAt set" version always
  wins over the "still active" one if both exist.

### Question parsing
- Inline option markers `(A)X (B)Y (C)Z` are common in CJK sheets;
  line-leading `A. ...` is the Western default. The parser tries both.
- Take the longest A,B,C,... sequence so a stray `(A)` in the prompt
  body doesn't break splitting.

### Auth model (Apps Script)
- Passwords: SHA-256(salt + password), salt = `Utilities.getUuid()`.
- Sessions: stateless HMAC over `username|role|expiresAt`, key in
  `PropertiesService.getScriptProperties()`, auto-generated on first call.
- Token TTL: 30 days. Renewed only by logging in again — fine for this
  audience size.
- Bootstrap: provide a `seedAdmin()` function the user runs manually from
  the Apps Script editor; tell them to reset the password literal
  immediately after the one Run.

### Backups
- Apps Script's `.after(ms)` triggers DO NOT auto-delete after firing —
  delete them at the top of the handler or you'll exhaust the 20-trigger
  quota.
- Drive copy of a sheet takes a few seconds; debouncing the post-submit
  trigger to fire ~60s after the last submit coalesces bursts cleanly.

### GitHub Pages quirks
- `vite.config.js` `base = '/<repo>/'` is required for non-custom domains;
  derive it from `${{ github.event.repository.name }}` in the workflow.
- Use **hash router** (`createWebHashHistory`) so deep links don't 404 on
  GH Pages. (Already done.)

## File map (what lives where)

| File | Purpose | Likely to touch in new project |
|---|---|---|
| `scripts/fetch-sheet.mjs` | Build-time sheet → JSON | Only if column layout differs |
| `apps-script/Code.gs` | All backend ops | Only `seedAdmin` literal |
| `.github/workflows/deploy.yml` | CI/CD | Verify `VITE_BASE` derivation |
| `src/lib/api.js` | Single point of contact with backend — REWRITE THIS to swap backends | No, unless changing backend |
| `src/lib/sync.js` | Debounce, pull/push, syncing flag | No |
| `src/lib/parseQuestion.js` | Option-marker parser | Only if format differs |
| `src/stores/progress.js` | Exam lifecycle, stats derivation | No |
| `src/stores/auth.js` | Login state + token | No |
| `src/stores/questions.js` | Question pool loader | No |
| `src/views/*.vue` | All UI | Branding / strings |
| `SETUP.md` | Human deploy steps | Update repo-name references |

## When the user says "swap the backend"

The minimum surface to change is `src/lib/api.js`. It exposes:
- `login(u, p)` → `{ token, username, displayName, role }`
- `changePassword(old, new)`
- `getAll(username?)` → `{ progress, exams[] }`
- `putProgress(username, snapshot)` → `{ ok }`
- `putExam(username, exam)` → `{ ok }`
- `adminListUsers()` / `adminUpsertUser()` / `adminDeleteUser()`

Reimplement those against any backend (REST, Firebase, Supabase) and
nothing else needs to change. The `progress.js` store already separates
local state from network calls.

## When the user says "swap the question source"

Change `scripts/fetch-sheet.mjs` to read from the new source (DB, API,
file) and write the same `public/data/questions.json` shape:

```json
{
  "sheetId": "any-string",
  "fetchedAt": "ISO8601",
  "sheets": [{ "name": "...", "gid": "..." }],
  "count": 1234,
  "questions": [
    { "id": "stable-id", "sheet": "...", "gid": "...",
      "prompt": "Q + options merged or just Q", "answer": "A" }
  ]
}
```

Frontend doesn't care how that JSON was produced.

## Avoid these temptations

- **Don't** generalize this into a quiz library. One project's use is
  not enough signal; you'll regret the abstraction layer.
- **Don't** add a CI build step that fails on a stale sheet snapshot.
  Refreshes are async; build failures from a temporarily-unreachable
  Google block deploys for unrelated reasons.
- **Don't** invite OAuth for "real" auth unless the user explicitly asks.
  The hardcoded-then-hashed model is fine for <50 users.
- **Don't** store `questionStats` in the cloud. It's a derived cache;
  treat exams as the source of truth.

## Reference

Source-of-truth repo: `github.com/ethansadism/Juliet`. When in doubt,
read commits — every gotcha above has a corresponding fix commit with
a long message explaining the root cause.
