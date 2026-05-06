# Juliet 模擬考

Vue 3 + Pinia 打造的手機優先模擬考站,題庫直接從 Google Sheet 拉取,
最終靜態檔部署於 GitHub Pages。

## 架構摘要

- **前端**: Vue 3 + Pinia + Vue Router + Vite
- **題庫**: build 時用 `scripts/fetch-sheet.mjs` 把 Google Sheet 三個工作表
  匯出成 `public/data/questions.json`(免 API key,sheet 須為「知道連結的人可檢視」)
- **進度**: `localStorage` 為主(離線可用)
- **跨裝置同步(可選)**: Google Apps Script Web App,參見 `apps-script/Code.gs`
- **登入**: SHA-256 + salt 存於 sheet 的 `_users` 隱藏分頁,Apps Script 驗證後簽 30 天 HMAC token

## 本機開發

```bash
npm install
npm run fetch:sheet     # 抓題庫 → public/data/questions.json
npm run dev             # http://localhost:5173
```

第一次跑 `dev` 之前要先 `fetch:sheet`,否則前端會找不到題庫 JSON。

## 部署到 GitHub Pages

1. 將此 repo 推到 GitHub。
2. Repository → **Settings → Pages → Build and deployment → Source = GitHub Actions**。
3. (可選)Settings → Secrets and variables → Actions
   - **Variables**:
     - `SHEET_ID` = 您的 Google Sheet ID(預設已內建現用的)
     - `SHEET_GIDS` = 手動指定工作表 gid,只有在自動探勘失敗時才需要設。
       格式 `gid1,gid2,gid3` 或附名稱 `0:題庫A,123:題庫B,456:題庫C`。
       gid 可以從 sheet URL 列點開該分頁時的 `#gid=NNN` 找到。
   - **Secrets**: `SYNC_URL` = Apps Script 部署後的 web app URL(若要跨裝置同步)
4. push 到 `main` 後 Action 會自動 build + deploy,並每天 01:00 (Taipei)
   重新拉一次題庫。

部署完成後網址通常是 `https://<user>.github.io/<repo>/`。

## 帳號與後端

帳號密碼以 SHA-256 + salt 儲存在 sheet 的隱藏分頁 `_users`,
登入透過 Apps Script 驗證,前端只持有一個 30 天的 HMAC token。
**前端不再有任何明碼帳號**,因此本系統需要 Apps Script 後端才能登入。

### 一次性設定 Apps Script

1. 開啟您的 Google Sheet → 擴充功能 → Apps Script。
2. 把 `apps-script/Code.gs` 內容貼上去儲存。
3. **部署 → 新增部署** → 類型 = Web app
   - 「以使用者身分執行」: 我
   - 「具有存取權的對象」: 知道連結的任何人
4. 複製產生的 web app URL,填入 GitHub Secret `SYNC_URL`。
5. 在 Apps Script 編輯器:
   - 編輯 `seedAdmin()` 函式裡的 `password` 變數設一個您要的初始管理員密碼。
   - 函式下拉選單選 `seedAdmin` → Run。第一次會要求授權,允許即可。
   - 跑完之後把那行密碼改回 `'CHANGE_ME_NOW'` 存檔(避免將來不小心又跑)。
6. 重新觸發 Action(push 一個 commit 或手動執行 workflow)讓網站接到新的 SYNC_URL。

登入後管理員會在右上角看到「管理」按鈕,可以新增/刪除使用者、
重設任意密碼、或改變角色。一般使用者忘記密碼時,請管理員到該頁重設。

### 跨裝置同步(隨後即啟用)

只要設了 `SYNC_URL`,進度就會自動同步到 sheet 的另一個隱藏分頁 `_progress`:

- 每次答題/設定變更 1.5s debounce 後 push。
- 登入時會 pull 一次,若雲端較新則覆蓋本機(last-writer-wins)。
- 離線或 rate limit 時自動退化為純 localStorage 模式,
  下次連線會自動再 push。

> 看不到資料?在試算表「檢視 → 顯示 → 隱藏的工作表」可以打開 `_users` / `_progress`。

## 題庫格式

`public/data/questions.json`:

```jsonc
{
  "sheetId": "...",
  "fetchedAt": "ISO8601",
  "sheets": [{ "name": "工作表1", "gid": "0" }, ...],
  "count": 3664,
  "questions": [
    { "id": "s0-0", "sheet": "工作表1", "gid": "0", "prompt": "Q+選項合併文字", "answer": "A" },
    ...
  ]
}
```

選項是在前端用 `src/lib/parseQuestion.js` 解析的,支援 `(A)` / `A.` / `A、`
等寫法。如果某題未能正確解析,UI 會以原文呈現並在檢討畫面顯示標準答案。

## 結構

```
scripts/fetch-sheet.mjs   build 時抓 sheet → JSON
apps-script/Code.gs       後端:登入 / 管理 / 進度同步
src/
  main.js / App.vue / router.js
  styles.css              全域樣式(手機優先,深色)
  lib/
    parseQuestion.js      題目+選項拆解、答案比對
    api.js                Apps Script 共用 client(token、登入、管理、同步)
    sync.js               進度的 push / pull 包裝(debounce)
  stores/
    auth.js               登入狀態 + token
    questions.js          題庫載入
    progress.js           進度、考試生命週期、設定
  views/
    Login.vue
    Home.vue              主畫面+設定
    Exam.vue              答題頁
    ReviewList.vue        歷史考試列表
    Review.vue            單次考試檢討
    Admin.vue             管理員專用(新增/重設/刪除使用者)
```
