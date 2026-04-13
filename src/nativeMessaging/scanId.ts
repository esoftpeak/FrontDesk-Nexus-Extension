import { NATIVE_HOST_NAME } from '../shared/protocol'
import type { ParsedIdFields } from '../shared/pms-types'
import type {
  NativeErrorMessage,
  NativeScanRequest,
  NativeScanResultMessage,
  ScanResult,
} from './types'
import {
  logPipelineBeforeConnectNative,
  logPipelineConnectNativeFailed,
  logPipelineConnectNativeOk,
  logPipelineHostMessageSummary,
  logPipelinePostScanIdRequest,
  logPipelineScanCompleteErr,
  logPipelineScanCompleteOk,
} from './pipelineLog'

const SCAN_TIMEOUT_MS = 120_000
const LOG = '[FDN ID scan]'

function summarizeHostMessage(raw: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...raw }
  if (typeof copy.image_base64 === 'string') {
    copy.image_base64 = `<string len=${copy.image_base64.length}>`
  }
  return copy
}

const ID_KEYS: (keyof ParsedIdFields)[] = [
  'fullName',
  'dateOfBirth',
  'idNumber',
  'idType',
  'issueDate',
  'expiryDate',
  'address',
]

const emptyParsed: ParsedIdFields = {
  fullName: null,
  dateOfBirth: null,
  idNumber: null,
  idType: null,
  issueDate: null,
  expiryDate: null,
  address: null,
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function stringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

/**
 * Host sends the same field names as the side panel (`ParsedIdFields`, camelCase).
 * Values may live in `ocr_data` and/or on the `SCAN_RESULT` object; top-level wins.
 */
export function parsedFieldsFromHost(root: Record<string, unknown>): ParsedIdFields {
  const nested =
    root.ocr_data != null && typeof root.ocr_data === 'object' && !Array.isArray(root.ocr_data)
      ? (root.ocr_data as Record<string, unknown>)
      : {}
  const out: ParsedIdFields = { ...emptyParsed }
  for (const k of ID_KEYS) {
    out[k] = stringOrNull(root[k]) ?? stringOrNull(nested[k])
  }
  console.log(`${LOG} [ext] Step 14b — Parsed ID fields for UI (trimmed):`, out)
  return out
}

function isScanResultMessage(msg: Record<string, unknown>): msg is NativeScanResultMessage {
  if (msg.type !== 'SCAN_RESULT' || msg.success !== true || typeof msg.image_base64 !== 'string')
    return false
  if (msg.ocr_data == null) return true
  return typeof msg.ocr_data === 'object' && !Array.isArray(msg.ocr_data)
}

function isErrorMessage(msg: Record<string, unknown>): msg is NativeErrorMessage {
  return msg.type === 'ERROR' && typeof msg.message === 'string'
}

/**
 * Chrome MV3 native messaging: connect to Python host, request ID scan, wait for first reply.
 * Host name must match Windows registry + host JSON (`allowed_origins`).
 */
export function runIdScan(): Promise<ScanResult> {
  return new Promise((resolve) => {
    let finished = false
    let port: chrome.runtime.Port | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const done = (r: ScanResult) => {
      if (finished) return
      finished = true
      if (timer != null) clearTimeout(timer)
      timer = null
      try {
        port?.disconnect()
      } catch {
        /* ignore */
      }
      if (r.ok) {
        logPipelineScanCompleteOk({
          imageBase64Len: r.result.image_base64.length,
          parsed: r.result.parsed,
        })
      } else {
        logPipelineScanCompleteErr((r as { error: string }).error)
      }
      resolve(r)
    }

    timer = setTimeout(() => {
      console.warn(`${LOG} runIdScan: timeout (${SCAN_TIMEOUT_MS}ms)`)
      done({ ok: false, error: 'Native ID scan timed out.' })
    }, SCAN_TIMEOUT_MS)

    logPipelineBeforeConnectNative()
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
      logPipelineConnectNativeOk()
    } catch (e) {
      if (timer != null) clearTimeout(timer)
      timer = null
      logPipelineConnectNativeFailed(e)
      const msg = e instanceof Error ? e.message : 'connectNative failed'
      resolve({
        ok: false,
        error: `${msg} — is the com.frontdesk.nexus host installed?`,
      })
      return
    }

    port.onMessage.addListener((raw: unknown) => {
      if (finished) return
      if (!isRecord(raw)) {
        logPipelineHostMessageSummary('onMessage: not an object (invalid)', raw)
        done({ ok: false, error: 'Native host sent a non-object response.' })
        return
      }
      logPipelineHostMessageSummary('onMessage from host (summary, no raw base64)', summarizeHostMessage(raw))
      if (isErrorMessage(raw)) {
        console.warn(`${LOG} host replied type=ERROR`, raw.message)
        done({ ok: false, error: raw.message })
        return
      }
      if (isScanResultMessage(raw)) {
        console.log(`${LOG} host replied type=SCAN_RESULT — mapping to form fields…`)
        done({
          ok: true,
          result: {
            image_base64: raw.image_base64,
            parsed: parsedFieldsFromHost(raw),
          },
        })
        return
      }
      logPipelineHostMessageSummary('unexpected message shape', { type: raw.type })
      done({
        ok: false,
        error: `Unexpected native response (type: ${String(raw.type)}).`,
      })
    })

    port.onDisconnect.addListener(() => {
      if (finished) return
      const le = chrome.runtime.lastError?.message
      console.warn(`${LOG} onDisconnect before reply`, { lastError: le ?? null })
      done({
        ok: false,
        error:
          le ??
          'Native host disconnected before a scan result was received. Check host logs and registry manifest.',
      })
    })

    try {
      logPipelinePostScanIdRequest()
      port.postMessage({ type: 'SCAN_ID' } satisfies NativeScanRequest)
    } catch (e) {
      console.warn(`${LOG} postMessage threw`, e)
      done({
        ok: false,
        error: e instanceof Error ? e.message : 'postMessage to native host failed',
      })
    }
  })
}
