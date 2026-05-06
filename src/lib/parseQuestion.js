// The sheet's column A combines the prompt with options. We try several
// formats so the UI can render proper option buttons.
//
// Supported markers:
//   (A) ... (B) ...     — parens-wrapped letter, can be inline or multiline
//   A. ...  / A、 ...   — letter-then-punct at start of a line
//   Full-width １-８ are mapped to A-H.

const FULLWIDTH_TO_LATIN = {
  '１': 'A',
  '２': 'B',
  '３': 'C',
  '４': 'D',
  '５': 'E',
  '６': 'F',
  '７': 'G',
  '８': 'H',
}

export function normalizeLetter(s) {
  if (!s) return ''
  const c = s.toString().trim().charAt(0)
  if (FULLWIDTH_TO_LATIN[c]) return FULLWIDTH_TO_LATIN[c]
  return c.toUpperCase()
}

// Pattern 1: parens-wrapped letter "(A)" / "（A）" / "[A]"
// Matches anywhere — works for both inline and multiline option layouts.
const PAREN_MARKER = /[（(\[]\s*([A-Ha-h１-８])\s*[)）\]]/g

// Pattern 2: line-leading letter followed by punctuation: "A." "A、" "A:"
const LINE_MARKER = /(?:^|\n)[ \t]*([A-Ha-h１-８])\s*[.、:：。]\s*/g

function extract(text, regex) {
  const out = []
  regex.lastIndex = 0
  let m
  while ((m = regex.exec(text))) {
    out.push({
      start: m.index,
      end: regex.lastIndex,
      letter: normalizeLetter(m[1]),
    })
  }
  return out
}

// Keep matches that form a sensible A,B,C,... sequence (ignoring stray
// "(A)" that may appear inside the prompt body).
function pickSequence(matches) {
  if (matches.length < 2) return []
  // Find the longest run starting from "A" (or first letter) where letters
  // increase by one. We try each possible start so the run can begin partway.
  let best = []
  for (let start = 0; start < matches.length; start++) {
    if (matches[start].letter !== 'A' && start > 0) break
    const run = [matches[start]]
    for (let j = start + 1; j < matches.length; j++) {
      const expected = String.fromCharCode(
        run[run.length - 1].letter.charCodeAt(0) + 1,
      )
      if (matches[j].letter === expected) run.push(matches[j])
      // duplicates / out-of-order: skip without breaking
    }
    if (run.length > best.length) best = run
  }
  return best
}

export function parseQuestion(raw) {
  const text = (raw ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return { prompt: '', options: [] }

  const candidateRegexes = [PAREN_MARKER, LINE_MARKER]
  let chosen = []
  for (const re of candidateRegexes) {
    const all = extract(text, re)
    const seq = pickSequence(all)
    if (seq.length >= 2) {
      chosen = seq
      break
    }
  }
  if (chosen.length < 2) {
    return { prompt: text, options: [] }
  }

  const prompt = text.slice(0, chosen[0].start).trim()
  const options = chosen.map((mm, i) => {
    const start = mm.end
    const next = chosen[i + 1]
    let body = text.slice(start, next ? next.start : text.length)
    body = body.replace(/\s+/g, ' ').trim()
    return { letter: mm.letter, text: body }
  })
  return { prompt, options }
}

export function isCorrect(answerKey, selectedLetter) {
  if (!answerKey || !selectedLetter) return false
  return normalizeLetter(answerKey) === normalizeLetter(selectedLetter)
}
