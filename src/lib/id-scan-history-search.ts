import type { SupabaseClient } from '@supabase/supabase-js'
import { hashIdNumber, hashPhoneNumber } from './encryption'
import {
  buildIdScanLogFromScanRows,
  idScanGuestDisplayName,
} from './id-scan-log'
import { isCompletePhoneForLookup } from './phone-lookup'
import type { IdScanLogEntry } from '../shared/protocol'
import type { EncryptedPayload } from './encryption'
import { decryptJson } from './encryption'

export type HistorySearchKind = 'name' | 'phone' | 'id' | 'confirmation'

export function classifyHistorySearchQuery(raw: string): HistorySearchKind | null {
  const q = raw.trim()
  if (q.length < 2) return null
  if (isCompletePhoneForLookup(q)) return 'phone'
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{3,}$/.test(q) && /\d/.test(q)) return 'confirmation'
  if (/^[\d\s-]+$/.test(q) && q.replace(/\D/g, '').length >= 4) return 'id'
  return 'name'
}

function entryMatchesNeedle(entry: IdScanLogEntry, needle: string): boolean {
  const hay = [
    entry.displayName,
    entry.fullName,
    entry.firstName,
    entry.middleName,
    entry.lastName,
    entry.idNumber,
    entry.confirmationNumber,
    entry.reservationGuestName,
    entry.phone,
    entry.email,
    entry.roomNumber,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(needle)
}

type StoredPiiName = {
  fullName?: string | null
  idGuru?: { firstName?: string | null; middleName?: string | null; lastName?: string | null } | null
}

async function guestNameFromScanRow(row: Record<string, unknown>): Promise<string | null> {
  try {
    if (!row.pii_encrypted) return null
    const pii = await decryptJson<StoredPiiName>(row.pii_encrypted as EncryptedPayload)
    const fn = pii.fullName?.trim()
    if (fn) return fn
    const g = pii.idGuru
    if (!g) return null
    const parts = [g.firstName, g.middleName, g.lastName]
      .map((x) => (x && String(x).trim()) || '')
      .filter(Boolean)
    return parts.length ? parts.join(' ') : null
  } catch {
    return null
  }
}

async function scanRowMatchesName(
  row: Record<string, unknown>,
  resGuest: string | null | undefined,
  needle: string,
): Promise<boolean> {
  const fromPii = await guestNameFromScanRow(row)
  const display = idScanGuestDisplayName(
    fromPii ? { fullName: fromPii, idGuru: null } : null,
    resGuest,
  )
  const conf = String(row.confirmation_number ?? '')
  const hay = [display, fromPii, resGuest, conf].filter(Boolean).join(' ').toLowerCase()
  return hay.includes(needle)
}

const MAX_SEARCH_RESULTS = 20

export async function searchIdScanHistory(
  client: SupabaseClient,
  query: string,
): Promise<IdScanLogEntry[]> {
  const kind = classifyHistorySearchQuery(query)
  if (!kind) return []

  const q = query.trim()

  if (kind === 'phone') {
    const hash = await hashPhoneNumber(q)
    if (!hash) return []
    const { data, error } = await client
      .from('id_scans')
      .select('*')
      .eq('phone_hash', hash)
      .order('scanned_at', { ascending: false })
      .limit(25)
    if (error) throw new Error(error.message)
    return buildIdScanLogFromScanRows(client, (data ?? []) as Record<string, unknown>[])
  }

  if (kind === 'id') {
    const hash = await hashIdNumber(q.replace(/\s+/g, '').toUpperCase())
    const { data, error } = await client
      .from('id_scans')
      .select('*')
      .eq('id_number_hash', hash)
      .order('scanned_at', { ascending: false })
      .limit(25)
    if (error) throw new Error(error.message)
    return buildIdScanLogFromScanRows(client, (data ?? []) as Record<string, unknown>[])
  }

  if (kind === 'confirmation') {
    const { data, error } = await client
      .from('id_scans')
      .select('*')
      .ilike('confirmation_number', `%${q}%`)
      .order('scanned_at', { ascending: false })
      .limit(25)
    if (error) throw new Error(error.message)
    return buildIdScanLogFromScanRows(client, (data ?? []) as Record<string, unknown>[])
  }

  const needle = q.toLowerCase()
  const seenIds = new Set<string>()
  const scanRows: Record<string, unknown>[] = []

  const pushRows = (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const id = String(row.id ?? '')
      if (!id || seenIds.has(id)) continue
      seenIds.add(id)
      scanRows.push(row)
    }
  }

  const { data: resRows, error: resErr } = await client
    .from('reservations')
    .select('confirmation_number, guest_name')
    .ilike('guest_name', `%${q}%`)
    .order('updated_at', { ascending: false })
    .limit(8)
  if (resErr) throw new Error(resErr.message)

  for (const row of resRows ?? []) {
    const conf = String((row as { confirmation_number?: string }).confirmation_number ?? '').trim()
    if (!conf) continue
    const { data: scans } = await client
      .from('id_scans')
      .select('*')
      .eq('confirmation_number', conf)
      .order('scanned_at', { ascending: false })
      .limit(3)
    pushRows((scans ?? []) as Record<string, unknown>[])
    if (scanRows.length >= MAX_SEARCH_RESULTS) break
  }

  if (scanRows.length < MAX_SEARCH_RESULTS) {
    const { data: recent, error: scanErr } = await client
      .from('id_scans')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(150)
    if (scanErr) throw new Error(scanErr.message)

    const confs = [
      ...new Set(
        ((recent ?? []) as Record<string, unknown>[]).map((s) =>
          String(s.confirmation_number ?? ''),
        ),
      ),
    ].filter(Boolean)

    const resByConf: Record<string, string | null> = {}
    if (confs.length > 0) {
      const { data: resLite } = await client
        .from('reservations')
        .select('confirmation_number, guest_name')
        .in('confirmation_number', confs)
      for (const r of resLite ?? []) {
        const c = String((r as { confirmation_number: string }).confirmation_number ?? '')
        resByConf[c] = (r as { guest_name: string | null }).guest_name
      }
    }

    for (const row of (recent ?? []) as Record<string, unknown>[]) {
      if (scanRows.length >= MAX_SEARCH_RESULTS) break
      const id = String(row.id ?? '')
      if (!id || seenIds.has(id)) continue
      const conf = String(row.confirmation_number ?? '')
      const matches = await scanRowMatchesName(row, resByConf[conf], needle)
      if (!matches) continue
      seenIds.add(id)
      scanRows.push(row)
    }
  }

  const built = await buildIdScanLogFromScanRows(client, scanRows)
  return built
    .filter((e) => entryMatchesNeedle(e, needle))
    .sort((a, b) => (a.scannedAt < b.scannedAt ? 1 : -1))
    .slice(0, MAX_SEARCH_RESULTS)
}
