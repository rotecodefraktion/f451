/**
 * Checker for theme stylesheets (`_meta/theme.css`, f451#61).
 *
 * Not a CSS parser: a single-pass tokenizer with the states normal, comment,
 * string (single/double) and url-body. It skips comments and strings for
 * keyword detection, reads every `url(…)` argument (quoted or not) and decodes
 * CSS escapes (CSS Syntax §4.3.7) — for comparison only, the text itself is
 * never altered except by `rewriteFontUrls`.
 *
 * Rules: no `@import`; `url()` only `data:` or `fonts/<name>.woff2`; none of
 * `expression(`, `behavior:`, `-moz-binding`, `javascript:`. Size is checked by
 * the callers on bytes.
 */

export type StylesheetProblemCode = 'css_import' | 'css_url' | 'css_forbidden'

export interface StylesheetProblem {
  code: StylesheetProblemCode
  line: number
  message: string
}

export interface StylesheetCheck {
  ok: boolean
  problems: StylesheetProblem[]
}

interface UrlRef {
  /** Offset right after the `(`. */
  argStart: number
  /** Offset of the closing `)`, null when the url is not closed cleanly. */
  argEnd: number | null
  /** Font name when the argument is a valid `fonts/<name>.woff2`. */
  font: string | null
}

const isWs = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'

const isNewline = (c: string | undefined): boolean => c === '\n' || c === '\r' || c === '\f'

const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9a-fA-F]$/.test(c)

const isNameChar = (c: string): boolean => /^[a-z0-9_-]$/.test(c) || c.charCodeAt(0) >= 0x80

const lowerAscii = (c: string): string => (c >= 'A' && c <= 'Z' ? c.toLowerCase() : c)

/** `fonts/<name>.woff2` → name; prefix and extension case-insensitive, name strict lower case. */
function fontName(value: string): string | null {
  const m = /^fonts\/(.+)\.woff2$/i.exec(value)
  if (!m) return null
  const name = m[1]!
  return /^[a-z0-9-]{1,40}$/.test(name) ? name : null
}

/** 1-based line of an offset; CR, LF, CRLF and FF each count as one line break. */
function lineIndex(text: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\r' && text[i + 1] === '\n') continue
    if (isNewline(c)) starts.push(i + 1)
  }
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid]! <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** Escape at `i` (text[i] is a backslash not followed by a newline). */
function readEscape(text: string, i: number): { ch: string; next: number } {
  let j = i + 1
  if (j >= text.length) return { ch: '�', next: j }
  let hex = ''
  while (hex.length < 6 && isHex(text[j])) hex += text[j++]
  if (hex) {
    if (text[j] === '\r' && text[j + 1] === '\n') j += 2
    else if (isWs(text[j])) j++
    const cp = parseInt(hex, 16)
    const invalid = cp === 0 || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff
    return { ch: invalid ? '�' : String.fromCodePoint(cp), next: j }
  }
  const ch = String.fromCodePoint(text.codePointAt(j)!)
  return { ch, next: j + ch.length }
}

/** String starting at `i` (text[i] is the quote): decoded value and offset after it. */
function readString(text: string, i: number): { value: string; end: number; closed: boolean } {
  const quote = text[i]
  let value = ''
  let j = i + 1
  while (j < text.length) {
    const c = text[j]!
    if (c === quote) return { value, end: j + 1, closed: true }
    // Unescaped newline: bad string, the newline belongs to the normal state again.
    if (isNewline(c)) return { value, end: j, closed: false }
    if (c === '\\') {
      const next = text[j + 1]
      if (next === undefined) {
        j++
      } else if (isNewline(next)) {
        // Line continuation.
        j += next === '\r' && text[j + 2] === '\n' ? 3 : 2
      } else {
        const e = readEscape(text, j)
        value += e.ch
        j = e.next
      }
      continue
    }
    value += c
    j++
  }
  return { value, end: j, closed: false }
}

