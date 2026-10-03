import { eq } from 'drizzle-orm'
import { parseThemeFile, type ParsedTheme } from '@f451/design-tokens'
import type { Db } from '../db/client.js'
import { userSettings } from '../db/schema.js'

/**
 * Personal theme (theming addendum §2): one `user_settings` row per user, the
 * normalised theme file in `theme`. Same validation as a space file; `use` is
 * allowed, a favicon is not (a user theme has no brand at all — the write route
 * drops the block before parsing).
 */

/** The parser for a user theme file, as stored or as sent. */
export function parseUserTheme(input: unknown): ParsedTheme {
  return parseThemeFile(input, 'user', { allowUse: true, allowFavicon: false })
}

/**
 * The parsed theme of `userId`, or `null` without a row. One primary-key read,
 * no cache — the user layer is read per request (addendum §1 "Cache").
 */
export async function loadUserTheme(db: Db, userId: string): Promise<ParsedTheme | null> {
  const rows = await db
    .select({ theme: userSettings.theme })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
  const row = rows[0]
  return row ? parseUserTheme(row.theme) : null
}
