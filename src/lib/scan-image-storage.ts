import { normalizeScanBase64 } from './imageDataUrl'

/** Large ID images live in separate storage keys — not inside runtime messages. */
export const FDN_SCAN_IMAGE_FRONT_KEY = 'fdn_scan_image_front' as const
export const FDN_SCAN_IMAGE_BACK_KEY = 'fdn_scan_image_back' as const
/** Marks an in-progress two-pass scan so stale complete metadata is not re-applied. */
export const FDN_SCAN_PHASE_KEY = 'fdn_id_scan_phase' as const

export type IdScanPhase = 'front' | 'complete'

export type StoredScanImages = {
  front: string
  back: string | null
}

/** True when both sides have image data (required before OCR auto-fill). */
export function isCompleteTwoSidedScan(
  front: string | null | undefined,
  back: string | null | undefined,
): boolean {
  return Boolean(normalizeScanBase64(front) && normalizeScanBase64(back))
}

export async function writeScanPhase(phase: IdScanPhase): Promise<void> {
  await chrome.storage.local.set({ [FDN_SCAN_PHASE_KEY]: phase })
}

export async function readScanPhase(): Promise<IdScanPhase | null> {
  const stored = await chrome.storage.local.get(FDN_SCAN_PHASE_KEY)
  const v = stored[FDN_SCAN_PHASE_KEY]
  return v === 'front' || v === 'complete' ? v : null
}

export async function writeScanImagesToStorage(
  front: string,
  back: string | null,
): Promise<void> {
  const f = normalizeScanBase64(front)
  const b = back ? normalizeScanBase64(back) : ''
  if (!f && !b) {
    await clearScanImagesFromStorage()
    return
  }
  // Single write — avoids a remove() event that races with panel storage listeners.
  await chrome.storage.local.set({
    [FDN_SCAN_IMAGE_FRONT_KEY]: f,
    [FDN_SCAN_IMAGE_BACK_KEY]: b,
  })
}

export async function readScanImagesFromStorage(): Promise<StoredScanImages | null> {
  const stored = await chrome.storage.local.get([
    FDN_SCAN_IMAGE_FRONT_KEY,
    FDN_SCAN_IMAGE_BACK_KEY,
  ])
  const front = normalizeScanBase64(
    typeof stored[FDN_SCAN_IMAGE_FRONT_KEY] === 'string'
      ? stored[FDN_SCAN_IMAGE_FRONT_KEY]
      : '',
  )
  const back = normalizeScanBase64(
    typeof stored[FDN_SCAN_IMAGE_BACK_KEY] === 'string'
      ? stored[FDN_SCAN_IMAGE_BACK_KEY]
      : '',
  )
  if (!front && !back) return null
  return { front, back: back || null }
}

export async function clearScanImagesFromStorage(): Promise<void> {
  await chrome.storage.local.remove([
    FDN_SCAN_IMAGE_FRONT_KEY,
    FDN_SCAN_IMAGE_BACK_KEY,
    FDN_SCAN_PHASE_KEY,
  ])
}

/** Prefer inline message images when present; otherwise read from storage. */
export async function resolveScanImages(
  inline: { front_image_base64?: string; back_image_base64?: string } | undefined,
): Promise<StoredScanImages | null> {
  const inlineFront = normalizeScanBase64(inline?.front_image_base64)
  const inlineBack = normalizeScanBase64(inline?.back_image_base64)
  if (inlineFront || inlineBack) {
    return { front: inlineFront, back: inlineBack || null }
  }
  return readScanImagesFromStorage()
}
