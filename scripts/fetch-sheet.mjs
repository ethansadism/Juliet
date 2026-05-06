// Fetches the Google Sheet (3 worksheets) and writes a flat JSON
// of questions to public/data/questions.json.
//
// Sheet must be set to "Anyone with the link can view".
// Build runs at deploy time (GitHub Actions / `npm run build`).

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const SHEET_ID = process.env.SHEET_ID ?? '1usFOv65YmnxXbilHyBFTkmmKrgP_e4opfqk3vUviUOg'

// The first tab is always gid=0. Other tabs we discover by scraping the
// spreadsheet's HTML page (works for "anyone with link" sheets without an API key).
async function discoverGids(sheetId) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Failed to load sheet HTML: ${res.status}`)
  const html = await res.text()

  // Each sheet appears in the bootstrap blob as {"name":"...","gid":NNN,...}
  // We extract unique pairs preserving order.
  const seen = new Set()
  const sheets = []
  const re = /\{"name":"([^"\\]*(?:\\.[^"\\]*)*)","label":"[^"]*","sheetType":[^,]+,"gid":(\d+)/g
  let m
  while ((m = re.exec(html))) {
    const name = m[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    const gid = m[2]
    if (seen.has(gid)) continue
    seen.add(gid)
    sheets.push({ name, gid })
  }
  if (sheets.length === 0) {
    // Fallback: just use gid=0
    sheets.push({ name: 'Sheet1', gid: '0' })
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

async function fetchSheetCsv(sheetId, gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Failed to fetch gid=${gid}: ${res.status}`)
  return res.text()
}

function looksLikeHeader(row) {
  if (row.length < 2) return false
  const a = (row[0] || '').trim().toLowerCase()
  const b = (row[1] || '').trim().toLowerCase()
  return /題|question|q\b/.test(a) && /答|answer|a\b/.test(b)
}

async function main() {
  console.log(`Fetching sheet ${SHEET_ID}...`)
  const sheets = await discoverGids(SHEET_ID)
  console.log(`Discovered ${sheets.length} worksheet(s):`, sheets)

  const questions = []
  let serial = 0
  for (const sheet of sheets) {
    const csv = await fetchSheetCsv(SHEET_ID, sheet.gid)
    const rows = parseCsv(csv)
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
