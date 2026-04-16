import {
  describeRuntimeLastError,
  describeUnknownError,
  runtimeLastErrorDetail,
} from '../nativeHost'
import { NATIVE_HOST_NAME } from '../shared/protocol'

const LOG = '[nativePing]'

/** True if the native host is registered and Chrome can open a native messaging port. */
export async function pingNativeHost(): Promise<boolean> {
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    const afterConnect = runtimeLastErrorDetail()
    if (afterConnect.message || afterConnect.raw) {
      console.warn(`${LOG} connectNative returned with chrome.runtime.lastError set`, {
        host: NATIVE_HOST_NAME,
        ...afterConnect,
      })
      try {
        port.disconnect()
      } catch {
        /* ignore */
      }
      return false
    }
    try {
      port.disconnect()
    } catch {
      /* ignore */
    }
    return true
  } catch (e) {
    const lastErr = runtimeLastErrorDetail()
    console.warn(`${LOG} connectNative failed`, {
      host: NATIVE_HOST_NAME,
      lastErrorMessage: lastErr.message || describeRuntimeLastError(),
      lastErrorDetail: lastErr,
      thrown: describeUnknownError(e),
    })
    return false
  }
}
