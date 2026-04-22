import {
  extractEzeeScrapeFields,
  ezeeScrapeToGuestDisplay,
  ezeeScrapeToSnapshot,
  isEzeeGuestDrawerOpen,
  isValidEzeeReservationNumber,
  probeEzeeDrawer,
} from '../lib/ezee-drawer-extract'
import type { EzeeGuestDisplay, ReservationSnapshot } from '../shared/pms-types'
import { injectFields, type InjectResult } from './inject-helpers'

const EZEE_INJECT_SELECTORS: Record<string, string[]> = {
  firstName: ['input[name="firstName"]', 'input[id*="FirstName" i]'],
  lastName: ['input[name="lastName"]', 'input[id*="LastName" i]'],
  phone: ['input[name="phone"]', 'input[id*="Phone" i]', 'input[type="tel"]'],
  email: ['input[name="email"]', 'input[type="email"]'],
  address: ['input[name="address"]', 'textarea[name="address"]'],
  city: ['input[name="city"]'],
  state: ['input[name="state"]'],
  postalCode: ['input[name="zip"]', 'input[name="postalCode"]'],
}

const DEBOUNCE_MS = 120
const LOCAL_DEDUPE_MS = 30_000
const BACKUP_RUN_AT_MS = [500, 2000, 4500, 7000, 10_000] as const
const FAIL_PROBE_LOG_THROTTLE_MS = 800
const DEDUPE_LOG_THROTTLE_MS = 5000

let debounceTimer = 0
let lastDedupeKey: string | null = null
let lastSentAt = 0
let wasDrawerOpen = false
let lastFailProbeKey = ''
let lastFailProbeAt = 0
let lastDedupeLogAt = 0

console.info('[FDN eZee] content script loaded', {
  href: location.href,
  readyState: document.readyState,
})

function scheduleCheck(): void {
  window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    void runDetection()
  }, DEBOUNCE_MS)
}

function logThrottledFailProbe(probe: ReturnType<typeof probeEzeeDrawer>): void {
  const key = `${probe.failStage}|${probe.bodyTextLength}|${probe.mergedReservationRaw ?? ''}`
  const now = Date.now()
  if (key === lastFailProbeKey && now - lastFailProbeAt < FAIL_PROBE_LOG_THROTTLE_MS) return
  lastFailProbeKey = key
  lastFailProbeAt = now
  console.warn('[FDN eZee] Drawer open but guest scrape not complete yet — see probe:', probe)
}

function buildExtractPayload():
  | { ok: true; snapshot: ReservationSnapshot; guestDisplay: EzeeGuestDisplay }
  | { ok: false; error: string } {
  if (!isEzeeGuestDrawerOpen(document)) {
    return { ok: false, error: 'Guest drawer is not open.' }
  }
  const fields = extractEzeeScrapeFields(document)
  if (!fields || !isValidEzeeReservationNumber(fields.reservationNumber)) {
    console.warn('[FDN eZee] EZEE_EXTRACT_NOW: scrape failed', probeEzeeDrawer(document))
    return {
      ok: false,
      error: 'Could not read reservation number from the drawer yet (still loading?).',
    }
  }
  const loadedAt = new Date().toISOString()
  return {
    ok: true,
    snapshot: ezeeScrapeToSnapshot(fields, window.location.href, loadedAt),
    guestDisplay: ezeeScrapeToGuestDisplay(fields),
  }
}

