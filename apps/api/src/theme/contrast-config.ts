import { DEFAULT_THRESHOLDS, type ContrastThresholds } from '@f451/design-tokens'
import { NotFoundError } from '@f451/git-provider'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { instancePseudoSpace, type InstanceThemeDeps, type InstanceThemeLogger } from './instance-theme.js'

/**
 * Contrast thresholds of the instance: `_meta/contrast.yaml` in the instance repo
 * (spec 2026-07-26, chapter "Kontrast", section "Prüfschärfe einstellen"):
 *
 * ```yaml
 * thresholds:
 *   body-text: 4.5    # readingText
 *   ui-text: 3.5      # shortText
 *   incidental: 2.0   # incidental
 *   non-text: 3.0     # nonText
 * note: free text, at most 500 characters
 * ```
 *
 * The file uses the spec's names; the API and `@f451/design-tokens` use the
 * `ContrastThresholds` field names. `FILE_KEY` is the one place that maps them.
 */

/** Path of the thresholds file in the instance repo, next to `_meta/theme.yaml`. */
export const CONTRAST_CONFIG_PATH = '_meta/contrast.yaml'

/** Thresholds are read from and written to the published state. */
export const CONTRAST_CONFIG_REF = 'main'

/** Bounds per role: 1.5 is the limit of mere distinguishability, 7.0 the AAA value (SC 1.4.6). */
export const THRESHOLD_MIN = 1.5
export const THRESHOLD_MAX = 7.0
export const NOTE_MAX_LENGTH = 500

export type ThresholdKey = keyof ContrastThresholds

export const THRESHOLD_KEYS: readonly ThresholdKey[] = ['readingText', 'shortText', 'nonText', 'incidental']

/** Key in `contrast.yaml` per `ContrastThresholds` field. */
export const FILE_KEY: Readonly<Record<ThresholdKey, string>> = {
  readingText: 'body-text',
  shortText: 'ui-text',
  nonText: 'non-text',
  incidental: 'incidental',
}

export type ThresholdInput = Partial<ContrastThresholds>

export interface ContrastProblem {
  code:
    | 'threshold_not_a_number'
    | 'threshold_out_of_range'
    | 'threshold_precision'
    | 'threshold_order'
    | 'key_unknown'
    | 'note_invalid'
    | 'file_invalid'
    | 'file_unreadable'
  /** The offending `ContrastThresholds` field, when the problem is about one. */
  key?: ThresholdKey
  message: string
}

export interface ContrastConfig {
  /** Effective thresholds: the file's values, defaults for keys it does not set. */
  thresholds: ContrastThresholds
  /** `instance` when a valid file is in effect, else `default`. */
  source: 'default' | 'instance'
  note: string | null
  /** What was ignored while reading (shown as a hint next to the thresholds). */
  problems: ContrastProblem[]
}

export type ThresholdCheck = { ok: true; set: ThresholdInput } | { ok: false; problem: ContrastProblem }

/**
 * Strict check of a set of thresholds (spec table "In welchen Grenzen"): each value a
 * finite number in 1.5–7.0 with at most one decimal; the effective values (given or
 * default) keep `readingText ≥ shortText ≥ incidental`. `nonText` has its own anchor and
 * is not ordered. Returns the first problem. Used for writing (422) and for reading
 * (any problem → the whole file is ignored).
 */
export function checkThresholds(values: Readonly<Record<string, unknown>>): ThresholdCheck {
  const set: ThresholdInput = {}
  for (const key of THRESHOLD_KEYS) {
    const value = values[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, problem: { code: 'threshold_not_a_number', key, message: `${key} must be a number.` } }
    }
    if (value < THRESHOLD_MIN || value > THRESHOLD_MAX) {
      return {
        ok: false,
        problem: {
          code: 'threshold_out_of_range',
          key,
          message: `${key} must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX.toFixed(1)}.`,
        },
      }
    }
    if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) {
      return {
        ok: false,
        problem: { code: 'threshold_precision', key, message: `${key} may have at most one decimal place.` },
      }
    }
    set[key] = value
  }

  const effective = { ...DEFAULT_THRESHOLDS, ...set }
  if (effective.shortText > effective.readingText) {
    return {
      ok: false,
      problem: { code: 'threshold_order', key: 'shortText', message: 'shortText must not exceed readingText.' },
    }
  }
  if (effective.incidental > effective.shortText) {
    return {
      ok: false,
      problem: { code: 'threshold_order', key: 'incidental', message: 'incidental must not exceed shortText.' },
    }
  }
  return { ok: true, set }
}

/** YAML text of the thresholds file: only the keys that are set, in role order. */
export function serializeContrastFile(set: ThresholdInput, note: string | null): string {
  const thresholds: Record<string, number> = {}
  for (const key of THRESHOLD_KEYS) {
    const value = set[key]
    if (value !== undefined) thresholds[FILE_KEY[key]] = value
  }
  const doc: Record<string, unknown> = { thresholds }
  if (note) doc.note = note
  return stringifyYaml(doc)
}

