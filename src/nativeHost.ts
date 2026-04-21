/**
 * Single native messaging connection to com.frontdesk.nexus (MV3 service worker).
 * Connect on init; reconnect on disconnect with backoff. No UI / button required.
 */
import { idGuruDetailFromAutoScan, mergeParsedWithGuru } from './lib/id-guru-fields'
import { NATIVE_HOST_NAME, type NativeHostRxDebugBroadcast } from './shared/protocol'
import type { IdScanDetailGuru, ParsedIdFields } from './shared/pms-types'
import { parsedFieldsFromHost } from './nativeMessaging/scanId'
import type { NativeScanSuccessPayload } from './nativeMessaging/types'

const LOG = '[nativeHost]'

/**
 * Read immediately after a chrome.runtime API call — lastError is cleared on the next async tick.
 * Exported for ping / diagnostics (e.g. `native-scan.ts`).
 */
export function describeRuntimeLastError(): string {
  const le = chrome.runtime.lastError
  if (le == null) {
    return '(no chrome.runtime.lastError — cleared or not set for this call)'
  }
  const msg = typeof le.message === 'string' ? le.message : ''
  if (msg) return msg
  try {
    return JSON.stringify(le)
  } catch {
    return String(le)
  }
}

/** Structured detail for DevTools (expand object in console). */
export function runtimeLastErrorDetail(): { message?: string; raw?: string } {
  const le = chrome.runtime.lastError
  if (le == null) return {}
  const message = typeof le.message === 'string' ? le.message : undefined
  let raw: string | undefined
  try {
    raw = JSON.stringify(le)
  } catch {
    raw = String(le)
  }
  return { message, raw }
}

export function describeUnknownError(e: unknown): { name?: string; message: string; stack?: string } {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack }
  }
  if (typeof e === 'string') return { message: e }
  try {
    return { message: JSON.stringify(e) }
  } catch {
    return { message: String(e) }
  }
}

let nativePort: chrome.runtime.Port | null = null
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 60_000

function summarizeBase64ForConsole(b64: string): { characterLength: number; approxDecodedBytes: number } {
  const len = b64.length
  const approxDecoded = Math.floor((len * 3) / 4)
  return {
    characterLength: len,
    approxDecodedBytes: approxDecoded,
  }
}

function shouldRedactStringKeyAsLikelyImageB64(key: string): boolean {
  const s = key.toLowerCase()
  return s.includes('base64') || s.endsWith('b64')
}

function isProbablyRawBase64String(s: string): boolean {
  if (s.length < 400) return false
  const head = s.slice(0, 120).replace(/\s/g, '')
  return /^[A-Za-z0-9+/]+=*$/.test(head)
}

/** Deep-clone-ish plain JSON objects and replace image-sized base64 strings (never log raw pixels). */
function redactImageBase64Deep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactImageBase64Deep)
  const o = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string') {
      const byKey = shouldRedactStringKeyAsLikelyImageB64(k)
      const byShape = (k === 'front' || k === 'back') && isProbablyRawBase64String(v)
      if (byKey || byShape) out[k] = summarizeBase64ForConsole(v)
      else out[k] = v
    } else if (v !== null && typeof v === 'object') {
      out[k] = redactImageBase64Deep(v)
    } else {
      out[k] = v
    }
  }
  return out
}

/** Safe JSON for nested objects (avoids circular refs). */
function tryJson(value: unknown, maxLen = 50_000): string {
  try {
    const s = JSON.stringify(value, null, 2)
    if (s.length > maxLen) return `${s.slice(0, maxLen)}\n…(truncated, ${s.length} chars total)`
    return s
  } catch {
    return String(value)
  }
}

/**
 * Read candidate front / rear (back) base64 from one object (AUTO_SCAN_RESULT root, `images`, `document_data`, …).
 * Matches Python host + Thales-style keys: canonical `image_*_base64` plus SDK `visible_image_*` / `visible_image_rear_base64`.
 */
