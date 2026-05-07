/**
 * Juliet 模擬考 backend (Google Apps Script).
 *
 * Provides login, password management, and per-user progress sync.
 * All data is stored in two hidden tabs in the host spreadsheet:
 *
 *   _users     : username | displayName | role | salt | passwordHash | updatedAt
 *   _progress  : username | updatedAt    | snapshot
 *
 * Setup (one-off):
 *   1. Open the sheet → Extensions → Apps Script.
 *   2. Replace Code.gs with this file. Save.
 *   3. In the function dropdown choose `seedAdmin` and set the password
 *      inline below, then run it once. (You can rerun to reset the admin pw.)
 *   4. Deploy → New deployment → Web app.
 *        Execute as: Me.   Who has access: Anyone with the link.
 *   5. Copy the URL into your GitHub repo secret `SYNC_URL`.
 *
 * Tokens are stateless HMACs over `username|role|expiresAt`, signed by a
 * SCRIPT_SECRET auto-generated and stored in script properties on first use.
 */

const USERS_SHEET = '_users';
const PROGRESS_SHEET = '_progress';
const EXAMS_SHEET = '_exams';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const EXAMS_HEADERS = [
  'username', 'examId', 'startedAt', 'finishedAt',
  'questionCount', 'correctCount',
  'settings', 'questionIds', 'answers',
  'wrongIncluded', 'wrongPoolSize',
];

// =====================================================================
// Manual setup helpers — run from the Apps Script editor, not via web.
// =====================================================================

/** One-shot admin bootstrap. Edit the password, choose this in the function
 *  dropdown, click Run. Re-running with a new password resets it. */
function seedAdmin() {
  const username = 'admin';
  const password = 'CHANGE_ME_NOW';   // <-- edit, run once, then edit back
  const displayName = 'Administrator';
  upsertUser_(username, displayName, 'admin', password);
  Logger.log('Admin seeded: %s', username);
}

/** Convenience: list users to the Apps Script log. */
function listUsersLog() {
  const sh = sheet_(USERS_SHEET, ['username', 'displayName', 'role', 'salt', 'passwordHash', 'updatedAt']);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    Logger.log('%s (%s) role=%s updated=%s', data[i][0], data[i][1], data[i][2], data[i][5]);
  }
}

// =====================================================================
// Web entry points
// =====================================================================

