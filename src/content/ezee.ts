import {
  extractEzeeScrapeFields,
  ezeeScrapeToGuestDisplay,
  ezeeScrapeToSnapshot,
  isCompleteEzeeGuestScrape,
  isEzeeFolioContext,
  isEzeeGuestDrawerOpen,
  isEzeeGuestScrapeAllowed,
  probeEzeeDrawer,
} from '../lib/ezee-drawer-extract'
import type { EzeeGuestDisplay, ReservationSnapshot } from '../shared/pms-types'
import { US_STATES_BY_CODE as US_STATES } from '../lib/us-states'
import {
  ezeeExpiryPickerTitle,
  formatEzeeExpiryForPicker,
  mapIdTypeToEzeeDropdownOption,
  parseEzeeExpiryParts,
} from '../lib/ezee-pms-id-map'
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
  if (!isEzeeGuestScrapeAllowed(document)) {
    return {
      ok: false,
      error:
        'Guest data is not available on this tab — open Guest Details or use the Arrivals guest drawer.',
    }
  }
  if (!isEzeeGuestDrawerOpen(document)) {
    return { ok: false, error: 'Guest drawer is not open.' }
  }
  const fields = extractEzeeScrapeFields(document)
  if (!fields || !isCompleteEzeeGuestScrape(fields)) {
    console.warn('[FDN eZee] EZEE_EXTRACT_NOW: scrape failed', probeEzeeDrawer(document))
    return {
      ok: false,
      error: 'Could not read complete guest data — open Guest Details or the Arrivals guest drawer.',
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
  // Only auto-detect guests on the reservations list page, not other eZee pages.
  if (!location.pathname.startsWith('/unity/reservations')) return

  if (!isEzeeGuestScrapeAllowed(document)) {
    if (isEzeeFolioContext(document)) {
      console.info('[FDN eZee] Folio / edit reservation — keeping loaded guest; auto-detect skipped')
    }
    wasDrawerOpen = false
    lastDedupeKey = null
    return
  }

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
  if (!fields || !isCompleteEzeeGuestScrape(fields)) {
    logThrottledFailProbe(probeEzeeDrawer(document))
    return
  }

  const conf = fields.reservationNumber!.trim()
  const roomHint = (fields.roomNumber ?? '').trim()
  const statusHint = (fields.status ?? '').trim()
  const dedupeKey = `${conf}|${roomHint}|${statusHint}`
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
  const want = text.trim().toLowerCase()
  for (const item of Array.from(document.querySelectorAll('.ant-form-item, [class*="form-item"]'))) {
    const labelEl = item.querySelector('.ant-form-item-label label, .ant-form-item-label')
    const candidates = labelEl
      ? [labelEl, ...Array.from(item.querySelectorAll('label, [class*="label"]'))]
      : Array.from(item.querySelectorAll('label, [class*="label"]'))
    for (const lbl of candidates) {
      const got = labelText(lbl).toLowerCase()
      if (got === want || got.startsWith(`${want} `)) return item
      if (want === 'id type' && /^id\s*type\b/.test(got)) return item
      if (want === 'expiry date' && /^expiry\s*date\b/.test(got)) return item
    }
  }
  return null
}

function findInputInFormItem(formItem: Element): HTMLInputElement | null {
  return (
    formItem.querySelector<HTMLInputElement>('input:not([type="hidden"]):not([type="checkbox"])') ??
    null
  )
}

async function ensureIdentitySectionExpanded(): Promise<void> {
  for (const hdr of document.querySelectorAll<HTMLElement>(
    '.ant-collapse-header, [class*="collapse-header"], .ant-card-head, legend, h3, h4, h5, [class*="section-title"], [class*="SectionTitle"]',
  )) {
    const text = (hdr.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!/identity\s*information/i.test(text)) continue

    const item = hdr.closest('.ant-collapse-item, [class*="collapse-item"]')
    const expanded =
      item?.classList.contains('ant-collapse-item-active') ||
      hdr.getAttribute('aria-expanded') === 'true'
    if (!expanded) {
      hdr.click()
      await sleep(400)
    }
    return
  }
}

async function fillInputByLabel(label: string, value: string | null | undefined): Promise<boolean> {
  if (!value?.trim()) return false
  const item = findFormItemByLabel(label)
  if (!item) {
    console.warn('[FDN] fillInputByLabel: form item not found →', label)
    return false
  }
  const input = findInputInFormItem(item)
  if (!input) {
    console.warn('[FDN] fillInputByLabel: input not found →', label)
    return false
  }
  reactSet(input, value.trim())
  console.log('[FDN] filled:', label, '←', value.trim())
  await sleep(80)
  return true
}

function getVisibleAntSelectDropdown(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('.ant-select-dropdown')) {
    if (el.classList.contains('ant-select-dropdown-hidden')) continue
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    return el
  }
  return null
}