function extractSidesFromRecord(rec: Record<string, unknown>): { f: string | null; b: string | null } {
  const f =
    stringOrNull(rec.image_front_base64) ??
    stringOrNull(rec.imageFrontBase64) ??
    stringOrNull(rec.front_image_base64) ??
    stringOrNull(rec.visible_image_front_base64) ??
    stringOrNull(rec.visibleImageFrontBase64) ??
    stringOrNull(rec.front)
  const b =
    stringOrNull(rec.image_back_base64) ??
    stringOrNull(rec.imageBackBase64) ??
    stringOrNull(rec.back_image_base64) ??
    stringOrNull(rec.visible_image_rear_base64) ??
    stringOrNull(rec.visibleImageRearBase64) ??
    stringOrNull(rec.visible_image_back_base64) ??
    stringOrNull(rec.visibleImageBackBase64) ??
    stringOrNull(rec.back)
  return { f, b }
}

function distinctImagePair(f: string | null, b: string | null): { front: string; back: string } | null {
  if (!f || !b) return null
  if (f === b) return null
  return { front: f, back: b }
}

function distinctPairFromStringArray(arr: unknown[]): { front: string; back: string } | null {
  if (arr.length < 2) return null
  return distinctImagePair(stringOrNull(arr[0]), stringOrNull(arr[1]))
}

function tryImagesNestedObject(nested: Record<string, unknown>): { front: string; back: string } | null {
  const { f, b } = extractSidesFromRecord(nested)
  return distinctImagePair(f, b)
}

function tryDocumentDataImages(doc: Record<string, unknown>): { front: string; back: string } | null {
  const sides = extractSidesFromRecord(doc)
  let p = distinctImagePair(sides.f, sides.b)
  if (p) return p
  const inner = doc.images
  if (inner != null && typeof inner === 'object') {
    if (Array.isArray(inner)) return distinctPairFromStringArray(inner as unknown[])
    return tryImagesNestedObject(inner as Record<string, unknown>)
  }
  return null
}

/**
 * Extract front + back images from `AUTO_SCAN_RESULT`.
 *
 * **Primary (Python contract):** `image_front_base64` and `image_back_base64` — both non-empty strings
 * and **not identical** (see also SDK aliases in `extractSidesFromRecord`).
 *
 * **Fallback order:**
 * 1. Distinct pair from root (canonical + `visible_image_*` / `visible_image_rear_base64`, …).
 * 2. Distinct pair from nested `images`, `document_data` (incl. `document_data.images`), `captured_images`.
 * 3. If root front & rear strings are **identical**, use legacy **`image_base64`** for both panels (same image twice).
 * 4. Else legacy `image_base64` alone (single raster).
 * 5. Else duplicate root pair or single side (last resort).
 */
export function extractIdCardImages(raw: Record<string, unknown>): { front: string; back: string } | null {
  const legacy = stringOrNull(raw.image_base64)
  const root = extractSidesFromRecord(raw)

  let p = distinctImagePair(root.f, root.b)
  if (p) return p

  const nested = raw.images
  if (nested != null && typeof nested === 'object') {
    if (Array.isArray(nested)) {
      p = distinctPairFromStringArray(nested as unknown[])
      if (p) return p
    } else {
      p = tryImagesNestedObject(nested as Record<string, unknown>)
      if (p) return p
    }
  }

  const doc = raw.document_data
  if (doc != null && typeof doc === 'object' && !Array.isArray(doc)) {
    p = tryDocumentDataImages(doc as Record<string, unknown>)
    if (p) return p
  }

  const captured = raw.captured_images
  if (Array.isArray(captured)) {
    p = distinctPairFromStringArray(captured)
    if (p) return p
  }

  if (root.f && root.b && root.f === root.b && legacy) {
    return { front: legacy, back: legacy }
  }

  if (legacy) return { front: legacy, back: legacy }

  if (root.f && root.b) return { front: root.f, back: root.b }
  if (root.f || root.b) {
    const one = root.f ?? root.b!
    return { front: one, back: one }
  }

  return null
}

