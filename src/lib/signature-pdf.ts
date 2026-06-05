import { decryptBinary } from './encryption'
import { createExtensionSupabase } from './supabase-factory'

/** Download encrypted PDF from storage, decrypt, return application/pdf blob. */
export async function fetchDecryptSignaturePdf(storagePath: string): Promise<Blob> {
  const supabase = createExtensionSupabase()
  const { data: urlData, error: urlErr } = await supabase.storage
    .from('signature-pdfs')
    .createSignedUrl(storagePath, 3600)
  if (urlErr) throw new Error(urlErr.message)

  const res = await fetch(urlData.signedUrl)
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)

  const buf = await res.arrayBuffer()
  const decrypted = await decryptBinary(new Uint8Array(buf))
  const ab = new Uint8Array(decrypted).buffer
  return new Blob([ab], { type: 'application/pdf' })
}