async function runDetection(): Promise<void> {
  const openNow = isEzeeGuestDrawerOpen(document)

  if (openNow && !wasDrawerOpen) {
    console.info('[FDN eZee] Guest info right-panel / drawer opened — running DOM probe')
    console.info('[FDN eZee] probe:', probeEzeeDrawer(document))
  }
  if (!openNow && wasDrawerOpen) {
    console.info('[FDN eZee] Guest drawer closed')
    lastFailProbeKey = ''
  }
  wasDrawerOpen = openNow

  if (!openNow) return

  const fields = extractEzeeScrapeFields(document)
  if (!fields || !isValidEzeeReservationNumber(fields.reservationNumber)) {
    logThrottledFailProbe(probeEzeeDrawer(document))
    return
  }

  const conf = fields.reservationNumber!.trim()
  const roomHint = (fields.roomNumber ?? '').trim()
  const dedupeKey = `${conf}|${roomHint}`
  const now = Date.now()
  if (dedupeKey === lastDedupeKey && now - lastSentAt < LOCAL_DEDUPE_MS) {
    if (now - lastDedupeLogAt > DEDUPE_LOG_THROTTLE_MS) {
      lastDedupeLogAt = now
      console.info('[FDN eZee] Dedupe: same guest within 30s — not re-sending', { conf, roomHint })
    }
    return
  }

  const { fdn_ezee_auto_load: auto } = await chrome.storage.local.get('fdn_ezee_auto_load')
  if (auto === false) {
    console.info('[FDN eZee] Auto-load disabled (fdn_ezee_auto_load=false); guest parsed but not sent', {
      conf,
      guestName: fields.guestName,
    })
    return
  }

  const loadedAt = new Date().toISOString()
  const snapshot = ezeeScrapeToSnapshot(fields, window.location.href, loadedAt)
  const guestDisplay = ezeeScrapeToGuestDisplay(fields)

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'EZEE_AUTO_GUEST_DETECTED',
      snapshot,
      guestDisplay,
    })
    console.info('[FDN eZee] Auto-load message sent to extension', {
      confirmation: conf,
      guestName: guestDisplay.nameLine,
      room: roomHint,
      responseOk: res && typeof res === 'object' && 'ok' in res ? (res as { ok: boolean }).ok : undefined,
    })
    lastDedupeKey = dedupeKey
    lastSentAt = now
  } catch (e) {
    console.error('[FDN eZee] sendMessage to extension failed (is the extension enabled?)', e)
  }
}

const observer = new MutationObserver(() => scheduleCheck())
observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class', 'style'],
})
scheduleCheck()
for (const ms of BACKUP_RUN_AT_MS) {
  window.setTimeout(() => void runDetection(), ms)
}

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; fields?: Record<string, string>; payload?: LastScanResult },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: InjectResult | ReturnType<typeof buildExtractPayload> | { ok: boolean }) => void,
  ) => {
    if (message?.type === 'FDN_INJECT' && message.fields) {
      sendResponse(injectFields(EZEE_INJECT_SELECTORS, message.fields))
      return
    }
    if (message?.type === 'EZEE_EXTRACT_NOW') {
      sendResponse(buildExtractPayload())
      return
    }
    if (message?.type === 'FDN_FILL_GUEST_FORM') {
      const payload = message.payload ?? null
      console.log('[FDN] received FDN_FILL_GUEST_FORM, payload:', payload)
      triggerFill(payload)
      sendResponse({ ok: true })
      return
    }
  },
)

// ── Add Reservation auto-fill ─────────────────────────────────────────────────

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


type LastScanResult = {
  first_name:string|null; middle_name:string|null; last_name:string|null
  dob:string|null; id_number:string|null; expiry_date:string|null
  issue_date:string|null; gender:string|null; address:string|null
  city:string|null; state:string|null; postal_code:string|null
  document_type:string|null; phone:string|null; email:string|null
}

let _fillInProgress = false
let _addResDebounce = 0

const sleep = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

// ── helpers ──────────────────────────────────────────────────────────────────

/** React-controlled input: must use native setter then dispatch events. */
function reactSet(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input',  { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.blur()
}

function fillPlaceholder(placeholder: string, value: string | null | undefined): boolean {
  if (!value) return false
  const el = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  if (!el) { console.warn('[FDN] fillPlaceholder: not found →', placeholder); return false }
  reactSet(el, value)
  console.log('[FDN] filled:', placeholder, '←', value)
  return true
}

/** Label text may contain asterisk (*) for required fields — strip before comparing. */
function labelText(el: Element): string {
  return (el.textContent ?? '').replace(/[*\s]+$/g, '').trim()
}

