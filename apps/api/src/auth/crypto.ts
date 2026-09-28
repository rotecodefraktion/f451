import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Token-Verschlüsselung (AES-256-GCM) für Provider-Access-/Refresh-Tokens.
 * Schlüssel kommt aus F451_TOKEN_KEY (32 Byte, base64). Tokens dürfen laut
 * Plan (Global Constraints) nie unverschlüsselt in der DB landen und nie in
 * Fehlermeldungen auftauchen — hier werden daher nur Metadaten (Länge,
 * Format), nie der Klartext, in Fehlern erwähnt.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const FORMAT_VERSION = 'v1'
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

function decodeKey(keyB64: string): Buffer {
  if (!BASE64_RE.test(keyB64)) {
    throw new Error('Token-Schlüssel ist kein gültiger base64-String.')
  }
  const key = Buffer.from(keyB64, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Token-Schlüssel muss base64-dekodiert exakt ${KEY_BYTES} Byte lang sein (F451_TOKEN_KEY), erhalten: ${key.length} Byte.`,
    )
  }
  return key
}

/** Verschlüsselt einen Klartext zu `v1:<iv-b64>:<tag-b64>:<ct-b64>`. */
export function encryptToken(plain: string, keyB64: string): string {
  const key = decodeKey(keyB64)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [FORMAT_VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

/** Entschlüsselt einen mit {@link encryptToken} erzeugten String. Wirft bei Manipulation oder falschem Schlüssel. */
export function decryptToken(enc: string, keyB64: string): string {
  const key = decodeKey(keyB64)

  const parts = enc.split(':')
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error(`Ungültiges Token-Format, erwartet "${FORMAT_VERSION}:<iv>:<tag>:<ct>".`)
  }
  const [, ivB64, tagB64, ctB64] = parts

  const iv = Buffer.from(ivB64!, 'base64')
  const tag = Buffer.from(tagB64!, 'base64')
  const ct = Buffer.from(ctB64!, 'base64')

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()])
  return plain.toString('utf8')
}

/** Erzeugt eine kryptographisch zufällige Session-Id (128 bit, base64url). */
export function generateSessionId(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Persönliche API-Tokens (MCP-Phase 0, `db/schema.ts#apiTokens`): eindeutig
 * am Präfix erkennbar (`f451_pat_`) — grenzt sie sowohl optisch als auch
 * programmatisch (`isApiToken`) vom Admin-Bearer-Token (`routes/admin.ts
 * #hasValidAdminToken`, ein beliebiger, operator-konfigurierter Geheimwert
 * OHNE dieses Präfix) ab. Beide Prüfpfade können dadurch kollisionsfrei
 * nebeneinander existieren (siehe `auth/sessions.ts#createSessionAuthHook`).
 */
export const API_TOKEN_PREFIX = 'f451_pat_'

/** 256 bit Zufall, base64url-kodiert hinter dem Präfix — das ist der Klartext, den der Nutzer sich notiert. */
export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** SHA-256-Hash (hex) eines Klartext-API-Tokens — NUR dieser Hash landet in `api_tokens.token_hash`, nie der Klartext. */
export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Erkennt am Präfix, ob ein Bearer-Wert überhaupt ein f451-API-Token sein könnte (vor dem Hash-Lookup). */
export function isApiToken(token: string): boolean {
  return token.startsWith(API_TOKEN_PREFIX)
}
