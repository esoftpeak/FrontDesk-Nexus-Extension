import { NATIVE_HOST_NAME } from '../shared/protocol'

const TAG = '[FDN ID scan]'

export function logPipelineFromUiClick(): void {
  console.log(`${TAG} UI: Scan ID clicked`)
}

export function logPipelineServiceWorkerStart(): void {
  console.log(`${TAG} Worker: SCAN_ID_START received`, { host: NATIVE_HOST_NAME })
}

export function logPipelineBeforeConnectNative(): void {
  console.log(`${TAG} Worker: connectNative start`, { host: NATIVE_HOST_NAME })
}

export function logPipelineConnectNativeOk(): void {
  console.log(`${TAG} Worker: connectNative success`)
}

export function logPipelineConnectNativeFailed(e: unknown): void {
  console.warn(`${TAG} Worker: connectNative failed`, e)
}

export function logPipelinePostScanIdRequest(): void {
  console.log(`${TAG} Worker: postMessage`, { type: 'SCAN_ID' })
}

export function logPipelineHostMessageSummary(label: string, payload: unknown): void {
  console.log(`${TAG} Worker: ${label}`, payload)
}

export function logPipelineScanCompleteOk(summary: Record<string, unknown>): void {
  console.log(`${TAG} Worker: scan complete`, summary)
}

export function logPipelineScanCompleteErr(message: string): void {
  console.warn(`${TAG} Worker: scan error`, message)
}

export function logPipelineUiResponse(ok: boolean, detail: unknown): void {
  if (ok) {
    console.log(`${TAG} UI: response success`, detail)
  } else {
    console.warn(`${TAG} UI: response failed`, detail)
  }
}