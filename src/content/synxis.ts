import { extractConfirmationFromDocument } from '../lib/synxis-confirmation-dom'
import { injectFields, type InjectResult } from './inject-helpers'

// ── Guest Details auto-fill ───────────────────────────────────────────────────

type FillPayload = {
  first_name: string | null
  last_name: string | null
  middle_name: string | null
  phone: string | null
  email: string | null
  address: string | null
  postal_code: string | null
  city: string | null
  state: string | null
  [key: string]: string | null | undefined
}

const US_STATES: Record<string, string> = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',
  KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',
  MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',
  NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',
  OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',
  SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',
  VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',
  WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia',
}

let _synxisFillInProgress = false
const sleep = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

function synxisSet(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur()
}

/**
 * The Guest Details modal is uniquely identified by a visible "Primary/Mobile Phone" input.
 * Using input presence avoids fragile textContent matching on container divs.
 */
function isGuestDetailsModalOpen(): boolean {
  const el = document.querySelector<HTMLInputElement>('input[placeholder*="Mobile Phone" i]')
  if (!el) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function findInput(placeholderSubstr: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    `input[placeholder*="${placeholderSubstr}" i], textarea[placeholder*="${placeholderSubstr}" i]`,
  ) ?? null
}

function findSelect(labelSubstr: string): HTMLSelectElement | null {
  // Try label[for] → select, then proximity scan
  for (const lbl of Array.from(document.querySelectorAll('label'))) {
    if (lbl.textContent?.toLowerCase().includes(labelSubstr.toLowerCase())) {
      const forAttr = lbl.getAttribute('for')
      if (forAttr) {
        const sel = document.querySelector<HTMLSelectElement>(`select#${forAttr}`)
        if (sel) return sel
      }
      const parent = lbl.parentElement
      if (parent) {
        const sel = parent.querySelector<HTMLSelectElement>('select')
        if (sel) return sel
      }
    }
  }
  // Fallback: find select near any leaf element whose text contains label
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (el.children.length === 0 &&
        el.textContent?.trim().toLowerCase().includes(labelSubstr.toLowerCase())) {
      const parent = el.closest('td, tr, div, li')
      if (parent) {
        const sel = parent.querySelector<HTMLSelectElement>('select') ??
                    parent.nextElementSibling?.querySelector<HTMLSelectElement>('select')
        if (sel) return sel
      }
    }
  }
  return null
}

function fillSynxisSelect(labelSubstr: string, value: string): boolean {
  if (!value) return false
  const sel = findSelect(labelSubstr)
  if (!sel) { console.warn('[FDN SynXis] select not found:', labelSubstr); return false }
  const needle = value.toLowerCase()
  const match = Array.from(sel.options).find(
    o => o.text.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)
  )
  if (!match) {
    console.warn('[FDN SynXis] no option match for', labelSubstr, value,
      'available:', Array.from(sel.options).map(o => o.text))
    return false
  }
  sel.value = match.value
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  console.log('[FDN SynXis] select filled:', labelSubstr, '→', match.text)
  return true
}

async function fillSynxisGuestForm(data: FillPayload): Promise<void> {
  if (_synxisFillInProgress) { console.log('[FDN SynXis] fill already in progress'); return }
  _synxisFillInProgress = true
  console.log('[FDN SynXis] fill started', data)

  await sleep(400)

  const textFields: Array<[string, string | null | undefined]> = [
    ['First Name',      data.first_name],
    ['Last Name',       data.last_name],
    ['Middle',          data.middle_name ? data.middle_name.charAt(0) : null],
    ['Mobile Phone',    data.phone ? normalizePhone(data.phone) : null],
    ['Primary Email',   data.email],
    ['Primary Address', data.address],
    ['Zip',             data.postal_code],
    ['City',            data.city],
  ]

  for (const [placeholder, value] of textFields) {
    if (!value) continue
    const el = findInput(placeholder)
    if (el) {
      synxisSet(el, value)
      console.log('[FDN SynXis] filled:', placeholder, '←', value)
    } else {
      console.warn('[FDN SynXis] input not found:', placeholder)
    }
    await sleep(80)
  }

  // State: OCR gives 2-letter code → full name
  const stateCode = (data.state ?? '').toUpperCase().trim()
  const stateName = US_STATES[stateCode] ?? data.state ?? ''
  if (stateName) {
    fillSynxisSelect('State', stateName)
    await sleep(200)
  }

  // Country: default to United States
  fillSynxisSelect('Country', 'United States')

  _synxisFillInProgress = false
  console.log('[FDN SynXis] fill complete ✓')
}

function normalizePhone(phone: string): string {
  const raw = phone.replace(/\D/g, '')
  return (raw.length === 11 && raw.startsWith('1')) ? raw.slice(1) : raw
}

function triggerSynxisFill(payload: FillPayload | null): void {
  console.log('[FDN SynXis] triggerFill called', { hasPayload: !!payload, isModalOpen: isGuestDetailsModalOpen() })
  void (async () => {
    if (!payload) { console.warn('[FDN SynXis] triggerFill: no payload'); return }

    // Reset stuck guard from any previous failed fill
    _synxisFillInProgress = false

    if (isGuestDetailsModalOpen()) {
      // Modal already open — fill immediately
      await fillSynxisGuestForm(payload)
      return
    }

    // Modal not yet open — wait up to 30s via observer
    console.log('[FDN SynXis] modal not detected yet, waiting...')
    const obs = new MutationObserver(() => {
      if (isGuestDetailsModalOpen() && !_synxisFillInProgress) {
        obs.disconnect()
        window.clearTimeout(timeout)
        window.setTimeout(() => void fillSynxisGuestForm(payload), 400)
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
    const timeout = window.setTimeout(() => {
      obs.disconnect()
      console.warn('[FDN SynXis] triggerFill: timed out waiting for Guest Details modal')
    }, 30_000)
  })()
}

// Reset fill guard when modal closes
const synxisModalObserver = new MutationObserver(() => {
  if (_synxisFillInProgress && !isGuestDetailsModalOpen()) {
    _synxisFillInProgress = false
  }
})
synxisModalObserver.observe(document.body, { childList: true, subtree: true })

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
    if (message?.type === 'FDN_FILL_GUEST_FORM') {
      console.log('[FDN SynXis] FDN_FILL_GUEST_FORM received')
      triggerSynxisFill((message as { type: string; payload?: FillPayload }).payload ?? null)
      sendResponse({ ok: true })
      return
    }
  },
)
