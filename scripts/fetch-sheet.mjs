// Fetches the Google Sheet (3 worksheets) and writes a flat JSON
// of questions to public/data/questions.json.
//
// Sheet must be set to "Anyone with the link can view".
// Build runs at deploy time (GitHub Actions / `npm run build`).

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const SHEET_ID = process.env.SHEET_ID ?? '1usFOv65YmnxXbilHyBFTkmmKrgP_e4opfqk3vUviUOg'

// Some Google endpoints return 400 for bare/empty User-Agents (common on CI runners).
const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,text/csv,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
}

// Manual override: SHEET_GIDS="0,123456,789" (optionally "gid:Name,gid:Name,...")
function parseGidOverride(spec) {
  if (!spec) return null
  const out = []
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [g, n] = part.split(':')
    if (!/^\d+$/.test(g)) continue
    out.push({ gid: g, name: (n || `Sheet ${out.length + 1}`).trim() })
  }
  return out.length ? out : null
}

function decodeUnicode(s) {
  return (s || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  )
}

async function fetchHtml(sheetId) {
  // Try several public-friendly endpoints in order. /htmlview works for
  // "anyone with link can view" sheets without redirecting to login.
  const candidates = [
    `https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/preview`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/edit`,
  ]
  let lastStatus = 0
  for (const url of candidates) {
    const res = await fetch(url, { redirect: 'follow', headers: FETCH_HEADERS })
    lastStatus = res.status
    if (res.ok) {
      const html = await res.text()
      return { url, html }
    }
    console.warn(`  ${url} -> ${res.status}`)
  }
  throw new Error(
    `Failed to load sheet HTML (last status ${lastStatus}). ` +
      `Make sure the sheet is "Anyone with the link can view".`,
  )
}

async function discoverGids(sheetId) {
  const override = parseGidOverride(process.env.SHEET_GIDS)
  if (override) {
    console.log(`Using SHEET_GIDS override: ${override.map((s) => s.gid).join(',')}`)
    return override
  }

  const { url, html } = await fetchHtml(sheetId)
  console.log(`Loaded HTML from ${url} (${html.length} bytes)`)

  // Try several patterns. Google rotates the bootstrap shape, so be lenient.
  const namesByGid = new Map()
  const namePatterns = [
    /\{"name":"([^"\\]*(?:\\.[^"\\]*)*)","label":"[^"]*","sheetType":[^,]+,"gid":(\d+)/g,
    /"name":"([^"\\]*(?:\\.[^"\\]*)*)"[^{}]{0,200}?"gid":(\d+)/g,
    /"title":"([^"\\]*(?:\\.[^"\\]*)*)"[^{}]{0,200}?"sheetId":(\d+)/g,
    // /htmlview tab labels: <li id="sheet-button-NNN"><a ... >Name</a></li>
    /id="sheet-button-(\d+)"[^>]*>\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/g,
  ]
  for (const re of namePatterns) {
    let m
    while ((m = re.exec(html))) {
      // The id="sheet-button-..." pattern has gid first; others have name first.
      const isIdFirst = re.source.startsWith('id="sheet-button-')
      const gid = isIdFirst ? m[1] : m[2]
      const name = isIdFirst ? m[2] : m[1]
      if (!namesByGid.has(gid)) namesByGid.set(gid, decodeUnicode(name))
    }
  }

  // Also collect any gid that appears as a query string anywhere — helps
  // when name patterns miss but tab links exist.
  const allGids = new Set(namesByGid.keys())
  const looseRe = /[?&#]gid=(\d+)|"gid":(\d+)|"sheetId":(\d+)/g
  let m
  while ((m = looseRe.exec(html))) {
    const gid = m[1] || m[2] || m[3]
    if (gid) allGids.add(gid)
  }

  const sheets = [...allGids].map((gid, i) => ({
    name: namesByGid.get(gid) ?? `Sheet ${i + 1}`,
    gid,
  }))

  if (sheets.length === 0) {
    throw new Error(
      'Could not discover any worksheet gids. Set SHEET_GIDS="gid1,gid2,..." ' +
        'env var to override (find each gid in the URL bar when you click the tab).',
    )
  }
  return sheets
}

// Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF).
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
    } else {
      if (c === '"') {
        inQuotes = true
      } else if (c === ',') {
        row.push(field)
        field = ''
      } else if (c === '\n') {
        row.push(field)
        rows.push(row)
        row = []
        field = ''
      } else if (c === '\r') {
        // skip
      } else {
        field += c
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}


function looksLikeHeader(row) {
  if (row.length < 2) return false
  const a = (row[0] || '').trim().toLowerCase()
  const b = (row[1] || '').trim().toLowerCase()
  return /題|question|q\b/.test(a) && /答|answer|a\b/.test(b)
}

async function fetchSheetCsv(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`
  const res = await fetch(url, { redirect: 'follow', headers: FETCH_HEADERS })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`gid=${gid} HTTP ${res.status} ${body.slice(0, 120)}`)
  }
  return res.text()
}

async function main() {
  console.log(`Fetching sheet ${SHEET_ID}...`)
  const candidates = await discoverGids(SHEET_ID)
  console.log(`Candidate worksheet(s): ${candidates.length}`)
  for (const s of candidates) console.log(`  - gid=${s.gid} name="${s.name}"`)

  // Validate each candidate by attempting to fetch it; skip ones that 400
  // (deleted tabs, hidden internal sheets) or come back empty.
  const sheets = []
  for (const s of candidates) {
    try {
      const csv = await fetchSheetCsv(SHEET_ID, s.gid)
      if (csv && csv.replace(/\s+/g, '').length > 0) {
        sheets.push({ ...s, csv })
      } else {
        console.log(`  skip gid=${s.gid}: empty`)
      }
    } catch (err) {
      console.log(`  skip gid=${s.gid}: ${err.message}`)
    }
  }
  if (!sheets.length) {
    throw new Error(
      'No worksheet was fetchable. Confirm "Anyone with the link can view" ' +
        'is set, or set SHEET_GIDS="gid1,gid2,..." manually.',
    )
  }
  console.log(`Using ${sheets.length} worksheet(s)`)

  const questions = []
  let serial = 0
  for (const sheet of sheets) {
    const rows = parseCsv(sheet.csv)
    let started = false
    for (const row of rows) {
      const a = (row[0] ?? '').trim()
      const b = (row[1] ?? '').trim()
      if (!a && !b) continue
      if (!started && looksLikeHeader(row)) {
        started = true
        continue
      }
      started = true
      if (!a || !b) continue
      questions.push({
        id: `s${sheet.gid}-${serial++}`,
        sheet: sheet.name,
        gid: sheet.gid,
        prompt: a,
        answer: b,
      })
    }
    console.log(`  ${sheet.name} (gid=${sheet.gid}): now ${questions.length} questions total`)
  }

  const outPath = 'public/data/questions.json'
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(
    outPath,
    JSON.stringify(
      {
        sheetId: SHEET_ID,
        fetchedAt: new Date().toISOString(),
        sheets: sheets.map((s) => ({ name: s.name, gid: s.gid })),
        count: questions.length,
        questions,
      },
      null,
      0,
    ),
  )
  console.log(`Wrote ${questions.length} questions to ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
