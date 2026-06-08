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

/**
 * Download the encrypted signature PNG from the `guest-signatures` bucket,
 * decrypt it, and return a `data:image/png;base64,...` data URL.
 *
 * The returned string is accepted directly by pdf-lib's `embedPng()` so you
 * can stamp the guest's signature onto any new PDF without asking them to sign again.
 *
 * Usage:
 *   const pngDataUrl = await fetchSignaturePng(signatureImagePath)
 *   const pngImage   = await pdfDoc.embedPng(pngDataUrl)
 *   page.drawImage(pngImage, { x, y, width, height })
 */
export async function fetchSignaturePng(imagePath: string): Promise<string> {
  const supabase = createExtensionSupabase()
  const { data: urlData, error: urlErr } = await supabase.storage
    .from('guest-signatures')
    .createSignedUrl(imagePath, 3600)
  if (urlErr) throw new Error(urlErr.message)

  const res = await fetch(urlData.signedUrl)
  if (!res.ok) throw new Error(`Signature PNG download failed (HTTP ${res.status})`)

  const buf = await res.arrayBuffer()
  const decrypted = await decryptBinary(new Uint8Array(buf))

  let binary = ''
  for (let i = 0; i < decrypted.length; i++) binary += String.fromCharCode(decrypted[i])
  return `data:image/png;base64,${btoa(binary)}`
}
