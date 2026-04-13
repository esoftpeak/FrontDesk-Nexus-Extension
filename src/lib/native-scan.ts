import { NATIVE_HOST_NAME } from '../shared/protocol'

/** True if the native host is registered and Chrome can open a native messaging port. */
export async function pingNativeHost(): Promise<boolean> {
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    try {
      port.disconnect()
    } catch {
      /* ignore */
    }
    return true
  } catch {
    return false
  }
}
