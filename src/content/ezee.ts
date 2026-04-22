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
    message: { type?: string; fields?: Record<string, string> },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: InjectResult | ReturnType<typeof buildExtractPayload>) => void,
  ) => {
    if (message?.type === 'FDN_INJECT' && message.fields) {
      sendResponse(injectFields(EZEE_INJECT_SELECTORS, message.fields))
      return
    }
    if (message?.type === 'EZEE_EXTRACT_NOW') {
      sendResponse(buildExtractPayload())
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

const DOC_TYPE_MAP: Record<string, string> = {
  DRIVERS_LICENSE:"Driving License",DRIVER_LICENSE:"Driving License",
  DL:"Driving License",PASSPORT:'Passport',ID_CARD:'ID Card',
  STATE_ID:'State ID',MILITARY_ID:'Military ID',
}

/** Normalize OCR doc type to match exact site option text. */
function normalizeDocType(raw: string | null | undefined): string {
  if (!raw) return ''
  const key = raw.toLowerCase().trim()
  const patterns: [string, string][] = [
    ['driver', 'Driving License'],
    ['driving', 'Driving License'],
    ['passport', 'Passport'],
    ['id card', 'ID Card'],
    ['state id', 'State ID'],
    ['military', 'Military ID'],
  ]
  for (const [pattern, mapped] of patterns) {
    if (key.includes(pattern)) return mapped
  }
  const docKey = raw.toUpperCase().replace(/[\s\-]/g, '_')
  return DOC_TYPE_MAP[docKey] ?? raw
}

type LastScanResult = {
  first_name:string|null; middle_name:string|null; last_name:string|null
  dob:string|null; id_number:string|null; expiry_date:string|null
  issue_date:string|null; gender:string|null; address:string|null
  city:string|null; state:string|null; postal_code:string|null
  document_type:string|null; phone:string|null; email:string|null
}

// 'idle' → ready to fill; 'filling' → in progress; 'done' → filled this session
type FillState = 'idle' | 'filling' | 'done'
let _fillState: FillState = 'idle'
let _noDataAttempts = 0
let _sidebarWasOpen = false
let _addResDebounce = 0

const sleep = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))

// ── helpers ──────────────────────────────────────────────────────────────────

