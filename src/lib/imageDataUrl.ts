import { guessImageMimeFromBase64 } from './imageMime'

export function base64ToDataUrl(b64: string): string {
  const mime = guessImageMimeFromBase64(b64)
  return `data:${mime};base64,${b64}`
}
