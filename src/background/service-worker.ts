import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type {
  ExtensionMessage,
  ExtensionResponse,
  ExtensionState,
  IdScanHistoryRow,
  KeyHistoryRow,
  NativeHostRxDebugBroadcast,
  NativeIdScanBroadcast,
  PanelToastBroadcast,
  GuestStayHistoryRecord,
  PendingGuestDraft,
  ReturningGuestRecord,
  ScanFrontBroadcast,
} from '../shared/protocol'
import {
  FDN_PENDING_GUEST_DRAFT_KEY,
  GUEST_DRAFT_AUTOSAVE_MIN_MS,
} from '../shared/protocol'
import type {
  EzeeGuestDisplay,
  IdScanDetailGuru,
  ParsedIdFields,
  ReservationSnapshot,
  SynxisGuestDisplay,
} from '../shared/pms-types'
import { checkActiveDnr, idVariantsForDnrLookup, normalizeIdNumber } from '../lib/dnr'
import {
  DEFAULT_EXTENSION_HOTEL_SETTINGS,
  parseHotelSettingsValue,
} from '../lib/hotel-settings'
import { encryptBinary, encryptJson, hashIdNumber, hashPhoneNumber } from '../lib/encryption'
import {
  filterRecordsByPhone,
  guestStayRecordFromScanRow,
} from '../lib/guest-stay-history'
import { buildIdScanLogFromScanRows } from '../lib/id-scan-log'
import { searchIdScanHistory } from '../lib/id-scan-history-search'
import { buildSignatureLogFromRows } from '../lib/signature-log'
import {
  createRoomBlockSw,
  fetchKeyBoardData,
  fetchKeyLedger,
  keysWriteAuthorized,
  releaseRoomBlockSw,
} from '../lib/keys-operations-sw'
import { isCompletePhoneForLookup } from '../lib/phone-lookup'
import {
  isCompleteTwoSidedScan,
  writeScanImagesToStorage,
  writeScanPhase,
} from '../lib/scan-image-storage'
import { createExtensionSupabase } from '../lib/supabase-factory'
import { guessImageMimeFromBase64 } from '../lib/imageMime'
import { pingNativeHost } from '../lib/native-scan'
import type { NativeScanSuccessPayload } from '../nativeMessaging/types'
import { initNativeHost, sendNativeMessage, sendNativeRequest } from '../nativeHost'
import { checkMinExtensionVersion } from '../lib/version-check'
import { toSdkDatetimeHotel } from '../lib/hotel-dates'
import { logSynxisGuestSpecConsole, parseSynxisReservationSummaryResponse } from '../lib/synxis-guest-summary'
import { isSynxisConfirmationToken } from '../lib/synxis-confirmation-dom'
import {
  buildMergedScrapePayload,
  formatRoomChainForColumn,
  mergeRoomNumberHistory,
} from '../lib/reservation-merge'
import { synxisExtractInFrame } from '../lib/synxis-extract-in-frame'
import { isValidEzeeReservationNumber } from '../lib/ezee-drawer-extract'
import {
  formatDollarLog,
  parseMoneyToNumber,
  prepareMoneyColumnForDb,
} from '../lib/parse-money'

let supabase: SupabaseClient | null = null

// ── RFID encoder hardware status ─────────────────────────────────────────────
// Updated via the onRfidStatus callback in initNativeHost whenever Python
// responds to an RFID_HANDSHAKE command. buildHardwareStatus() triggers a fresh
// check when the cache is older than RFID_STATUS_TTL_MS.
let rfidConnected: 'connected' | 'disconnected' = 'disconnected'
let rfidError: string | null = null
let rfidStatusCheckedAt = 0
let idScannerStatusCheckedAt = 0

function handleRfidStatus(connected: boolean, error: string | null): void {
  const next = connected ? 'connected' : 'disconnected'
  if (next !== rfidConnected) {
    console.log('[FDN SW] RFID encoder status changed:', next, error ? `— ${error}` : '')
  }
  rfidConnected = next
  rfidError = connected ? null : (error ?? null)
  rfidStatusCheckedAt = Date.now()
}
// ─────────────────────────────────────────────────────────────────────────────

let reservation: ReservationSnapshot | null = null
let synxisGuestDisplay: SynxisGuestDisplay | null = null
let ezeeGuestDisplay: EzeeGuestDisplay | null = null
let lastPmsTabId: number | null = null
let cachedRole: string | null = null
let versionBlocked = false
let versionMessage: string | null = null
let lastError: string | null = null

/** Per browser tab: last successful auto-load (confirmation + DOM room hint so room moves re-trigger). */
const synxisAutoDedupeByTab = new Map<
  number,
  { confirmation: string; roomHint: string; at: number }
>()
/** In-flight auto-loads: `${tabId}|${confirmation}|${roomHint}` — tab-only would drop a new room hint while first fetch runs. */
const synxisAutoInFlight = new Set<string>()
const SYNXIS_AUTO_DEDUPE_MS = 30_000

const ezeeAutoDedupeByTab = new Map<
  number,
  { confirmation: string; roomHint: string; at: number }
>()
const ezeeAutoInFlight = new Set<string>()
const EZEE_AUTO_DEDUPE_MS = 30_000

/** Currently open eZee reg-card popup windows — prevents reopening on duplicate events. */
const ezeeRegCardWindowByConf = new Map<string, number>()
/** Pre-captured Stimulsoft PDF (via CDP Page.printToPDF), keyed by confirmation. */
const ezeePreCapturedPdf = new Map<string, string>()

function synxisAutoFlightKey(tabId: number, confirmation: string, roomHint: string): string {
  return `${tabId}|${confirmation}|${roomHint}`
}

function ezeeAutoFlightKey(tabId: number, confirmation: string, roomHint: string): string {
  return `ezee|${tabId}|${confirmation}|${roomHint}`
}

const SYNXIS_DEFAULT_GUEST_ID = 100

/**
 * `key_history` text times: keep the same 12-char SDK form as the encoder (`YYYYMMDDHHmm`),
 * matching legacy PMS-synced rows. Falls back to `toSdkDatetimeHotel` when Python omits a value.
 */
function keyHistoryTimeForDb(rawSdk: unknown, fallbackMsg: string, defaultHour: number): string {
  if (typeof rawSdk === 'string') {
    const t = rawSdk.trim()
    if (/^\d{12}$/.test(t)) return t
  }
  return toSdkDatetimeHotel(fallbackMsg, defaultHour)
}

type RfidMakeKeyMessage = Extract<ExtensionMessage, { type: 'RFID_MAKE_KEY' }>

/** True when PMS status indicates the guest is currently in-house (eZee or SynXis). */
function isPmsCheckedIn(pmsStatus: string | null): boolean {
  if (!pmsStatus) return true // unknown status → do not block
  const s = pmsStatus.trim().toLowerCase().replace(/\s+/g, ' ')
  return (
    s === 'in house' ||
    s === 'inhouse' ||
    s === 'arrived' ||   // eZee: guest has checked in
    s === 'stayover' ||
    s === 'stay over' ||
    s === 'due out' ||
    s === 'day use'
  )
}

async function runRfidMakeKey(msg: RfidMakeKeyMessage): Promise<ExtensionResponse | Record<string, unknown>> {
  const client = getClient()

  // ── Key-making gates (check-in status + balance) ──────────────────────────
  const settings = await loadExtensionHotelSettings(client)

  const isOverride =
    typeof msg.managerPin === 'string' &&
    msg.managerPin.length > 0 &&
    settings.managerOverridePin.length > 0 &&
    msg.managerPin === settings.managerOverridePin

  if (!isOverride) {
    const keyBlocks: { type: 'not_checked_in' | 'balance_over_threshold'; message: string }[] = []

    // Check-in gate — applies to any PMS where pmsStatus is known
    if (reservation?.pmsStatus !== null && reservation?.pmsStatus !== undefined) {
      if (!isPmsCheckedIn(reservation.pmsStatus)) {
        keyBlocks.push({
          type: 'not_checked_in',
          message: 'Guest is not yet checked in — check in the guest in the PMS first.',
        })
      }
    }

    // Balance gate — applies to any PMS where dueAmount is known
    if (settings.maxAllowedBalance >= 0) {
      const balance = parseMoneyToNumber(reservation?.dueAmount ?? null)
      if (balance !== null && balance > settings.maxAllowedBalance) {
        const fmt = (n: number) => n.toFixed(2)
        keyBlocks.push({
          type: 'balance_over_threshold',
          message: `Balance of $${fmt(balance)} exceeds the $${fmt(settings.maxAllowedBalance)} limit — process a payment before encoding a key.`,
        })
      }
    }

    if (keyBlocks.length > 0) {
      return {
        ok: false,
        error: keyBlocks.map((b) => b.message).join(' '),
        keyBlocks,
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  try {
    const raw = await sendNativeRequest({
      type: 'RFID_MAKE_KEY',
      room_number: msg.roomNumber,
      checkin_time: toSdkDatetimeHotel(msg.checkinTime, 14),
      checkout_time: toSdkDatetimeHotel(msg.checkoutTime, 12),
      card_serial: msg.cardSerial ?? 1,
    })

    if (!raw.success) {
      return { ok: false, error: String(raw.error ?? 'Key encoding failed') }
    }

    const { data: sess } = await client.auth.getSession()
    const user = sess.session?.user ?? null
    const terminalId = await ensureTerminal(client)
    const confFromMsg = msg.confirmationNumber?.trim() || null
    const confFromPms = reservation?.confirmationNumber ?? null
    const conf = confFromMsg || confFromPms
    let dbWarning: string | null = null

    const dbCheckinTime = keyHistoryTimeForDb(raw.checkin_time, msg.checkinTime, 14)
    const dbCheckoutTime = keyHistoryTimeForDb(raw.checkout_time, msg.checkoutTime, 12)

    if (user && conf) {
      const adminPortal = Boolean(msg.portalAdminEncode)
      const encodedByUsername = adminPortal ? 'Admin' : (user.email ?? null)

      const insertRow: Record<string, unknown> = {
        confirmation_number: conf,
        room_number: msg.roomNumber,
        card_serial: msg.cardSerial ?? 1,
        checkin_time: dbCheckinTime,
        checkout_time: dbCheckoutTime,
        encoded_by: user.id,
        encoded_by_username: encodedByUsername,
        terminal_id: terminalId,
      }

      const { error: khErr } = await client.from('key_history').insert(insertRow)
      if (khErr) {
        console.error('[FDN SW] key_history insert failed:', khErr.message)
        dbWarning = `Card encoded but DB record failed: ${khErr.message}`
      }

      const auditDescription = adminPortal
        ? `Portal admin room key encoded — room ${msg.roomNumber}, serial ${msg.cardSerial ?? 1}`
        : isOverride
          ? `Manager override: key encoded — room ${msg.roomNumber}, serial ${msg.cardSerial ?? 1}`
          : `Room key encoded — room ${msg.roomNumber}, serial ${msg.cardSerial ?? 1}`

      await client
        .from('audit_log')
        .insert({
          user_id: user.id,
          username: user.email,
          user_role: cachedRole,
          terminal_id: terminalId,
          action_type: isOverride ? 'MANAGER_OVERRIDE_KEY' : 'KEY_ENCODED',
          confirmation_number: conf,
          description: auditDescription,
          new_value: {
            room_number: msg.roomNumber,
            card_serial: msg.cardSerial ?? 1,
            return_msg: raw.return_msg,
            portal_admin: adminPortal,
            manager_override: isOverride,
          },
        })
        .then(({ error }) => {
          if (error) console.error('[FDN SW] audit_log (key_encoded) failed:', error.message)
        })
    } else if (!user) {
      dbWarning = 'Card encoded but extension is not signed in — key_history not saved.'
    } else if (!conf) {
      dbWarning = 'Card encoded but no confirmation — key_history not saved.'
    }

    const serialLabel = (msg.cardSerial ?? 1) === 1 ? 'Primary key' : `Duplicate key (serial ${msg.cardSerial})`
    if (dbWarning) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Key Encoded — DB Warning',
        message: `${serialLabel} — Room ${msg.roomNumber}\n${dbWarning}`,
        priority: 2,
      })
    } else {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon.png',
        title: 'Key Card Encoded',
        message: `${serialLabel} — Room ${msg.roomNumber}\nConf: ${conf ?? '—'}`,
        priority: 1,
      })
    }

    if (typeof raw.encoded_data === 'string' && raw.encoded_data) {
      const entry = {
        roomNumber: msg.roomNumber,
        cardSerial: msg.cardSerial ?? 1,
        checkinTime: dbCheckinTime,
        checkoutTime: dbCheckoutTime,
      }
      void chrome.storage.local.set({ [`fdn_card_${raw.encoded_data}`]: entry })
    }

    return { ok: true, dbWarning: dbWarning ?? undefined, state: await getState() }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'RFID command failed'
    return { ok: false, error: message }
  }
}

const SYNXIS_RESERVATION_SUMMARY_URL =
  'https://sph.synxis.com/pms-web-ui/service/v2/guest-mgt/guest-stay-record/reservation-summary'

const SYNXIS_ACCOUNTING_SUMMARY_URL =
  'https://sph.synxis.com/pms-web-ui/service/v2/guest-mgt/guest-stay-record/accounting-summary'

function buildSynxisReservationSummaryBody(confirmationNumber: string): {
  payload: {
    account: string
    confirmationNumber: string
    guestId: number
    property: string
  }
} {
  const c = confirmationNumber.trim().toUpperCase()
  const property = c.length >= 5 ? c.slice(0, 5) : c
  return {
    payload: {
      account: c,
      confirmationNumber: c,
      guestId: SYNXIS_DEFAULT_GUEST_ID,
      property,
    },
  }
}

