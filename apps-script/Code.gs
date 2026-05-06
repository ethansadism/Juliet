/**
 * Optional cross-device sync backend for Juliet 模擬考.
 *
 * Setup:
 *  1. In your Google Sheet, Extensions → Apps Script.
 *  2. Replace the default Code.gs with this file.
 *  3. (Optional) Edit the SHARED_SECRET below to require a token.
 *  4. Deploy → New deployment → Web app
 *       - Execute as:        Me
 *       - Who has access:    Anyone with the link
 *     Copy the resulting URL.
 *  5. In your GitHub repo, add it as a secret named SYNC_URL.
 *     The deploy workflow forwards it to the build as VITE_SYNC_URL.
 *
 * The script stores per-user JSON snapshots in a hidden "_progress" tab,
 * keyed by username. The frontend last-writer-wins on login.
 */

const SHEET_NAME = '_progress';
// Optional: set to a non-empty string to require a token in requests.
const SHARED_SECRET = '';

function _sheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['username', 'updatedAt', 'snapshot']);
    sh.hideSheet();
  }
  return sh;
}

function _findRow(sh, username) {
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === username) return i + 1; // 1-based
  }
  return -1;
}

function _checkSecret(payload, params) {
  if (!SHARED_SECRET) return true;
  const t = (payload && payload.token) || (params && params.token);
  return t === SHARED_SECRET;
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

function doGet(e) {
  const params = e.parameter || {};
  if (!_checkSecret(null, params)) return _json({ error: 'forbidden' });
  const op = params.op;
  if (op === 'get') {
    const sh = _sheet();
    const row = _findRow(sh, params.username);
    if (row < 0) return _json({ snapshot: null });
    const cell = sh.getRange(row, 3).getValue();
    let snapshot = null;
    try {
      snapshot = cell ? JSON.parse(cell) : null;
    } catch (err) {
      snapshot = null;
    }
    return _json({ snapshot });
  }
  return _json({ error: 'unknown op' });
}

function doPost(e) {
  let payload = {};
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return _json({ error: 'bad json' });
  }
  if (!_checkSecret(payload, null)) return _json({ error: 'forbidden' });
  if (payload.op === 'put') {
    const sh = _sheet();
    const row = _findRow(sh, payload.username);
    const ts = new Date().toISOString();
    const blob = JSON.stringify(payload.snapshot);
    if (row < 0) {
      sh.appendRow([payload.username, ts, blob]);
    } else {
      sh.getRange(row, 2).setValue(ts);
      sh.getRange(row, 3).setValue(blob);
    }
    return _json({ ok: true, updatedAt: ts });
  }
  return _json({ error: 'unknown op' });
}
