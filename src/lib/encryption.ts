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