/** React-controlled input: must use native setter then dispatch events. */
function reactSet(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input',  { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
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

const MONTHS_SHORT = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']

function parseCalendarHeader(text: string): [number, number] {
  const parts = text.trim().split(/\s+/)
  const m = MONTHS_SHORT.findIndex(m => parts[0].toLowerCase().startsWith(m)) + 1
  const y = parseInt(parts[1] ?? parts[0], 10)
  return [m, y]
}

/**
 * Open an AntD date-picker, navigate to the correct month/year, then click the day cell.
 * dateStr format: "M/D/YYYY" (as stored from Thales OCR).
 */
async function fillCalendarDate(labelText_: string, dateStr: string | null | undefined): Promise<void> {
  if (!dateStr) return
  const parts = dateStr.split('/')
  if (parts.length < 3) return
  const month = parseInt(parts[0], 10)
  const day   = parseInt(parts[1], 10)
  const year  = parseInt(parts[2], 10)
  if (!month || !day || !year) return

  const item = findFormItemByLabel(labelText_)
  const input = (item ?? document).querySelector<HTMLInputElement>(
    '.ant-picker-input input, input[class*="picker"], input[placeholder*="date" i], input[placeholder*="Date" i]'
  )
  if (!input) { console.warn('[FDN] date picker input not found for label:', labelText_); return }

  input.click()
  await sleep(500)

  // Navigate to correct month/year (max 36 steps)
  for (let i = 0; i < 36; i++) {
    // AntD renders the picker panel outside the input — search whole document
    const header = document.querySelector<HTMLElement>(
      '.ant-picker-header-view, [class*="picker-header-view"]'
    )
    if (!header) { console.warn('[FDN] calendar header not found'); break }

    const [dispMonth, dispYear] = parseCalendarHeader(header.textContent ?? '')
    console.log('[FDN] calendar at:', dispMonth, dispYear, '→ target:', month, year)
    if (dispYear === year && dispMonth === month) break

    const goNext = dispYear < year || (dispYear === year && dispMonth < month)

    // AntD month-navigation buttons: .ant-picker-header-next-btn / prev-btn
    // Fallback: find by aria-label or by being the >/< button inside the header
    const headerEl = header.closest('.ant-picker-header, [class*="picker-header"]') ?? header.parentElement
    const buttons = headerEl
      ? Array.from(headerEl.querySelectorAll<HTMLElement>('button, [role="button"]'))
      : []

    let navBtn: HTMLElement | null = null
    if (goNext) {
      navBtn =
        document.querySelector<HTMLElement>('.ant-picker-header-next-btn') ??
        buttons.find(b =>
          b.className.includes('next') && !b.className.includes('super') ||
          (b.getAttribute('aria-label') ?? '').toLowerCase().includes('next month')
        ) ?? null
    } else {
      navBtn =
        document.querySelector<HTMLElement>('.ant-picker-header-prev-btn') ??
        buttons.find(b =>
          b.className.includes('prev') && !b.className.includes('super') ||
          (b.getAttribute('aria-label') ?? '').toLowerCase().includes('prev month')
        ) ?? null
    }

    if (!navBtn) {
      console.warn('[FDN] calendar nav button not found; buttons:', buttons.map(b => b.className))
      break
    }
    navBtn.click()
    await sleep(250)
  }

  await sleep(150)

  // Click the correct day — restrict to cells in the current view month (.ant-picker-cell-in-view)
  const inView = Array.from(document.querySelectorAll<HTMLElement>(
    '.ant-picker-cell.ant-picker-cell-in-view:not(.ant-picker-cell-disabled) .ant-picker-cell-inner, ' +
    '[class*="picker-cell-in-view"]:not([class*="disabled"]) [class*="cell-inner"]'
  ))
  // Fallback: all gridcells if AntD-specific selectors find nothing
  const cells = inView.length > 0
    ? inView
    : Array.from(document.querySelectorAll<HTMLElement>(
        '[role="gridcell"]:not([aria-disabled="true"]), td:not([class*="disabled"]):not([class*="outside"])'
      ))
  console.log('[FDN] calendar day cells:', cells.map(c => c.textContent?.trim()))

  const match = cells.find(c => c.textContent?.trim() === String(day))
  if (match) {
    match.click()
    console.log('[FDN] calendar date selected:', dateStr)
    await sleep(150)
  } else {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    console.warn('[FDN] calendar: day cell not found for day', day)
  }
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

// ── fill orchestrator ────────────────────────────────────────────────────────

async function autoFillGuestInfo(): Promise<void> {
  if (_fillState !== 'idle') return
  _fillState = 'filling'

  const scan = await getLastScanResult()
  if (!scan) {
    _noDataAttempts++
    console.warn(`[FDN] autoFill: no scan data in storage (attempt ${_noDataAttempts})`)
    // After 5 failed attempts give up until sidebar reopens
    _fillState = _noDataAttempts >= 5 ? 'done' : 'idle'
    return
  }

  console.log('[FDN] autoFill: starting fill', { first: scan.first_name, last: scan.last_name, state: scan.state })
  await sleep(400) // let form fully render

  // ── Title prefix ────────────────────────────────────────────────────────────
  if (scan.gender) {
    const g = scan.gender.toUpperCase()
    const title = (g === 'F' || g === 'FEMALE') ? 'Ms.' : 'Mr.'
    // Title prefix select sits in the same row as Full Name input
    const fullNameEl = document.querySelector<HTMLInputElement>('input[placeholder="Full Name"]')
    if (fullNameEl) {
      // Walk up to find the row/form-item, then find the first ant-select inside it
      let node: Element | null = fullNameEl.parentElement
      let titleTrigger: HTMLElement | null = null
      for (let i = 0; i < 8 && node; i++) {
        titleTrigger = node.querySelector<HTMLElement>('.ant-select-selector, [class*="select-selector"]')
        if (titleTrigger) break
        node = node.parentElement
      }
      if (titleTrigger) {
        await openAndPickOption(titleTrigger, title, 200)
        await sleep(100)
      }
    }
  }

  // ── Text inputs ─────────────────────────────────────────────────────────────
  const fullName = [scan.first_name, scan.last_name].filter(Boolean).join(' ')
  fillPlaceholder('Full Name', fullName)

  // ── Mobile ──────────────────────────────────────────────────────────────────
  if (scan.phone) {
    const raw = scan.phone.replace(/\D/g, '')
    // Strip country code only when 11 digits starting with "1" (US +1 prefix)
    const digits = (raw.length === 11 && raw.startsWith('1')) ? raw.slice(1) : raw
    console.log('[FDN] phone value:', scan.phone, '→ digits:', digits)
    const mobileEl = document.querySelector<HTMLInputElement>('input[placeholder="Mobile"]')
    if (mobileEl) reactSet(mobileEl, digits)
    else console.warn('[FDN] Mobile input not found')
  }

  // ── Email (BUG 2 fix) ────────────────────────────────────────────────────────
  console.log('[FDN] email value:', scan.email)
  if (scan.email) {
    const emailEl = document.querySelector<HTMLInputElement>('input[placeholder="Email"]')
    if (emailEl) reactSet(emailEl, scan.email)
    else console.warn('[FDN] Email input not found')
  }

  fillPlaceholder('Address', scan.address)
  fillPlaceholder('Zip', scan.postal_code)

  // ── Country ─────────────────────────────────────────────────────────────────
  await fillDropdownByLabel('Country', 'United States of America')

  // ── State (2-letter code → full state name) ──────────────────────────────────
  const stateCode = (scan.state ?? '').toUpperCase().trim()
  const stateName = US_STATES[stateCode] ?? scan.state ?? ''
  if (stateName) {
    await fillDropdownByLabel('State', stateName)
    await sleep(500) // City options cascade from State — wait for them to load
  }

  // ── City ─────────────────────────────────────────────────────────────────────
  if (scan.city) {
    const cityItem = findFormItemByLabel('City')
    if (cityItem) {
      await fillCityWithPoll(cityItem, scan.city)
    } else {
      console.warn('[FDN] City form item not found')
    }
  }

  // ── ID Number ────────────────────────────────────────────────────────────────
  fillPlaceholder('ID Number', scan.id_number)

  // ── ID Type — portal-rendered options, use normalizeDocType for site text match ──
  const docLabel = normalizeDocType(scan.document_type)
  if (docLabel) {
    const idTypeItem = findFormItemByLabel('ID Type')
    const idTypeTrigger = idTypeItem
      ? getAntSelectTrigger(idTypeItem)
      : document.querySelector<HTMLElement>(
          '[class*="idType"] .ant-select-selector, [class*="id-type"] .ant-select-selector'
        )
    if (idTypeTrigger) {
      console.log('[FDN] ID Type: clicking trigger')
      idTypeTrigger.click()
      await sleep(400)
      // Options render in a portal at body level — use [role="option"] + broad selectors
      const opts = Array.from(document.querySelectorAll<HTMLElement>(
        '[role="option"], .ant-select-item-option-content, .ant-select-item, [class*="option-content"], [class*="option-item"]'
      ))
      console.log('[FDN] ID Type options:', opts.map(o => o.textContent?.trim()))
      const needle = docLabel.toLowerCase()
      const match =
        opts.find(o => (o.textContent?.trim() ?? '').toLowerCase() === needle) ??
        opts.find(o => (o.textContent?.trim() ?? '').toLowerCase().includes(needle))
      if (match) {
        match.click()
        console.log('[FDN] ID Type selected →', match.textContent?.trim())
        await sleep(120)
      } else {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        console.warn('[FDN] ID Type: no match for', docLabel)
      }
    } else {
      console.warn('[FDN] ID Type trigger not found')
    }
  }

  // ── Expiry Date (BUG 4 fix) — navigate calendar and click day cell ───────────
  if (scan.expiry_date) {
    await fillCalendarDate('expiry_date', scan.expiry_date)
  }

  _fillState = 'done'
  console.log('[FDN] autoFill: complete ✓')
}

// ── observer ─────────────────────────────────────────────────────────────────

function checkGuestForm(): void {
  const visible = isGuestFormVisible()
  console.log('[FDN] checkGuestForm:', { visible, fillState: _fillState })

  // Detect sidebar close → reset for next open
  if (_sidebarWasOpen && !visible && isSidebarClosed()) {
    _fillState = 'idle'
    _noDataAttempts = 0
    _sidebarWasOpen = false
    console.log('[FDN] Add Reservation closed — fill state reset')
    return
  }

  if (visible) {
    _sidebarWasOpen = true
    if (_fillState === 'idle') {
      console.log('[FDN] Guest form visible + idle → starting autoFill')
      void autoFillGuestInfo()
    }
  }
}

const addResObserver = new MutationObserver(() => {
  window.clearTimeout(_addResDebounce)
  _addResDebounce = window.setTimeout(checkGuestForm, 180)
})
addResObserver.observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'aria-selected', 'aria-expanded', 'aria-hidden'],
})
console.log('[FDN] addResObserver registered on document.body')

export {}
