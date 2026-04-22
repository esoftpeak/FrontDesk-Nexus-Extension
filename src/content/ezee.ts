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

// ── Add Reservation sidebar auto-fill ────────────────────────────────────────

const US_STATES: Record<string, string> = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', FL:'Florida', GA:'Georgia',
  HI:'Hawaii', ID:'Idaho', IL:'Illinois', IN:'Indiana', IA:'Iowa', KS:'Kansas',
  KY:'Kentucky', LA:'Louisiana', ME:'Maine', MD:'Maryland', MA:'Massachusetts',
  MI:'Michigan', MN:'Minnesota', MS:'Mississippi', MO:'Missouri', MT:'Montana',
  NE:'Nebraska', NV:'Nevada', NH:'New Hampshire', NJ:'New Jersey',
  NM:'New Mexico', NY:'New York', NC:'North Carolina', ND:'North Dakota',
  OH:'Ohio', OK:'Oklahoma', OR:'Oregon', PA:'Pennsylvania', RI:'Rhode Island',
  SC:'South Carolina', SD:'South Dakota', TN:'Tennessee', TX:'Texas', UT:'Utah',
  VT:'Vermont', VA:'Virginia', WA:'Washington', WV:'West Virginia',
  WI:'Wisconsin', WY:'Wyoming', DC:'District of Columbia',
}

const DOC_TYPE_MAP: Record<string, string> = {
  DRIVERS_LICENSE: "Driver's License",
  DRIVER_LICENSE:  "Driver's License",
  DL:              "Driver's License",
  PASSPORT:        'Passport',
  ID_CARD:         'ID Card',
  STATE_ID:        'State ID',
  MILITARY_ID:     'Military ID',
}

type LastScanResult = {
  first_name: string | null; middle_name: string | null; last_name: string | null
  dob: string | null; id_number: string | null; expiry_date: string | null
  issue_date: string | null; gender: string | null; address: string | null
  city: string | null; state: string | null; postal_code: string | null
  document_type: string | null
}

let _addResFillDone = false
let _addResSidebarWasOpen = false
let _addResDebounceTimer = 0