/** Lengths from primary root keys (canonical + SDK aliases) — use to verify SDK returned non-empty, distinct front vs rear. */
function logAutoScanPrimaryImageStats(raw: Record<string, unknown>): void {
  const root = extractSidesFromRecord(raw)
  const xf = root.f?.length ?? 0
  const xb = root.b?.length ?? 0
  const identical = root.f != null && root.b != null && root.f === root.b
  console.info(`${LOG} Image fetch: front_b64_chars=${xf} rear_b64_chars=${xb} identical=${identical}`)
}

/** DevTools: log inbound message with image/base64 fields replaced by length stats only. */
function logInboundFromPython(label: string, raw: Record<string, unknown>): void {
  const type = raw.type
  const keys = Object.keys(raw)
  const rawForConsole = redactImageBase64Deep(raw) as Record<string, unknown>
  console.log(`${LOG} ← Python native host [${label}]`, {
    type,
    keys,
    rawForConsole,
  })
}

/** Inbound from host when Thales/SDK pushes a completed scan (flexible image keys). */
export type AutoScanResultMessage = {
  type: 'AUTO_SCAN_RESULT'
  document_data?: Record<string, unknown>
  first_name?: string
  last_name?: string
  document_number?: string
  date_of_birth?: string
  document_type?: string
  expiry_date?: string
  issue_date?: string
  address?: string
} & Record<string, unknown>

export type AutoScanFlatFields = {
  first_name?: string
  last_name?: string
  document_number?: string
  date_of_birth?: string
  document_type?: string
  expiry_date?: string
  issue_date?: string
  address?: string
}

/** Extended payload for listeners that want document_data + flat SDK fields. */
export type NativeHostAutoScanPayload = {
  images: { front: string; back: string }
  document_data: Record<string, unknown>
  flat: AutoScanFlatFields
  parsed: ParsedIdFields
  detail: IdScanDetailGuru
}

export type NativeHostScanCallback = (payload: NativeScanSuccessPayload) => void | Promise<void>

export type NativeHostPanelDebugFn = (payload: NativeHostRxDebugBroadcast) => void

function documentDataPreviewForPanel(doc: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v === 'string') {
      if (shouldRedactStringKeyAsLikelyImageB64(k) || isProbablyRawBase64String(v)) {
        out[k] = JSON.stringify(summarizeBase64ForConsole(v))
        continue
      }
      out[k] = v.length > 240 ? `${v.slice(0, 240)}…` : v
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v)
    } else if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      try {
        const s = JSON.stringify(v)
        out[k] = s.length > 200 ? `${s.slice(0, 200)}…` : s
      } catch {
        out[k] = '[object]'
      }
    }
  }
  return out
}

function parsedFieldsPreview(parsed: ParsedIdFields): Record<string, string | null> {
  return {
    fullName: parsed.fullName,
    dateOfBirth: parsed.dateOfBirth,
    idNumber: parsed.idNumber,
    idType: parsed.idType,
    issueDate: parsed.issueDate,
    expiryDate: parsed.expiryDate,
    address: parsed.address,
  }
}