function scan(text: string): { problems: StylesheetProblem[]; urls: UrlRef[] } {
  const lineOf = lineIndex(text)
  const problems: StylesheetProblem[] = []
  const urls: UrlRef[] = []
  // Decoded, ASCII-lower-cased text of the normal state; comments and strings
  // are replaced by a single space. `offs` maps each entry back to the source.
  const chars: string[] = []
  const offs: number[] = []
  const n = text.length
  // Open functions of the normal state: inside image-set() a bare string is a URL.
  const parens: ('image-set' | 'other')[] = []

  const report = (code: StylesheetProblemCode, offset: number, message: string): void => {
    problems.push({ code, line: lineOf(offset), message })
  }

  /** Identifier ending the decoded text, whitespace before the current char skipped. */
  const trailingIdent = (): { ident: string; start: number } => {
    let k = chars.length - 1
    while (k >= 0 && isWs(chars[k])) k--
    const end = k
    while (k >= 0 && isNameChar(chars[k]!)) k--
    return { ident: chars.slice(k + 1, end + 1).join(''), start: offs[k + 1] ?? 0 }
  }

  const endsWith = (word: string): boolean => {
    if (chars.length < word.length) return false
    const base = chars.length - word.length
    for (let k = 0; k < word.length; k++) if (chars[base + k] !== word[k]) return false
    return true
  }

  const push = (ch: string, offset: number): void => {
    chars.push(lowerAscii(ch))
    offs.push(offset)
    if (endsWith('@import')) {
      report('css_import', offs[chars.length - 7]!, '@import is not allowed')
    }
    if (endsWith('-moz-binding')) {
      const before = chars[chars.length - 13]
      if (before === undefined || !isNameChar(before)) {
        report('css_forbidden', offs[chars.length - 12]!, '-moz-binding is not allowed')
      }
    }
  }

  const checkUrl = (value: string, bad: boolean, identStart: number): string | null => {
    const v = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '')
    const squashed = v.replace(/[\t\n\r]/g, '').toLowerCase()
    if (squashed.includes('javascript:')) {
      report('css_forbidden', identStart, 'javascript: is not allowed')
      return null
    }
    if (bad) {
      report('css_url', identStart, 'malformed url()')
      return null
    }
    if (squashed.startsWith('data:')) return null
    const font = fontName(v)
    if (font === null) {
      report('css_url', identStart, `url() may only point to data: or fonts/<name>.woff2, found "${v}"`)
    }
    return font
  }

  /** url-body state, `start` right after `(`. Returns the offset to continue from. */
  const readUrl = (start: number, identStart: number): number => {
    let j = start
    while (j < n && isWs(text[j])) j++
    if (text[j] === '"' || text[j] === "'") {
      const s = readString(text, j)
      let k = s.end
      while (k < n && isWs(text[k])) k++
      const closed = s.closed && text[k] === ')'
      const font = checkUrl(s.value, false, identStart)
      urls.push({ argStart: start, argEnd: closed ? k : null, font })
      // Not closed right after the string: the url function stays open in the normal state.
      if (!closed) parens.push('other')
      return closed ? k + 1 : s.end
    }
    let value = ''
    let bad = false
    while (j < n) {
      const c = text[j]!
      if (c === ')') break
      if (isWs(c)) {
        let k = j
        while (k < n && isWs(text[k])) k++
        j = k
        if (k >= n || text[k] === ')') break
        bad = true
        continue
      }
      if (c === '\\') {
        if (isNewline(text[j + 1])) {
          bad = true
          j++
          continue
        }
        const e = readEscape(text, j)
        value += e.ch
        j = e.next
        continue
      }
      const code = c.charCodeAt(0)
      if (c === '"' || c === "'" || c === '(' || code <= 0x08 || code === 0x0b || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
        bad = true
      }
      value += c
      j++
    }
    const font = checkUrl(value, bad, identStart)
    if (j < n) {
      urls.push({ argStart: start, argEnd: j, font })
      return j + 1
    }
    urls.push({ argStart: start, argEnd: null, font })
    return n
  }

  let i = 0
  while (i < n) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      push(' ', i)
      i = close < 0 ? n : close + 2
      continue
    }
    if (c === '"' || c === "'") {
      const s = readString(text, i)
      if (parens[parens.length - 1] === 'image-set') checkUrl(s.value, false, i)
      push(' ', i)
      i = s.end
      continue
    }

    let ch = c
    let next = i + 1
    let escaped = false
    if (c === '\\' && !isNewline(text[i + 1])) {
      const e = readEscape(text, i)
      ch = e.ch
      next = e.next
      escaped = true
    }

    if (ch === '(') {
      const word = trailingIdent()
      if (word.ident === 'expression') report('css_forbidden', word.start, 'expression() is not allowed')
      push(ch, i)
      // Only a literal parenthesis opens a url token; the name may be escaped.
      if (!escaped && word.ident === 'url') {
        i = readUrl(next, word.start)
        push(' ', i)
        continue
      }
      if (!escaped) {
        const imageSet = word.ident === 'image-set' || word.ident === '-webkit-image-set'
        parens.push(imageSet ? 'image-set' : 'other')
      }
    } else if (ch === ')' && !escaped) {
      parens.pop()
      push(ch, i)
    } else if (ch === ':') {
      const word = trailingIdent()
      if (word.ident === 'behavior' || word.ident === '-ms-behavior') {
        report('css_forbidden', word.start, 'behavior is not allowed')
      } else if (word.ident === 'javascript') {
        report('css_forbidden', word.start, 'javascript: is not allowed')
      }
      push(ch, i)
    } else {
      push(ch, i)
    }
    i = next
  }

  return { problems, urls }
}

/** Checks a theme stylesheet against the four rules; each problem names its line. */
export function checkStylesheet(text: string): StylesheetCheck {
  const { problems } = scan(text)
  return { ok: problems.length === 0, problems }
}

/** Distinct font names referenced via a valid `url(fonts/<name>.woff2)`, in order of appearance. */
export function fontRefs(text: string): string[] {
  const names: string[] = []
  for (const u of scan(text).urls) {
    if (u.font !== null && !names.includes(u.font)) names.push(u.font)
  }
  return names
}

const cssString = (s: string): string =>
  `"${s.replace(/["\\\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`

/**
 * Replaces the argument of each valid `url(fonts/<name>.woff2)` with
 * `"<base><name>.woff2"`; all other text stays byte-identical.
 */
export function rewriteFontUrls(text: string, base: string): string {
  let out = ''
  let last = 0
  for (const u of scan(text).urls) {
    if (u.font === null || u.argEnd === null) continue
    out += text.slice(last, u.argStart) + cssString(`${base}${u.font}.woff2`)
    last = u.argEnd
  }
  return out + text.slice(last)
}
