import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { chromeLocalStorageAdapter, SUPABASE_AUTH_STORAGE_KEY } from './extension-storage'

export function createExtensionSupabase(): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
  }

  return createClient(url, key, {
    auth: {
      storage: chromeLocalStorageAdapter,
      storageKey: SUPABASE_AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  })
}