/**
 * Reads confirmation from every frame (parent + cross-origin sph iframe).
 * Prefers sph.synxis.com — the guest stay UI often lives there while the parent shell can show stale text.
 */
async function getConfirmationFromSynxisTab(tabId: number): Promise<string> {
  let injectionResults: chrome.scripting.InjectionResult[]
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: synxisExtractInFrame,
    })
  } catch {
    throw new Error(
      'Could not run extraction in SynXis tab. Reload the Control Center tab and try again.',
    )
  }

  type FrameResult = { value: string | null; href: string }
  const hits: { value: string; href: string }[] = []
  for (const ir of injectionResults) {
    const r = ir.result as FrameResult | undefined
    if (!r?.value || typeof r.value !== 'string') continue
    hits.push({ value: r.value.trim().toUpperCase(), href: r.href || '' })
  }

  console.info('[FDN] confirmationNumber (per frame)', hits)

  if (hits.length === 0) {
    throw new Error('Could not read confirmation from page or iframe.')
  }

  const sph = hits.filter((h) => h.href.includes('sph.synxis.com'))
  const uniqSp = [...new Set(sph.map((h) => h.value))]
  if (uniqSp.length === 1) {
    console.info('[FDN] confirmationNumber (using sph.synxis.com iframe)', uniqSp[0])
    return uniqSp[0]
  }
  if (sph.length > 0) {
    const last = sph[sph.length - 1].value
    console.warn('[FDN] multiple iframe hits; using last sph frame', sph)
    return last
  }

  const chosen = hits[hits.length - 1].value
  console.info('[FDN] confirmationNumber (parent only, no sph iframe hit)', chosen)
  return chosen
}

async function findSynxisTab(): Promise<chrome.tabs.Tab | undefined> {
  const focused = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    url: 'https://controlcenter-p2.synxis.com/*',
  })
  if (focused[0]) return focused[0]
  const any = await chrome.tabs.query({ url: 'https://controlcenter-p2.synxis.com/*' })
  return any.find((t) => t.active) ?? any[0]
}

const EZEE_TAB_URL_PATTERNS = ['https://live.ipms247.com/*', 'https://*.ipms247.com/*'] as const

function isEzeePmsUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname
    return h === 'live.ipms247.com' || h.endsWith('.ipms247.com')
  } catch {
    return false
  }
}

async function findEzeeTab(): Promise<chrome.tabs.Tab | undefined> {
  const focused = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    url: [...EZEE_TAB_URL_PATTERNS],
  })
  if (focused[0]) return focused[0]
  const any = await chrome.tabs.query({ url: [...EZEE_TAB_URL_PATTERNS] })
  return any.find((t) => t.active) ?? any[0]
}

async function resolvePmsTabId(): Promise<number | null> {
  if (lastPmsTabId != null) {
    try {
      const t = await chrome.tabs.get(lastPmsTabId)
      const u = t.url ?? ''
      if (/^https:\/\/controlcenter-p2\.synxis\.com\//i.test(u) || isEzeePmsUrl(u)) {
        return lastPmsTabId
      }
    } catch {
      lastPmsTabId = null
    }
  }
  const focused = await chrome.tabs.query({
    url: ['https://controlcenter-p2.synxis.com/*', ...EZEE_TAB_URL_PATTERNS],
    lastFocusedWindow: true,
  })
  const pick = focused.find((t) => t.active) ?? focused[0]
  if (pick?.id != null) {
    lastPmsTabId = pick.id
    return pick.id
  }
  const anyHost = await chrome.tabs.query({
    url: ['https://controlcenter-p2.synxis.com/*', ...EZEE_TAB_URL_PATTERNS],
  })
  const fallback = anyHost.find((t) => t.active) ?? anyHost[0]
  if (fallback?.id != null) {
    lastPmsTabId = fallback.id
    return fallback.id
  }
  return null
}

function broadcastPanelToast(args: {
  confirmationNumber: string
  detail?: string
  variant?: PanelToastBroadcast['variant']
}): void {
  const msg: PanelToastBroadcast = {
    type: 'FDN_PANEL_TOAST',
    confirmationNumber: args.confirmationNumber,
    detail: args.detail,
    variant: args.variant ?? 'success',
  }
  void chrome.runtime.sendMessage(msg).catch(() => {
    /* Side panel may be closed */
  })
}

async function notifyUser(title: string, message: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: 'basic',
      title,
      message,
      // Raster PNG — Chrome notifications often reject SVG ("Unable to download all specified images").
      iconUrl: chrome.runtime.getURL('icon.png'),
    })
  } catch (e) {
    console.warn('FrontDesk: notification failed', e)
  }
}

async function fetchSynxisReservationSummaryByApi(
  tabUrl: string,
  confirmationNumber: string,
): Promise<
  | { ok: true; payload: ReservationSnapshot; guestDisplay: SynxisGuestDisplay }
  | { ok: false; error: string }
> {
  const body = buildSynxisReservationSummaryBody(confirmationNumber)
  const confirmationFallback = body.payload.confirmationNumber

  console.info('[FDN] confirmationNumber (final, sent to SynXis API)', confirmationFallback)

  const requestHeaders: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
  }
  const bodyString = JSON.stringify(body)

  const res = await fetch(SYNXIS_RESERVATION_SUMMARY_URL, {
    method: 'POST',
    credentials: 'include',
    headers: requestHeaders,
    body: bodyString,
  })

  const contentType = res.headers.get('content-type') ?? ''
  const raw = await res.text()

  if (!res.ok) return { ok: false, error: `SynXis API error ${res.status}` }

  if (contentType.includes('text/html') || raw.includes('Please enter your user name and password')) {
    return {
      ok: false,
      error: 'SynXis API returned login HTML (session/cookie not accepted for sph.synxis.com).',
    }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'SynXis API response is not valid JSON.' }
  }

  const parsed = parseSynxisReservationSummaryResponse(json, tabUrl, confirmationFallback)
  logSynxisGuestSpecConsole(parsed.display)
  return { ok: true, payload: parsed.snapshot, guestDisplay: parsed.display }
}

/**
 * Fetches balance and in-house status from the SynXis accounting-summary endpoint.
 * Returns null on any failure so callers fail open (never block a key due to API error).
 */
async function fetchSynxisAccountingSummary(
  confirmationNumber: string,
): Promise<{ estimatedRemaining: number | null; inHouse: boolean | null } | null> {
  const c = confirmationNumber.trim().toUpperCase()
  const property = c.length >= 5 ? c.slice(0, 5) : c
  const body = JSON.stringify({
    payload: {
      property,
      account: c,
      guestId: SYNXIS_DEFAULT_GUEST_ID,
      confirmationNumber: c,
    },
  })

  try {
    const res = await fetch(SYNXIS_ACCOUNTING_SUMMARY_URL, {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
      body,
    })

    if (!res.ok) {
      console.warn('[FDN SW] SynXis accounting-summary HTTP error', res.status)
      return null
    }

    const raw = await res.text()
    if (raw.includes('Please enter your user name and password')) {
      console.warn('[FDN SW] SynXis accounting-summary returned login HTML — session expired')
      return null
    }

    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      console.warn('[FDN SW] SynXis accounting-summary non-JSON response')
      return null
    }

    if (!json || typeof json !== 'object' || Array.isArray(json)) return null
    const root = json as Record<string, unknown>
    const summary = root.accountSummary
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null
    const acct = summary as Record<string, unknown>

    const estimatedRemaining =
      typeof acct.estimatedRemaining === 'number' ? acct.estimatedRemaining : null

    let inHouse: boolean | null = null
    const stay = acct.stay
    if (stay && typeof stay === 'object' && !Array.isArray(stay)) {
      const s = stay as Record<string, unknown>
      if (typeof s.inHouse === 'boolean') inHouse = s.inHouse
    }

    console.info('[FDN SW] SynXis accounting-summary', { estimatedRemaining, inHouse })
    return { estimatedRemaining, inHouse }
  } catch (e) {
    console.warn('[FDN SW] SynXis accounting-summary fetch failed', e)
    return null
  }
}

async function completeSynxisReservationFromConfirmation(
  tabId: number,
  tabUrl: string,
  confirmation: string,
  options: { chromeNotify: boolean; panelToast: boolean },
): Promise<ExtensionResponse | Record<string, unknown>> {
  const client = getClient()
  lastPmsTabId = tabId

  const apiRes = await fetchSynxisReservationSummaryByApi(tabUrl, confirmation)
  if (apiRes.ok === false) {
    const err = apiRes.error
    lastError = err
    synxisGuestDisplay = null
    if (options.chromeNotify) void notifyUser('FrontDesk Nexus — Reservation failed', err)
    return { ok: false, error: err }
  }

  reservation = apiRes.payload
  synxisGuestDisplay = apiRes.guestDisplay
  ezeeGuestDisplay = null

  // Patch balance from accounting-summary (fail open on error)
  // Note: stay.inHouse from this API is unreliable — SynXis check-in uses date logic instead
  const accounting = await fetchSynxisAccountingSummary(confirmation)
  if (accounting && accounting.estimatedRemaining !== null) {
    reservation = {
      ...reservation,
      dueAmount: String(accounting.estimatedRemaining),
    }
  }

  void chrome.storage.local.set({ fdn_active_reservation: reservation })
  void chrome.storage.local.remove('fdn_ezee_guest_display')
  const { data: sess } = await client.auth.getSession()
  let dbSaved = false
  if (sess.session) {
    const ur = await upsertReservationSnapshot(client, apiRes.payload)
    dbSaved = ur.ok
  }

  const conf = apiRes.payload.confirmationNumber ?? confirmation

  if (options.panelToast) {
    if (sess.session) {
      if (dbSaved) {
        broadcastPanelToast({
          confirmationNumber: conf,
          variant: 'success',
          detail: 'Guest loaded and saved to database',
        })
      } else {
        broadcastPanelToast({
          confirmationNumber: conf,
          variant: 'warn',
          detail: 'Guest loaded from SynXis but not saved to database',
        })
      }
    } else {
      broadcastPanelToast({
        confirmationNumber: conf,
        variant: 'warn',
        detail: 'Sign in to save this guest to the database',
      })
    }
  }

  const msgText = `Loaded reservation ${conf} (SynXis API)`
  if (options.chromeNotify) {
    const detail = sess.session
      ? dbSaved
        ? 'Guest loaded from SynXis and saved to database'
        : 'Guest loaded from SynXis but not saved to database'
      : 'Guest loaded from SynXis. Sign in to save to the database.'
    void notifyUser('FrontDesk Nexus', `#${conf} — ${detail}`)
  }
  lastError = null
  return { ok: true, state: await getState(), message: msgText }
}

async function completeEzeeReservationFromSnapshot(
  tabId: number,
  tabUrl: string,
  snapshot: ReservationSnapshot,
  guestDisplay: EzeeGuestDisplay,
  options: { chromeNotify: boolean; panelToast: boolean },
): Promise<ExtensionResponse | Record<string, unknown>> {
  const client = getClient()
  lastPmsTabId = tabId

  reservation = { ...snapshot, pageUrl: tabUrl }
  synxisGuestDisplay = null
  ezeeGuestDisplay = guestDisplay
  void chrome.storage.local.set({
    fdn_active_reservation: reservation,
    fdn_ezee_guest_display: guestDisplay,
  })

  const { data: sess } = await client.auth.getSession()
  let dbSaved = false
  if (sess.session) {
    const ur = await upsertReservationSnapshot(client, reservation)
    dbSaved = ur.ok
  }

  const conf = snapshot.confirmationNumber ?? ''

  if (options.panelToast) {
    if (sess.session) {
      if (dbSaved) {
        broadcastPanelToast({
          confirmationNumber: conf,
          variant: 'success',
          detail: 'Guest loaded from eZee and saved to database',
        })
      } else {
        broadcastPanelToast({
          confirmationNumber: conf,
          variant: 'warn',
          detail: 'Guest loaded from eZee but not saved to database',
        })
      }
    } else {
      broadcastPanelToast({
        confirmationNumber: conf,
        variant: 'warn',
        detail: 'Sign in to save this guest to the database',
      })
    }
  }

  const msgText = `Loaded reservation ${conf} (eZee)`
  console.info('[FDN SW] eZee reservation loaded', {
    confirmation: conf,
    dbSaved,
    guestName: guestDisplay.nameLine,
  })
  if (options.chromeNotify) {
    const detail = sess.session
      ? dbSaved
        ? 'Guest loaded from eZee and saved to database'
        : 'Guest loaded from eZee but not saved to database'
      : 'Guest loaded from eZee. Sign in to save to the database.'
    void notifyUser('FrontDesk Nexus', `#${conf} — ${detail}`)
  }
  lastError = null
  return { ok: true, state: await getState(), message: msgText }
}

function getClient(): SupabaseClient {
  if (!supabase) supabase = createExtensionSupabase()
  return supabase
}

async function ensureTerminal(client: SupabaseClient): Promise<string | null> {
  const { fdn_terminal_id: existing } = await chrome.storage.local.get('fdn_terminal_id')
  if (typeof existing === 'string' && existing.length > 0) return existing

  const label = `ext-${crypto.randomUUID().slice(0, 8)}`
  const { data, error } = await client
    .from('terminals')
    .insert({ label, metadata: { source: 'chrome-extension' } })
    .select('id')
    .single()

  if (error || !data?.id) {
    console.warn('FrontDesk: could not create terminal row', error?.message)
    return null
  }
  await chrome.storage.local.set({ fdn_terminal_id: data.id })
  return data.id as string
}

async function refreshRole(client: SupabaseClient): Promise<void> {
  const { data: u } = await client.auth.getUser()
  const uid = u.user?.id
  if (!uid) {
    cachedRole = null
    return
  }
  const { data: prof } = await client.from('profiles').select('role').eq('id', uid).maybeSingle()
  cachedRole = (prof?.role as string) ?? null
}

