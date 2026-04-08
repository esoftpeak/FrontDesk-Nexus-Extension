/** Supabase Auth custom storage backed by chrome.storage.local (shared by SW + side panel). */
export const SUPABASE_AUTH_STORAGE_KEY = 'fdn_supabase_auth_token'

export const chromeLocalStorageAdapter = {
  getItem: (key: string): Promise<string | null> =>
    new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        const v = result[key]
        resolve(v !== undefined && v !== null ? String(v) : null)
      })
    }),

  setItem: (key: string, value: string): Promise<void> =>
    new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve()
      })
    }),

  removeItem: (key: string): Promise<void> =>
    new Promise((resolve, reject) => {
      chrome.storage.local.remove(key, () => {
        const err = chrome.runtime.lastError
        if (err) reject(new Error(err.message))
        else resolve()
      })
    }),
}
