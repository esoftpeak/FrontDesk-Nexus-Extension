/**
 * Client-side AES-GCM for id_scans.pii_encrypted (MVP).
 * Decryption on web portal may require the same device key or a future Vault-backed flow.
 */
const STORAGE_KEY = 'fdn_pii_aes_key'

async function getOrCreateAesKey(): Promise<CryptoKey> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  let raw: ArrayBuffer
  if (stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === 'string') {
    raw = Uint8Array.from(atob(stored[STORAGE_KEY]), (c) => c.charCodeAt(0)).buffer
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32)).buffer
    const b64 = btoa(String.fromCharCode(...new Uint8Array(raw)))
    await chrome.storage.local.set({ [STORAGE_KEY]: b64 })
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
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