function findFormItemByLabel(text: string): Element | null {
  for (const item of Array.from(document.querySelectorAll('.ant-form-item, [class*="form-item"]'))) {
    for (const lbl of Array.from(item.querySelectorAll('label, [class*="label"]'))) {
      if (labelText(lbl) === text) return item
    }
  }
  return null
}

function getAntSelectTrigger(formItem: Element): HTMLElement | null {
  return formItem.querySelector<HTMLElement>('.ant-select-selector, [class*="select-selector"]')
}

async function openAndPickOption(trigger: HTMLElement, optionText: string, waitMs = 320): Promise<boolean> {
  console.log('[FDN] dropdown: opening for option =', optionText)
  trigger.click()
  await sleep(waitMs)

  const containers = [
    ...Array.from(document.querySelectorAll<HTMLElement>(
      '.ant-select-item-option-content, .ant-select-item, [class*="option-content"], [class*="option-item"]'
    )),
  ]
  console.log('[FDN] dropdown: visible options =', containers.map(o => o.textContent?.trim()))

  // Prefer exact match, then partial (case-insensitive)
  const needle = optionText.toLowerCase()
  const match =
    containers.find(o => (o.textContent?.trim() ?? '').toLowerCase() === needle) ??
    containers.find(o => (o.textContent?.trim() ?? '').toLowerCase().includes(needle))

  if (match) {
    match.click()
    console.log('[FDN] dropdown: selected →', match.textContent?.trim())
    await sleep(120)
    return true
  }
  // No match — close dropdown
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  console.warn('[FDN] dropdown: no match for', optionText)
  return false
}

async function fillDropdownByLabel(labelText_: string, optionText: string): Promise<boolean> {
  const item = findFormItemByLabel(labelText_)
  if (!item) { console.warn('[FDN] label not found:', labelText_); return false }
  const trigger = getAntSelectTrigger(item)
  if (!trigger) { console.warn('[FDN] no select trigger in form item for:', labelText_); return false }
  return openAndPickOption(trigger, optionText)
}

/** Poll for city options up to maxWaitMs after state selection. */
async function fillCityWithPoll(cityItem: Element, cityName: string, maxWaitMs = 2000): Promise<boolean> {
  const trigger = getAntSelectTrigger(cityItem)
  if (!trigger) return false
  const deadline = Date.now() + maxWaitMs
  while (Date.now() < deadline) {
    trigger.click()
    await sleep(300)
    const opts = Array.from(document.querySelectorAll<HTMLElement>(
      '.ant-select-item-option-content, .ant-select-item, [class*="option-content"]'
    ))
    if (opts.length > 1) {
      const needle = cityName.toLowerCase()
      const match =
        opts.find(o => (o.textContent?.trim() ?? '').toLowerCase() === needle) ??
        opts.find(o => (o.textContent?.trim() ?? '').toLowerCase().includes(needle))
      if (match) {
        match.click()
        console.log('[FDN] city selected →', match.textContent?.trim())
        return true
      }
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      return false
    }
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await sleep(300)
  }
  console.warn('[FDN] city options never loaded')
  return false
}


// ── storage ──────────────────────────────────────────────────────────────────

/**
 * Primary key: 'lastScanResult' (written by service-worker after each native scan).
 * Fallback:    'fdn_last_native_scan' (always written — what the panel displays).
 */
async function getLastScanResult(): Promise<LastScanResult | null> {
  const store = await chrome.storage.local.get(['lastScanResult', 'fdn_last_native_scan'])
  console.log('[FDN] storage read:', {
    hasLastScanResult: !!store.lastScanResult,
    hasFdnNativeScan: !!store.fdn_last_native_scan,
  })

  if (store.lastScanResult) return store.lastScanResult as LastScanResult

  // Normalise from panel's source-of-truth key
  const raw = store.fdn_last_native_scan as {
    parsed?: Record<string, string|null>
    detail?: Record<string, string|null>
    documentData?: Record<string, unknown>
  } | undefined
  if (!raw) return null

  const p = raw.parsed ?? {}
  const d = raw.detail ?? {}
  const doc = raw.documentData ?? {}
  return {
    first_name:    (d.firstName   ?? null) as string|null,
    middle_name:   (d.middleName  ?? null) as string|null,
    last_name:     (d.lastName    ?? null) as string|null,
    dob:           (p.dateOfBirth ?? null) as string|null,
    id_number:     (p.idNumber    ?? null) as string|null,
    expiry_date:   (p.expiryDate  ?? null) as string|null,
    issue_date:    (p.issueDate   ?? null) as string|null,
    gender:        (typeof doc.gender === 'string' ? doc.gender
                  : typeof doc.sex   === 'string' ? doc.sex
                  : null),
    address:       (d.streetAddress ?? null) as string|null,
    city:          (d.city          ?? null) as string|null,
    state:         (d.state         ?? null) as string|null,
    postal_code:   (d.postalCode    ?? null) as string|null,
    document_type: (p.idType        ?? null) as string|null,
    phone:         (d.phone         ?? null) as string|null,
    email:         (d.email         ?? null) as string|null,
  }
}

