import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { ExtensionMessage, ExtensionResponse, ExtensionState } from '../shared/protocol'
import type { ParsedIdFields, ScrapedReservation } from '../shared/scrape-types'
import { encryptJson } from '../lib/encryption'
import { createExtensionSupabase } from '../lib/supabase-factory'
import { pingNativeHost, scanIdFromNativeOrSimulate } from '../lib/native-scan'
import { runOcrWithEdgeFunction } from '../lib/ocr'
import { checkMinExtensionVersion } from '../lib/version-check'

let supabase: SupabaseClient | null = null

let reservation: ScrapedReservation | null = null
let lastPmsTabId: number | null = null
let cachedRole: string | null = null
let versionBlocked = false
let versionMessage: string | null = null
let lastError: string | null = null

function getClient(): SupabaseClient {
  if (!supabase) supabase = createExtensionSupabase()
  return supabase
}

async function loadSimulation(): Promise<boolean> {
  const r = await chrome.storage.local.get('fdn_simulation')
  if (r.fdn_simulation === undefined) return true
  return Boolean(r.fdn_simulation)
}

async function setSimulation(enabled: boolean) {
  await chrome.storage.local.set({ fdn_simulation: enabled })
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

async function upsertReservationFromScrape(
  client: SupabaseClient,
  scrape: ScrapedReservation,
): Promise<void> {
  if (!scrape.confirmationNumber) return

  const row = {
    confirmation_number: scrape.confirmationNumber,
    pms_source: scrape.pms,
    guest_name: scrape.guestName,
    room_number: scrape.roomNumber,
    check_in_date: scrape.checkInDate,
    check_out_date: scrape.checkOutDate,
    last_scraped_at: scrape.scrapedAt,
    scrape_payload: scrape as unknown as Record<string, unknown>,
  }

  const { error } = await client.from('reservations').upsert(row, {
    onConflict: 'confirmation_number,pms_source',
  })
  if (error) console.warn('FrontDesk: reservation upsert', error.message)
}

async function buildHardwareStatus(simulation: boolean): Promise<ExtensionState['hardware']> {
  let idScanner: 'connected' | 'disconnected' = 'disconnected'
  if (simulation) idScanner = 'connected'
  else {
    try {
      idScanner = (await pingNativeHost()) ? 'connected' : 'disconnected'
    } catch {
      idScanner = 'disconnected'
    }
  }
  return {
    id_scanner: idScanner,
    spectral_payout: 'disconnected',
    rfid_encoder: 'disconnected',
  }
}

async function getState(): Promise<ExtensionState> {
  const client = getClient()
  const simulation = await loadSimulation()
  const { data: sessionData } = await client.auth.getSession()
  const user = sessionData.session?.user ?? null
  const hardware = await buildHardwareStatus(simulation)
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
    simulation,
    versionBlocked,
    versionMessage,
    reservation,
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
}): Promise<ExtensionResponse> {
  lastError = null
  const client = getClient()
  const { data: sess } = await client.auth.getSession()
  if (!sess.session) return { ok: false, error: 'Not signed in' }
  if (versionBlocked) return { ok: false, error: versionMessage ?? 'Extension version blocked' }

  const scrape = reservation
  if (!scrape?.confirmationNumber) {
    return { ok: false, error: 'No reservation context (confirmation number missing from PMS page).' }
  }

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

  const { data: resRow, error: resErr } = await client
    .from('reservations')
    .upsert(
      {
        confirmation_number: scrape.confirmationNumber,
        pms_source: scrape.pms,
        guest_name: scrape.guestName ?? args.parsed.fullName,
        room_number: scrape.roomNumber,
        check_in_date: scrape.checkInDate,
        check_out_date: scrape.checkOutDate,
        last_scraped_at: scrape.scrapedAt,
        scrape_payload: scrape as unknown as Record<string, unknown>,
      },
      { onConflict: 'confirmation_number,pms_source' },
    )
    .select('id')
    .single()

  if (resErr || !resRow?.id) {
    lastError = resErr?.message ?? 'Reservation upsert failed'
    return { ok: false, error: lastError }
  }

  const scanId = crypto.randomUUID()
  const conf = scrape.confirmationNumber
  const basePath = `${conf}/${scanId}`

  let imageFrontPath: string | null = null
  let imageBackPath: string | null = null

  try {
    if (args.imageFrontBase64) {
      const path = `${basePath}/front.png`
      const blob = base64ToBlob(args.imageFrontBase64, 'image/png')
      const { error: upErr } = await client.storage.from('id-images').upload(path, blob, {
        contentType: 'image/png',
        upsert: true,
      })
      if (!upErr) imageFrontPath = path
      else console.warn('Front image upload', upErr.message)
    }
    if (args.imageBackBase64) {
      const path = `${basePath}/back.png`
      const blob = base64ToBlob(args.imageBackBase64, 'image/png')
      const { error: upErr } = await client.storage.from('id-images').upload(path, blob, {
        contentType: 'image/png',
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
      ocr_provider: args.manualEntry ? null : (import.meta.env.VITE_OCR_FUNCTION_URL ? 'edge_function' : 'mock'),
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
      : 'ID record saved (OCR or simulation)',
    new_value: {
      id_scan_id: insertRow?.id,
      manager_override: args.managerOverride,
    },
  })
  if (audErr) console.warn('audit_log insert', audErr.message)

  return { ok: true, state: await getState() }
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

async function handleMessage(
  msg: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse | Record<string, unknown>> {
  const client = getClient()

  if (msg.type === 'PMS_SCRAPE') {
    reservation = msg.payload
    if (sender.tab?.id) lastPmsTabId = sender.tab.id
    const { data: sess } = await client.auth.getSession()
    if (sess.session) void upsertReservationFromScrape(client, msg.payload)
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'GET_STATE') {
    return { ok: true, state: await getState() }
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
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'SET_SIMULATION') {
    await setSimulation(msg.enabled)
    return { ok: true, state: await getState() }
  }

  if (msg.type === 'VERIFY_MANAGER') {
    return verifyManager(msg.email, msg.password)
  }

  if (msg.type === 'SCAN_ID_START') {
    const simulation = await loadSimulation()
    try {
      const images = await scanIdFromNativeOrSimulate(simulation)
      const { data: sess } = await client.auth.getSession()
      const token = sess.session?.access_token
      if (!token) return { ok: false, error: 'Not signed in' }
      const parsed = await runOcrWithEdgeFunction(
        token,
        images.front_image_base64,
        images.back_image_base64,
      )
      return { ok: true, images, parsed }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Scan failed'
      lastError = message
      return { ok: false, error: message }
    }
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
    })
  }

  if (msg.type === 'INJECT_PMS') {
    if (lastPmsTabId == null) {
      return { ok: false, error: 'No active PMS tab captured yet. Open a guest page.' }
    }
    try {
      const tabRes = await chrome.tabs.sendMessage(lastPmsTabId, {
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

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    void chrome.storage.local.set({ fdn_simulation: true })
  }
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

export {}
