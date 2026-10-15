import { isImagePath, extOf } from './links.js'

/** Resolves a wikilink target (without `#…` and `|…`) to a path of the vault. */
export type WikiResolver = (target: string) => string | null

export interface PrepassResult {
  text: string
  /** Wikilink targets that matched nothing; they became plain text. */
  unresolved: string[]
  /** Embedded attachments that are not in the vault. */
  missing: string[]
}

const FENCE_OPEN = /^([ \t>]*)(`{3,}|~{3,})/
const BLOCK_ID = /^\^[A-Za-z0-9-]+[ \t]*(?=\n|$)/
const SIZE = /^\d+(x\d+)?$/

function escapeText(s: string): string {
  return s.replace(/[\\[\]]/g, '\\$&')
}

/** `<…>` destination: allows spaces; `<`, `>` and `\` are escaped. */
function dest(path: string, anchor: string): string {
  return `</${`${path}${anchor}`.replace(/[<>\\]/g, '\\$&')}>`
}

/** Rewrites Obsidian syntax to CommonMark before parsing: wikilinks and
 *  embeds, `==highlight==`, `%%comments%%` and `^block-ids`. Fenced code and
 *  code spans are copied unchanged. */
export function obsidianPrepass(src: string, resolve: WikiResolver): PrepassResult {
  const unresolved: string[] = []
  const missing: string[] = []

  const wikilink = (inner: string, embed: boolean): string => {
    const bar = /\\?\|/.exec(inner)
    const targetFull = (bar ? inner.slice(0, bar.index) : inner).trim()
    const alias = bar ? inner.slice(bar.index + bar[0].length).trim() : ''
    const hash = targetFull.indexOf('#')
    const target = (hash < 0 ? targetFull : targetFull.slice(0, hash)).trim()
    const fragment = hash < 0 ? '' : targetFull.slice(hash + 1).trim()
    const anchor = fragment && !fragment.startsWith('^') ? `#${fragment}` : ''

    if (!target) return alias || fragment
    const path = resolveTarget(target, resolve)
    if (embed) {
      if (!path) {
        // An embed with a file extension other than `.md` is an attachment.
        const attachment = extOf(target) !== '' && extOf(target) !== 'md'
        ;(attachment ? missing : unresolved).push(target)
        return escapeText(alias && !SIZE.test(alias) ? alias : target)
      }
      if (isImagePath(path)) {
        const alt = alias && !SIZE.test(alias) ? alias : baseOfName(target)
        return `![${escapeText(alt)}](${dest(path, '')})`
      }
      const text = alias && !SIZE.test(alias) ? alias : extOf(path) === 'md' ? target : baseOfName(target)
      return `[${escapeText(text)}](${dest(path, extOf(path) === 'md' ? anchor : '')})`
    }
    const text = alias || (anchor || !fragment ? targetFull : target)
    if (!path) {
      unresolved.push(target)
      return escapeText(text)
    }
    return `[${escapeText(text)}](${dest(path, extOf(path) === 'md' ? anchor : '')})`
  }

  const transform = (s: string, blocks: boolean): string => {
    let out = ''
    let i = 0
    while (i < s.length) {
      const atLineStart = i === 0 || s[i - 1] === '\n'
      if (blocks && atLineStart) {
        const lineEnd = s.indexOf('\n', i)
        const line = s.slice(i, lineEnd < 0 ? s.length : lineEnd)
        const open = FENCE_OPEN.exec(line)
        if (open) {
          const ch = open[2][0]
          const close = new RegExp(`^[ \\t>]*\\${ch}{${open[2].length},}[ \\t]*$`)
          let j = lineEnd < 0 ? s.length : lineEnd + 1
          while (j < s.length) {
            const e = s.indexOf('\n', j)
            const l = s.slice(j, e < 0 ? s.length : e)
            j = e < 0 ? s.length : e + 1
            if (close.test(l)) break
          }
          out += s.slice(i, j)
          i = j
          continue
        }
      }
      const c = s[i]
      if (c === '\\' && i + 1 < s.length) {
        out += s.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        let n = 1
        while (s[i + n] === '`') n++
        const run = '`'.repeat(n)
        // A closing run of exactly the same length ends the span; short spans
        // do not cross a blank line.
        let k = i + n
        let end = -1
        while (k < s.length) {
          const f = s.indexOf(run, k)
          if (f < 0) break
          if (s[f + n] === '`') {
            k = f + n
            while (s[k] === '`') k++
            continue
          }
          end = f
          break
        }
        if (end >= 0 && n < 3 && /\n[ \t]*\n/.test(s.slice(i, end))) end = -1
        if (end < 0) {
          out += run
          i += n
        } else {
          out += s.slice(i, end + n)
          i = end + n
        }
        continue
      }
      if (c === '%' && s[i + 1] === '%') {
        const end = s.indexOf('%%', i + 2)
        i = end < 0 ? s.length : end + 2
        continue
      }
      if (c === '!' && s.startsWith('[[', i + 1)) {
        const end = s.indexOf(']]', i + 3)
        const inner = end < 0 ? '' : s.slice(i + 3, end)
        if (end >= 0 && !inner.includes('\n')) {
          out += wikilink(inner, true)
          i = end + 2
          continue
        }
      }
      if (c === '[' && s[i + 1] === '[') {
        const end = s.indexOf(']]', i + 2)
        const inner = end < 0 ? '' : s.slice(i + 2, end)
        if (end >= 0 && inner && !inner.includes('\n')) {
          out += wikilink(inner, false)
          i = end + 2
          continue
        }
      }
      if (c === '=' && s[i + 1] === '=' && s[i - 1] !== '=' && s[i + 2] !== undefined && !/[=\s]/.test(s[i + 2])) {
        const lineEnd = s.indexOf('\n', i)
        const limit = lineEnd < 0 ? s.length : lineEnd
        let f = s.indexOf('==', i + 2)
        while (f >= 0 && f < limit && (/\s/.test(s[f - 1]) || s[f + 2] === '=')) f = s.indexOf('==', f + 1)
        if (f >= 0 && f < limit) {
          out += `**${transform(s.slice(i + 2, f), false)}**`
          i = f + 2
          continue
        }
      }
      if (c === '^' && (i === 0 || /\s/.test(s[i - 1]))) {
        const m = BLOCK_ID.exec(s.slice(i, s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i)))
        if (m) {
          out = out.replace(/[ \t]+$/, '')
          i += m[0].length
          continue
        }
      }
      out += c
      i++
    }
    return out
  }

  return { text: transform(src, true), unresolved, missing }
}

function baseOfName(target: string): string {
  return target.slice(target.lastIndexOf('/') + 1)
}

/** `[[Note]]` means `Note.md`; `[[file.pdf]]` the file itself. */
function resolveTarget(target: string, resolve: WikiResolver): string | null {
  if (/\.md$/i.test(target)) return resolve(target)
  return resolve(`${target}.md`) ?? resolve(target)
}