function findAntSelectOptionRow(optionText: string, root?: ParentNode): HTMLElement | null {
  const needle = optionText.toLowerCase().trim()
  const scope = root ?? getVisibleAntSelectDropdown() ?? document

  for (const opt of scope.querySelectorAll<HTMLElement>('.ant-select-item.ant-select-item-option')) {
    const title = (opt.getAttribute('title') ?? '').trim().toLowerCase()
    const labelAttr = (opt.getAttribute('label') ?? '').trim().toLowerCase()
    const content = (opt.querySelector('.ant-select-item-option-content')?.textContent ?? '')
      .trim()
      .toLowerCase()
    const text = title || labelAttr || content
    if (!text || text === '-select-') continue
    if (text === needle || text.includes(needle) || needle.includes(text)) {
      return opt
    }
  }
  return null
}

async function openAntSelect(trigger: HTMLElement): Promise<void> {
  trigger.focus()
  trigger.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
  )
  await sleep(40)
  trigger.click()
  await sleep(450)
}

async function pickAntSelectOption(optionText: string): Promise<boolean> {
  let row = findAntSelectOptionRow(optionText)
  if (!row) {
    await sleep(200)
    row = findAntSelectOptionRow(optionText)
  }
  if (!row) {
    const names = Array.from(
      (getVisibleAntSelectDropdown() ?? document).querySelectorAll(
        '.ant-select-item-option-content',
      ),
    ).map((o) => o.textContent?.trim())
    console.warn('[FDN] dropdown: no row for', optionText, '— visible:', names)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return false
  }

  row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
  row.click()
  const inner = row.querySelector<HTMLElement>('.ant-select-item-option-content')
  if (inner) inner.click()
  console.log('[FDN] dropdown: selected →', optionText)
  await sleep(150)
  return true
}

function getAntSelectTrigger(formItem: Element): HTMLElement | null {
  const select = formItem.querySelector('.ant-select')
  if (select) {
    const t = select.querySelector<HTMLElement>('.ant-select-selector')
    if (t) return t
  }
  return formItem.querySelector<HTMLElement>('.ant-select-selector, [class*="select-selector"]')
}

async function fillAntSelectByLabel(label: string, optionText: string): Promise<boolean> {
  const item = findFormItemByLabel(label)
  if (!item) {
    console.warn('[FDN] fillAntSelectByLabel: label not found →', label)
    return false
  }
  const trigger = getAntSelectTrigger(item)
  if (!trigger) {
    console.warn('[FDN] fillAntSelectByLabel: no .ant-select-selector →', label)
    return false
  }
  await openAntSelect(trigger)
  return pickAntSelectOption(optionText)
}

function findExpiryDateInput(): HTMLInputElement | null {
  const byId = document.querySelector<HTMLInputElement>('#add-reservation-Form_expirydate')
  if (byId) return byId
  const item = findFormItemByLabel('Expiry Date')
  if (!item) return null
  return (
    item.querySelector<HTMLInputElement>('.ant-picker input') ??
    item.querySelector<HTMLInputElement>('input[placeholder*="date" i]') ??
    findInputInFormItem(item)
  )
}

function getVisibleAntPickerDropdown(): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('.ant-picker-dropdown')) {
    if (el.classList.contains('ant-picker-dropdown-hidden')) continue
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    return el
  }
  return null
}

async function pickAntPickerCell(titleYyyyMmDd: string): Promise<boolean> {
  const panel = getVisibleAntPickerDropdown()
  if (!panel) return false

  const cell =
    panel.querySelector<HTMLElement>(`td[title="${titleYyyyMmDd}"] .ant-picker-cell-inner`) ??
    panel.querySelector<HTMLElement>(`td[title="${titleYyyyMmDd}"]`)
  if (!cell) {
    console.warn('[FDN] date picker: no cell for title=', titleYyyyMmDd)
    return false
  }
  cell.click()
  await sleep(120)
  return true
}