type UpsertReservationResult = { ok: true; id: string } | { ok: false }

/**
 * Upserts reservation: merges prior scrape_payload (email, phone, etc. follow latest API snapshot),
 * and appends room changes to scrape_payload.fdn.roomNumberHistory (e.g. 111 → 345 → 823).
 */
async function upsertReservationSnapshot(
  client: SupabaseClient,
  snap: ReservationSnapshot,
  guestNameOverride?: string | null,
): Promise<UpsertReservationResult> {
  if (!snap.confirmationNumber) return { ok: false }

  const guestName =
    guestNameOverride !== undefined ? guestNameOverride : snap.guestName

  const { data: existing, error: selErr } = await client
    .from('reservations')
    .select('room_number, scrape_payload')
    .eq('confirmation_number', snap.confirmationNumber)
    .eq('pms_source', snap.pms)
    .maybeSingle()

  if (selErr) console.warn('FrontDesk: reservation select', selErr.message)

  const prevCol =
    existing?.room_number != null && String(existing.room_number).trim().length > 0
      ? String(existing.room_number).trim()
      : null
  const prevPayload =
    existing?.scrape_payload && typeof existing.scrape_payload === 'object'
      ? (existing.scrape_payload as Record<string, unknown>)
      : undefined

  const roomHistory = mergeRoomNumberHistory({
    previousRoomColumn: prevCol,
    previousPayload: prevPayload,
    newRoomFromPms: snap.roomNumber,
  })

  const mergedPayload = buildMergedScrapePayload(
    snap,
    prevPayload,
    roomHistory,
    snap.loadedAt,
  )

  const roomColumn = formatRoomChainForColumn(roomHistory)

  const totalParsed = parseMoneyToNumber(snap.reservationTotal)
  const paidParsed = parseMoneyToNumber(snap.amountPaid)
  const balanceParsed = parseMoneyToNumber(snap.dueAmount)
  const totalDb = prepareMoneyColumnForDb(snap.reservationTotal)
  const paidDb = prepareMoneyColumnForDb(snap.amountPaid)
  const balanceDb = prepareMoneyColumnForDb(snap.dueAmount)

  console.info('[FDN SW] reservations money → DB (raw → parsed → whole $)', {
    total: {
      raw: snap.reservationTotal,
      parsed: totalParsed,
      roundedWholeDollars: totalDb,
      saveDisplay: formatDollarLog(totalDb),
    },
    paid: {
      raw: snap.amountPaid,
      parsed: paidParsed,
      roundedWholeDollars: paidDb,
      saveDisplay: formatDollarLog(paidDb),
    },
    balance: {
      raw: snap.dueAmount,
      parsed: balanceParsed,
      roundedWholeDollars: balanceDb,
      saveDisplay: formatDollarLog(balanceDb),
    },
    confirmation: snap.confirmationNumber,
    pms: snap.pms,
  })

  const row = {
    confirmation_number: snap.confirmationNumber,
    pms_source: snap.pms,
    guest_name: guestName ?? null,
    phone: snap.phone ?? null,
    email: snap.email ?? null,
    room_number: roomColumn,
    check_in_date: snap.checkInDate,
    check_out_date: snap.checkOutDate,
    last_scraped_at: snap.loadedAt,
    scrape_payload: mergedPayload,
    total: totalDb,
    paid: paidDb,
    balance: balanceDb,
  }

  const { data, error } = await client
    .from('reservations')
    .upsert(row, { onConflict: 'confirmation_number,pms_source' })
    .select('id')
    .single()

  if (error || !data?.id) {
    console.warn('FrontDesk: reservation upsert', error?.message)
    return { ok: false }
  }
  return { ok: true, id: data.id as string }
}

async function buildHardwareStatus(): Promise<ExtensionState['hardware']> {
  let idScanner: 'connected' | 'disconnected' = 'disconnected'
  try {
    idScanner = (await pingNativeHost()) ? 'connected' : 'disconnected'
    idScannerStatusCheckedAt = Date.now()
  } catch {
    idScanner = 'disconnected'
    idScannerStatusCheckedAt = Date.now()
  }

  // Check once on startup only (rfidStatusCheckedAt === 0).
  // After that, status only updates via RFID_CHECK_CONNECTION (manual button).
  if (rfidStatusCheckedAt === 0) {
    rfidStatusCheckedAt = Date.now()
    sendNativeMessage({ type: 'RFID_HANDSHAKE' })
  }

  return {
    id_scanner: idScanner,
    spectral_payout: 'disconnected',
    rfid_encoder: rfidConnected,
  }
}

let cachedExtensionHotelSettings = DEFAULT_EXTENSION_HOTEL_SETTINGS
let extensionHotelSettingsFetchedAt = 0
let extensionHotelSettingsUnavailable = false
let extensionHotelSettingsWarned = false
const EXTENSION_HOTEL_SETTINGS_TTL_MS = 60_000

function isAppSettingsTableMissing(message: string): boolean {
  const m = message.toLowerCase()
  return m.includes('app_settings') && (m.includes('schema cache') || m.includes('does not exist'))
}

async function loadExtensionHotelSettings(
  client: SupabaseClient,
): Promise<typeof cachedExtensionHotelSettings> {
  if (extensionHotelSettingsUnavailable) {
    return DEFAULT_EXTENSION_HOTEL_SETTINGS
  }
  if (
    extensionHotelSettingsFetchedAt > 0 &&
    Date.now() - extensionHotelSettingsFetchedAt < EXTENSION_HOTEL_SETTINGS_TTL_MS
  ) {
    return cachedExtensionHotelSettings
  }
  const { data, error } = await client
    .from('app_settings')
    .select('value')
    .eq('key', 'hotel')
    .maybeSingle()
  if (error) {
    extensionHotelSettingsFetchedAt = Date.now()
    if (isAppSettingsTableMissing(error.message)) {
      extensionHotelSettingsUnavailable = true
    }
    if (!extensionHotelSettingsWarned) {
      extensionHotelSettingsWarned = true
      console.warn(
        '[FDN SW] hotel settings unavailable — using defaults (minimumCheckInAge=18, maxAllowedBalance=-1).',
        error.message,
      )
    }
    return DEFAULT_EXTENSION_HOTEL_SETTINGS
  }
  cachedExtensionHotelSettings = parseHotelSettingsValue(data?.value)
  extensionHotelSettingsFetchedAt = Date.now()
  extensionHotelSettingsUnavailable = false
  return cachedExtensionHotelSettings
}

async function restorePersistedReservationState(): Promise<void> {
  const stored = await chrome.storage.local.get(['fdn_active_reservation', 'fdn_ezee_guest_display'])
  if (!reservation && stored.fdn_active_reservation) {
    reservation = stored.fdn_active_reservation as ReservationSnapshot
  }
  if (!ezeeGuestDisplay && stored.fdn_ezee_guest_display && reservation?.pms === 'ezee') {
    ezeeGuestDisplay = stored.fdn_ezee_guest_display as EzeeGuestDisplay
  }
}

async function getState(): Promise<ExtensionState> {
  await restorePersistedReservationState()
  const client = getClient()
  const { data: sessionData } = await client.auth.getSession()
  const user = sessionData.session?.user ?? null
  const hardware = await buildHardwareStatus()
  const { fdn_terminal_id: terminalId } = await chrome.storage.local.get('fdn_terminal_id')

  if (user && !cachedRole) await refreshRole(client)

  const hotelSettings = user
    ? await loadExtensionHotelSettings(client)
    : DEFAULT_EXTENSION_HOTEL_SETTINGS
  const dnrHit = false

  return {
    auth: {
      signedIn: !!user,
      email: user?.email ?? null,
      role: cachedRole,
      userId: user?.id ?? null,
    },
    versionBlocked,
    versionMessage,
    reservation,
    synxisGuestDisplay,
    ezeeGuestDisplay,
    hardware,
    hardwareCheckedAt: {
      id_scanner: idScannerStatusCheckedAt > 0 ? idScannerStatusCheckedAt : null,
      rfid_encoder: rfidStatusCheckedAt > 0 ? rfidStatusCheckedAt : null,
    },
    rfidError,
    terminalId: typeof terminalId === 'string' ? terminalId : null,
    dnrHit,
    minimumCheckInAge: hotelSettings.minimumCheckInAge,
    maxAllowedBalance: hotelSettings.maxAllowedBalance,
    hasManagerPin: hotelSettings.managerOverridePin.length > 0,
    autoLogoutMinutes: hotelSettings.autoLogoutMinutes,
    lastError,
  }
}

type ManagerVerifyOk = {
  ok: true
  userId: string
  email: string
  role: string
}

type ManagerVerifyFail = { ok: false; error: string }