// ── detection ────────────────────────────────────────────────────────────────

/**
 * Detect Step 2 by field PRESENCE (not CSS class), which is robust against
 * custom step-indicator class names. If the Full Name input is visible and
 * inside a modal that has an Add Reservation heading → we are on step 2.
 */
function isGuestFormVisible(): boolean {
  const el = document.querySelector<HTMLInputElement>('input[placeholder="Full Name"]')
  if (!el) return false
  const rect = el.getBoundingClientRect()
  const visible = rect.width > 0 && rect.height > 0
  if (!visible) return false
  // Confirm we are inside Add Reservation (not some other form with Full Name)
  const modal =
    el.closest('.ant-modal-content, .ant-drawer-content, [class*="modal"], [class*="dialog"]')
  if (!modal) return true  // trust field presence alone if no modal wrapper found
  const heading = modal.querySelector('h2, h3, .ant-modal-title, .ant-drawer-title, [class*="title"]')
  const headingText = heading?.textContent?.trim() ?? ''
  return headingText === '' || headingText.includes('Add Reservation') || headingText.includes('Reservation')
}

function isSidebarClosed(): boolean {
  // Sidebar is gone when no Add Reservation heading exists in DOM
  const allTitles = [
    ...Array.from(document.querySelectorAll('.ant-modal-title, .ant-drawer-title, h2, h3')),
  ]
  return !allTitles.some(el => el.textContent?.includes('Add Reservation'))
}

/**
 * Guest Details TAB (reservation detail page) is visible when Phone input is
 * present and visible. The Add Reservation modal uses "Mobile" not "Phone".
 */