function emitNativePanelDebug(
  onPanelDebug: NativeHostPanelDebugFn | undefined,
  payload: NativeHostRxDebugBroadcast,
) {
  try {
    onPanelDebug?.(payload)
  } catch {
    /* ignore */
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function stringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

function docPick(doc: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = stringOrNull(doc[k])
    if (v) return v
  }
  return null
}

/**
 * Map AUTO_SCAN_RESULT + document_data + flat SDK fields → ParsedIdFields (camelCase).
 */
export function autoScanResultToParsed(msg: AutoScanResultMessage): ParsedIdFields {
  const doc = (msg.document_data ?? {}) as Record<string, unknown>

  const first =
    docPick(doc, 'first_name', 'firstName') ?? stringOrNull(msg.first_name)
  const last = docPick(doc, 'last_name', 'lastName') ?? stringOrNull(msg.last_name)
  let fullName: string | null = null
  if (first && last) fullName = `${last}, ${first}`
  else fullName = first ?? last ?? docPick(doc, 'full_name', 'fullName')

  return {
    fullName,
    dateOfBirth:
      docPick(doc, 'date_of_birth', 'dateOfBirth', 'dob') ?? stringOrNull(msg.date_of_birth),
    idNumber:
      docPick(doc, 'document_number', 'id_number', 'idNumber') ?? stringOrNull(msg.document_number),
    idType: docPick(doc, 'document_type', 'idType') ?? stringOrNull(msg.document_type),
    issueDate: docPick(doc, 'issue_date', 'issueDate') ?? stringOrNull(msg.issue_date),
    expiryDate: docPick(doc, 'expiry_date', 'expiryDate') ?? stringOrNull(msg.expiry_date),
    address: docPick(doc, 'address', 'address_line') ?? stringOrNull(msg.address),
  }
}

function flattenAutoScanFields(msg: AutoScanResultMessage): AutoScanFlatFields {
  const doc = (msg.document_data ?? {}) as Record<string, unknown>
  return {
    first_name: docPick(doc, 'first_name') ?? stringOrNull(msg.first_name) ?? undefined,
    last_name: docPick(doc, 'last_name') ?? stringOrNull(msg.last_name) ?? undefined,
    document_number: docPick(doc, 'document_number') ?? stringOrNull(msg.document_number) ?? undefined,
    date_of_birth: docPick(doc, 'date_of_birth') ?? stringOrNull(msg.date_of_birth) ?? undefined,
    document_type: docPick(doc, 'document_type') ?? stringOrNull(msg.document_type) ?? undefined,
    expiry_date: docPick(doc, 'expiry_date') ?? stringOrNull(msg.expiry_date) ?? undefined,
    issue_date: docPick(doc, 'issue_date') ?? stringOrNull(msg.issue_date) ?? undefined,
    address: docPick(doc, 'address') ?? stringOrNull(msg.address) ?? undefined,
  }
}

function isAutoScanResult(msg: Record<string, unknown>): msg is AutoScanResultMessage {
  return msg.type === 'AUTO_SCAN_RESULT' && extractIdCardImages(msg) != null
}

function isScanResultLegacy(msg: Record<string, unknown>): boolean {
  return msg.type === 'SCAN_RESULT' && msg.success === true && typeof msg.image_base64 === 'string'
}

function scheduleReconnect(connectFn: () => void) {
  if (reconnectTimer != null) clearTimeout(reconnectTimer)
  const exp = Math.min(MIN_BACKOFF_MS * 2 ** reconnectAttempt, MAX_BACKOFF_MS)
  reconnectAttempt += 1
  console.warn(`${LOG} scheduling reconnect`, {
    delayMs: exp,
    attempt: reconnectAttempt,
    host: NATIVE_HOST_NAME,
  })
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectFn()
  }, exp)
}

/**
 * Connect once on extension startup. Listens for AUTO_SCAN_RESULT (and legacy SCAN_RESULT).
 * Does not postMessage on connect (minimal); add commands here if needed.
 */
