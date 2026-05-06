// The sheet's column A combines the prompt with options. We try to split
// them out so the UI can render proper option buttons. Format detection is
// lenient: supports "(A)", "A.", "A、", "A:" etc., and CJK/ASCII letters.

const OPTION_RE =
  /(?:^|\n)\s*[（(\[]?\s*([A-Ha-h１-８])\s*[)）\].、:：\-。\s]\s*([\s\S]*?)(?=(?:\n\s*[（(\[]?\s*[A-Ha-h１-８]\s*[)）\].、:：\-。\s])|$)/g

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

export function parseQuestion(raw) {
  const text = (raw ?? '').replace(/\r\n/g, '\n')
  const matches = []
  let m
  OPTION_RE.lastIndex = 0
  while ((m = OPTION_RE.exec(text))) {
    matches.push({ index: m.index, letter: normalizeLetter(m[1]), body: m[2].trim() })
  }
  if (matches.length < 2) {
    return { prompt: text.trim(), options: [] }
  }
  const prompt = text.slice(0, matches[0].index).trim()
  const options = matches.map((x) => ({ letter: x.letter, text: x.body }))
  return { prompt, options }
}

export function isCorrect(answerKey, selectedLetter) {
  if (!answerKey || !selectedLetter) return false
  return normalizeLetter(answerKey) === normalizeLetter(selectedLetter)
}
