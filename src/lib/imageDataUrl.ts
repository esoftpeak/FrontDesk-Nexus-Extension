import { guessImageMimeFromBase64 } from './imageMime'

/** Strip data-URL prefix and whitespace from scanner/host payloads. */
export function normalizeScanBase64(b64: string | null | undefined): string {
  if (!b64?.trim()) return ''
  let s = b64.trim()
  const dataUrl = /^data:[^;]+;base64,(.+)$/i.exec(s)
  if (dataUrl?.[1]) s = dataUrl[1]
  return s.replace(/\s+/g, '')
}

export function base64ToDataUrl(b64: string): string {
  const normalized = normalizeScanBase64(b64)
  const mime = guessImageMimeFromBase64(normalized)
  return `data:${mime};base64,${normalized}`
}

/** Blob URLs handle large BMP scans more reliably than huge data: URLs in the side panel. */
export function base64ToBlobUrl(b64: string): string {
  const normalized = normalizeScanBase64(b64)
  if (!normalized) return ''
  const mime = guessImageMimeFromBase64(normalized)
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

export function revokeBlobUrl(url: string | null | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
}
