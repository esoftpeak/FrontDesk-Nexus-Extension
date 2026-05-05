import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type {
  ExtensionMessage,
  ExtensionResponse,
  ExtensionState,
  IdScanHistoryRow,
  NativeHostRxDebugBroadcast,
  NativeIdScanBroadcast,
  PanelToastBroadcast,
} from '../shared/protocol'
import type {
  EzeeGuestDisplay,
  IdScanDetailGuru,
  ParsedIdFields,
  ReservationSnapshot,
  SynxisGuestDisplay,
} from '../shared/pms-types'
import { encryptBinary, encryptJson } from '../lib/encryption'
import { createExtensionSupabase } from '../lib/supabase-factory'
import { guessImageMimeFromBase64 } from '../lib/imageMime'
import { pingNativeHost } from '../lib/native-scan'
import type { NativeScanSuccessPayload } from '../nativeMessaging/types'
import { initNativeHost } from '../nativeHost'
import { checkMinExtensionVersion } from '../lib/version-check'
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

function synxisAutoFlightKey(tabId: number, confirmation: string, roomHint: string): string {
  return `${tabId}|${confirmation}|${roomHint}`
}

function ezeeAutoFlightKey(tabId: number, confirmation: string, roomHint: string): string {
  return `ezee|${tabId}|${confirmation}|${roomHint}`
}

const SYNXIS_DEFAULT_GUEST_ID = 100

const SYNXIS_RESERVATION_SUMMARY_URL =
  'https://sph.synxis.com/pms-web-ui/service/v2/guest-mgt/guest-stay-record/reservation-summary'

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
  void chrome.storage.local.set({ fdn_active_reservation: reservation })
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
  if (options.chromeNotify) void notifyUser('FrontDesk Nexus — Reservation loaded', msgText)
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
  void chrome.storage.local.set({ fdn_active_reservation: reservation })

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
  if (options.chromeNotify) void notifyUser('FrontDesk Nexus — Reservation loaded', msgText)
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
  } catch {
    idScanner = 'disconnected'
  }
  return {
    id_scanner: idScanner,
    spectral_payout: 'disconnected',
    rfid_encoder: 'disconnected',
  }
}

async function getState(): Promise<ExtensionState> {
  const client = getClient()
  const { data: sessionData } = await client.auth.getSession()
  const user = sessionData.session?.user ?? null
  const hardware = await buildHardwareStatus()
  const { fdn_terminal_id: terminalId } = await chrome.storage.local.get('fdn_terminal_id')

  if (user && !cachedRole) await refreshRole(client)

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
    terminalId: typeof terminalId === 'string' ? terminalId : null,
    dnrHit,
    lastError,
  }
}

async function verifyManager(email: string, password: string): Promise<ExtensionResponse> {
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
  return { ok: true }
}