function doGet(e) {
  const params = e.parameter || {};
  try {
    if (params.op === 'get')    return json_(handleGetProgress_(params));
    if (params.op === 'getAll') return json_(handleGetAll_(params));
    return json_({ error: 'unknown op' });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    return json_({ error: 'bad json' });
  }
  try {
    switch (body.op) {
      case 'login':           return json_(handleLogin_(body));
      case 'changePassword':  return json_(handleChangePassword_(body));
      case 'put':             return json_(handlePutProgress_(body));
      case 'putExam':         return json_(handlePutExam_(body));
      case 'adminListUsers':  return json_(handleAdminListUsers_(body));
      case 'adminUpsertUser': return json_(handleAdminUpsertUser_(body));
      case 'adminDeleteUser': return json_(handleAdminDeleteUser_(body));
      default: return json_({ error: 'unknown op' });
    }
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

// =====================================================================
// Op handlers
// =====================================================================

function handleLogin_(body) {
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return { error: 'missing credentials' };
  const u = findUser_(username);
  if (!u) return { error: 'invalid credentials' };
  if (sha256_(u.salt + password) !== u.passwordHash) {
    return { error: 'invalid credentials' };
  }
  return {
    ok: true,
    token: makeToken_(u.username, u.role),
    username: u.username,
    displayName: u.displayName,
    role: u.role,
  };
}

function handleChangePassword_(body) {
  const session = requireSession_(body);
  const oldPw = String(body.oldPassword || '');
  const newPw = String(body.newPassword || '');
  if (newPw.length < 4) return { error: 'password too short' };
  const u = findUser_(session.username);
  if (!u) return { error: 'user not found' };
  if (sha256_(u.salt + oldPw) !== u.passwordHash) return { error: 'wrong old password' };
  upsertUser_(u.username, u.displayName, u.role, newPw);
  return { ok: true };
}

function handlePutProgress_(body) {
  const session = requireSession_(body);
  const target = String(body.username || session.username);
  if (target !== session.username && session.role !== 'admin') {
    return { error: 'forbidden' };
  }
  let snap = body.snapshot;
  // Defensive: an old client may still post the legacy {exams,questionStats}
  // shape. Migrate it into the new model so we never lose data.
  if (snap && (Array.isArray(snap.exams) || snap.questionStats)) {
    snap = migrateLegacySnapshot_(target, snap);
  }
  writeProgressRow_(target, snap);
  return { ok: true, updatedAt: new Date().toISOString() };
}

function handlePutExam_(body) {
  const session = requireSession_(body);
  const target = String(body.username || session.username);
  if (target !== session.username && session.role !== 'admin') {
    return { error: 'forbidden' };
  }
  const exam = body.exam;
  if (!exam || !exam.id) return { error: 'missing exam' };
  upsertExam_(target, exam);
  // Fire-and-forget: queue a debounced backup for ~60s from now.
  scheduleOneShotBackup_();
  return { ok: true };
}

function handleGetProgress_(params) {
  const session = requireSession_({ token: params.token });
  const target = String(params.username || session.username);
  if (target !== session.username && session.role !== 'admin') {
    return { error: 'forbidden' };
  }
  return { snapshot: readProgress_(target) };
}

function handleGetAll_(params) {
  const session = requireSession_({ token: params.token });
  const target = String(params.username || session.username);
  if (target !== session.username && session.role !== 'admin') {
    return { error: 'forbidden' };
  }
  return {
    progress: readProgress_(target),
    exams: readExams_(target),
  };
}

// =====================================================================
// Progress + exams I/O (with one-shot migration of legacy snapshots)
// =====================================================================

function readProgress_(username) {
  const sh = sheet_(PROGRESS_SHEET, ['username', 'updatedAt', 'snapshot']);
  const row = findRow_(sh, username);
  if (row < 0) return null;
  let snap = null;
  try {
    const cell = sh.getRange(row, 3).getValue();
    snap = cell ? JSON.parse(cell) : null;
  } catch (err) {
    return null;
  }
  if (!snap) return null;
  if (Array.isArray(snap.exams) || snap.questionStats) {
    snap = migrateLegacySnapshot_(username, snap);
    writeProgressRow_(username, snap);
  }
  return snap;
}

function writeProgressRow_(username, snap) {
  const sh = sheet_(PROGRESS_SHEET, ['username', 'updatedAt', 'snapshot']);
  const row = findRow_(sh, username);
  const ts = new Date().toISOString();
  const blob = JSON.stringify(snap ?? null);
  if (row < 0) sh.appendRow([username, ts, blob]);
  else {
    sh.getRange(row, 2).setValue(ts);
    sh.getRange(row, 3).setValue(blob);
  }
}

function readExams_(username) {
  const sh = sheet_(EXAMS_SHEET, EXAMS_HEADERS);
  const data = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] !== username) continue;
    out.push({
      id: data[i][1],
      startedAt: data[i][2],
      finishedAt: data[i][3] || null,
      questionCount: Number(data[i][4]) || 0,
      correctCount: Number(data[i][5]) || 0,
      settings: parseJson_(data[i][6], {}),
      questionIds: parseJson_(data[i][7], []),
      answers: parseJson_(data[i][8], {}),
      wrongIncluded: Number(data[i][9]) || 0,
      wrongPoolSize: Number(data[i][10]) || 0,
    });
  }
  out.sort(function (a, b) { return a.startedAt < b.startedAt ? -1 : 1; });
  return out;
}

function upsertExam_(username, exam) {
  const sh = sheet_(EXAMS_SHEET, EXAMS_HEADERS);
  const data = sh.getDataRange().getValues();
  let row = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === username && data[i][1] === exam.id) { row = i + 1; break; }
  }
  const answers = exam.answers || {};
  let correct = 0;
  for (const k in answers) if (answers[k] && answers[k].correct) correct++;
  const values = [
    username,
    exam.id,
    exam.startedAt || '',
    exam.finishedAt || '',
    (exam.questionIds || []).length,
    correct,
    JSON.stringify(exam.settings || {}),
    JSON.stringify(exam.questionIds || []),
    JSON.stringify(answers),
    Number(exam.wrongIncluded) || 0,
    Number(exam.wrongPoolSize) || 0,
  ];
  if (row < 0) sh.appendRow(values);
  else sh.getRange(row, 1, 1, values.length).setValues([values]);
}

