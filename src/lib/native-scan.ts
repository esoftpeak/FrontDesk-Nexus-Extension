import { NATIVE_HOST_NAME } from '../shared/protocol'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export type NativeScanResult = {
  front_image_base64: string
  back_image_base64: string
}

export type NativeOutgoing = {
  cmd: 'scan_id' | 'heartbeat'
  correlation_id?: string
}

export type NativeIncoming =
  | { ok: true; correlation_id?: string; result: NativeScanResult }
  | { ok: false; correlation_id?: string; error: string }

/**
 * Request ID images from Native Messaging host, or return placeholders in simulation.
 */
export function scanIdFromNativeOrSimulate(simulation: boolean): Promise<NativeScanResult> {
  if (simulation) {
    return Promise.resolve({
      front_image_base64: TINY_PNG_BASE64,
      back_image_base64: TINY_PNG_BASE64,
    })
  }

  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    } catch (e) {
      reject(
        e instanceof Error
          ? e
          : new Error('Native Messaging host is not available for this extension.'),
      )
      return
    }

    const correlationId = crypto.randomUUID()
    const timer = setTimeout(() => {
      try {
        port.disconnect()
      } catch {
        /* ignore */
      }
      reject(new Error('Native ID scan timed out.'))
    }, 120_000)

    port.onMessage.addListener((raw: NativeIncoming) => {
      if (raw && typeof raw === 'object' && 'ok' in raw && raw.ok && raw.result) {
        clearTimeout(timer)
        try {
          port.disconnect()
        } catch {
          /* ignore */
        }
        resolve(raw.result)
        return
      }
      if (raw && typeof raw === 'object' && 'ok' in raw && !raw.ok) {
        clearTimeout(timer)
        try {
          port.disconnect()
        } catch {
          /* ignore */
        }
        reject(new Error('error' in raw ? String(raw.error) : 'Native scan failed'))
      }
    })

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer)
        reject(
          new Error(
            chrome.runtime.lastError.message ||
              'Native host disconnected (is the host installed?).',
          ),
        )
      }
    })

    const out: NativeOutgoing = { cmd: 'scan_id', correlation_id: correlationId }
    port.postMessage(out)
  })
}

export async function pingNativeHost(): Promise<boolean> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    } catch {
      resolve(false)
      return
    }
    const done = (ok: boolean) => {
      try {
        port.disconnect()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const t = setTimeout(() => done(false), 3_000)
    port.onMessage.addListener(() => {
      clearTimeout(t)
      done(true)
    })
    port.onDisconnect.addListener(() => {
      clearTimeout(t)
      done(false)
    })
    port.postMessage({ cmd: 'heartbeat' } satisfies NativeOutgoing)
  })
}