function normalizeIdNumber(n: string | null): string {
  return (n ?? '').replace(/\s+/g, '').toUpperCase()
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
}): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }
  if (versionBlocked) return { ok: false, error: versionMessage ?? 'Extension version blocked' }

  const rawId = (args.parsed.idNumber ?? '').trim()
  if (rawId && !args.managerOverride) {
    const norm = normalizeIdNumber(args.parsed.idNumber)
    const idVariants = [...new Set([rawId, norm].filter((x) => x.length > 0))]
    const { data: hits, error: dnrErr } = await client
      .from('dnr_entries')
      .select('id')
      .eq('status', 'active')
      .in('id_number', idVariants)

    if (dnrErr) console.warn('DNR check failed', dnrErr.message)
    if (hits && hits.length > 0) {
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
  const scanId = crypto.randomUUID()

  // Never write to reservations from Save buttons.
  // SELECT existing reservation ID only if a confirmation number is loaded; otherwise null.
  let resId: string | null = null
  const conf: string = snap?.confirmationNumber ?? `NO-RES-${scanId}`
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
  const resRow = { id: resId }
  const basePath = `${conf}/${scanId}`

  let imageFrontPath: string | null = null
  let imageBackPath: string | null = null

  try {
    if (args.imageFrontBase64) {
      const mime = guessImageMimeFromBase64(args.imageFrontBase64)
      const ext = mime === 'image/jpeg' ? 'jpg' : 'png'
      const path = `${basePath}/front.${ext}`
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
      const ext = mime === 'image/jpeg' ? 'jpg' : 'png'
      const path = `${basePath}/back.${ext}`
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

  let phone_encrypted: Record<string, unknown> | null = null
  let email_encrypted: Record<string, unknown> | null = null
  if (args.phone?.trim()) phone_encrypted = (await encryptJson({ value: args.phone.trim() })) as unknown as Record<string, unknown>
  if (args.email?.trim()) email_encrypted = (await encryptJson({ value: args.email.trim() })) as unknown as Record<string, unknown>

  const { data: insertRow, error: insErr } = await client
    .from('id_scans')
    .insert({
      id: scanId,
      reservation_id: resRow.id,
      confirmation_number: conf,
      scanned_by: user.id,
      terminal_id: terminalId,
      manual_entry: args.manualEntry,
      ocr_provider: args.manualEntry
        ? null
        : args.ocrProvider && String(args.ocrProvider).trim()
          ? String(args.ocrProvider).trim()
          : 'native_host',
      pii_encrypted: pii_encrypted as unknown as Record<string, unknown>,
      image_front_path: imageFrontPath,
      image_back_path: imageBackPath,
      phone_encrypted,
      email_encrypted,
    })
    .select('id')
    .single()

  if (insErr) {
    lastError = insErr.message
    return { ok: false, error: insErr.message }
  }

  const { error: audErr } = await client.from('audit_log').insert({
    user_id: user.id,
    username: user.email,
    user_role: cachedRole,
    terminal_id: terminalId,
    action_type: 'ID_SCAN',
    confirmation_number: conf,
    description: args.manualEntry
      ? 'ID record saved (MANUAL_ENTRY)'
      : 'ID record saved (native host or manual)',
    new_value: {
      id_scan_id: insertRow?.id,
      manager_override: args.managerOverride,
    },
  })
  if (audErr) console.warn('audit_log insert', audErr.message)

  // Patch lastScanResult with manually-entered phone/email so content scripts can read them.
  const stored = await chrome.storage.local.get('lastScanResult')
  const prev = (stored.lastScanResult ?? {}) as Record<string, unknown>
  await chrome.storage.local.set({
    lastScanResult: {
      ...prev,
      phone: args.phone?.trim() || prev.phone || null,
      email: args.email?.trim() || prev.email || null,
    },
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
      left: second.workArea.left,
      top: second.workArea.top,
      width: second.workArea.width,
      height: second.workArea.height,
      state: 'normal',
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
    y:      Math.round(height * 0.18),
    width:  Math.round(width  * 0.35),
    height: Math.round(height * 0.06),
  })
  return pdfDoc.save()
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
  function getPos(e: MouseEvent | TouchEvent): { x: number; y: number } {
    const r   = canvas.getBoundingClientRect()
    const src = 'touches' in e ? (e as TouchEvent).touches[0]! : (e as MouseEvent)
    return {
      x: (src.clientX - r.left) * (canvas.width  / r.width),
      y: (src.clientY - r.top)  * (canvas.height / r.height),
    }
  }

  canvas.addEventListener('mousedown',  e => { drawing = true; ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y) })
  canvas.addEventListener('mousemove',  e => { if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke() })
  canvas.addEventListener('mouseup',    () => { drawing = false })
  canvas.addEventListener('mouseleave', () => { drawing = false })
  canvas.addEventListener('touchstart', e => { e.preventDefault(); drawing = true; ctx.beginPath(); const p = getPos(e); ctx.moveTo(p.x, p.y) }, { passive: false })
  canvas.addEventListener('touchmove',  e => { e.preventDefault(); if (!drawing) return; const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke() }, { passive: false })
  canvas.addEventListener('touchend',   () => { drawing = false })

  btnClear.onclick  = () => ctx.clearRect(0, 0, canvas.width, canvas.height)
  btnCancel.onclick = () => overlay.remove()

  btnSave.onclick = () => {
    btnSave.disabled = true
    btnSave.textContent = 'Saving…'
    statusEl.textContent = 'Capturing registration card…'
    statusEl.style.color = '#555'

    const signaturePng = canvas.toDataURL('image/png')

    // Capture all Stimulsoft report page canvases (skip our own signature canvas)
    function captureReportCanvas(): string | null {
      try {
        const reportCanvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas'))
          .filter(c => c !== canvas && c.width > 300 && c.height > 300)
        if (reportCanvases.length === 0) return null
        reportCanvases.sort((a, b) => b.width * b.height - a.width * a.height)
        if (reportCanvases.length === 1) return reportCanvases[0].toDataURL('image/png')
        // Multiple pages — combine vertically into one image
        const maxW   = Math.max(...reportCanvases.map(c => c.width))
        const totalH = reportCanvases.reduce((s, c) => s + c.height, 0)
        const combined = document.createElement('canvas')
        combined.width = maxW; combined.height = totalH
        const cx = combined.getContext('2d')
        if (!cx) return null
        let y = 0
        for (const rc of reportCanvases) { cx.drawImage(rc, 0, y); y += rc.height }
        return combined.toDataURL('image/png')
      } catch { return null }
    }

    // Try to export the real PDF via Stimulsoft's JS API
    function tryStimulsoftPdf(): Promise<string | null> {
      return new Promise<string | null>((resolve) => {
        try {
          const win = window as { Stimulsoft?: Record<string, unknown>; stimulsoft?: Record<string, unknown> }
          const S = win.Stimulsoft ?? win.stimulsoft
          if (!S) { resolve(null); return }
          const instances = ((S['Viewer'] as Record<string, unknown>)?.['StiViewer'] as Record<string, unknown[]>)?.['instances'] ?? []
          let report: Record<string, unknown> | null = null
          for (const inst of instances) {
            const r = (inst as Record<string, unknown>)?.['report']
            if (r) { report = r as Record<string, unknown>; break }
          }
          if (!report) { resolve(null); return }
          const exportFn = report['exportDocumentAsync']
          if (typeof exportFn !== 'function') { resolve(null); return }
          const fmtObj = (S['Report'] as Record<string, Record<string, unknown>>)?.['StiExportFormat']
          const pdfFmt = fmtObj?.['Pdf'] ?? fmtObj?.['PDF'] ?? 'Pdf'
          ;(exportFn as (cb: (d: unknown) => void, fmt: unknown) => void).call(report, (data: unknown) => {
            try {
              const bytes = data as Uint8Array
              let bin = ''
              for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
              resolve(btoa(bin))
            } catch { resolve(null) }
          }, pdfFmt)
          setTimeout(() => resolve(null), 15_000)
        } catch { resolve(null) }
      })
    }

    void (async () => {
      // Best case: real PDF from Stimulsoft JS API
      let cardPdfBase64: string | null = await tryStimulsoftPdf()
      let cardImageBase64: string | null = null

      // Fallback: capture rendered canvas elements
      if (!cardPdfBase64) {
        cardImageBase64 = captureReportCanvas()
        console.log('[FDN eZee] Card capture:', cardImageBase64 ? 'canvas PNG ✓' : 'none — text fallback')
      } else {
        console.log('[FDN eZee] Card capture: Stimulsoft PDF ✓')
      }

      overlay.style.display = 'none'
      await new Promise<void>(r => setTimeout(r, 200))

      try {
        const res = await (chrome.runtime.sendMessage({
          type: 'EZEE_SAVE_SIGNATURE',
          signaturePng,
          confirmation: conf,
          cardPdfBase64: cardPdfBase64 ?? null,
          cardImageBase64: cardImageBase64 ?? null,
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

async function broadcastNativeIdScan(payload: Omit<NativeIdScanBroadcast, 'type' | 'receivedAt'>) {
  const msg: NativeIdScanBroadcast = {
    type: 'FDN_NATIVE_ID_SCAN',
    receivedAt: new Date().toISOString(),
    ...payload,
  }
  try {
    await chrome.storage.local.set({ fdn_last_native_scan: msg })
  } catch (e) {
    console.warn('[FDN ID scan] storage set failed', e)
  }
  try {
    await chrome.runtime.sendMessage(msg)
  } catch {
    /* side panel may not be listening */
  }
}

async function handleThalesNativeScan(payload: NativeScanSuccessPayload) {
  const images = payload.images
  const b64Front = images.front_image_base64
  const b64Back = images.back_image_base64
  const detail = payload.detail ?? null
  const phone = detail?.phone?.trim() ? detail.phone.trim() : null
  const email = detail?.email?.trim() ? detail.email.trim() : null
  const saveRes = await saveIdScan({
    parsed: payload.parsed,
    phone,
    email,
    manualEntry: false,
    managerOverride: false,
    imageFrontBase64: b64Front,
    imageBackBase64: b64Back,
    ocrProvider: 'native_host',
    detail,
    documentData: payload.documentData ?? null,
  })
  const autoSave: NativeIdScanBroadcast['autoSave'] =
    saveRes.ok === true ? { ok: true } : { ok: false, error: saveRes.error }
  await broadcastNativeIdScan({
    parsed: payload.parsed,
    images,
    imageBase64Length: b64Front.length + b64Back.length,
    ocrProvider: 'native_host',
    autoSave,
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
        { chromeNotify: true, panelToast: true },
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
        chromeNotify: false,
        panelToast: true,
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
    void notifyUser(
      'FrontDesk Nexus — Print Card',
      msg.confirmation
        ? `Registration card for ${msg.confirmation} requested`
        : 'Guest registration card print requested',
    )
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

      if (msg.cardPdfBase64) {
        // Best case: real Stimulsoft PDF — embed signature directly into it
        console.log('[FDN SW] eZee signature: embedding into Stimulsoft PDF ✓')
        const bin = atob(msg.cardPdfBase64)
        const cardBytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) cardBytes[i] = bin.charCodeAt(i)
        pdfBytes = await embedSignatureIntoEzeePdf(cardBytes, msg.signaturePng)
      } else {
        // Canvas PNG background or plain text fallback
        console.log('[FDN SW] eZee signature:', msg.cardImageBase64 ? 'canvas PNG background' : 'text fallback')
        pdfBytes = await createEzeeSignaturePdf(msg.cardImageBase64 ?? null, msg.signaturePng, msg.confirmation)
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
    await client.auth.signOut()
    cachedRole = null
    reservation = null
    void chrome.storage.local.remove('fdn_active_reservation')
    synxisGuestDisplay = null
    ezeeGuestDisplay = null
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'VERIFY_MANAGER') {
    return verifyManager(msg.email, msg.password)
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

chrome.runtime.onInstalled.addListener(() => {
  ensureSidePanelOpensOnActionClick()
})

chrome.runtime.onStartup.addListener(() => {
  ensureSidePanelOpensOnActionClick()
})

ensureSidePanelOpensOnActionClick()

void (async () => {
  const v = await checkMinExtensionVersion()
  versionBlocked = v.blocked
  versionMessage = v.message
})()

void chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.fdn_bridge_revoked) {
    void getClient().auth.signOut()
    cachedRole = null
  }
})

void initNativeHost(handleThalesNativeScan, forwardNativeHostRxToPanel)

export {}
