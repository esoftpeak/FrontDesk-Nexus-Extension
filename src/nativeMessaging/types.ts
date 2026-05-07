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

// ── RFID Key Card Encoder ─────────────────────────────────────────────────────

/** Outbound to Python: encode a guest key card. */
export type RfidMakeKeyRequest = {
  type: 'RFID_MAKE_KEY'
  room_number: string
  checkin_time: string
  checkout_time: string
  card_serial?: number
  requestId?: string
}

/** Python response: result of HandShake() ping. */
export type RfidHandshakeResult = {
  type: 'RFID_HANDSHAKE_RESULT'
  success: boolean
  connected: boolean
  return_msg: string
  error: string | null
  requestId?: string
}

/** Python response: result of MakeCard() / re-enable. */
export type RfidKeyResult = {
  type: 'RFID_KEY_RESULT'
  success: boolean
  return_msg: string
  error: string | null
  room_number?: string
  card_serial?: number
  requestId?: string
}

/** Python response: result of ReadCardCK(). */
export type RfidReadResult = {
  type: 'RFID_READ_RESULT'
  success: boolean
  return_msg: string
  error: string | null
  card_data?: string
  requestId?: string
}

/** Python response: result of disable (cancel card). */
export type RfidDisableResult = {
  type: 'RFID_DISABLE_RESULT'
  success: boolean
  return_msg: string
  error: string | null
  requestId?: string
}

export type RfidNativeResult =
  | RfidHandshakeResult
  | RfidKeyResult
  | RfidReadResult
  | RfidDisableResult
