import type { IdScanDetailGuru, ParsedIdFields } from '../shared/pms-types'

/** Outbound to Python native host (Chrome → host). */
export type NativeScanRequest = {
  type: 'SCAN_ID'
}

/**
 * ID fields from the Python host: same property names as the side panel (`ParsedIdFields`).
 * Put them in `ocr_data`, or at the top level of `SCAN_RESULT` — both are merged (top-level wins).
 */
export type NativeHostIdPayload = Partial<Record<keyof ParsedIdFields, string | null | undefined>>

/** Inbound success shape (host may add camelCase ID fields at root or under `ocr_data`). */
export type NativeScanResultMessage = {
  type: 'SCAN_RESULT'
  success: true
  image_base64: string
  ocr_data?: NativeHostIdPayload
} & Record<string, unknown>

export type NativeErrorMessage = {
  type: 'ERROR'
  message: string
}

export type NativeScanReply = NativeScanResultMessage | NativeErrorMessage | Record<string, unknown>

/** Front + back ID images (Python sends both after both sides are captured; order of capture may vary). */
export type NativeScanImages = {
  front_image_base64: string
  back_image_base64: string
}

export type NativeScanSuccessPayload = {
  images: NativeScanImages
  /** Coerced from host message (trim + null empty). */
  parsed: ParsedIdFields
  /** Structured Guru-style fields from AUTO_SCAN_RESULT / document_data. */
  detail?: IdScanDetailGuru | null
  /** Optional raw snapshot from Python (AUTO_SCAN_RESULT). */
  documentData?: Record<string, unknown> | null
}
