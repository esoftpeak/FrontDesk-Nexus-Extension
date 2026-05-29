/** Large ID images live in separate storage keys — not inside runtime messages. */
export const FDN_SCAN_IMAGE_FRONT_KEY = 'fdn_scan_image_front' as const
export const FDN_SCAN_IMAGE_BACK_KEY = 'fdn_scan_image_back' as const

export type StoredScanImages = {
  front: string
  back: string | null
}

/** True when both sides have image data (required before OCR auto-fill). */
export function isCompleteTwoSidedScan(
  front: string | null | undefined,
  back: string | null | undefined,
): boolean {
  return Boolean(front?.trim() && back?.trim())
}

export async function writeScanImagesToStorage(
  front: string,
  back: string | null,
): Promise<void> {
  const f = front.trim()
  const b = back?.trim() || null
  if (!f && !b) {
    await clearScanImagesFromStorage()
    return
  }
  if (b) {
    await chrome.storage.local.set({
      [FDN_SCAN_IMAGE_FRONT_KEY]: f,
      [FDN_SCAN_IMAGE_BACK_KEY]: b,
    })
    return
  }
  await chrome.storage.local.set({ [FDN_SCAN_IMAGE_FRONT_KEY]: f })
  await chrome.storage.local.remove(FDN_SCAN_IMAGE_BACK_KEY)
}

export async function readScanImagesFromStorage(): Promise<StoredScanImages | null> {
  const stored = await chrome.storage.local.get([
    FDN_SCAN_IMAGE_FRONT_KEY,
    FDN_SCAN_IMAGE_BACK_KEY,
  ])
  const frontRaw = stored[FDN_SCAN_IMAGE_FRONT_KEY]
  const backRaw = stored[FDN_SCAN_IMAGE_BACK_KEY]
  const front = typeof frontRaw === 'string' ? frontRaw.trim() : ''
  const back = typeof backRaw === 'string' ? backRaw.trim() || null : null
  if (!front && !back) return null
  return { front, back }
}

export async function clearScanImagesFromStorage(): Promise<void> {
  await chrome.storage.local.remove([FDN_SCAN_IMAGE_FRONT_KEY, FDN_SCAN_IMAGE_BACK_KEY])
}

/** Prefer inline message images when present; otherwise read from storage. */
export async function resolveScanImages(
  inline: { front_image_base64?: string; back_image_base64?: string } | undefined,
): Promise<StoredScanImages | null> {
  const inlineFront = inline?.front_image_base64?.trim() ?? ''
  const inlineBack = inline?.back_image_base64?.trim() ?? ''
  if (inlineFront || inlineBack) {
    return { front: inlineFront, back: inlineBack || null }
  }
  return readScanImagesFromStorage()
}