/** Use React's native setter so controlled inputs update state. */
function setReactValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event('input',  { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

function fillByPlaceholder(placeholder: string, value: string | null | undefined): boolean {
  if (!value) return false
  const el = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  if (!el) return false
  setReactValue(el, value)
  return true
}

/** Walk up from an element until we find a node containing an ant-select. */
function findAntSelectInRow(anchor: Element, maxLevels = 6): HTMLElement | null {
  let node: Element | null = anchor
  for (let i = 0; i < maxLevels; i++) {
    if (!node) break
    const sel = node.querySelector<HTMLElement>('.ant-select-selector')
    if (sel) return sel
    node = node.parentElement
  }
  return null
}

function findFormItemByLabel(labelText: string): Element | null {
  for (const item of Array.from(document.querySelectorAll('.ant-form-item'))) {
    const lbl = item.querySelector<HTMLElement>('label')
    if (lbl?.textContent?.trim() === labelText) return item
  }
  return null
}

async function clickAntSelectOption(labelText: string, optionText: string): Promise<boolean> {
  const formItem = findFormItemByLabel(labelText)
  if (!formItem) return false
  const trigger = formItem.querySelector<HTMLElement>('.ant-select-selector')
  if (!trigger) return false
  trigger.click()
  await new Promise<void>(r => window.setTimeout(r, 220))
  for (const opt of Array.from(document.querySelectorAll<HTMLElement>(
    '.ant-select-item-option-content, .ant-select-item',
  ))) {
    if (opt.textContent?.trim() === optionText) {
      opt.click()
      return true
    }
  }
  // No match — close dropdown
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return false
}

async function fillAntDatePicker(labelText: string, dateStr: string | null | undefined): Promise<void> {
  if (!dateStr) return
  const formItem = findFormItemByLabel(labelText)
  const input = (formItem ?? document).querySelector<HTMLInputElement>('.ant-picker-input input')
  if (!input) return
  input.focus()
  setReactValue(input, dateStr)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await new Promise<void>(r => window.setTimeout(r, 120))
  // Close picker
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}

function isAddResSidebarOpen(): boolean {
  const titleSelectors = ['.ant-modal-title', '.ant-drawer-title', '.ant-modal-header .ant-typography']
  return titleSelectors.some(sel =>
    Array.from(document.querySelectorAll(sel)).some(el =>
      el.textContent?.trim() === 'Add Reservation',
    ),
  )
}

function isGuestInfoStepActive(): boolean {
  // Ant Design Steps: active step carries ant-steps-item-process
  for (const step of Array.from(document.querySelectorAll('.ant-steps-item'))) {
    const title = step.querySelector('.ant-steps-item-title')?.textContent ?? ''
    if (title.includes('Guest Information') && step.classList.contains('ant-steps-item-process')) {
      return true
    }
  }
  // Fallback: aria-selected or active class on any element containing the text
  return Array.from(document.querySelectorAll('[aria-selected="true"], .active'))
    .some(el => (el.textContent ?? '').includes('Guest Information'))
}

async function autoFillGuestInfo(): Promise<void> {
  if (_addResFillDone) return
  _addResFillDone = true

  const { lastScanResult } = await chrome.storage.local.get('lastScanResult') as {
    lastScanResult: LastScanResult | undefined
  }
  if (!lastScanResult) {
    console.info('[FDN eZee] autoFill: no lastScanResult in storage — scan first')
    return
  }
  const s = lastScanResult
  console.info('[FDN eZee] autoFill: filling Guest Information', { first: s.first_name, last: s.last_name })

  // Allow form to fully render before filling
  await new Promise<void>(r => window.setTimeout(r, 350))

  // ── Title prefix (gender → Mr. / Ms.) ──────────────────────────────────────
  if (s.gender) {
    const gUpper = s.gender.toUpperCase()
    const title = (gUpper === 'F' || gUpper === 'FEMALE') ? 'Ms.' : 'Mr.'
    // The prefix select is in the same row as Full Name — find it via anchor
    const fullNameInput = document.querySelector<HTMLInputElement>('input[placeholder="Full Name"]')
    if (fullNameInput) {
      const trigger = findAntSelectInRow(fullNameInput)
      if (trigger) {
        trigger.click()
        await new Promise<void>(r => window.setTimeout(r, 200))
        for (const opt of Array.from(document.querySelectorAll<HTMLElement>(
          '.ant-select-item-option-content, .ant-select-item',
        ))) {
          if (opt.textContent?.trim() === title) { opt.click(); break }
        }
        await new Promise<void>(r => window.setTimeout(r, 100))
      }
    }
  }

  // ── Guest name ─────────────────────────────────────────────────────────────
  const fullName = [s.first_name, s.last_name].filter(Boolean).join(' ')
  fillByPlaceholder('Full Name', fullName)

  // ── Address ────────────────────────────────────────────────────────────────
  fillByPlaceholder('Address', s.address)

  // ── Zip ────────────────────────────────────────────────────────────────────
  fillByPlaceholder('Zip', s.postal_code)

  // ── Country ────────────────────────────────────────────────────────────────
  await clickAntSelectOption('Country', 'United States of America')

  // ── State (2-letter → full name) ───────────────────────────────────────────
  const stateCode = (s.state ?? '').toUpperCase().trim()
  const stateName = US_STATES[stateCode] ?? s.state ?? ''
  if (stateName) await clickAntSelectOption('State', stateName)

  // ── City (may be cascaded after state) ─────────────────────────────────────
  await new Promise<void>(r => window.setTimeout(r, 180))
  if (s.city) await clickAntSelectOption('City', s.city)

  // ── Identity section ───────────────────────────────────────────────────────
  fillByPlaceholder('ID Number', s.id_number)

  const docKey = (s.document_type ?? '').toUpperCase().replace(/[\s\-]/g, '_')
  const docLabel = DOC_TYPE_MAP[docKey] ?? s.document_type ?? ''
  if (docLabel) await clickAntSelectOption('ID Type', docLabel)

  // ── Expiry Date ────────────────────────────────────────────────────────────
  await fillAntDatePicker('Expiry Date', s.expiry_date)

  console.info('[FDN eZee] autoFill: done')
}

function checkAddResSidebar(): void {
  const open = isAddResSidebarOpen()
  if (!open && _addResSidebarWasOpen) {
    _addResFillDone = false
    console.info('[FDN eZee] Add Reservation sidebar closed — fill flag reset')
  }
  _addResSidebarWasOpen = open
  if (open && isGuestInfoStepActive() && !_addResFillDone) {
    void autoFillGuestInfo()
  }
}

const addResObserver = new MutationObserver(() => {
  window.clearTimeout(_addResDebounceTimer)
  _addResDebounceTimer = window.setTimeout(checkAddResSidebar, 150)
})
addResObserver.observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['class', 'aria-selected', 'style'],
})

export {}