async function verifyManagerRole(
  email: string,
  password: string,
): Promise<ManagerVerifyOk | ManagerVerifyFail> {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return { ok: false, error: 'Supabase env not configured' }

  const mem: Record<string, string> = {}
  const ephemeral = createClient(url, key, {
    auth: {
      storage: {
        getItem: (k) => mem[k] ?? null,
        setItem: (k, v) => {
          mem[k] = v
        },
        removeItem: (k) => {
          delete mem[k]
        },
      },
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  const { data, error } = await ephemeral.auth.signInWithPassword({ email, password })
  if (error || !data.user) {
    await ephemeral.auth.signOut()
    return { ok: false, error: 'Invalid manager credentials' }
  }

  const { data: prof } = await ephemeral
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .maybeSingle()

  await ephemeral.auth.signOut()

  const role = prof?.role as string | undefined
  if (role !== 'manager' && role !== 'admin') {
    return { ok: false, error: 'User is not a manager or admin' }
  }
  return {
    ok: true,
    userId: data.user.id,
    email: data.user.email ?? email,
    role,
  }
}

async function verifyManager(email: string, password: string): Promise<ExtensionResponse> {
  const r = await verifyManagerRole(email, password)
  if (!r.ok) return r
  return { ok: true }
}

async function addDnrEntry(args: {
  guestName: string
  idNumber: string
  dateOfBirth: string | null
  reason: string
  managerEmail: string
  managerPassword: string
}): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }

  const gn = args.guestName.trim()
  const idStored = normalizeIdNumber(args.idNumber)
  const rr = args.reason.trim()
  if (!gn) return { ok: false, error: 'Guest name required' }
  if (!idStored) return { ok: false, error: 'ID number required' }
  if (!rr) return { ok: false, error: 'Reason required' }

  const mgr = await verifyManagerRole(args.managerEmail, args.managerPassword)
  if (!mgr.ok) return mgr

  const variants = idVariantsForDnrLookup(args.idNumber)
  const { data: existing } = await client
    .from('dnr_entries')
    .select('id')
    .eq('status', 'active')
    .in('id_number', variants)

  if (existing && existing.length > 0) {
    return { ok: false, error: 'Guest is already on the active DNR list.' }
  }

  const dob = args.dateOfBirth?.trim() ? args.dateOfBirth.trim() : null
  const terminalId = await ensureTerminal(client)

  const { data: inserted, error } = await client
    .from('dnr_entries')
    .insert({
      guest_name: gn,
      id_number: idStored,
      date_of_birth: dob,
      reason: rr,
      status: 'active',
      flagged_by: mgr.userId,
    })
    .select('id')
    .single()

  if (error) {
    lastError = error.message
    return { ok: false, error: error.message }
  }

  const { error: audErr } = await client.from('audit_log').insert({
    user_id: mgr.userId,
    username: mgr.email,
    user_role: mgr.role,
    terminal_id: terminalId,
    action_type: 'dnr_added',
    description: `DNR added for id_number ${idStored} (extension)`,
    new_value: { dnr_entry_id: inserted?.id, id_number: idStored, guest_name: gn },
  })
  if (audErr) console.warn('[FDN SW] audit_log (dnr_added)', audErr.message)

  return { ok: true, dnrActive: true, state: await getState() }
}

async function patchLastScanResultContact(args: {
  phone: string | null
  email: string | null
  parsed: ParsedIdFields
}): Promise<void> {
  const stored = await chrome.storage.local.get('lastScanResult')
  const prev = (stored.lastScanResult ?? {}) as Record<string, unknown>
  await chrome.storage.local.set({
    lastScanResult: {
      ...prev,
      phone: args.phone?.trim() || null,
      email: args.email?.trim() || null,
      id_number: args.parsed.idNumber?.trim() || (prev.id_number as string | null) || null,
      expiry_date: args.parsed.expiryDate?.trim() || (prev.expiry_date as string | null) || null,
      issue_date: args.parsed.issueDate?.trim() || (prev.issue_date as string | null) || null,
      document_type: args.parsed.idType?.trim() || (prev.document_type as string | null) || null,
      dob: args.parsed.dateOfBirth?.trim() || (prev.dob as string | null) || null,
    },
  })
}

async function flushPendingGuestDraftIfPresent(options: {
  ignoreMinAge?: boolean
}): Promise<void> {
  const stored = await chrome.storage.local.get(FDN_PENDING_GUEST_DRAFT_KEY)
  const raw = stored[FDN_PENDING_GUEST_DRAFT_KEY]
  if (!raw || typeof raw !== 'object') return

  const draft = raw as PendingGuestDraft
  if (draft.canceled) {
    await chrome.storage.local.remove(FDN_PENDING_GUEST_DRAFT_KEY)
    return
  }
  if (
    !options.ignoreMinAge &&
    Date.now() - draft.draftStartedAtMs < GUEST_DRAFT_AUTOSAVE_MIN_MS
  ) {
    return
  }

  try {
    const res = await saveIdScan({
      parsed: draft.parsed,
      phone: draft.phone,
      email: draft.email,
      manualEntry: draft.manualEntry,
      managerOverride: draft.managerOverride,
      imageFrontBase64: draft.imageFrontBase64,
      imageBackBase64: draft.imageBackBase64,
      ocrProvider: draft.ocrProvider ?? null,
      detail: draft.detail ?? null,
      documentData: draft.documentData ?? null,
      guestRemark: draft.guestRemark ?? null,
      checkInRemark: draft.checkInRemark ?? null,
    })
    if (res.ok === false) {
      console.warn('[FrontDesk Nexus] Auto-save guest draft on logout failed:', res.error)
    }
  } catch (e) {
    console.warn('[FrontDesk Nexus] Auto-save guest draft on logout error:', e)
  } finally {
    await chrome.storage.local.remove(FDN_PENDING_GUEST_DRAFT_KEY)
  }
}

async function saveIdScan(args: {
  parsed: ParsedIdFields
  phone: string | null
  email: string | null
  manualEntry: boolean
  managerOverride: boolean
  imageFrontBase64: string | null
  imageBackBase64: string | null
  /** Set from Thales/native host when not manual entry. */
  ocrProvider?: string | null
  /** Structured Guru fields + raw document_data snapshot (encrypted in pii). */
  detail?: IdScanDetailGuru | null
  documentData?: Record<string, unknown> | null
  guestRemark?: string | null
  checkInRemark?: string | null
  /** When set, update this row (e.g. loaded from History) instead of inserting a duplicate. */
  existingScanId?: string | null
}): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }
  if (versionBlocked) return { ok: false, error: versionMessage ?? 'Extension version blocked' }

  const rawId = (args.parsed.idNumber ?? '').trim()
  if (rawId && !args.managerOverride) {
    const onDnr = await checkActiveDnr(client, rawId)
    if (onDnr) {
      return {
        ok: false,
        error: 'DNR match — manager approval required before saving.',
      }
    }
  }

  const terminalId = await ensureTerminal(client)
  const user = sess.session.user

  // Restore persisted reservation if service worker was restarted (in-memory state lost).
  if (!reservation) {
    const stored = await chrome.storage.local.get('fdn_active_reservation')
    if (stored.fdn_active_reservation) {
      reservation = stored.fdn_active_reservation as ReservationSnapshot
    }
  }
  const snap = reservation
  const existingScanId = args.existingScanId?.trim() || null
  const isUpdate = !!existingScanId
  const scanId = isUpdate ? existingScanId : crypto.randomUUID()

  let resId: string | null = null
  let conf: string
  let existingFrontPath: string | null = null
  let existingBackPath: string | null = null

  if (isUpdate) {
    const { data: existingRow, error: selErr } = await client
      .from('id_scans')
      .select('id, confirmation_number, reservation_id, image_front_path, image_back_path')
      .eq('id', scanId)
      .maybeSingle()
    if (selErr || !existingRow) {
      return {
        ok: false,
        error: 'Original ID scan not found — it may have been deleted.',
      }
    }
    conf = String(existingRow.confirmation_number ?? snap?.confirmationNumber ?? `NO-RES-${scanId}`)
    resId = (existingRow.reservation_id as string | null) ?? null
    existingFrontPath =
      typeof existingRow.image_front_path === 'string' ? existingRow.image_front_path : null
    existingBackPath =
      typeof existingRow.image_back_path === 'string' ? existingRow.image_back_path : null
  } else {
    conf = snap?.confirmationNumber ?? `NO-RES-${scanId}`
    if (snap?.confirmationNumber) {
      const { data, error } = await client
        .from('reservations')
        .select('id')
        .eq('confirmation_number', snap.confirmationNumber)
        .eq('pms_source', snap.pms)
        .maybeSingle()
      if (error) console.warn('[FDN SW] reservation select', error.message)
      resId = (data?.id as string) ?? null
    }
  }

  const resRow = { id: resId }
  const basePath = `${conf}/${scanId}`

  let imageFrontPath: string | null = isUpdate ? existingFrontPath : null
  let imageBackPath: string | null = isUpdate ? existingBackPath : null

  try {
    if (args.imageFrontBase64) {
      const mime = guessImageMimeFromBase64(args.imageFrontBase64)
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/bmp' ? 'bmp' : 'png'
      const path = existingFrontPath ?? `${basePath}/front.${ext}`
      const blob = base64ToBlob(args.imageFrontBase64, mime)
      const { error: upErr } = await client.storage.from('id-images').upload(path, blob, {
        contentType: mime,
        upsert: true,
      })
      if (!upErr) imageFrontPath = path
      else console.warn('Front image upload', upErr.message)
    }
    if (args.imageBackBase64) {
      const mime = guessImageMimeFromBase64(args.imageBackBase64)
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/bmp' ? 'bmp' : 'png'
      const path = existingBackPath ?? `${basePath}/back.${ext}`
      const blob = base64ToBlob(args.imageBackBase64, mime)
      const { error: upErr } = await client.storage.from('id-images').upload(path, blob, {
        contentType: mime,
        upsert: true,
      })
      if (!upErr) imageBackPath = path
      else console.warn('Back image upload', upErr.message)
    }
  } catch (e) {
    console.warn('Storage upload error', e)
  }

  const piiPayload = {
    fullName: args.parsed.fullName,
    dateOfBirth: args.parsed.dateOfBirth,
    idNumber: args.parsed.idNumber,
    idType: args.parsed.idType,
    issueDate: args.parsed.issueDate,
    expiryDate: args.parsed.expiryDate,
    address: args.parsed.address,
    idGuru: args.detail ?? undefined,
    documentDataSnapshot: args.documentData ?? undefined,
    remarks: {
      guest: args.guestRemark?.trim() || undefined,
      checkIn: args.checkInRemark?.trim() || undefined,
    },
  }
  const pii_encrypted = await encryptJson(piiPayload)
  const id_number_hash = rawId ? await hashIdNumber(rawId) : null
  const phoneTrim = args.phone?.trim() ?? ''
  const emailTrim = args.email?.trim() ?? ''
  const phone_number_hash = phoneTrim ? await hashPhoneNumber(phoneTrim) : null

  let phone_encrypted: Record<string, unknown> | null = null
  let email_encrypted: Record<string, unknown> | null = null
  if (phoneTrim) {
    phone_encrypted = (await encryptJson({ value: phoneTrim })) as unknown as Record<string, unknown>
  }
  if (emailTrim) {
    email_encrypted = (await encryptJson({ value: emailTrim })) as unknown as Record<string, unknown>
  }

  const scannedAt = new Date().toISOString()
  const ocrProvider = args.manualEntry
    ? null
    : args.ocrProvider && String(args.ocrProvider).trim()
      ? String(args.ocrProvider).trim()
      : 'native_host'

  const rowPayload = {
    reservation_id: resRow.id,
    confirmation_number: conf,
    scanned_at: scannedAt,
    scanned_by: user.id,
    terminal_id: terminalId,
    manual_entry: args.manualEntry,
    ocr_provider: ocrProvider,
    pii_encrypted: pii_encrypted as unknown as Record<string, unknown>,
    image_front_path: imageFrontPath,
    image_back_path: imageBackPath,
    phone_encrypted,
    email_encrypted,
  }

  let savedScanId = scanId

  if (isUpdate) {
    let updResult = await client
      .from('id_scans')
      .update({ ...rowPayload, id_number_hash, phone_number_hash })
      .eq('id', scanId)
      .select('id')
      .single()

    if (
      updResult.error?.message?.includes('id_number_hash') ||
      updResult.error?.message?.includes('phone_number_hash')
    ) {
      console.warn(
        '[FDN SW] id_number_hash / phone_number_hash missing on update — saving without hashes.',
      )
      updResult = await client.from('id_scans').update(rowPayload).eq('id', scanId).select('id').single()
    }

    const { error: updErr } = updResult
    if (updErr) {
      lastError = updErr.message
      return { ok: false, error: updErr.message }
    }
    savedScanId = (updResult.data?.id as string) ?? scanId
  } else {
    const insertBase = { id: scanId, ...rowPayload }

    let scanResult = await client
      .from('id_scans')
      .insert({ ...insertBase, id_number_hash, phone_number_hash })
      .select('id')
      .single()

    if (
      scanResult.error?.message?.includes('id_number_hash') ||
      scanResult.error?.message?.includes('phone_number_hash')
    ) {
      console.warn('[FDN SW] id_number_hash / phone_number_hash missing — run SQL migration. Saving without hashes.')
      scanResult = await client.from('id_scans').insert(insertBase).select('id').single()
    }

    const { data: insertRow, error: insErr } = scanResult

    if (insErr) {
      lastError = insErr.message
      return { ok: false, error: insErr.message }
    }
    savedScanId = (insertRow?.id as string) ?? scanId
  }

  const { error: audErr } = await client.from('audit_log').insert({
    user_id: user.id,
    username: user.email,
    user_role: cachedRole,
    terminal_id: terminalId,
    action_type: isUpdate ? 'ID_SCAN_UPDATED' : 'ID_SCAN',
    confirmation_number: conf,
    description: isUpdate
      ? args.manualEntry
        ? 'ID record updated (MANUAL_ENTRY)'
        : 'ID record updated'
      : args.manualEntry
        ? 'ID record saved (MANUAL_ENTRY)'
        : 'ID record saved (native host or manual)',
    new_value: {
      id_scan_id: savedScanId,
      manager_override: args.managerOverride,
      updated: isUpdate,
    },
  })
  if (audErr) console.warn('audit_log insert', audErr.message)

  await patchLastScanResultContact({
    phone: phoneTrim || null,
    email: emailTrim || null,
    parsed: args.parsed,
  })

  return { ok: true, state: await getState() }
}

async function saveSignature(args: {
  pdfBase64: string
  confirmationNumber: string
}): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }

  const terminalId = await ensureTerminal(client)
  const user = sess.session.user
  const conf = args.confirmationNumber.trim()

  if (!reservation) {
    const stored = await chrome.storage.local.get('fdn_active_reservation')
    if (stored.fdn_active_reservation) {
      reservation = stored.fdn_active_reservation as ReservationSnapshot
    }
  }

  let resId: string | null = null
  if (conf) {
    const pms = reservation?.pms ?? 'synxis'
    const { data, error } = await client
      .from('reservations')
      .select('id')
      .eq('confirmation_number', conf)
      .eq('pms_source', pms)
      .maybeSingle()
    if (error) console.warn('[FDN SW] signature: reservation lookup', error.message)
    resId = (data?.id as string) ?? null
  }

  const bin = atob(args.pdfBase64)
  const pdfBytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) pdfBytes[i] = bin.charCodeAt(i)

  const encryptedBytes = await encryptBinary(pdfBytes)

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const fileId = crypto.randomUUID()
  const storagePath = `${conf}/${timestamp}_${fileId}.pdf.enc`

  const blob = new Blob([encryptedBytes], { type: 'application/octet-stream' })
  const { error: upErr } = await client.storage
    .from('signature-pdfs')
    .upload(storagePath, blob, { contentType: 'application/octet-stream', upsert: false })

  if (upErr) {
    lastError = upErr.message
    return { ok: false, error: `PDF upload failed: ${upErr.message}` }
  }

  const { data: sigRow, error: sigErr } = await client
    .from('signatures')
    .insert({
      confirmation_number: conf,
      reservation_id: resId,
      storage_path: storagePath,
      signed_by: user.id,
      signed_by_username: user.email,
      terminal_id: terminalId,
    })
    .select('id')
    .single()

  if (sigErr) {
    lastError = sigErr.message
    return { ok: false, error: sigErr.message }
  }

  const { error: audErr } = await client.from('audit_log').insert({
    user_id: user.id,
    username: user.email,
    user_role: cachedRole,
    terminal_id: terminalId,
    action_type: 'SIGNATURE',
    confirmation_number: conf,
    description: 'Guest registration card signed — encrypted PDF stored',
    new_value: { signature_id: sigRow?.id, storage_path: storagePath },
  })
  if (audErr) console.warn('[FDN SW] audit_log insert (signature)', audErr.message)

  lastError = null
  return { ok: true, signaturePath: storagePath }
}

// ── eZee sign overlay helpers ─────────────────────────────────────────────────

/** Moves a Chrome window to the secondary display (mirrors registration-card logic). */
async function moveWindowToSecondDisplay(windowId: number): Promise<void> {
  try {
    const displays = await chrome.system.display.getInfo()
    const second = displays.find(d => !d.isPrimary) ?? displays[1]
    if (!second) return
    await chrome.windows.update(windowId, {
      left:    second.workArea.left,
      top:     second.workArea.top,
      width:   second.workArea.width,
      height:  second.workArea.height,
      state:   'normal',
      focused: true,
    })
  } catch (e) {
    console.warn('[FDN SW] moveWindowToSecondDisplay failed:', e)
  }
}

/**
 * Creates a PDF that includes the registration card screenshot as the background
 * with the signature PNG overlaid at the "Guest Signature:" line position.
 * Falls back to a text-only record if no screenshot is available.
 */
async function createEzeeSignaturePdf(
  screenshotDataUrl: string | null,
  signaturePng: string,
  conf: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const pageW = 612
  const pageH = 792
  const page  = pdfDoc.addPage([pageW, pageH])

  if (screenshotDataUrl) {
    // Embed the captured registration card screenshot as the full-page background
    const screenshot = await pdfDoc.embedPng(screenshotDataUrl)
    page.drawImage(screenshot, { x: 0, y: 0, width: pageW, height: pageH })
  } else {
    // Fallback: plain text header when capture failed
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
    page.drawText('Guest Registration Card — Signature Record', {
      x: 50, y: pageH - 60, size: 14, font: bold, color: rgb(0.08, 0.28, 0.56),
    })
    page.drawText(`Confirmation: ${conf}`, {
      x: 50, y: pageH - 86, size: 11, font, color: rgb(0.2, 0.2, 0.2),
    })
    page.drawText(`Signed: ${new Date().toLocaleString()}`, {
      x: 50, y: pageH - 106, size: 10, font, color: rgb(0.45, 0.45, 0.45),
    })
    page.drawText('Guest Signature:', {
      x: 50, y: pageH - 152, size: 11, font, color: rgb(0.2, 0.2, 0.2),
    })
  }

  // Overlay the signature PNG on top of the card screenshot.
  // The "Guest Signature:" box in the eZee card sits at ~76% from the top of the page,
  // i.e. ~24% from the bottom → sigY ≈ pageH * 0.24 ≈ 190 pts from bottom.
  // sigX ≈ 80 pts matches the left edge of the signature box in the card.
  const sigImage = await pdfDoc.embedPng(signaturePng)
  const sigY = screenshotDataUrl ? Math.round(pageH * 0.24) : pageH - 270
  page.drawImage(sigImage, { x: 80, y: sigY, width: 250, height: 55 })

  return pdfDoc.save()
}