function migrateLegacySnapshot_(username, snap) {
  // 1. Lift exams[] into the _exams sheet (idempotent by examId)
  if (Array.isArray(snap.exams)) {
    const existing = readExamIds_(username);
    for (const ex of snap.exams) {
      if (!ex || !ex.id) continue;
      if (existing.has(ex.id)) continue;
      upsertExam_(username, ex);
      existing.add(ex.id);
    }
  }
  // 2. Convert questionStats[*].knownByUser → knownIds
  let knownIds = Array.isArray(snap.knownIds) ? snap.knownIds.slice() : null;
  if (!knownIds && snap.questionStats) {
    knownIds = [];
    for (const qid in snap.questionStats) {
      const s = snap.questionStats[qid];
      if (s && s.knownByUser) knownIds.push(qid);
    }
  }
  return {
    version: 2,
    settings: snap.settings || {},
    knownIds: knownIds || [],
    activeExam: snap.activeExam || null,
    lastActivityAt: snap.lastActivityAt || null,
  };
}

function readExamIds_(username) {
  const sh = sheet_(EXAMS_SHEET, EXAMS_HEADERS);
  const data = sh.getDataRange().getValues();
  const ids = new Set();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === username) ids.add(data[i][1]);
  }
  return ids;
}

function parseJson_(s, dflt) {
  if (s == null || s === '') return dflt;
  try { return JSON.parse(s); } catch (err) { return dflt; }
}

function handleAdminListUsers_(body) {
  const session = requireSession_(body);
  if (session.role !== 'admin') return { error: 'forbidden' };
  const sh = sheet_(USERS_SHEET, ['username', 'displayName', 'role', 'salt', 'passwordHash', 'updatedAt']);
  const data = sh.getDataRange().getValues();
  const users = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    users.push({
      username: data[i][0],
      displayName: data[i][1],
      role: data[i][2],
      updatedAt: data[i][5],
    });
  }
  return { users };
}

function handleAdminUpsertUser_(body) {
  const session = requireSession_(body);
  if (session.role !== 'admin') return { error: 'forbidden' };
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.displayName || username);
  const role = body.role === 'admin' ? 'admin' : 'user';
  if (!username) return { error: 'missing username' };
  if (password && password.length < 4) return { error: 'password too short' };
  const existing = findUser_(username);
  if (!existing && !password) return { error: 'new user requires password' };
  upsertUser_(username, displayName, role, password || null);
  return { ok: true };
}

function handleAdminDeleteUser_(body) {
  const session = requireSession_(body);
  if (session.role !== 'admin') return { error: 'forbidden' };
  const username = String(body.username || '').trim();
  if (!username) return { error: 'missing username' };
  if (username === session.username) return { error: "can't delete self" };
  const sh = sheet_(USERS_SHEET, ['username', 'displayName', 'role', 'salt', 'passwordHash', 'updatedAt']);
  const row = findRow_(sh, username);
  if (row > 0) sh.deleteRow(row);
  // Clean up progress + exams too.
  const psh = sheet_(PROGRESS_SHEET, ['username', 'updatedAt', 'snapshot']);
  const prow = findRow_(psh, username);
  if (prow > 0) psh.deleteRow(prow);
  const esh = sheet_(EXAMS_SHEET, EXAMS_HEADERS);
  const edata = esh.getDataRange().getValues();
  for (let i = edata.length - 1; i >= 1; i--) {
    if (edata[i][0] === username) esh.deleteRow(i + 1);
  }
  return { ok: true };
}

// =====================================================================
// Sheet helpers
// =====================================================================

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.hideSheet();
  }
  return sh;
}

function findRow_(sh, key) {
  const col = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (let i = 1; i < col.length; i++) {
    if (col[i][0] === key) return i + 1; // 1-based
  }
  return -1;
}

function findUser_(username) {
  const sh = sheet_(USERS_SHEET, ['username', 'displayName', 'role', 'salt', 'passwordHash', 'updatedAt']);
  const row = findRow_(sh, username);
  if (row < 0) return null;
  const v = sh.getRange(row, 1, 1, 6).getValues()[0];
  return {
    row,
    username: v[0],
    displayName: v[1],
    role: v[2] || 'user',
    salt: v[3],
    passwordHash: v[4],
    updatedAt: v[5],
  };
}

function upsertUser_(username, displayName, role, passwordOrNull) {
  const sh = sheet_(USERS_SHEET, ['username', 'displayName', 'role', 'salt', 'passwordHash', 'updatedAt']);
  const row = findRow_(sh, username);
  const ts = new Date().toISOString();
  if (row < 0) {
    const salt = Utilities.getUuid();
    const hash = sha256_(salt + (passwordOrNull || ''));
    sh.appendRow([username, displayName, role, salt, hash, ts]);
  } else {
    sh.getRange(row, 2).setValue(displayName);
    sh.getRange(row, 3).setValue(role);
    sh.getRange(row, 6).setValue(ts);
    if (passwordOrNull) {
      const salt = Utilities.getUuid();
      const hash = sha256_(salt + passwordOrNull);
      sh.getRange(row, 4).setValue(salt);
      sh.getRange(row, 5).setValue(hash);
    }
  }
}

