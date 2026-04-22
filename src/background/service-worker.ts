import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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
import { encryptJson } from '../lib/encryption'
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

/**
 * Minimal placeholder reservation so `id_scans.reservation_id` FK can be satisfied when no
 * SynXis/eZee reservation is loaded. OCR identity data stays in `pii_encrypted` only —
 * none of it is written to the `reservations` table.
 */
function standaloneReservationSnapshot(
  confirmationNumber: string,
): ReservationSnapshot {
  const now = new Date().toISOString()
  return {
    pms: 'ezee',
    confirmationNumber,
    guestName: null,
    roomNumber: null,
    stayDatesRaw: null,
    addressRaw: null,
    checkInDate: null,
    checkOutDate: null,
    email: null,
    phone: null,
    rateAmount: null,
    reservationTotal: null,
    amountPaid: null,
    dueAmount: null,
    restricted: false,
    loadedAt: now,
    pageUrl: 'chrome-extension://fdn/id-scan-without-pms',
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

  const snap = reservation
  const scanId = crypto.randomUUID()

  let conf: string
  let snapForUpsert: ReservationSnapshot
  if (snap?.confirmationNumber) {
    conf = snap.confirmationNumber
    snapForUpsert = {
      ...snap,
      guestName: snap.guestName ?? null,
      loadedAt: new Date().toISOString(),
    }
  } else {
    conf = `FDN-IDONLY-${scanId}`
    snapForUpsert = standaloneReservationSnapshot(conf)
  }

  const ur = await upsertReservationSnapshot(client, snapForUpsert)
  if (!ur.ok) {
    lastError = 'Reservation upsert failed'
    return { ok: false, error: lastError }
  }
  const resRow = { id: ur.id }
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

  return { ok: true, state: await getState() }
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