/**
 * Embeds the guest signature PNG into the real Stimulsoft registration card PDF.
 * The "Guest Signature:" box in the eZee card sits at ~20% from the bottom.
 */
async function embedSignatureIntoEzeePdf(
  cardPdfBytes: Uint8Array,
  signaturePng: string,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(cardPdfBytes, { ignoreEncryption: true })
  const page   = pdfDoc.getPages().at(-1)!
  const { width, height } = page.getSize()
  const sigImage = await pdfDoc.embedPng(signaturePng)
  page.drawImage(sigImage, {
    x:      Math.round(width  * 0.12),
    y:      Math.round(height * 0.12),
    width:  Math.round(width  * 0.35),
    height: Math.round(height * 0.06),
  })
  return pdfDoc.save()
}

/**
 * Attaches the Chrome DevTools debugger to the Stimulsoft popup tab, captures the
 * full registration card as a PDF via Page.printToPDF (equivalent to "Print → Save as
 * PDF"), then detaches.  Returns base64-encoded PDF bytes, or null on failure.
 */
async function captureStimulsoftAsPdf(tabId: number): Promise<string | null> {
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
        else resolve()
      })
    })

    // Inject print CSS to hide Stimulsoft toolbar/navigation so it doesn't appear in PDF.
    await new Promise<void>(resolve => {
      chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(() => {
          const s = document.createElement('style');
          s.textContent = '@media print { [id*="Toolbar"],[class*="Toolbar"],[class*="toolbar"],[class*="StatusBar"],[id*="StatusBar"] { display:none!important } }';
          document.head.appendChild(s);
        })()`,
      }, () => resolve())
    })

    await new Promise(r => setTimeout(r, 300))

    const result = await new Promise<{ data: string }>((resolve, reject) => {
      chrome.debugger.sendCommand(
        { tabId },
        'Page.printToPDF',
        {
          printBackground:    true,
          displayHeaderFooter: false,
          landscape:           false,
          paperWidth:          8.27,   // A4
          paperHeight:         11.69,
          marginTop:           0,
          marginBottom:        0,
          marginLeft:          0,
          marginRight:         0,
          preferCSSPageSize:   true,
        },
        (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
          else resolve(res as { data: string })
        }
      )
    })

    await new Promise<void>(resolve => chrome.debugger.detach({ tabId }, () => resolve()))
    console.log('[FDN SW] CDP printToPDF captured:', result.data?.length, 'b64 chars')
    return result.data ?? null
  } catch (err) {
    console.warn('[FDN SW] CDP printToPDF failed:', err)
    try { await new Promise<void>(r => chrome.debugger.detach({ tabId }, () => r())) } catch { /* already detached */ }
    return null
  }
}

/**
 * Self-contained sign overlay injected into the Stimulsoft popup tab.
 * Must not close over any module-level variables — all inputs come via args[].
 */
function eZeeSignOverlayFunc(conf: string): void {
  if (document.getElementById('fdn-sign-overlay')) return

  const overlay = document.createElement('div')
  overlay.id = 'fdn-sign-overlay'
  overlay.style.cssText = [
    'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2147483647',
    'display:flex;align-items:flex-end;justify-content:center;padding-bottom:150px',
  ].join(';')

  const box = document.createElement('div')
  box.style.cssText = [
    'background:#fff;border-radius:8px;padding:16px 24px;width:700px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.4);display:flex;flex-direction:column;gap:8px',
  ].join(';')

  const canvas = document.createElement('canvas')
  canvas.width = 650
  canvas.height = 100
  canvas.style.cssText = 'width:100%;border:2px solid #1565c0;border-radius:4px;cursor:crosshair;touch-action:none;background:#f8f9ff'

  
  const statusEl = document.createElement('p')
  statusEl.style.cssText = 'margin:0;font:12px sans-serif;color:#555'

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:10px;justify-content:flex-end'

  function mkBtn(text: string, bg: string, color: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.textContent = text
    b.style.cssText = `padding:8px 22px;border-radius:4px;border:none;font-weight:600;cursor:pointer;font-size:14px;background:${bg};color:${color}`
    return b
  }

  const btnClear  = mkBtn('Clear',          '#f0f0f0', '#333')
  const btnCancel = mkBtn('Cancel',         '#f0f0f0', '#333')
  const btnSave   = mkBtn('Save Signature', '#1565c0', '#fff')

  btnRow.append(btnClear, btnCancel, btnSave)
  box.append(canvas, statusEl, btnRow)
  overlay.appendChild(box)
  document.body.appendChild(overlay)

  const ctx = canvas.getContext('2d')!
  ctx.strokeStyle = '#1a237e'
  ctx.lineWidth   = 2
  ctx.lineCap     = 'round'
  ctx.lineJoin    = 'round'

  let drawing = false
  function getPos(e: PointerEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect()
    return {
      x: (e.clientX - r.left) * (canvas.width  / r.width),
      y: (e.clientY - r.top)  * (canvas.height / r.height),
    }
  }

  canvas.addEventListener('pointerdown', e => {
    e.preventDefault()
    canvas.setPointerCapture(e.pointerId)
    drawing = true
    ctx.beginPath()
    const p = getPos(e)
    ctx.moveTo(p.x, p.y)
  })
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return
    const p = getPos(e)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
  })
  canvas.addEventListener('pointerup',     () => { drawing = false })
  canvas.addEventListener('pointercancel', () => { drawing = false })
  canvas.addEventListener('pointerleave',  () => { drawing = false })

  btnClear.onclick  = () => ctx.clearRect(0, 0, canvas.width, canvas.height)
  btnCancel.onclick = () => overlay.remove()

  btnSave.onclick = () => {
    btnSave.disabled = true
    btnSave.textContent = 'Saving…'
    statusEl.textContent = 'Saving signature…'
    statusEl.style.color = '#555'

    const signaturePng = canvas.toDataURL('image/png')
    overlay.style.display = 'none'

    void (async () => {
      try {
        const res = await (chrome.runtime.sendMessage({
          type: 'EZEE_SAVE_SIGNATURE',
          signaturePng,
          confirmation: conf,
          cardPdfBase64:   null,
          cardImageBase64: null,
        }) as Promise<{ ok: boolean; error?: string }>)

        if (!res?.ok) {
          overlay.style.display = 'flex'
          statusEl.textContent = '✗ Save failed: ' + (res?.error ?? 'unknown')
          statusEl.style.color = '#c62828'
          btnSave.disabled = false
          btnSave.textContent = 'Save Signature'
        }
        // On success the service worker closes this window
      } catch {
        overlay.style.display = 'flex'
        statusEl.textContent = '✗ Could not reach extension'
        statusEl.style.color = '#c62828'
        btnSave.disabled = false
        btnSave.textContent = 'Save Signature'
      }
    })()
  }
}

function forwardNativeHostRxToPanel(payload: NativeHostRxDebugBroadcast) {
  void chrome.runtime.sendMessage(payload).catch(() => {
    /* side panel may not be open */
  })
}

function broadcastScanFrontResult(imageFrontBase64: string): void {
  void (async () => {
    try {
      await writeScanImagesToStorage(imageFrontBase64, null)
      await writeScanPhase('front')
      // Drop stale complete-scan metadata so the panel does not re-apply old OCR over the preview.
      await chrome.storage.local.remove(['fdn_last_native_scan', 'lastScanResult'])
    } catch (e) {
      console.warn('[FDN ID scan] front image storage failed', e)
    }
    const msg: ScanFrontBroadcast = {
      type: 'FDN_SCAN_FRONT_RESULT',
      imageFrontBase64,
      imagesInStorage: true,
    }
    try {
      await chrome.runtime.sendMessage(msg)
    } catch {
      /* side panel may be closed — reads storage on change */
    }
  })()
}

async function broadcastNativeIdScan(payload: Omit<NativeIdScanBroadcast, 'type' | 'receivedAt' | 'imagesInStorage'>) {
  const receivedAt = new Date().toISOString()
  const front = payload.images.front_image_base64
  const back = payload.images.back_image_base64

  try {
    await writeScanImagesToStorage(front, back ?? null)
    await writeScanPhase('complete')
  } catch (e) {
    console.warn('[FDN ID scan] image storage failed', e)
  }

  const msg: NativeIdScanBroadcast = {
    type: 'FDN_NATIVE_ID_SCAN',
    receivedAt,
    parsed: payload.parsed,
    images: { front_image_base64: '', back_image_base64: '' },
    imageBase64Length: front.length + (back?.length ?? 0),
    ocrProvider: payload.ocrProvider,
    detail: payload.detail,
    documentData: payload.documentData,
    imagesInStorage: true,
  }
  try {
    await chrome.storage.local.set({ fdn_last_native_scan: msg })
  } catch (e) {
    console.warn('[FDN ID scan] metadata storage failed', e)
  }
  try {
    await chrome.runtime.sendMessage(msg)
  } catch {
    /* side panel may not be listening — reads storage on change */
  }
}

async function handleThalesNativeScan(payload: NativeScanSuccessPayload) {
  const images = payload.images
  const b64Front = images.front_image_base64?.trim() ?? ''
  const b64Back = images.back_image_base64?.trim() ?? ''

  if (b64Front && !b64Back) {
    broadcastScanFrontResult(b64Front)
    return
  }

  if (!isCompleteTwoSidedScan(b64Front, b64Back)) {
    console.warn('[FDN ID scan] ignored — no front image in scan payload')
    return
  }

  const detail = payload.detail ?? null
  await broadcastNativeIdScan({
    parsed: payload.parsed,
    images,
    imageBase64Length: b64Front.length + b64Back.length,
    ocrProvider: 'native_host',
    detail,
    documentData: payload.documentData ?? null,
  })

  // Write normalised lastScanResult for eZee content-script auto-fill.
  const docData = payload.documentData ?? {}
  const pr = payload.parsed
  await chrome.storage.local.set({
    lastScanResult: {
      first_name:    detail?.firstName  ?? null,
      middle_name:   detail?.middleName ?? null,
      last_name:     detail?.lastName   ?? null,
      dob:           pr.dateOfBirth     ?? null,
      id_number:     pr.idNumber        ?? null,
      expiry_date:   pr.expiryDate      ?? null,
      issue_date:    pr.issueDate       ?? null,
      gender:        (typeof docData.gender === 'string' ? docData.gender
                      : typeof docData.sex === 'string'  ? docData.sex
                      : null),
      address:       detail?.streetAddress ?? null,
      city:          detail?.city          ?? null,
      state:         detail?.state         ?? null,
      postal_code:   detail?.postalCode    ?? null,
      document_type: pr.idType            ?? null,
      phone:         detail?.phone?.trim()  || null,
      email:         detail?.email?.trim()  || null,
    },
  })
}

async function fetchIdScanHistoryForCurrentReservation(): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }
  const snap = reservation
  if (!snap?.confirmationNumber) return { ok: true, idScanHistory: [] }

  const conf = snap.confirmationNumber
  const { data, error } = await client
    .from('id_scans')
    .select('id, confirmation_number, manual_entry, created_at')
    .eq('confirmation_number', conf)
    .order('created_at', { ascending: false })
    .limit(25)

  if (error) {
    console.warn('[FDN] id_scans history query', error.message)
    return { ok: false, error: error.message }
  }

  const rows: IdScanHistoryRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    confirmationNumber: String(r.confirmation_number ?? ''),
    scannedAt: typeof r.created_at === 'string' ? r.created_at : '',
    manualEntry: Boolean(r.manual_entry),
  }))
  return { ok: true, idScanHistory: rows }
}

async function fetchIdScansByDate(fromDate: string, toDate: string): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }

  let q = client.from('id_scans').select('*').order('scanned_at', { ascending: false })
  if (fromDate.trim()) q = q.gte('scanned_at', `${fromDate.trim()}T00:00:00`)
  if (toDate.trim()) q = q.lte('scanned_at', `${toDate.trim()}T23:59:59.999`)

  const { data, error } = await q
  if (error) {
    console.warn('[FDN] id_scans by date', error.message)
    return { ok: false, error: error.message }
  }

  const scans = (data ?? []) as Record<string, unknown>[]
  const idScanLog = await buildIdScanLogFromScanRows(client, scans)
  return { ok: true, idScanLog }
}

async function fetchSignaturesByDate(
  fromDate: string,
  toDate: string,
  agentFilter?: string,
): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }

  let q = client.from('signatures').select('*').order('created_at', { ascending: false })
  if (fromDate.trim()) q = q.gte('created_at', `${fromDate.trim()}T00:00:00`)
  if (toDate.trim()) q = q.lte('created_at', `${toDate.trim()}T23:59:59.999`)
  if (agentFilter?.trim()) q = q.ilike('signed_by_username', `%${agentFilter.trim()}%`)

  const { data, error } = await q
  if (error) {
    console.warn('[FDN] signatures by date', error.message)
    return { ok: false, error: error.message }
  }

  const signatureLog = await buildSignatureLogFromRows(
    client,
    (data ?? []) as Record<string, unknown>[],
  )
  return { ok: true, signatureLog }
}

async function requireKeysWriteAccess(managerPin?: string): Promise<ExtensionResponse | null> {
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }
  const settings = await loadExtensionHotelSettings(client)
  const ok = keysWriteAuthorized(cachedRole, managerPin, settings.managerOverridePin)
  if (!ok) {
    return {
      ok: false,
      error: 'Admin role or valid manager PIN required for this action.',
    }
  }
  return null
}

async function handleCreateRoomBlock(
  msg: Extract<ExtensionMessage, { type: 'CREATE_ROOM_BLOCK' }>,
): Promise<ExtensionResponse> {
  const denied = await requireKeysWriteAccess(msg.managerPin)
  if (denied) return denied

  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  const user = sess.session!.user

  let blockedUntil: string | null = null
  const now = new Date()
  if (msg.durationKind === 'hours') {
    const h = Math.max(1, msg.durationValue ?? 4)
    blockedUntil = new Date(now.getTime() + h * 3_600_000).toISOString()
  } else if (msg.durationKind === 'days') {
    const d = Math.max(1, msg.durationValue ?? 1)
    blockedUntil = new Date(now.getTime() + d * 86_400_000).toISOString()
  }

  const { error } = await createRoomBlockSw(client, {
    roomNumber: msg.roomNumber,
    blockedUntil,
    reason: msg.reason ?? null,
    userId: user.id,
    username: user.email ?? null,
    role: cachedRole,
    effectiveFromVacancy: Boolean(msg.effectiveFromVacancy),
  })
  if (error) return { ok: false, error }
  return { ok: true }
}

async function handleReleaseRoomBlock(
  msg: Extract<ExtensionMessage, { type: 'RELEASE_ROOM_BLOCK' }>,
): Promise<ExtensionResponse> {
  const denied = await requireKeysWriteAccess(msg.managerPin)
  if (denied) return denied

  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  const user = sess.session!.user

  const { error } = await releaseRoomBlockSw(client, {
    blockId: msg.blockId,
    roomNumber: msg.roomNumber,
    userId: user.id,
    username: user.email ?? null,
    role: cachedRole,
  })
  if (error) return { ok: false, error }
  return { ok: true }
}

async function handleKeysAdminEncode(
  msg: Extract<ExtensionMessage, { type: 'KEYS_ADMIN_ENCODE' }>,
): Promise<ExtensionResponse> {
  const denied = await requireKeysWriteAccess(msg.managerPin)
  if (denied) return denied

  const result = await runRfidMakeKey({
    type: 'RFID_MAKE_KEY',
    roomNumber: msg.roomNumber,
    checkinTime: msg.checkinTime,
    checkoutTime: msg.checkoutTime,
    cardSerial: msg.cardSerial ?? 1,
    confirmationNumber: msg.confirmationNumber,
    portalAdminEncode: true,
  })
  return result as ExtensionResponse
}

async function fetchKeyBoard(businessDate: string, agentFilter?: string): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }
  try {
    const { board, stats } = await fetchKeyBoardData(client, businessDate, agentFilter)
    return { ok: true, keyBoard: board, keyBoardStats: stats }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not load room board'
    return { ok: false, error: message }
  }
}

async function fetchKeyLedgerMsg(
  fromDate: string,
  toDate: string,
  agentFilter?: string,
  roomFilter?: string,
): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }
  try {
    const keyLedger = await fetchKeyLedger(client, fromDate, toDate, agentFilter, roomFilter)
    return { ok: true, keyLedger }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not load key history'
    return { ok: false, error: message }
  }
}

async function verifyManagerPin(pin: string): Promise<ExtensionResponse> {
  const settings = await loadExtensionHotelSettings(getClient())
  if (!settings.managerOverridePin) {
    return { ok: false, error: 'No manager PIN configured — contact your admin.' }
  }
  if (pin.trim() !== settings.managerOverridePin) {
    return { ok: false, error: 'Invalid PIN' }
  }
  return { ok: true }
}

async function fetchIdScansBySearch(query: string): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }

  const q = query.trim()
  if (q.length < 2) return { ok: true, idScanLog: [] }

  try {
    const idScanLog = await searchIdScanHistory(client, q)
    return { ok: true, idScanLog }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Search failed'
    console.warn('[FDN] id_scans search', message)
    return { ok: false, error: message }
  }
}

async function fetchReturningGuestHistory(idNumber: string): Promise<ExtensionResponse> {
  const norm = idNumber.replace(/\s+/g, '').toUpperCase()
  if (!norm) return { ok: true, returningGuestHistory: [] }

  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: true, returningGuestHistory: [] }

  const hash = await hashIdNumber(norm)
  let data: Record<string, unknown>[] | null = null
  let error: { message: string } | null = null

  const byHash = await client
    .from('id_scans')
    .select(GUEST_HISTORY_SCAN_SELECT)
    .eq('id_number_hash', hash)
    .order('scanned_at', { ascending: false })
    .limit(25)

  data = (byHash.data ?? []) as Record<string, unknown>[]
  error = byHash.error

  if (error?.message?.includes('scanned_at')) {
    const fallback = await client
      .from('id_scans')
      .select(GUEST_HISTORY_SCAN_SELECT)
      .eq('id_number_hash', hash)
      .order('created_at', { ascending: false })
      .limit(25)
    data = (fallback.data ?? []) as Record<string, unknown>[]
    error = fallback.error
  }

  if (error?.message?.includes('id_number_hash')) {
    const recent = await client
      .from('id_scans')
      .select(GUEST_HISTORY_SCAN_SELECT)
      .order('scanned_at', { ascending: false })
      .limit(120)
    if (!recent.error) {
      const want = norm
      const matched: Record<string, unknown>[] = []
      for (const row of (recent.data ?? []) as Record<string, unknown>[]) {
        const rec = await guestStayRecordFromScanRow(row)
        if (!rec?.idNumber) continue
        if (normalizeIdNumber(rec.idNumber) === want) matched.push(row)
        if (matched.length >= 25) break
      }
      data = matched
      error = null
    }
  }

  if (error) {
    console.warn('[FDN] returning guest query', error.message)
    return { ok: true, returningGuestHistory: [], guestStayHistory: [] }
  }

  const records = (
    await Promise.all((data ?? []).map((r) => guestStayRecordFromScanRow(r)))
  ).filter((r): r is GuestStayHistoryRecord => r != null)

  const returningGuestHistory: ReturningGuestRecord[] = records.map((r) => ({
    id: r.id,
    confirmationNumber: r.confirmationNumber,
    scannedAt: r.scannedAt,
    phone: r.phone,
    email: r.email,
  }))

  return { ok: true, returningGuestHistory, guestStayHistory: records }
}

const GUEST_HISTORY_SCAN_SELECT =
  'id, confirmation_number, created_at, scanned_at, manual_entry, phone_encrypted, email_encrypted, pii_encrypted'

async function fetchGuestHistoryByPhone(phone: string): Promise<ExtensionResponse> {
  if (!isCompletePhoneForLookup(phone)) return { ok: true, guestStayHistory: [] }

  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: true, guestStayHistory: [] }

  const phoneHash = await hashPhoneNumber(phone.trim())
  let data: Record<string, unknown>[] | null = null
  let error: { message: string } | null = null

  if (phoneHash) {
    const res = await client
      .from('id_scans')
      .select(GUEST_HISTORY_SCAN_SELECT)
      .eq('phone_number_hash', phoneHash)
      .order('scanned_at', { ascending: false })
      .limit(25)
    data = (res.data ?? []) as Record<string, unknown>[]
    error = res.error
    if (error?.message?.includes('phone_number_hash') || error?.message?.includes('scanned_at')) {
      if (error?.message?.includes('scanned_at') && phoneHash) {
        const retry = await client
          .from('id_scans')
          .select(GUEST_HISTORY_SCAN_SELECT)
          .eq('phone_number_hash', phoneHash)
          .order('created_at', { ascending: false })
          .limit(25)
        data = (retry.data ?? []) as Record<string, unknown>[]
        error = retry.error
      }
      if (error?.message?.includes('phone_number_hash')) {
        data = null
        error = null
      }
    }
  }

  if (!data) {
    let res = await client
      .from('id_scans')
      .select(GUEST_HISTORY_SCAN_SELECT)
      .not('phone_encrypted', 'is', null)
      .order('scanned_at', { ascending: false })
      .limit(60)
    if (res.error?.message?.includes('scanned_at')) {
      res = await client
        .from('id_scans')
        .select(GUEST_HISTORY_SCAN_SELECT)
        .not('phone_encrypted', 'is', null)
        .order('created_at', { ascending: false })
        .limit(60)
    }
    if (res.error) {
      console.warn('[FDN] guest phone history fallback', res.error.message)
      return { ok: true, guestStayHistory: [] }
    }
    const records = await filterRecordsByPhone((res.data ?? []) as Record<string, unknown>[], phone)
    return { ok: true, guestStayHistory: records.slice(0, 25) }
  }

  if (error) {
    console.warn('[FDN] guest phone history', error.message)
    return { ok: true, guestStayHistory: [] }
  }

  const records: GuestStayHistoryRecord[] = (
    await Promise.all((data ?? []).map((r) => guestStayRecordFromScanRow(r)))
  ).filter((r): r is GuestStayHistoryRecord => r != null)

  return { ok: true, guestStayHistory: records.slice(0, 25) }
}

async function fetchKeyHistoryForCurrentReservation(): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }
  const snap = reservation
  if (!snap?.confirmationNumber) return { ok: true, keyHistory: [] }

  const conf = snap.confirmationNumber
  const { data, error } = await client
    .from('key_history')
    .select('id, confirmation_number, room_number, card_serial, checkin_time, checkout_time, encoded_by_username, created_at')
    .eq('confirmation_number', conf)
    .order('created_at', { ascending: false })
    .limit(25)

  if (error) {
    console.warn('[FDN] key_history query', error.message)
    return { ok: false, error: error.message }
  }

  const rows: KeyHistoryRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
    id: String(r.id),
    confirmation_number: String(r.confirmation_number ?? ''),
    room_number: String(r.room_number ?? ''),
    card_serial: typeof r.card_serial === 'number' ? r.card_serial : Number(r.card_serial ?? 1),
    checkin_time: typeof r.checkin_time === 'string' ? r.checkin_time : '',
    checkout_time: typeof r.checkout_time === 'string' ? r.checkout_time : '',
    encoded_by_username: typeof r.encoded_by_username === 'string' ? r.encoded_by_username : null,
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
  }))
  return { ok: true, keyHistory: rows }
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

async function handleMessage(
  msg: ExtensionMessage,
  _sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse | Record<string, unknown>> {
  const client = getClient()

  if (msg.type === 'GET_STATE') {
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'GET_ID_SCAN_HISTORY') {
    return fetchIdScanHistoryForCurrentReservation()
  }

  if (msg.type === 'GET_ID_SCANS_BY_DATE') {
    return fetchIdScansByDate(msg.fromDate, msg.toDate)
  }

  if (msg.type === 'SEARCH_ID_SCANS_HISTORY') {
    return fetchIdScansBySearch(msg.query)
  }

  if (msg.type === 'GET_SIGNATURES_BY_DATE') {
    return fetchSignaturesByDate(msg.fromDate, msg.toDate, msg.agentFilter)
  }

  if (msg.type === 'VERIFY_MANAGER_PIN') {
    return verifyManagerPin(msg.pin)
  }

  if (msg.type === 'GET_KEY_BOARD') {
    return fetchKeyBoard(msg.businessDate, msg.agentFilter)
  }

  if (msg.type === 'GET_KEY_LEDGER') {
    return fetchKeyLedgerMsg(msg.fromDate, msg.toDate, msg.agentFilter, msg.roomFilter)
  }

  if (msg.type === 'CREATE_ROOM_BLOCK') {
    return handleCreateRoomBlock(msg)
  }

  if (msg.type === 'RELEASE_ROOM_BLOCK') {
    return handleReleaseRoomBlock(msg)
  }

  if (msg.type === 'KEYS_ADMIN_ENCODE') {
    return handleKeysAdminEncode(msg)
  }

  if (msg.type === 'GET_KEY_HISTORY') {
    return fetchKeyHistoryForCurrentReservation()
  }

  if (msg.type === 'GET_RETURNING_GUEST_HISTORY') {
    return fetchReturningGuestHistory(msg.idNumber)
  }

  if (msg.type === 'GET_GUEST_HISTORY_BY_PHONE') {
    return fetchGuestHistoryByPhone(msg.phone)
  }

  if (msg.type === 'LOAD_EZEE_RESERVATION') {
    const tab = await findEzeeTab()
    if (!tab?.id) {
      const reason =
        'Open eZee Absolute (live.ipms247.com), open a guest in the Arrivals drawer, then click Get Guest Data.'
      lastError = reason
      return { ok: false, error: reason }
    }
    lastPmsTabId = tab.id
    let tabRes: unknown
    try {
      tabRes = await chrome.tabs.sendMessage(tab.id, { type: 'EZEE_EXTRACT_NOW' })
    } catch {
      lastError = 'Could not run eZee scrape in this tab. Reload the page and try again.'
      return {
        ok: false,
        error: lastError,
      }
    }
    const tr = tabRes as {
      ok?: boolean
      snapshot?: ReservationSnapshot
      guestDisplay?: EzeeGuestDisplay
      error?: string
    }
    if (!tr.ok || !tr.snapshot || !tr.guestDisplay) {
      lastError = tr.error ?? 'Could not read the guest drawer.'
      return { ok: false, error: lastError }
    }
    return completeEzeeReservationFromSnapshot(tab.id, tab.url ?? 'https://live.ipms247.com/', tr.snapshot, tr.guestDisplay, {
      chromeNotify: true,
      panelToast: false,
    })
  }

  if (msg.type === 'LOAD_SYNXIS_RESERVATION') {
    const tab = await findSynxisTab()
    if (!tab?.id) {
      const reason =
        'Open SynXis Control Center (controlcenter-p2.synxis.com) in a tab, then click Get Guest Data.'
      lastError = reason
      return { ok: false, error: reason }
    }
    lastPmsTabId = tab.id
    const tabUrl = tab.url ?? 'https://controlcenter-p2.synxis.com/'

    let confirmation: string
    try {
      confirmation = await getConfirmationFromSynxisTab(tab.id)
    } catch (e) {
      const err = e instanceof Error ? e.message : 'Confirmation extraction failed'
      lastError = err
      synxisGuestDisplay = null
      void notifyUser('FrontDesk Nexus — Confirmation not found', err)
      return { ok: false, error: err }
    }

    return completeSynxisReservationFromConfirmation(tab.id, tabUrl, confirmation, {
      chromeNotify: true,
      panelToast: false,
    })
  }

  if (msg.type === 'EZEE_SUPPRESS_GUEST_LOAD') {
    // Legacy no-op: folio/edit navigation must not clear an already-loaded guest.
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'EZEE_AUTO_GUEST_DETECTED') {
    const tabId = _sender.tab?.id
    if (tabId == null) {
      return { ok: false, error: 'eZee auto-load: no sender tab' }
    }
    const c = (msg.snapshot.confirmationNumber ?? '').trim()
    if (!isValidEzeeReservationNumber(c)) {
      console.warn('[FDN] eZee auto-load: invalid reservation #, ignored', msg.snapshot.confirmationNumber)
      return { ok: true, state: await getState() }
    }
    const g = msg.guestDisplay
    const hasContact = !!(g.phone?.trim() || g.email?.trim())
    const hasStay = !!(g.roomNumber?.trim() || g.staySummary?.trim())
    if (!hasContact && !hasStay) {
      console.warn('[FDN] eZee auto-load: incomplete guest payload, ignored', c, g.nameLine)
      return { ok: true, state: await getState() }
    }

    const roomHint = (msg.snapshot.roomNumber ?? '').trim()
    const now = Date.now()
    const prev = ezeeAutoDedupeByTab.get(tabId)
    if (
      prev &&
      prev.confirmation === c &&
      prev.roomHint === roomHint &&
      now - prev.at < EZEE_AUTO_DEDUPE_MS
    ) {
      return { ok: true, state: await getState() }
    }

    const fk = ezeeAutoFlightKey(tabId, c, roomHint)
    if (ezeeAutoInFlight.has(fk)) {
      return { ok: true, state: await getState() }
    }
    ezeeAutoInFlight.add(fk)
    try {
      const tabUrl = _sender.tab?.url ?? 'https://live.ipms247.com/'
      const result = await completeEzeeReservationFromSnapshot(
        tabId,
        tabUrl,
        msg.snapshot,
        msg.guestDisplay,
        { chromeNotify: true, panelToast: false },
      )
      if (result && typeof result === 'object' && 'ok' in result && result.ok === true) {
        ezeeAutoDedupeByTab.set(tabId, { confirmation: c, roomHint, at: Date.now() })
      }
      return result
    } finally {
      ezeeAutoInFlight.delete(fk)
    }
  }

  if (msg.type === 'SYNXIS_AUTO_GUEST_DETECTED') {
    const tabId = _sender.tab?.id
    if (tabId == null) {
      return { ok: false, error: 'Auto-load: no sender tab' }
    }
    const c = msg.confirmation.trim().toUpperCase()
    if (!isSynxisConfirmationToken(c)) {
      console.warn('[FDN] SynXis auto-load: invalid confirmation, ignored', msg.confirmation)
      return { ok: true, state: await getState() }
    }

    const roomHint = (msg.roomHint ?? '').trim()
    const now = Date.now()
    const prev = synxisAutoDedupeByTab.get(tabId)
    if (
      prev &&
      prev.confirmation === c &&
      prev.roomHint === roomHint &&
      now - prev.at < SYNXIS_AUTO_DEDUPE_MS
    ) {
      return { ok: true, state: await getState() }
    }

    const tabUrl = _sender.tab?.url ?? 'https://controlcenter-p2.synxis.com/'
    const fk = synxisAutoFlightKey(tabId, c, roomHint)
    if (synxisAutoInFlight.has(fk)) {
      return { ok: true, state: await getState() }
    }
    synxisAutoInFlight.add(fk)
    try {
      const result = await completeSynxisReservationFromConfirmation(tabId, tabUrl, c, {
        chromeNotify: true,
        panelToast: false,
      })
      if (result.ok === true) {
        synxisAutoDedupeByTab.set(tabId, { confirmation: c, roomHint, at: Date.now() })
      }
      return result
    } finally {
      synxisAutoInFlight.delete(fk)
    }
  }

  if (msg.type === 'SAVE_SIGNATURE') {
    return saveSignature({ pdfBase64: msg.pdfBase64, confirmationNumber: msg.confirmationNumber })
  }

  if (msg.type === 'SYNXIS_PRINT_BASIC_CARD_CLICKED') {
    console.log('[FDN] Print Basic Registration Card clicked')
    // TODO: implement print card action here
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'EZEE_PRINT_BASIC_CARD_CLICKED') {
    console.log('[FDN eZee] Print Guest Registration Card clicked | confirmation:', msg.confirmation)
    return { ok: true }
  }

  if (msg.type === 'EZEE_OPEN_REG_CARD') {
    // Prevent reopening if a window is already open for this confirmation.
    const existingWinId = ezeeRegCardWindowByConf.get(msg.confirmation)
    if (existingWinId != null) {
      try {
        await chrome.windows.update(existingWinId, { focused: true })
        console.log('[FDN SW] EZEE_OPEN_REG_CARD: reusing existing window', existingWinId)
        return { ok: true }
      } catch {
        // Window was closed externally — fall through to open a new one
        ezeeRegCardWindowByConf.delete(msg.confirmation)
      }
    }

    // Open the Stimulsoft URL as a real popup so session cookies load correctly.
    // (Embedding it in an extension-page iframe is blocked by X-Frame-Options.)
    const win = await chrome.windows.create({
      url: msg.ezeeReportUrl,
      type: 'popup',
      width: 1200,
      height: 900,
    })
    if (!win) return { ok: true }
    if (win.id != null) {
      ezeeRegCardWindowByConf.set(msg.confirmation, win.id)
      await moveWindowToSecondDisplay(win.id)
    }

    const tabId = win.tabs?.[0]?.id
    if (tabId != null) {
      // Wait for the tab to finish loading before injecting the sign overlay.
      await new Promise<void>((resolve) => {
        function onUpdated(tid: number, info: { status?: string }): void {
          if (tid !== tabId || info.status !== 'complete') return
          chrome.tabs.onUpdated.removeListener(onUpdated)
          resolve()
        }
        chrome.tabs.onUpdated.addListener(onUpdated)
        setTimeout(() => resolve(), 20_000) // fallback
      })
      // 135% zoom — larger text makes the card easier to read and sign on the 2nd display
      try { await chrome.tabs.setZoom(tabId, 1.35) } catch { /* ignore */ }

      // Hide the Stimulsoft viewer toolbar so the card is shown without viewer chrome.
      try {
        await chrome.scripting.insertCSS({
          target: { tabId },
          css: '[id*="Toolbar"],[id*="ToolBar"],[class*="Toolbar"],[class*="toolbar"],[class*="StatusBar"],[id*="StatusBar"] { display:none!important }',
        })
      } catch { /* ignore */ }

      // Wait for Stimulsoft to fetch and render the report (JS-driven, happens after load).
      await new Promise(r => setTimeout(r, 4000))

      // Capture the fully-rendered registration card via CDP before showing the overlay,
      // so the PDF contains no overlay elements.
      const capturedPdf = await captureStimulsoftAsPdf(tabId)
      if (capturedPdf) {
        ezeePreCapturedPdf.set(msg.confirmation, capturedPdf)
      } else {
        console.warn('[FDN SW] CDP PDF capture failed — will use text fallback')
      }

      await new Promise(r => setTimeout(r, 300))
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: eZeeSignOverlayFunc,
          args: [msg.confirmation],
        })
      } catch (e) {
        console.warn('[FDN SW] Sign overlay injection failed:', e)
      }
    }
    return { ok: true }
  }

  if (msg.type === 'EZEE_SAVE_SIGNATURE') {
    const senderWindowId = _sender.tab?.windowId
    try {
      let pdfBytes: Uint8Array

      // Prefer the CDP-captured real Stimulsoft PDF stored by EZEE_OPEN_REG_CARD.
      const preCapturePdfB64 = ezeePreCapturedPdf.get(msg.confirmation)
      ezeePreCapturedPdf.delete(msg.confirmation)

      const cardPdfB64 = preCapturePdfB64 ?? msg.cardPdfBase64 ?? null
      if (cardPdfB64) {
        console.log('[FDN SW] eZee signature: embedding into Stimulsoft PDF ✓', preCapturePdfB64 ? '(CDP)' : '(overlay)')
        const bin = atob(cardPdfB64)
        const cardBytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) cardBytes[i] = bin.charCodeAt(i)
        pdfBytes = await embedSignatureIntoEzeePdf(cardBytes, msg.signaturePng)
      } else {
        console.log('[FDN SW] eZee signature: text fallback (no PDF captured)')
        pdfBytes = await createEzeeSignaturePdf(null, msg.signaturePng, msg.confirmation)
      }

      let binary = ''
      for (let i = 0; i < pdfBytes.length; i++) binary += String.fromCharCode(pdfBytes[i])
      const result = await saveSignature({
        pdfBase64: btoa(binary),
        confirmationNumber: msg.confirmation,
      })

      // Clean up dedup tracking
      ezeeRegCardWindowByConf.delete(msg.confirmation)

      // Defer window close so the response reaches the injected script first,
      // preventing it from showing an error and potentially re-triggering the flow.
      if (senderWindowId != null) {
        setTimeout(() => {
          void chrome.windows.remove(senderWindowId).catch(() => { /* already closed */ })
        }, 500)
      }

      void notifyUser(
        'Guest Signature Complete',
        msg.confirmation
          ? `Confirmation ${msg.confirmation} — guest has signed.`
          : 'Guest has signed the registration card.',
      )
      return result
    } catch (e) {
      const err = e instanceof Error ? e.message : 'Signature save failed'
      console.error('[FDN SW] EZEE_SAVE_SIGNATURE failed:', e)
      return { ok: false, error: err }
    }
  }

  if (msg.type === 'AUTH_DEV_LOGIN') {
    lastError = null
    const { error } = await client.auth.signInWithPassword({
      email: msg.email,
      password: msg.password,
    })
    if (error) return { ok: false, error: error.message }
    await refreshRole(client)
    await ensureTerminal(client)
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'BRIDGE_SET_SESSION') {
    lastError = null
    const { error } = await client.auth.setSession({
      access_token: msg.accessToken,
      refresh_token: msg.refreshToken,
    })
    if (error) return { ok: false, error: error.message }
    await refreshRole(client)
    await ensureTerminal(client)
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'AUTH_LOGOUT') {
    await flushPendingGuestDraftIfPresent({ ignoreMinAge: true })
    await client.auth.signOut()
    cachedRole = null
    reservation = null
    void chrome.storage.local.remove(['fdn_active_reservation', 'fdn_ezee_guest_display'])
    synxisGuestDisplay = null
    ezeeGuestDisplay = null
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'VERIFY_MANAGER') {
    return verifyManager(msg.email, msg.password)
  }

  if (msg.type === 'CHECK_DNR') {
    const client = getClient()
    const { data: sess } = await client.auth.getSession()
    if (!sess.session) return { ok: false, error: 'Not signed in' }
    const dnrActive = await checkActiveDnr(client, msg.idNumber)
    return { ok: true, dnrActive }
  }

  if (msg.type === 'ADD_DNR') {
    return addDnrEntry({
      guestName: msg.guestName,
      idNumber: msg.idNumber,
      dateOfBirth: msg.dateOfBirth,
      reason: msg.reason,
      managerEmail: msg.managerEmail,
      managerPassword: msg.managerPassword,
    })
  }

  if (msg.type === 'SAVE_ID_SCAN') {
    return saveIdScan({
      parsed: msg.parsed,
      phone: msg.phone,
      email: msg.email,
      manualEntry: msg.manualEntry,
      managerOverride: msg.managerOverride,
      imageFrontBase64: msg.imageFrontBase64,
      imageBackBase64: msg.imageBackBase64,
      ocrProvider: msg.ocrProvider,
      detail: msg.detail ?? null,
      documentData: msg.documentData ?? null,
      guestRemark: msg.guestRemark ?? null,
      checkInRemark: msg.checkInRemark ?? null,
      existingScanId: msg.existingScanId ?? null,
    })
  }

  if (msg.type === 'INJECT_PMS') {
    const tabId = await resolvePmsTabId()
    if (tabId == null) {
      return { ok: false, error: 'No SynXis or eZee tab found. Open a guest page first.' }
    }
    try {
      const tabRes = await chrome.tabs.sendMessage(tabId, {
        type: 'FDN_INJECT',
        fields: msg.fields,
      })
      return { ok: true, inject: tabRes }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Inject message failed'
      return { ok: false, error: message }
    }
  }

  if (msg.type === 'RFID_MAKE_KEY') {
    if (msg.portalAdminEncode && cachedRole !== 'admin') {
      const settings = await loadExtensionHotelSettings(getClient())
      const pinOk = keysWriteAuthorized(cachedRole, msg.managerPin, settings.managerOverridePin)
      if (!pinOk) {
        return {
          ok: false,
          error:
            'Admin encode requires an admin session or valid manager PIN in the extension.',
        }
      }
    }
    return runRfidMakeKey(msg)
  }

  if (msg.type === 'RFID_READ_CARD') {
    try {
      const raw = await sendNativeRequest({ type: 'RFID_READ_CARD' })
      if (!raw.success) {
        return { ok: false, error: String(raw.error ?? 'Card read failed') }
      }
      const cardData = String(raw.card_data ?? raw.return_msg ?? '')

      // Primary: use room number decoded by Python from raw card string (works for all SDK-encoded cards)
      const pythonRoomNumber = typeof raw.room_number === 'string' && raw.room_number ? raw.room_number : null
      const pythonSerial = typeof raw.card_serial === 'number' ? raw.card_serial : null
      const pythonCheckin = typeof raw.checkin_time === 'string' ? raw.checkin_time : null
      const pythonCheckout = typeof raw.checkout_time === 'string' ? raw.checkout_time : null

      const stored = await chrome.storage.local.get(`fdn_card_${cardData}`)
      const known = stored[`fdn_card_${cardData}`] as
        | {
            roomNumber: string
            cardSerial: number
            checkinTime?: string
            checkoutTime?: string
          }
        | undefined

      const roomNumber = pythonRoomNumber ?? known?.roomNumber ?? null
      const cardSerial = pythonSerial ?? known?.cardSerial ?? null

      // Checkin is yyyyMMddHHmm at bytes [15:27].
      // Checkout is at bytes [27:39] but uses a variant format for months 1–9:
      //   yyyy + '1' + M + ddHHmm  (M is single digit, no leading zero)
      // For months 10–12 the format is the standard yyyyMMddHHmm.
      // Detect by checking whether bytes [4:6] parsed as int exceed 12.
      let checkinFromCard: string | null = null
      let checkoutFromCard: string | null = null
      if (cardData.length >= 39) {
        const ci = cardData.slice(15, 27)
        if (/^\d{12}$/.test(ci)) checkinFromCard = ci
        const coRaw = cardData.slice(27, 39)
        if (/^\d{12}$/.test(coRaw)) {
          const mmInt = parseInt(coRaw.slice(4, 6), 10)
          if (mmInt > 12) {
            // Single-digit month: skip the extra byte at index 4, pad month to 2 digits
            const month = parseInt(coRaw[5]!, 10)
            checkoutFromCard = `${coRaw.slice(0, 4)}${String(month).padStart(2, '0')}${coRaw.slice(6)}`
          } else {
            checkoutFromCard = coRaw
          }
        }
      }
      const checkinTime = checkinFromCard ?? pythonCheckin
      const checkoutTime = checkoutFromCard ?? pythonCheckout

      if (roomNumber) {
        return { ok: true, cardData, roomNumber, cardSerial, checkinTime, checkoutTime }
      }

      return {
        ok: true,
        cardData,
        roomNumber: null,
        cardSerial: null,
        checkinTime: null,
        checkoutTime: null,
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Card read failed'
      return { ok: false, error: message }
    }
  }

  if (msg.type === 'RFID_MAKE_LOST_KEY') {
    const client = getClient()
    try {
      const raw = await sendNativeRequest({
        type: 'RFID_MAKE_LOST_KEY',
        room_number: msg.roomNumber,
        checkout_time: toSdkDatetimeHotel(msg.checkoutTime, 12),
      })

      if (!raw.success) {
        return { ok: false, error: String(raw.error ?? 'Lost key encoding failed') }
      }

      const { data: sess } = await client.auth.getSession()
      const user = sess.session?.user ?? null
      const terminalId = await ensureTerminal(client)
      const conf = reservation?.confirmationNumber ?? null
      let dbWarning: string | null = null

      const newCheckinTime = typeof raw.new_checkin_time === 'string' ? raw.new_checkin_time : String(raw.new_checkin_time ?? '')
      const dbCheckoutTime = keyHistoryTimeForDb(raw.checkout_time, msg.checkoutTime, 12)

      if (user && conf) {
        const { error: khErr } = await client.from('key_history').insert({
          confirmation_number: conf,
          room_number: msg.roomNumber,
          card_serial: 1,
          checkin_time: newCheckinTime,
          checkout_time: dbCheckoutTime,
          encoded_by: user.id,
          encoded_by_username: user.email ?? null,
          terminal_id: terminalId,
        })
        if (khErr) {
          console.error('[FDN SW] key_history insert (lost key) failed:', khErr.message)
          dbWarning = `Lost key encoded but DB record failed: ${khErr.message}`
        }

        await client
          .from('audit_log')
          .insert({
            user_id: user.id,
            username: user.email,
            user_role: cachedRole,
            terminal_id: terminalId,
            action_type: 'KEY_ENCODED',
            confirmation_number: conf,
            description: `Lost key replacement encoded — room ${msg.roomNumber}, serial 1`,
            new_value: { room_number: msg.roomNumber, card_serial: 1, return_msg: raw.return_msg, lost_key_replacement: true },
          })
          .then(({ error }) => {
            if (error) console.error('[FDN SW] audit_log (lost_key) failed:', error.message)
          })
      } else if (!user) {
        dbWarning = 'Lost key encoded but extension is not signed in — key_history not saved.'
      } else if (!conf) {
        dbWarning = 'Lost key encoded but no confirmation — key_history not saved.'
      }

      if (dbWarning) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.png',
          title: 'Lost Key Encoded — DB Warning',
          message: `Room ${msg.roomNumber}\n${dbWarning}`,
          priority: 2,
        })
      } else {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon.png',
          title: 'Lost Key Replacement Encoded',
          message: `Room ${msg.roomNumber} — tap door to invalidate old key. Conf: ${conf ?? '—'}`,
          priority: 1,
        })
      }

      return { ok: true, newCheckinTime, dbWarning: dbWarning ?? undefined, state: await getState() }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Lost key encoding failed'
      return { ok: false, error: message }
    }
  }

  if (msg.type === 'RFID_CHECK_CONNECTION') {
    try {
      const raw = await sendNativeRequest({ type: 'RFID_HANDSHAKE' })
      handleRfidStatus(!!raw.connected, raw.error ? String(raw.error) : null)
      rfidStatusCheckedAt = Date.now()
    } catch (e) {
      handleRfidStatus(false, e instanceof Error ? e.message : 'Check failed')
    }
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'FIND_GUEST_IN_PMS') {
    const tabId = await resolvePmsTabId()
    if (tabId == null) {
      return { ok: false, error: 'No SynXis or eZee tab found. Open the reservations page first.' }
    }

    let tabUrl = ''
    try { tabUrl = (await chrome.tabs.get(tabId)).url ?? '' } catch { /* ignore */ }

    if (/synxis\.com/i.test(tabUrl)) {
      // The "Find reservations" input lives in the cross-origin sph.synxis.com iframe.
      // chrome.tabs.sendMessage without frameId is unreliable for cross-origin iframes,
      // so we inject directly with executeScript allFrames:true — it runs in every frame
      // and the sph.synxis.com frame is the one that finds #find-reservation-input.
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: (lastName: string): boolean => {
            const el = document.getElementById('find-reservation-input') as HTMLInputElement | null
            if (!el) return false
            el.focus()
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            if (setter) setter.call(el, lastName)
            else el.value = lastName
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            ;(document.getElementById('find-reservation-search-bar') as HTMLElement | null)?.click()
            return true
          },
          args: [msg.lastName],
        })
        const found = results.some(r => r.result === true)
        return found
          ? { ok: true }
          : { ok: false, error: 'Search input not found. Navigate to the Guest Board page first.' }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : 'Find Guest failed' }
      }
    }

    // eZee: message passing works fine (search input is in the main frame, no iframe involved)
    try {
      const tabRes = await chrome.tabs.sendMessage(tabId, {
        type: 'FDN_FIND_GUEST',
        lastName: msg.lastName,
      })
      return { ok: true, ...(tabRes as object) }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Find Guest message failed'
      return { ok: false, error: message }
    }
  }

  return { ok: false, error: 'Unknown message type' }
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: unknown) => void,
  ) => {
    void handleMessage(message, sender)
      .then(sendResponse)
      .catch((e) => {
        sendResponse({
          ok: false,
          error: e instanceof Error ? e.message : 'Internal error',
        })
      })
    return true
  },
)

function ensureSidePanelOpensOnActionClick() {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
}

// Chrome kills service workers after ~30 s of inactivity, which stops Supabase's
// autoRefreshToken timer. A persistent alarm wakes the SW every 45 min so the JWT
// is refreshed before the 1-hour access-token expiry.
const SESSION_KEEPALIVE_ALARM = 'fdn-session-keepalive'

function ensureSessionKeepalive(): void {
  void chrome.alarms.get(SESSION_KEEPALIVE_ALARM).then((alarm) => {
    if (!alarm) {
      void chrome.alarms.create(SESSION_KEEPALIVE_ALARM, { periodInMinutes: 45 })
    }
  })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SESSION_KEEPALIVE_ALARM) {
    void getClient().auth.getSession()
  }
})

// Sign out after 8 hours of system-wide inactivity (no mouse/keyboard input).
// chrome.idle.onStateChanged wakes the service worker even when it is sleeping.
const IDLE_LOGOUT_SECONDS = 8 * 60 * 60

function ensureIdleLogout(): void {
  chrome.idle.setDetectionInterval(IDLE_LOGOUT_SECONDS)
}

chrome.idle.onStateChanged.addListener((newState) => {
  if (newState !== 'idle') return
  void (async () => {
    const client = getClient()
    const { data: sess } = await client.auth.getSession()
    if (!sess.session) return
    await flushPendingGuestDraftIfPresent({ ignoreMinAge: false })
    await client.auth.signOut()
    cachedRole = null
  })()
})

chrome.runtime.onInstalled.addListener(() => {
  ensureSidePanelOpensOnActionClick()
  ensureSessionKeepalive()
  ensureIdleLogout()
})

chrome.runtime.onStartup.addListener(() => {
  ensureSidePanelOpensOnActionClick()
  ensureSessionKeepalive()
  ensureIdleLogout()
})

ensureSidePanelOpensOnActionClick()
ensureSessionKeepalive()
ensureIdleLogout()

void (async () => {
  const v = await checkMinExtensionVersion()
  versionBlocked = v.blocked
  versionMessage = v.message
})()

void chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.fdn_bridge_revoked) {
    void (async () => {
      await flushPendingGuestDraftIfPresent({ ignoreMinAge: false })
      await getClient().auth.signOut()
      cachedRole = null
    })()
  }
})

const SESSION_BRIDGE_CHANNEL = 'FDN_SESSION_V1' as const
const PORTAL_BRIDGE_CHANNEL = 'FDN_PORTAL_V1' as const
const SESSION_SCHEMA_VERSION = 1 as const

/** Matches `Web/src/lib/sessionBridge.ts` — external session publish from the portal. */
type ExternalSessionBridgePayload =
  | {
      kind: 'session'
      schemaVersion: typeof SESSION_SCHEMA_VERSION
      issuedAtMs: number
      accessExpiresAtMs?: number
      userId: string
      email: string | null
      role: string
      supabaseUrl: string
      accessToken: string
      refreshToken: string
    }
  | {
      kind: 'invalidated'
      schemaVersion: typeof SESSION_SCHEMA_VERSION
      issuedAtMs: number
      reason: string
    }

const noopSender = null as unknown as chrome.runtime.MessageSender

chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (!message || typeof message !== 'object') {
        sendResponse({ ok: false, error: 'Invalid message' })
        return
      }
      const m = message as Record<string, unknown>

      if (m.channel === SESSION_BRIDGE_CHANNEL) {
        const payload = m.payload as ExternalSessionBridgePayload | undefined
        if (!payload || payload.schemaVersion !== SESSION_SCHEMA_VERSION) {
          sendResponse({ ok: false, error: 'Invalid session bridge envelope' })
          return
        }
        if (payload.kind === 'invalidated') {
          sendResponse(await handleMessage({ type: 'AUTH_LOGOUT' }, noopSender))
          return
        }
        if (payload.kind === 'session') {
          sendResponse(
            await handleMessage(
              {
                type: 'BRIDGE_SET_SESSION',
                accessToken: payload.accessToken,
                refreshToken: payload.refreshToken,
              },
              noopSender,
            ),
          )
          return
        }
      }

      if (m.channel === PORTAL_BRIDGE_CHANNEL && m.type === 'RFID_MAKE_KEY') {
        const roomNumber = String(m.roomNumber ?? '').trim()
        const checkinTime = String(m.checkinTime ?? '')
        const checkoutTime = String(m.checkoutTime ?? '')
        if (!roomNumber || !checkinTime || !checkoutTime) {
          sendResponse({ ok: false, error: 'roomNumber, checkinTime, and checkoutTime are required.' })
          return
        }
        const cardSerialRaw = m.cardSerial
        const cardSerial =
          typeof cardSerialRaw === 'number' && Number.isFinite(cardSerialRaw)
            ? Math.max(1, Math.min(8, Math.floor(cardSerialRaw)))
            : 1
        sendResponse(
          await handleMessage(
            {
              type: 'RFID_MAKE_KEY',
              roomNumber,
              checkinTime,
              checkoutTime,
              cardSerial,
              confirmationNumber:
                typeof m.confirmationNumber === 'string' ? m.confirmationNumber.trim() : undefined,
              guestName: typeof m.guestName === 'string' ? m.guestName : null,
              portalAdminEncode: Boolean(m.portalAdminEncode),
            },
            noopSender,
          ),
        )
        return
      }

      sendResponse({ ok: false, error: 'Unknown external message' })
    } catch (e) {
      console.error('[FDN SW] onMessageExternal', e)
      sendResponse({ ok: false, error: e instanceof Error ? e.message : 'External handler error' })
    }
  })()
  return true
})

void initNativeHost(handleThalesNativeScan, forwardNativeHostRxToPanel, handleRfidStatus, broadcastScanFrontResult)

export {}