/** The state without a (valid) file. A fresh copy, so callers cannot alter the defaults. */
export function defaultContrastConfig(problems: ContrastProblem[] = []): ContrastConfig {
  return { thresholds: { ...DEFAULT_THRESHOLDS }, source: 'default', note: null, problems }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Turns the parsed YAML into a config. Fail-soft per spec ("Grenzfälle"): a broken
 * structure or any invalid threshold ignores the **whole file** — defaults apply, never
 * a guessed mix. Unknown keys and a bad `note` are dropped without discarding the
 * thresholds.
 */
function parseContrastFile(raw: unknown): ContrastConfig {
  const problems: ContrastProblem[] = []
  const root = raw ?? {}
  if (!isPlainObject(root)) {
    return defaultContrastConfig([{ code: 'file_invalid', message: 'contrast.yaml must be a mapping.' }])
  }

  for (const key of Object.keys(root)) {
    if (key !== 'thresholds' && key !== 'note') {
      problems.push({ code: 'key_unknown', message: `Unknown key "${key}" ignored.` })
    }
  }

  const fileThresholds = root.thresholds ?? {}
  if (!isPlainObject(fileThresholds)) {
    return defaultContrastConfig([{ code: 'file_invalid', message: '"thresholds" must be a mapping.' }])
  }

  const values: Record<string, unknown> = {}
  const known = new Set(Object.values(FILE_KEY))
  for (const fileKey of Object.keys(fileThresholds)) {
    if (!known.has(fileKey)) {
      problems.push({ code: 'key_unknown', message: `Unknown threshold "${fileKey}" ignored.` })
    }
  }
  for (const key of THRESHOLD_KEYS) {
    if (FILE_KEY[key] in fileThresholds) values[key] = fileThresholds[FILE_KEY[key]]
  }

  const checked = checkThresholds(values)
  if (!checked.ok) {
    // Report the file's own key name, which is what the operator sees in the repo.
    const problem = checked.problem
    const fileKey = problem.key ? FILE_KEY[problem.key] : undefined
    return defaultContrastConfig([
      {
        ...problem,
        message: `${problem.message}${fileKey ? ` (file key "${fileKey}")` : ''} — whole file ignored, defaults apply.`,
      },
    ])
  }

  let note: string | null = null
  const rawNote = root.note
  if (rawNote !== undefined && rawNote !== null) {
    if (typeof rawNote === 'string' && rawNote.length <= NOTE_MAX_LENGTH) {
      note = rawNote.trim() || null
    } else {
      problems.push({ code: 'note_invalid', message: `"note" must be text of at most ${NOTE_MAX_LENGTH} characters; ignored.` })
    }
  }

  return { thresholds: { ...DEFAULT_THRESHOLDS, ...checked.set }, source: 'instance', note, problems }
}

interface CacheEntry {
  config: ContrastConfig
  expiresAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000

// One instance repo, one file — a single module-global entry (pattern `instance-theme.ts`).
let cache: CacheEntry | undefined

/**
 * Reads `_meta/contrast.yaml` from the instance repo. Never throws:
 *
 *  - no `instanceConfig` → defaults, provider untouched (not cached)
 *  - file missing → defaults, no log (the normal case)
 *  - provider error, broken YAML → defaults plus a warn log
 *  - invalid threshold → whole file ignored, defaults plus a warn log
 *
 * Cached for 5 minutes; `invalidateContrastThresholds` forces a fresh read.
 */
export async function loadContrastConfig(deps: InstanceThemeDeps, log: InstanceThemeLogger): Promise<ContrastConfig> {
  const cfg = deps.instanceConfig
  if (!cfg) return defaultContrastConfig()

  const now = deps.now ?? Date.now
  if (cache && cache.expiresAt > now()) return cache.config

  let config: ContrastConfig
  try {
    if (!deps.providerRegistry) {
      throw new Error('no provider registry configured (F451_SPACES unset)')
    }
    const provider = deps.providerRegistry(instancePseudoSpace(cfg))
    const file = await provider.readFile(cfg.repoRef, CONTRAST_CONFIG_PATH, CONTRAST_CONFIG_REF)
    config = parseContrastFile(parseYaml(file.content))
    if (config.problems.length > 0) {
      log.warn(
        { repo: cfg.repoRef, path: CONTRAST_CONFIG_PATH, problems: config.problems },
        'contrast thresholds: entries ignored (fail-soft)',
      )
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      config = defaultContrastConfig()
    } else {
      log.warn(
        { err, repo: cfg.repoRef, path: CONTRAST_CONFIG_PATH },
        'contrast thresholds: unreadable — defaults apply (fail-soft)',
      )
      config = defaultContrastConfig([
        { code: 'file_unreadable', message: 'contrast.yaml could not be read; defaults apply.' },
      ])
    }
  }

  cache = { config, expiresAt: now() + CACHE_TTL_MS }
  return config
}

/** The effective thresholds of the instance (see `loadContrastConfig`). */
export async function loadContrastThresholds(
  deps: InstanceThemeDeps,
  log: InstanceThemeLogger,
): Promise<ContrastThresholds> {
  return (await loadContrastConfig(deps, log)).thresholds
}

/** Drops the cached thresholds; the next load reads the file again. */
export function invalidateContrastThresholds(): void {
  cache = undefined
}