/** Ant Design DatePicker (#add-reservation-Form_expirydate, readonly). */
async function fillExpiryDateByLabel(label: string, rawExpiry: string | null | undefined): Promise<boolean> {
  const parts = parseEzeeExpiryParts(rawExpiry)
  if (!parts) {
    console.warn('[FDN] Expiry Date: unrecognized format', rawExpiry)
    return false
  }

  const display = formatEzeeExpiryForPicker(rawExpiry)!
  const pickerTitle = ezeeExpiryPickerTitle(rawExpiry)!
  const input = findExpiryDateInput()
  if (!input) {
    console.warn('[FDN] Expiry Date: input not found (', label, ')')
    return false
  }

  const pickerWrap = input.closest<HTMLElement>('.ant-picker')
  if (pickerWrap) {
    pickerWrap.click()
    await sleep(350)
  } else {
    input.click()
    await sleep(350)
  }

  if (await pickAntPickerCell(pickerTitle)) {
    console.log('[FDN] filled: Expiry Date (calendar) ←', display)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  }

  input.removeAttribute('readonly')
  reactSet(input, display)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  input.blur()
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  await sleep(80)

  const v = input.value?.trim()
  if (v) {
    console.log('[FDN] filled: Expiry Date (input) ←', v)
    return true
  }

  console.warn('[FDN] Expiry Date: calendar + input set failed for', rawExpiry, '→', display)
  return false
}

/** Identity Information: ID #, ID Type (Ant select), Expiry (date input MM-DD-YYYY). */
async function autoFillIdentityInformation(scan: LastScanResult): Promise<void> {
  await ensureIdentitySectionExpanded()
  await sleep(200)

  if (scan.id_number?.trim()) {
    await fillInputByLabel('ID Number', scan.id_number)
  }

  const idTypeOption = mapIdTypeToEzeeDropdownOption(scan.document_type)
  if (idTypeOption) {
    const alternates = [
      idTypeOption,
      idTypeOption === 'Driving License' ? 'Drivers License' : null,
      idTypeOption === 'Driving License' ? 'Driver License' : null,
    ].filter(Boolean) as string[]
    let picked = false
    for (const opt of alternates) {
      if (await fillAntSelectByLabel('ID Type', opt)) {
        picked = true
        break
      }
    }
    if (!picked) {
      console.warn('[FDN] ID Type dropdown: could not select', idTypeOption, '(from', scan.document_type, ')')
    }
  }

  if (scan.expiry_date?.trim()) {
    await fillExpiryDateByLabel('Expiry Date', scan.expiry_date)
  }
}

async function openAndPickOption(trigger: HTMLElement, optionText: string, waitMs = 320): Promise<boolean> {
  console.log('[FDN] dropdown: opening for option =', optionText)
  await openAntSelect(trigger)
  await sleep(Math.max(0, waitMs - 450))
  return pickAntSelectOption(optionText)
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

  await autoFillIdentityInformation(scan)

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

  // ── Full Name input (placeholder="Name", id="GuestTranDetails_name") ─────────
  const fullName = [scan.first_name, scan.last_name].filter(Boolean).join(' ')
  const nameInput = document.querySelector<HTMLInputElement>('input[placeholder="Name"]')
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
  if (!clickedTab) return
  const tabText = (clickedTab.textContent ?? '').replace(/\s+/g, ' ')
  if (/folio\s*operations/i.test(tabText)) {
    scheduleCheck()
    return
  }
  if (!tabText.includes('Guest Details')) {
    _fillInProgress = false
  }
})

// ── Print Guest Registration Card detection ───────────────────────────────────
// eZee renders the dropdown at body level via Ant Design portal.
// Capture phase fires before any component stopPropagation.

function waitForReportIframe(timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let pollTimer = 0

    function done(src: string | null): void {
      if (settled) return
      settled = true
      obs.disconnect()
      window.clearInterval(pollTimer)
      window.clearTimeout(timer)
      resolve(src)
    }

    // eZee loads the report via JS navigation — iframe.src stays "".
    // Read contentWindow.location.href (same-origin) to get the real URL.
    function check(): void {
      const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))
      for (const f of iframes) {
        if (f.id !== 'reportFrame' && f.name !== 'reportFrame') continue
        try {
          const href = f.contentWindow?.location?.href ?? ''
          console.log('[FDN eZee] reportFrame href:', href.slice(0, 150))
          if (href && href !== 'about:blank' && href.includes('stimulsoftJSON')) {
            done(href)
            return
          }
        } catch {
          // cross-origin guard — should not happen on live.ipms247.com
        }
      }
    }

    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { childList: true, subtree: true })

    check()
    pollTimer = window.setInterval(check, 300)

    const timer = window.setTimeout(() => {
      console.warn('[FDN eZee] reportFrame URL not found within timeout')
      done(null)
    }, timeoutMs)
  })
}

