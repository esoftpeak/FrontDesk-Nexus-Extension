import { extractConfirmationFromDocument } from '../lib/synxis-confirmation-dom'
import { injectFields, type InjectResult } from './inject-helpers'

// Note: FDN_FILL_GUEST_FORM is handled in synxis-sph-autoload.ts which runs inside
// the SphContentIframe (sph.synxis.com) where the Guest Details modal inputs actually live.

const SYNXIS_INJECT_SELECTORS: Record<string, string[]> = {
  firstName: ['input[name="firstName"]', 'input[id*="firstName" i]', '#firstName'],
  lastName: ['input[name="lastName"]', 'input[id*="lastName" i]', '#lastName'],
  phone: ['input[name="phone"]', 'input[type="tel"]', 'input[id*="phone" i]'],
  email: ['input[name="email"]', 'input[type="email"]', 'input[id*="email" i]'],
  address: ['input[name="address"]', 'textarea[name="address"]', 'input[id*="address" i]'],
  city: ['input[name="city"]', 'input[id*="city" i]'],
  state: ['input[name="state"]', 'input[id*="state" i]'],
  postalCode: ['input[name="postalCode"]', 'input[name="zip"]', 'input[id*="postal" i]'],
}

const MAX_ATTEMPTS = 15
const RETRY_MS = 1000

function tryExtractOnce(): string | null {
  return extractConfirmationFromDocument(document)
}

/**
 * Observes DOM mutations and retries up to 15 times every 1s until a confirmation is found
 * or attempts are exhausted. Persists to chrome.storage.session and notifies the extension.
 */
function extractConfirmationNumber(): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let attempts = 0
    let intervalId = 0

    const cleanup = (observer: MutationObserver) => {
      observer.disconnect()
      window.clearInterval(intervalId)
    }

    const succeed = async (value: string) => {
      if (settled) return
      settled = true
      try {
        await chrome.storage.session.set({ confirmationNumber: value })
      } catch {
        /* session storage unavailable — still resolve */
      }
      console.log('[FDN] confirmationNumber', value)
      try {
        await chrome.runtime.sendMessage({ type: 'CONFIRMATION_FOUND', value })
      } catch {
        /* no receiver is fine */
      }
      resolve(value)
    }

    const fail = () => {
      if (settled) return
      settled = true
      try {
        void chrome.runtime.sendMessage({ type: 'CONFIRMATION_NOT_FOUND' })
      } catch {
        /* no receiver is fine */
      }
      reject(new Error('Confirmation number not found after 15 attempts'))
    }

    const runAttempt = () => {
      if (settled) return
      attempts += 1
      const found = tryExtractOnce()
      if (found) {
        cleanup(observer)
        void succeed(found)
        return
      }
      if (attempts >= MAX_ATTEMPTS) {
        cleanup(observer)
        fail()
      }
    }

    const observer = new MutationObserver(() => {
      if (settled) return
      const found = tryExtractOnce()
      if (found) {
        cleanup(observer)
        void succeed(found)
      }
    })

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })

    intervalId = window.setInterval(runAttempt, RETRY_MS)
    runAttempt()
  })
}

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; fields?: Record<string, string> },
    _sender,
    sendResponse: (r: InjectResult | { ok: boolean; error?: string; confirmation?: string }) => void,
  ) => {
    if (message?.type === 'FDN_INJECT' && message.fields) {
      sendResponse(injectFields(SYNXIS_INJECT_SELECTORS, message.fields))
      return
    }
    if (message?.type === 'SYNXIS_EXTRACT_CONFIRMATION') {
      extractConfirmationNumber()
        .then((confirmation) => sendResponse({ ok: true, confirmation }))
        .catch((e: unknown) =>
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : 'Extraction failed',
          }),
        )
      return true
    }
    // FDN_FILL_GUEST_FORM is handled by synxis-sph-autoload.ts inside the SphContentIframe
  },
)
