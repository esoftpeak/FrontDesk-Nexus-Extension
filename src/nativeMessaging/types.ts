import type { ParsedIdFields } from '../shared/pms-types'

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

export type NativeScanSuccessPayload = {
  image_base64: string
  /** Coerced from host message in `runIdScan` (trim + null empty). */
  parsed: ParsedIdFields
}

export type ScanResultOk = {
  ok: true
  result: NativeScanSuccessPayload
}

export type ScanResultErr = {
  ok: false
  error: string
}

export type ScanResult = ScanResultOk | ScanResultErr
