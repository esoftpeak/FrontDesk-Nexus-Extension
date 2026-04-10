import { injectFields, type InjectResult } from './inject-helpers'

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

/** SynXis-style confirmation: alphanumeric, 10–16 chars (e.g. 88939EE050317). */
const CONFIRMATION_TOKEN = /^[A-Z0-9]{10,16}$/

const MAX_ATTEMPTS = 15
const RETRY_MS = 1000

/**
 * Strategy 1: header / labels like "Confirmation #:" or "Confirmation Number" with value nearby.
 * Runs in the parent document only; cross-origin iframe DOM is not accessible from this script.
 */
function extractFromConfirmationLabel(): string | null {
  const body = document.body
  if (!body) return null

  const labelPatterns: RegExp[] = [
    /Confirmation\s*#\s*:\s*([A-Z0-9]{10,16})/i,
    /Confirmation\s*Number\s*[:.]?\s*([A-Z0-9]{10,16})/i,
  ]

  const haystack = body.innerText ?? ''
  for (const re of labelPatterns) {
    const m = haystack.match(re)
    if (m?.[1] && CONFIRMATION_TOKEN.test(m[1].toUpperCase())) {
      return m[1].toUpperCase()
    }
  }

  const elements = body.querySelectorAll<HTMLElement>('*')
  for (const el of elements) {
    const text = el.innerText ?? el.textContent ?? ''
    if (!text.includes('Confirmation')) continue
    const compact = text.replace(/\s+/g, ' ').trim()
    for (const re of labelPatterns) {
      const m = compact.match(re)
      if (m?.[1] && CONFIRMATION_TOKEN.test(m[1].toUpperCase())) {
        return m[1].toUpperCase()
      }
    }
  }

  return null
}

/**
 * Strategy 2: walk text nodes and find standalone tokens matching /^[A-Z0-9]{10,16}$/.
 * If multiple matches, prefer one near the word "confirmation" in surrounding text (same parent block).
 */
function extractByRegexScan(): string | null {
  const body = document.body
  if (!body) return null

  const scored: { value: string; score: number }[] = []
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const t = node.textContent ?? ''
      return t.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })

  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const raw = node.textContent ?? ''
    for (const match of raw.matchAll(/\b([A-Za-z0-9]{10,16})\b/g)) {
      const upper = match[1].toUpperCase()
      if (!CONFIRMATION_TOKEN.test(upper)) continue
      let score = 0
      const parent = node.parentElement
      const ctx = (parent?.innerText ?? raw).toLowerCase()
      if (ctx.includes('confirmation')) score += 10
      if (ctx.includes('reservation')) score += 3
      if (ctx.includes('stay')) score += 1
      scored.push({ value: upper, score })
    }
  }

  if (scored.length === 0) return null
  scored.sort((a, b) => b.score - a.score)
  return scored[0].value
}

function tryExtractOnce(): string | null {
  return extractFromConfirmationLabel() ?? extractByRegexScan()
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
  },
)
