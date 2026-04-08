/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  /** Optional full URL e.g. https://xxx.supabase.co/functions/v1/ocr-id */
  readonly VITE_OCR_FUNCTION_URL?: string
  /** Optional JSON URL returning { minVersion: "1.0.0" } */
  readonly VITE_MIN_EXTENSION_VERSION_CHECK_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
