# Setup Checklist

Step-by-step from a fresh clone (or empty fork) to a deployed site. Skip the
explanation and just do the numbered actions — they're ordered to work.

## 0. Prerequisites

- Node 20+ and npm
- A GitHub repo (this code, public or private)
- A Google account (for Sheet + Apps Script + Drive backups)
- A Google Sheet whose column A is `題目敘述 + 選項`, column B is the answer
  letter, optionally split across multiple tabs

## 1. Prepare the question sheet

1. Open the sheet → **共用** → **一般存取權** → 「**知道連結的人**」=「**檢視者**」.
2. Copy the sheet ID from the URL — the long string between `/d/` and `/edit`.
3. (Skip unless step 5b fails.) Click each tab; for each, note the `#gid=NNN`
   value in the URL bar.

## 2. Apps Script backend

1. In the sheet: **擴充功能 → Apps Script**.
2. Replace the default `Code.gs` with this repo's `apps-script/Code.gs`. Save.
3. From the function dropdown, pick `setupBackupTrigger` → **Run**. Grant
   Drive permissions when prompted. (Installs the hourly backup trigger.)
4. Edit `seedAdmin()`: replace `'CHANGE_ME_NOW'` with your chosen admin
   password. From the dropdown → `seedAdmin` → **Run**. Then **change that
   literal back to `'CHANGE_ME_NOW'` and save**, so a stray future Run can't
   silently reset the admin password.
5. **部署 → 新增部署** → 類型 = **Web app**:
   - 「以使用者身分執行」: **我**
   - 「具有存取權的對象」: **知道連結的任何人**
6. Copy the deployment URL — this is your `SYNC_URL`.

## 3. GitHub repo configuration

1. Push the code to your repo (or fork).
2. **Settings → Secrets and variables → Actions**:
   - **Secrets** → New secret: `SYNC_URL` = the URL from step 2.6.
   - **Variables** → New variable: `SHEET_ID` = your sheet ID.
   - (Optional) **Variables** → `SHEET_GIDS` = `gid1,gid2,gid3` if the build
     log shows "Could not discover any worksheet gids".
3. **Settings → Pages → Source = GitHub Actions**.

## 4. Set the base path

In `vite.config.js`, ensure `base` matches your repo name:

```js
const base = process.env.VITE_BASE ?? '/<your-repo-name>/'
```

The workflow auto-sets it from `${{ github.event.repository.name }}`, so if
you've renamed the repo this just needs to match locally for `npm run dev`.

## 5. First deploy

1. Push any commit to `main`, or **Actions → Deploy to GitHub Pages → Run
   workflow**.
2. Wait ~2–3 min for the green check.
3. Open `https://<user>.github.io/<repo>/`.

## 6. First login + create users

1. Log in as `admin` with the password set in step 2.4.
2. **管理 → 新增使用者** to create real accounts.
3. Hand out credentials out-of-band; users can change their own password
   from the same admin page (only the admin sees the full user list).

## Updating the question bank

- After editing the sheet, **Actions → Deploy → Run workflow** to rebuild
  immediately. Hard-refresh the site (F5) on each device to bypass the
  Service Worker / browser cache.
- A daily cron at 17:00 UTC (01:00 Taipei) rebuilds automatically.
- If you change an answer key for a question users have already answered,
  past attempts get a yellow **⚠ 答案已更新** badge on the review page —
  historical scoring is preserved.

## Optional: install the local Claude skill

If you use Claude Code, link the in-repo skill into your home so future
"build me one of these" requests pick it up automatically:

```bash
ln -s "$(pwd)/skills/quiz-from-sheet" ~/.claude/skills/quiz-from-sheet
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build log: `Could not discover any worksheet gids` | Set `SHEET_GIDS` variable manually (step 3.2). |
| Build log: `gid=N HTTP 400` | Sheet isn't "Anyone with the link can view" — fix step 1.1. |
| Page loads blank, console 404s on `/assets/...` | `vite.config.js` `base` doesn't match repo name. Set `VITE_BASE` env in workflow or fix the default. |
| Login fails with `登入後端未設定` | `SYNC_URL` secret missing or wrong; re-run Actions after fixing. |
| Apps Script log: "exceeds 50000 chars" cell write | Should not happen post-refactor; if it does, the user has somehow returned to v1 schema. Force-pull the latest frontend code and have them log out + back in. |
| Backup folder fills up with copies | Already capped at 24h retention by `pruneOldBackups_`. If you see unbounded growth, check the hourly trigger is actually firing in Apps Script → Triggers. |
| User sees old questions after sheet edit | They need to hard-refresh. Question JSON has `cache: 'no-cache'` on fetch, but the index.html / asset bundle is still subject to CDN caching for ~10 min. |