document.addEventListener(
  'click',
  (event) => {
    const el = event.target as HTMLElement
    const menuItem = el.closest('li[role="menuitem"]') as HTMLElement | null
    if (!menuItem) return
    if (menuItem.textContent?.trim() !== 'Print Guest Registration Card') return

    const conf = lastDedupeKey ? lastDedupeKey.split('|')[0]! : ''
    console.log('[FDN eZee] Print Guest Registration Card clicked | confirmation:', conf || '(unknown)')

    void chrome.runtime.sendMessage({
      type: 'EZEE_PRINT_BASIC_CARD_CLICKED',
      confirmation: conf,
    }).catch(() => { /* extension may not be listening */ })

    void waitForReportIframe().then((iframeUrl) => {
      if (!iframeUrl) return
      console.log('[FDN eZee] Report iframe URL:', iframeUrl)

      // chrome.windows is not available in content scripts — delegate to service worker
      void chrome.runtime.sendMessage({
        type: 'EZEE_OPEN_REG_CARD',
        ezeeReportUrl: iframeUrl,
        confirmation: conf,
      }).catch(() => { /* extension may not be listening */ })
    })
  },
  true,
)

// ── Check-in confirmation auto-search ────────────────────────────────────────
//
// Detects the eZee "Guest has been checked in successfully" success toast,
// extracts the Reservation No, then auto-types it into Quick Search and clicks
// the single result card so the guest drawer opens automatically.

const CHECKIN_SUCCESS_LC = 'guest has been checked in successfully'
const CHECKIN_RES_NO_RE = /Reservation\s+no\s+is\s*:\s*(\d+)/i
const CHECKIN_DEDUPE_MS = 30_000

let lastCheckinResNo: string | null = null
let lastCheckinAt = 0
let _autoSearchRunning = false

/**
 * The target toast has these distinguishing characteristics:
 *   • Dark floating Ant Design success message/notification (not a modal dialog)
 *   • Green ✓ check-circle icon  (aria-label="check-circle" / .anticon-check-circle)
 *   • Text: "The Guest has been checked in successfully. Guest folio no is : X and Reservation no is : Y"
 *
 * False-positive guards:
 *   • The "CONFIRM – Do you want to charge early Check-In Rate?" dialog uses a ⚠ exclamation-circle
 *     icon and lives inside .ant-modal-confirm-body — excluded by the closest() check.
 *   • Table rows / drawer bodies are also excluded.
 */
function tryExtractCheckinResNo(el: Element): string | null {
  const text = el.textContent ?? ''
  if (!text.toLowerCase().includes(CHECKIN_SUCCESS_LC)) return null
  if (!CHECKIN_RES_NO_RE.test(text)) return null

  // Not inside a confirm dialog, drawer, or data table
  if (el.closest(
    '.ant-modal-confirm-body, .ant-modal-body, .ant-drawer-body, .ant-table-tbody, tr, td',
  )) return null

  // Must carry the success ✓ icon — the CONFIRM dialog has ⚠, info has ℹ
  const hasCheckIcon =
    !!el.querySelector('[aria-label="check-circle"], .anticon-check-circle, [data-icon="check-circle"]') ||
    el.classList.contains('ant-message-success') ||
    !!el.closest('.ant-message-success, .ant-notification-notice-success')
  if (!hasCheckIcon) return null

  return text.match(CHECKIN_RES_NO_RE)?.[1] ?? null
}

function handleCheckinConfirmed(resNo: string): void {
  const now = Date.now()
  if (resNo === lastCheckinResNo && now - lastCheckinAt < CHECKIN_DEDUPE_MS) return
  lastCheckinResNo = resNo
  lastCheckinAt = now
  console.info('[FDN eZee] Check-in confirmed — Reservation No:', resNo)
  void autoSearchAndSelect(resNo)
}

