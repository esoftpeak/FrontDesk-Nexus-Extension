/** Guess image MIME from base64-decoded magic bytes (JPEG / PNG / BMP). */
export function guessImageMimeFromBase64(b64: string): 'image/jpeg' | 'image/png' | 'image/bmp' {
  try {
    const raw = atob(b64.slice(0, 32))
    const u = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i)
    if (u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return 'image/jpeg'
    if (u.length >= 4 && u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return 'image/png'
    // BMP magic: 'BM' (0x42 0x4D) — TWAIN scanners return uncompressed BMP
    if (u.length >= 2 && u[0] === 0x42 && u[1] === 0x4d) return 'image/bmp'
  } catch {
    /* invalid base64 */
  }
  return 'image/png'
}
