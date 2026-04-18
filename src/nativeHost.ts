/**
 * Single native messaging connection to com.frontdesk.nexus (MV3 service worker).
 * Connect on init; reconnect on disconnect with backoff. No UI / button required.
 */
import { NATIVE_HOST_NAME } from './shared/protocol'
import type { ParsedIdFields } from './shared/pms-types'
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

const BASE64_PREVIEW_HEAD = 200
const BASE64_PREVIEW_TAIL = 120

function summarizeBase64ForConsole(b64: string): {
  characterLength: number
  approxDecodedBytes: number
  previewStart: string
  previewEnd: string
} {
  const len = b64.length
  const approxDecoded = Math.floor((len * 3) / 4)
  return {
    characterLength: len,
    approxDecodedBytes: approxDecoded,
    previewStart: b64.slice(0, BASE64_PREVIEW_HEAD),
    previewEnd: len > BASE64_PREVIEW_TAIL ? b64.slice(-BASE64_PREVIEW_TAIL) : '',
  }
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
 * DevTools: log everything Python sent. Full base64 is logged on its own line (can be large).
 */
function logInboundFromPython(label: string, raw: Record<string, unknown>): void {
  const type = raw.type
  const keys = Object.keys(raw)
  const rawForConsole: Record<string, unknown> = {
    ...raw,
    ...(typeof raw.image_base64 === 'string'
      ? { image_base64: summarizeBase64ForConsole(raw.image_base64) }
      : {}),
  }
  console.log(`${LOG} ← Python native host [${label}]`, {
    type,
    keys,
    rawForConsole,
  })
  if (typeof raw.image_base64 === 'string') {
    console.log(`${LOG} ← Python [${label}] image_base64 FULL string (${raw.image_base64.length} chars):`, raw.image_base64)
  }
}

/** Inbound from host when Thales/SDK pushes a completed scan. */
export type AutoScanResultMessage = {
  type: 'AUTO_SCAN_RESULT'
  image_base64: string
  document_data?: Record<string, unknown>
  first_name?: string
  last_name?: string
  document_number?: string
  date_of_birth?: string
  document_type?: string
  expiry_date?: string
  issue_date?: string
  address?: string
}

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
  image_base64: string
  document_data: Record<string, unknown>
  flat: AutoScanFlatFields
  parsed: ParsedIdFields
}

export type NativeHostScanCallback = (payload: NativeScanSuccessPayload) => void | Promise<void>

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
    stringOrNull(msg.first_name) ?? docPick(doc, 'first_name', 'firstName')
  const last = stringOrNull(msg.last_name) ?? docPick(doc, 'last_name', 'lastName')
  let fullName: string | null = null
  if (first && last) fullName = `${last}, ${first}`
  else fullName = first ?? last ?? docPick(doc, 'full_name', 'fullName')

  return {
    fullName,
    dateOfBirth:
      stringOrNull(msg.date_of_birth) ?? docPick(doc, 'date_of_birth', 'dateOfBirth', 'dob'),
    idNumber:
      stringOrNull(msg.document_number) ?? docPick(doc, 'document_number', 'id_number', 'idNumber'),
    idType: stringOrNull(msg.document_type) ?? docPick(doc, 'document_type', 'idType'),
    issueDate: stringOrNull(msg.issue_date) ?? docPick(doc, 'issue_date', 'issueDate'),
    expiryDate: stringOrNull(msg.expiry_date) ?? docPick(doc, 'expiry_date', 'expiryDate'),
    address: stringOrNull(msg.address) ?? docPick(doc, 'address', 'address_line'),
  }
}

function flattenAutoScanFields(msg: AutoScanResultMessage): AutoScanFlatFields {
  const doc = (msg.document_data ?? {}) as Record<string, unknown>
  return {
    first_name: stringOrNull(msg.first_name) ?? docPick(doc, 'first_name') ?? undefined,
    last_name: stringOrNull(msg.last_name) ?? docPick(doc, 'last_name') ?? undefined,
    document_number: stringOrNull(msg.document_number) ?? docPick(doc, 'document_number') ?? undefined,
    date_of_birth: stringOrNull(msg.date_of_birth) ?? docPick(doc, 'date_of_birth') ?? undefined,
    document_type: stringOrNull(msg.document_type) ?? docPick(doc, 'document_type') ?? undefined,
    expiry_date: stringOrNull(msg.expiry_date) ?? docPick(doc, 'expiry_date') ?? undefined,
    issue_date: stringOrNull(msg.issue_date) ?? docPick(doc, 'issue_date') ?? undefined,
    address: stringOrNull(msg.address) ?? docPick(doc, 'address') ?? undefined,
  }
}

function isAutoScanResult(msg: Record<string, unknown>): msg is AutoScanResultMessage {
  return (
    msg.type === 'AUTO_SCAN_RESULT' &&
    typeof msg.image_base64 === 'string'
  )
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
export function initNativeHost(onScan: NativeHostScanCallback): void {
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
      if (!isRecord(raw)) {
        console.log(`${LOG} ← Python onMessage (non-object payload):`, raw)
        return
      }

      console.log(`${LOG} ← Python onMessage summary`, {
        type: raw.type,
        keys: Object.keys(raw),
      })

      if (raw.type === 'ERROR' && typeof raw.message === 'string') {
        logInboundFromPython('ERROR', raw)
        console.log(`${LOG} host ERROR text:`, raw.message)
        console.log(`${LOG} host ERROR full object:`, tryJson(raw))
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
        console.log(`${LOG} AUTO_SCAN_RESULT document_data (JSON):`, tryJson(document_data))
        const flat = flattenAutoScanFields(raw)
        const parsed = autoScanResultToParsed(raw)
        console.log(`${LOG} AUTO_SCAN_RESULT derived flat (flattened):`, tryJson(flat))
        console.log(`${LOG} AUTO_SCAN_RESULT derived parsed (panel fields):`, tryJson(parsed))
        const extended: NativeHostAutoScanPayload = {
          image_base64: raw.image_base64,
          document_data,
          flat,
          parsed,
        }
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
        console.log(`${LOG} SCAN_RESULT ocr_data / text (JSON):`, tryJson(nested))
        const payload: NativeScanSuccessPayload = {
          image_base64: raw.image_base64 as string,
          parsed: parsedFieldsFromHost(raw),
        }
        console.log(`${LOG} SCAN_RESULT derived parsed (panel fields):`, tryJson(payload.parsed))
        void Promise.resolve(onScan(payload)).catch((err) => {
          console.error(`${LOG} onScan failed`, describeUnknownError(err))
        })
        return
      }

      console.log(`${LOG} unhandled message type — full payload (JSON):`, tryJson(raw))
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

/** Optional hook: same parsed payload; default forwards `parsed` + `image_base64` to onScan. */
async function onExtendedScan(
  extended: NativeHostAutoScanPayload,
  onScan: NativeHostScanCallback,
): Promise<void> {
  await onScan({
    image_base64: extended.image_base64,
    parsed: extended.parsed,
  })
}

/** Expose for tests / debugging. */
export function getNativePort(): chrome.runtime.Port | null {
  return nativePort
}