// Dedicated zero-debounce observer — catches the toast the instant it hits the DOM.
// Separate from the guest-drawer observer to keep the two concerns isolated.
const checkinToastObserver = new MutationObserver((mutations) => {
  outer: for (const mutation of mutations) {
    for (const node of Array.from(mutation.addedNodes)) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const root = node as Element
      // Check the added node itself, then every descendant.
      // The toast subtree is tiny (≈10 elements); cost is negligible.
      for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
        const resNo = tryExtractCheckinResNo(el)
        if (resNo) { handleCheckinConfirmed(resNo); break outer }
      }
    }
  }
})
checkinToastObserver.observe(document.body, { childList: true, subtree: true })

async function autoSearchAndSelect(resNo: string): Promise<void> {
  if (_autoSearchRunning) return
  if (!location.pathname.startsWith('/unity/reservations')) return

  _autoSearchRunning = true
  try {
    // Brief pause so the Add Reservation modal finishes its close animation
    await sleep(350)

    const searchInput = document.querySelector<HTMLInputElement>('input[placeholder="Quick Search"]')
    if (!searchInput) {
      console.warn('[FDN eZee] autoSearchAndSelect: Quick Search input not found')
      return
    }

    // Helper: set value via React's native setter + fire input event (no blur)
    const setSearchVal = (v: string) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (s) s.call(searchInput, v)
      else searchInput.value = v
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    }

    const current = searchInput.value.trim()
    if (current && current !== resNo) {
      // Another search term is in the field — clear it first so eZee resets
      // the dropdown state before we type the new confirmation number
      searchInput.focus()
      setSearchVal('')
      await sleep(200)
    }

    // Fill without blur — reactSet calls el.blur() which fires Ant Design's
    // onBlur handler and permanently marks the input as unfocused, breaking
    // every subsequent manual search until the page reloads.
    searchInput.focus()
    setSearchVal(resNo)
    console.info('[FDN eZee] autoSearchAndSelect: typing reservation no', resNo)

    if (!await waitForCheckinResultCard(resNo, 4_000)) {
      // One retry — eZee's search API can be slow
      await sleep(2_000)
      if (!await waitForCheckinResultCard(resNo, 3_000)) {
        console.warn('[FDN eZee] autoSearchAndSelect: result card not found for reservation no', resNo)
      }
    }
  } finally {
    _autoSearchRunning = false
  }
}

async function waitForCheckinResultCard(resNo: string, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    const card = findCheckinResultCard(resNo)
    if (card) {
      clickCheckinCard(card)
      console.info('[FDN eZee] autoSearchAndSelect: clicked result for reservation no', resNo)
      return true
    }
    await sleep(250)
  }
  return false
}

/**
 * React/Ant Design components require a real mousedown before click to register.
 * We also try the inner card body — eZee's React handler may sit on a child element.
 */
function clickCheckinCard(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
  el.click()
  const inner = el.querySelector<HTMLElement>(
    '.ant-card-body, .ant-list-item-main, [class*="card-body"], [class*="cardBody"], [class*="item-main"]',
  )
  if (inner) {
    inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
    inner.click()
  }
}

/**
 * Finds the Quick Search result card for the given reservation number.
 * Matches "Res No # 3629" / "Res No #3629" / "Res No  #  3629" (flexible spacing).
 */
function findCheckinResultCard(resNo: string): HTMLElement | null {
  const resNoPattern = new RegExp(`Res\\s*No\\s*#\\s*${resNo}`)

  // Priority 1: Ant Design select-item (AutoComplete dropdown), card, list-item, custom variants
  for (const sel of [
    '.ant-select-item',
    '.ant-card',
    '.ant-list-item',
    '[class*="resCard"]',
    '[class*="bookingCard"]',
    '[class*="searchItem"]',
    '[class*="search-item"]',
  ]) {
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      if (!isCheckinElVisible(el)) continue
      if (resNoPattern.test((el.textContent ?? '').replace(/\s+/g, ' '))) return el
    }
  }

  // Priority 2: any div/li carrying the pattern, outside the header/search bar
  for (const el of document.querySelectorAll<HTMLElement>('div[class], li')) {
    if (!isCheckinElVisible(el)) continue
    if (el.closest('header, nav, [class*="header"], [class*="search-bar"]')) continue
    const text = (el.textContent ?? '').replace(/\s+/g, ' ')
    if (!resNoPattern.test(text)) continue
    const r = el.getBoundingClientRect()
    if (r.width > 200 && r.height > 40 && r.width < window.innerWidth * 0.95) return el
  }

  return null
}

function isCheckinElVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

export {}