// =====================================================================
// Crypto + token
// =====================================================================

function scriptSecret_() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('SCRIPT_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SCRIPT_SECRET', s);
  }
  return s;
}

function sha256_(s) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytesToHex_(raw);
}

function hmacHex_(s, key) {
  const raw = Utilities.computeHmacSha256Signature(s, key);
  return bytesToHex_(raw);
}

function bytesToHex_(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 0xff;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function makeToken_(username, role) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = `${username}|${role}|${exp}`;
  const sig = hmacHex_(payload, scriptSecret_());
  return Utilities.base64EncodeWebSafe(`${payload}|${sig}`).replace(/=+$/, '');
}

function verifyToken_(token) {
  if (!token) return null;
  let raw;
  try {
    raw = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
  } catch (err) {
    return null;
  }
  const parts = raw.split('|');
  if (parts.length !== 4) return null;
  const [username, role, expStr, sig] = parts;
  const expected = hmacHex_(`${username}|${role}|${expStr}`, scriptSecret_());
  if (sig !== expected) return null;
  if (Number(expStr) < Date.now()) return null;
  return { username, role };
}

function requireSession_(body) {
  const session = verifyToken_(body && body.token);
  if (!session) throw new Error('unauthorized');
  return session;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

// =====================================================================
// Backup: hourly cron + post-submit one-shot, 24h retention
// =====================================================================
//
// Setup (one-shot, from Apps Script editor):
//   1. Choose `setupBackupTrigger` from the function dropdown → Run.
//      That installs an hourly time trigger that runs runHourlyBackup.
//   2. The first time it (or runOneShotBackup) runs Drive permissions
//      will be requested — accept them.
//
// Each backup creates a Google Sheets copy named
//   "Juliet backup YYYY-MM-DDTHH-mm-ss-sssZ (reason)"
// in a sibling folder called "Juliet Backups". Anything older than
// 24h whose name starts with "Juliet backup " is moved to trash.

const BACKUP_FOLDER_NAME = 'Juliet Backups';
const BACKUP_RETENTION_MS = 24 * 60 * 60 * 1000;
const ONESHOT_HANDLER = 'runOneShotBackup';
const HOURLY_HANDLER = 'runHourlyBackup';

function setupBackupTrigger() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === HOURLY_HANDLER) ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger(HOURLY_HANDLER).timeBased().everyHours(1).create();
  Logger.log('Hourly backup trigger installed.');
}

function runHourlyBackup() {
  runBackup_('hourly');
}

function runOneShotBackup() {
  // Self-clean so a future submit can schedule another.
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === ONESHOT_HANDLER) ScriptApp.deleteTrigger(t);
  }
  runBackup_('post-submit');
}

// Called from handlePutExam_. Schedules a single backup ~60s out and
// debounces against bursts of submits — at most one one-shot is queued
// at a time, so multiple consecutive submits coalesce into one backup.
function scheduleOneShotBackup_() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === ONESHOT_HANDLER) return;
  }
  try {
    ScriptApp.newTrigger(ONESHOT_HANDLER).timeBased().after(60 * 1000).create();
  } catch (err) {
    // Trigger quota exceeded or similar — just log; hourly will catch up.
    Logger.log('schedule one-shot backup failed: %s', err);
  }
}

function runBackup_(reason) {
  try {
    const ss = SpreadsheetApp.getActive();
    const folder = backupsFolder_();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const name = 'Juliet backup ' + ts + ' (' + (reason || 'manual') + ')';
    DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
    pruneOldBackups_(folder);
    Logger.log('Backup OK: %s', name);
  } catch (err) {
    Logger.log('Backup failed: %s', err);
  }
}

function backupsFolder_() {
  const ss = SpreadsheetApp.getActive();
  const file = DriveApp.getFileById(ss.getId());
  const parents = file.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const it = parent.getFoldersByName(BACKUP_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return parent.createFolder(BACKUP_FOLDER_NAME);
}

function pruneOldBackups_(folder) {
  const cutoff = Date.now() - BACKUP_RETENTION_MS;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (!f.getName().startsWith('Juliet backup ')) continue;
    if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
  }
}
