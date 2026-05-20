import { isCompletePhoneForLookup, normalizePhoneForLookup } from './phone-lookup'

/**
 * Client-side AES-GCM for id_scans.pii_encrypted.
 * Uses VITE_PII_ENCRYPTION_KEY (shared with Web portal) when set.
 * Falls back to a per-device random key stored in chrome.storage.local for
 * backwards compatibility with any records encrypted before the shared key was added.
 */
const STORAGE_KEY = 'fdn_pii_aes_key'
const ENV_KEY_B64: string | undefined = import.meta.env.VITE_PII_ENCRYPTION_KEY

let _cachedKey: CryptoKey | null = null

async function getOrCreateAesKey(): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey
  let raw: ArrayBuffer
  if (ENV_KEY_B64) {
    raw = Uint8Array.from(atob(ENV_KEY_B64), (c) => c.charCodeAt(0)).buffer
  } else {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    if (stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === 'string') {
      raw = Uint8Array.from(atob(stored[STORAGE_KEY]), (c) => c.charCodeAt(0)).buffer
    } else {
      raw = crypto.getRandomValues(new Uint8Array(32)).buffer
      const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)))
      await chrome.storage.local.set({ [STORAGE_KEY]: b64 })
    }
  }
  _cachedKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
  return _cachedKey
}

export type EncryptedPayload = {
  v: 1
  alg: 'AES-256-GCM'
  iv: string
  ciphertext: string
}

/**
 * Encrypts raw bytes with AES-256-GCM.
 * Returns a single Uint8Array: [12-byte IV][ciphertext].
 * Upload this blob directly to Supabase Storage as application/octet-stream.
 */
export async function encryptBinary(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const key = await getOrCreateAesKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  // slice() produces a plain ArrayBuffer (not SharedArrayBuffer), satisfying SubtleCrypto's BufferSource
  const plain = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  const out = new Uint8Array(12 + ciphertext.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ciphertext), 12)
  return out
}

export async function encryptJson(payload: unknown): Promise<EncryptedPayload> {
  const key = await getOrCreateAesKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded,
  )
  return {
    v: 1,
    alg: 'AES-256-GCM',
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  }
}

export async function decryptJson<T = unknown>(payload: EncryptedPayload): Promise<T> {
  const key = await getOrCreateAesKey()
  const iv = Uint8Array.from(atob(payload.iv), (c) => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(payload.ciphertext), (c) => c.charCodeAt(0))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return JSON.parse(new TextDecoder().decode(plain)) as T
}

/** SHA-256 hex of the normalized ID number — used as a privacy-safe lookup key in id_scans. */
export async function hashIdNumber(idNumber: string): Promise<string> {
  const norm = idNumber.replace(/\s+/g, '').toUpperCase()
  const data = new TextEncoder().encode(norm)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** SHA-256 hex of normalized phone digits — lookup key for returning guests by phone. */
export async function hashPhoneNumber(phone: string): Promise<string | null> {
  if (!isCompletePhoneForLookup(phone)) return null
  const norm = normalizePhoneForLookup(phone)
  const data = new TextEncoder().encode(norm)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