export function initNativeHost(
  onScan: NativeHostScanCallback,
  onPanelDebug?: NativeHostPanelDebugFn,
): void {
  const connect = () => {
    if (nativePort != null) {
      try {
        nativePort.disconnect()
      } catch {
        /* ignore */
      }
      nativePort = null
    }

    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    } catch (e) {
      const lastErr = runtimeLastErrorDetail()
      const thrown = describeUnknownError(e)
      console.error(`${LOG} connectNative threw — host will not run until fixed`, {
        host: NATIVE_HOST_NAME,
        lastErrorMessage: lastErr.message || describeRuntimeLastError(),
        lastErrorDetail: lastErr,
        thrown,
      })
      scheduleReconnect(connect)
      return
    }

    const syncLastErrorAfterConnect = runtimeLastErrorDetail()
    if (syncLastErrorAfterConnect.message || syncLastErrorAfterConnect.raw) {
      console.error(`${LOG} connectNative returned but chrome.runtime.lastError was set`, {
        host: NATIVE_HOST_NAME,
        ...syncLastErrorAfterConnect,
        hint: 'Registry/path typo, missing native host manifest, or host exe failed to start.',
      })
    }

    nativePort = port
    reconnectAttempt = 0
    const portName = port.name
    console.log(`${LOG} connected`, {
      host: NATIVE_HOST_NAME,
      portName,
    })

    port.onMessage.addListener((raw: unknown) => {
      const rxAt = new Date().toISOString()
      if (!isRecord(raw)) {
        console.log(`${LOG} ← Python onMessage (non-object payload):`, raw)
        emitNativePanelDebug(onPanelDebug, {
          type: 'FDN_NATIVE_HOST_RX',
          receivedAt: rxAt,
          source: 'other',
          topLevelKeys: [],
          documentDataKeys: [],
          errorMessage: typeof raw === 'string' ? raw : `non-object: ${String(raw)}`,
        })
        return
      }

      console.log(`${LOG} ← Python onMessage summary`, {
        type: raw.type,
        keys: Object.keys(raw),
      })

      if (raw.type === 'ERROR' && typeof raw.message === 'string') {
        logInboundFromPython('ERROR', raw)
        console.log(`${LOG} host ERROR text:`, raw.message)
        console.log(`${LOG} host ERROR full object:`, tryJson(redactImageBase64Deep(raw)))
        emitNativePanelDebug(onPanelDebug, {
          type: 'FDN_NATIVE_HOST_RX',
          receivedAt: rxAt,
          source: 'ERROR',
          topLevelKeys: Object.keys(raw),
          documentDataKeys: [],
          errorMessage: raw.message,
        })
        return
      }

      if (isAutoScanResult(raw)) {
        logInboundFromPython('AUTO_SCAN_RESULT', raw)
        console.log(`${LOG} AUTO_SCAN_RESULT top-level text fields`, {
          first_name: raw.first_name,
          last_name: raw.last_name,
          document_number: raw.document_number,
          date_of_birth: raw.date_of_birth,
          document_type: raw.document_type,
          expiry_date: raw.expiry_date,
          issue_date: raw.issue_date,
          address: raw.address,
        })
        const document_data = raw.document_data != null && isRecord(raw.document_data) ? raw.document_data : {}
        console.log(
          `${LOG} AUTO_SCAN_RESULT document_data (JSON):`,
          tryJson(redactImageBase64Deep(document_data)),
        )
        const flat = flattenAutoScanFields(raw as AutoScanResultMessage)
        const parsed = autoScanResultToParsed(raw as AutoScanResultMessage)
        const detail = idGuruDetailFromAutoScan(raw, document_data)
        logAutoScanPrimaryImageStats(raw)
        const cardImages = extractIdCardImages(raw)!
        if (cardImages.front === cardImages.back) {
          console.warn(
            `${LOG} AUTO_SCAN_RESULT: front and back payloads are the same string (${cardImages.front.length} chars). ` +
              'The native host must assign a different image to image_front_base64 / image_back_base64 (or nested images.* / document_data.*).',
          )
        }
        console.log(`${LOG} AUTO_SCAN_RESULT derived flat (flattened):`, tryJson(flat))
        console.log(`${LOG} AUTO_SCAN_RESULT derived parsed (panel fields):`, tryJson(parsed))
        console.log(`${LOG} AUTO_SCAN_RESULT IdGuru detail:`, tryJson(detail))
        const extended: NativeHostAutoScanPayload = {
          images: cardImages,
          document_data,
          flat,
          parsed,
          detail,
        }
        emitNativePanelDebug(onPanelDebug, {
          type: 'FDN_NATIVE_HOST_RX',
          receivedAt: rxAt,
          source: 'AUTO_SCAN_RESULT',
          topLevelKeys: Object.keys(raw),
          imageFrontB64Length: cardImages.front.length,
          imageBackB64Length: cardImages.back.length,
          documentDataKeys: Object.keys(document_data),
          documentDataPreview: documentDataPreviewForPanel(document_data),
          parsedPreview: parsedFieldsPreview(parsed),
        })
        void Promise.resolve(onExtendedScan(extended, onScan)).catch((err) => {
          console.error(`${LOG} onScan failed`, describeUnknownError(err))
        })
        return
      }

      if (isScanResultLegacy(raw)) {
        logInboundFromPython('SCAN_RESULT (legacy)', raw)
        const nested =
          raw.ocr_data != null && typeof raw.ocr_data === 'object' && !Array.isArray(raw.ocr_data)
            ? (raw.ocr_data as Record<string, unknown>)
            : {}
        console.log(`${LOG} SCAN_RESULT ocr_data / text (JSON):`, tryJson(redactImageBase64Deep(nested)))
        const detail = idGuruDetailFromAutoScan(raw, nested)
        const merged = mergeParsedWithGuru(parsedFieldsFromHost(raw), detail)
        const single = raw.image_base64 as string
        const payload: NativeScanSuccessPayload = {
          images: { front_image_base64: single, back_image_base64: single },
          parsed: merged,
          detail,
          documentData: nested,
        }
        console.log(`${LOG} SCAN_RESULT derived parsed (panel fields):`, tryJson(payload.parsed))
        emitNativePanelDebug(onPanelDebug, {
          type: 'FDN_NATIVE_HOST_RX',
          receivedAt: rxAt,
          source: 'SCAN_RESULT',
          topLevelKeys: Object.keys(raw),
          legacySingleImageB64Length: single.length,
          imageFrontB64Length: single.length,
          imageBackB64Length: single.length,
          documentDataKeys: Object.keys(nested),
          documentDataPreview: documentDataPreviewForPanel(nested),
          parsedPreview: parsedFieldsPreview(payload.parsed),
        })
        void Promise.resolve(onScan(payload)).catch((err) => {
          console.error(`${LOG} onScan failed`, describeUnknownError(err))
        })
        return
      }

      console.log(
        `${LOG} unhandled message type — full payload (JSON):`,
        tryJson(redactImageBase64Deep(raw)),
      )
      emitNativePanelDebug(onPanelDebug, {
        type: 'FDN_NATIVE_HOST_RX',
        receivedAt: rxAt,
        source: 'other',
        topLevelKeys: Object.keys(raw),
        documentDataKeys: [],
        unhandledType: typeof raw.type === 'string' ? raw.type : undefined,
      })
    })

    port.onDisconnect.addListener(() => {
      const lastErr = runtimeLastErrorDetail()
      nativePort = null
      const reason =
        lastErr.message ||
        (lastErr.raw && lastErr.raw !== '{}' ? lastErr.raw : null) ||
        'No chrome.runtime.lastError message — host process exited, crashed, or closed the pipe (check Python stderr / console).'
      console.warn(`${LOG} native port disconnected — will reconnect with backoff`, {
        host: NATIVE_HOST_NAME,
        portName,
        reason,
        chromeRuntimeLastError: lastErr,
        hints: [
          'If reason is empty: Python host often exited immediately (check host stderr / Task Manager).',
          'If "Access denied" or similar: verify registry path and manifest point to the correct exe.',
          'Host must write valid JSON frames (4-byte length prefix) to stdout or Chrome closes the pipe.',
        ],
      })
      scheduleReconnect(connect)
    })

    /* Minimal: no postMessage unless you add host commands (e.g. { type: 'SCAN_ID' }). */
  }

  connect()
}

/** Optional hook: same parsed payload; forwards `images` + `parsed` to onScan. */
async function onExtendedScan(
  extended: NativeHostAutoScanPayload,
  onScan: NativeHostScanCallback,
): Promise<void> {
  const merged = mergeParsedWithGuru(extended.parsed, extended.detail)
  await onScan({
    images: {
      front_image_base64: extended.images.front,
      back_image_base64: extended.images.back,
    },
    parsed: merged,
    detail: extended.detail,
    documentData: extended.document_data,
  })
}

/** Expose for tests / debugging. */
export function getNativePort(): chrome.runtime.Port | null {
  return nativePort
}
