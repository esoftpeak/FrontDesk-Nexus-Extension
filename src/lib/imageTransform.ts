import { guessImageMimeFromBase64 } from './imageMime'

/**
 * Apply rotation (degrees, clockwise) and horizontal flip to a raster image; returns raw base64 (no data URL prefix).
 */
export function transformBase64ImageSync(
  base64: string,
  rotationDeg: number,
  flipHorizontal: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const mime = guessImageMimeFromBase64(base64)
    const url = `data:${mime};base64,${base64}`
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const rad = (rotationDeg * Math.PI) / 180
        const w = img.naturalWidth
        const h = img.naturalHeight
        const cos = Math.abs(Math.cos(rad))
        const sin = Math.abs(Math.sin(rad))
        const nw = w * cos + h * sin
        const nh = w * sin + h * cos
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(nw))
        canvas.height = Math.max(1, Math.round(nh))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Canvas 2D context unavailable'))
          return
        }
        ctx.translate(canvas.width / 2, canvas.height / 2)
        ctx.rotate(rad)
        if (flipHorizontal) ctx.scale(-1, 1)
        ctx.drawImage(img, -w / 2, -h / 2)
        const out = canvas.toDataURL('image/jpeg', 0.92)
        const i = out.indexOf(',')
        resolve(i >= 0 ? out.slice(i + 1) : base64)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    img.onerror = () => reject(new Error('Failed to decode image for transform'))
    img.src = url
  })
}
