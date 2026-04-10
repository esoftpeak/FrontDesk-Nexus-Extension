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

export {}