function isGuestDetailsTabVisible(): boolean {
  const el = document.querySelector<HTMLInputElement>('input[placeholder="Phone"]')
  if (!el) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

// ── fill orchestrator ────────────────────────────────────────────────────────

async function autoFillGuestInfo(scan: LastScanResult): Promise<void> {
  if (_fillInProgress) { console.log('[FDN] fill already in progress — skipped'); return }
  _fillInProgress = true

  console.log('[FDN] autoFill: starting', { first: scan.first_name, last: scan.last_name })
  await sleep(400)

  // ── Title prefix ────────────────────────────────────────────────────────────
  if (scan.gender) {
    const g = scan.gender.toUpperCase()
    const title = (g === 'F' || g === 'FEMALE') ? 'Ms.' : 'Mr.'
    const fullNameEl = document.querySelector<HTMLInputElement>('input[placeholder="Full Name"]')
    if (fullNameEl) {
      let node: Element | null = fullNameEl.parentElement
      let titleTrigger: HTMLElement | null = null
      for (let i = 0; i < 8 && node; i++) {
        titleTrigger = node.querySelector<HTMLElement>('.ant-select-selector, [class*="select-selector"]')
        if (titleTrigger) break
        node = node.parentElement
      }
      if (titleTrigger) { await openAndPickOption(titleTrigger, title, 200); await sleep(100) }
    }
  }

  // ── Full Name ────────────────────────────────────────────────────────────────
  const fullName = [scan.first_name, scan.last_name].filter(Boolean).join(' ')
  fillPlaceholder('Full Name', fullName)

  // ── Mobile ──────────────────────────────────────────────────────────────────
  if (scan.phone) {
    const raw = scan.phone.replace(/\D/g, '')
    const digits = (raw.length === 11 && raw.startsWith('1')) ? raw.slice(1) : raw
    console.log('[FDN] phone:', scan.phone, '→', digits)
    const mobileEl = document.querySelector<HTMLInputElement>('input[placeholder="Mobile"]')
    if (mobileEl) reactSet(mobileEl, digits)
    else console.warn('[FDN] Mobile input not found')
  }

  // ── Email ────────────────────────────────────────────────────────────────────
  console.log('[FDN] email:', scan.email)
  if (scan.email) {
    const emailEl = document.querySelector<HTMLInputElement>('input[placeholder="Email"]')
    if (emailEl) reactSet(emailEl, scan.email)
    else console.warn('[FDN] Email input not found')
  }

  // ── Address / Zip ────────────────────────────────────────────────────────────
  fillPlaceholder('Address', scan.address)
  fillPlaceholder('Zip', scan.postal_code)

  // ── Country ─────────────────────────────────────────────────────────────────
  await fillDropdownByLabel('Country', 'United States of America')

  // ── State ────────────────────────────────────────────────────────────────────
  const stateCode = (scan.state ?? '').toUpperCase().trim()
  const stateName = US_STATES[stateCode] ?? scan.state ?? ''
  if (stateName) {
    await fillDropdownByLabel('State', stateName)
    await sleep(500)
  }

  // ── City ─────────────────────────────────────────────────────────────────────
  if (scan.city) {
    const cityItem = findFormItemByLabel('City')
    if (cityItem) await fillCityWithPoll(cityItem, scan.city)
    else console.warn('[FDN] City form item not found')
  }

  _fillInProgress = false
  console.log('[FDN] autoFill: complete ✓')
}

// ── Guest Details tab fill ───────────────────────────────────────────────────

async function autoFillGuestDetailsTab(scan: LastScanResult): Promise<void> {
  if (_fillInProgress) { console.log('[FDN] Guest Details fill already in progress — skipped'); return }
  _fillInProgress = true
  console.log('[FDN] Guest Details tab fill started', { first: scan.first_name, last: scan.last_name })

  await sleep(300)

  // ── Title prefix ─────────────────────────────────────────────────────────────
  if (scan.gender) {
    const g = scan.gender.toUpperCase()
    const title = (g === 'F' || g === 'FEMALE') ? 'Ms.' : 'Mr.'
    const nameFormItem = findFormItemByLabel('Name')
    if (nameFormItem) {
      const trigger = getAntSelectTrigger(nameFormItem)
      if (trigger) { await openAndPickOption(trigger, title, 200); await sleep(100) }
    }
  }

  // ── Full Name input ───────────────────────────────────────────────────────────
  const fullName = [scan.first_name, scan.last_name].filter(Boolean).join(' ')
  const nameInput = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find(i => {
    const ph = (i.placeholder ?? '').toLowerCase()
    if (ph.includes('search') || ph.includes('quick')) return false
    const rect = i.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    const formItem = i.closest('.ant-form-item, [class*="form-item"], [class*="form-row"]')
    if (!formItem) return false
    return Array.from(formItem.querySelectorAll('label, [class*="label"]'))
      .some(l => labelText(l) === 'Name')
  })
  if (nameInput) { reactSet(nameInput, fullName); await sleep(100) }
  else console.warn('[FDN] Guest Details: Name input not found')

  // ── Phone + Mobile ────────────────────────────────────────────────────────────
  if (scan.phone) {
    const raw = scan.phone.replace(/\D/g, '')
    const digits = (raw.length === 11 && raw.startsWith('1')) ? raw.slice(1) : raw
    const phoneEl = document.querySelector<HTMLInputElement>('input[placeholder="Phone"]')
    if (phoneEl) { reactSet(phoneEl, digits); await sleep(80) }
    else console.warn('[FDN] Guest Details: Phone input not found')
    const mobileEl = document.querySelector<HTMLInputElement>('input[placeholder="Mobile"]')
    if (mobileEl) { reactSet(mobileEl, digits); await sleep(80) }
  }

  // ── Email ─────────────────────────────────────────────────────────────────────
  if (scan.email) {
    const emailEl = document.querySelector<HTMLInputElement>('input[placeholder="Email"]')
    if (emailEl) { reactSet(emailEl, scan.email); await sleep(80) }
    else console.warn('[FDN] Guest Details: Email input not found')
  }

  // ── Gender dropdown ───────────────────────────────────────────────────────────
  if (scan.gender) {
    const g = scan.gender.toUpperCase()
    await fillDropdownByLabel('Gender', (g === 'F' || g === 'FEMALE') ? 'Female' : 'Male')
    await sleep(200)
  }

  // ── Address / Zip ─────────────────────────────────────────────────────────────
  fillPlaceholder('Address', scan.address)
  await sleep(80)
  fillPlaceholder('Zip', scan.postal_code)
  await sleep(80)

  // ── Country → State → City (order matters: state loads city options) ──────────
  await fillDropdownByLabel('Country', 'United States of America')
  await sleep(400)

  const stateCode = (scan.state ?? '').toUpperCase().trim()
  const stateName = US_STATES[stateCode] ?? scan.state ?? ''
  if (stateName) {
    await fillDropdownByLabel('State', stateName)
    await sleep(600)
  }

  if (scan.city) {
    const cityItem = findFormItemByLabel('City')
    if (cityItem) await fillCityWithPoll(cityItem, scan.city)
    else console.warn('[FDN] Guest Details: City form item not found')
  }

  // ── Click Save ────────────────────────────────────────────────────────────────
  await sleep(300)
  const saveBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find(b => b.textContent?.trim() === 'Save' && (b as HTMLElement).offsetParent !== null)
  if (saveBtn) {
    saveBtn.click()
    console.log('[FDN] Guest Details: Save clicked ✓')
  } else {
    console.warn('[FDN] Guest Details: Save button not found — click manually')
  }

  _fillInProgress = false
  console.log('[FDN] Guest Details tab fill complete ✓')
}

// ── trigger (called from message listener) ───────────────────────────────────

function triggerFill(payload: LastScanResult | null): void {
  void (async () => {
    const scan = payload ?? await getLastScanResult()
    if (!scan) { console.warn('[FDN] triggerFill: no scan data'); return }

    if (isGuestFormVisible()) {
      void autoFillGuestInfo(scan)
      return
    }

    if (isGuestDetailsTabVisible()) {
      void autoFillGuestDetailsTab(scan)
      return
    }

    // Neither view open yet — wait up to 30s for either
    console.log('[FDN] No fill target visible yet — waiting...')
    const obs = new MutationObserver(() => {
      if (isGuestFormVisible()) {
        obs.disconnect()
        window.clearTimeout(timeout)
        setTimeout(() => void autoFillGuestInfo(scan), 300)
      } else if (isGuestDetailsTabVisible()) {
        obs.disconnect()
        window.clearTimeout(timeout)
        setTimeout(() => void autoFillGuestDetailsTab(scan), 300)
      }
    })
    obs.observe(document.body, { childList: true, subtree: true, attributes: true })
    const timeout = window.setTimeout(() => {
      obs.disconnect()
      console.warn('[FDN] triggerFill: timed out waiting for fill target')
    }, 30_000)
  })()
}

// ── modal-close observer (resets fill guard when modal dismissed) ─────────────

const addResObserver = new MutationObserver(() => {
  window.clearTimeout(_addResDebounce)
  _addResDebounce = window.setTimeout(() => {
    if (_fillInProgress && isSidebarClosed()) {
      _fillInProgress = false
      console.log('[FDN] Add Reservation closed — fill guard reset')
    }
  }, 180)
})
addResObserver.observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'aria-hidden'],
})

// Reset fill guard when user navigates away from Guest Details tab
document.addEventListener('click', (e) => {
  const target = e.target as Element
  const clickedTab = target.closest('[class*="tab"], [role="tab"]')
  if (clickedTab && !clickedTab.textContent?.includes('Guest Details')) {
    _fillInProgress = false
  }
})

export {}
