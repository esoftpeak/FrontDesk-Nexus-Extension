import type { SupabaseClient } from '@supabase/supabase-js'
import type { EncryptedPayload } from './encryption'
import { decryptJson } from './encryption'
import type { IdScanLogEntry } from '../shared/protocol'
import type { IdScanDetailGuru } from '../shared/pms-types'

export type ReservationLite = {
  confirmation_number: string
  room_number: string | null
  guest_name: string | null
  check_in_date: string | null
  check_out_date: string | null
}

export type ProfileLite = {
  id: string
  email: string | null
  full_name: string | null
}

type StoredPii = {
  fullName?: string | null
  dateOfBirth?: string | null
  idNumber?: string | null
  idType?: string | null
  issueDate?: string | null
  expiryDate?: string | null
  address?: string | null
  idGuru?: Partial<IdScanDetailGuru> | null
}

export function agentLabel(
  profile: ProfileLite | undefined,
  fallbackId: string | null,
): string {
  if (!fallbackId) return '—'
  const name = profile?.full_name?.trim()
  const email = profile?.email?.trim()
  if (name && email) return `${name} (${email})`
  if (name) return name
  if (email) return email
  return `${fallbackId.slice(0, 8)}…`
}

function nameFromPii(pii: StoredPii | null): string | null {
  if (!pii) return null
  const fn = pii.fullName?.trim()
  if (fn) return fn
  const g = pii.idGuru
  if (!g) return null
  const parts = [g.firstName, g.middleName, g.lastName]
    .map((x) => (x && String(x).trim()) || '')
    .filter(Boolean)
  return parts.length ? parts.join(' ') : null
}

export function idScanGuestDisplayName(
  pii: StoredPii | null,
  reservationGuest?: string | null,
): string {
  const fromId = nameFromPii(pii)
  if (fromId) return fromId
  const pms = reservationGuest?.trim()
  if (pms) return pms
  return '—'
}

export async function buildIdScanLogFromScanRows(
  client: SupabaseClient,
  scans: Record<string, unknown>[],
): Promise<IdScanLogEntry[]> {
  if (scans.length === 0) return []

  const confirmationNumbers = [...new Set(scans.map((s) => String(s.confirmation_number ?? '')))].filter(
    Boolean,
  )

  const resByConf: Record<string, ReservationLite> = {}
  if (confirmationNumbers.length > 0) {
    const { data: resRows, error: resErr } = await client
      .from('reservations')
      .select('confirmation_number, room_number, guest_name, check_in_date, check_out_date')
      .in('confirmation_number', confirmationNumbers)
    if (resErr) console.warn('[FDN] reservations for id log', resErr.message)
    for (const r of (resRows ?? []) as ReservationLite[]) {
      resByConf[r.confirmation_number] = r
    }
  }

  const userIds = [...new Set(scans.map((s) => s.scanned_by).filter(Boolean))] as string[]
  const profById: Record<string, ProfileLite> = {}
  if (userIds.length > 0) {
    const { data: profRows, error: profErr } = await client
      .from('profiles')
      .select('id, email, full_name')
      .in('id', userIds)
    if (profErr) console.warn('[FDN] profiles for id log', profErr.message)
    for (const p of (profRows ?? []) as ProfileLite[]) {
      profById[p.id] = p
    }
  }

  const idScanLog: IdScanLogEntry[] = []
  for (const row of scans) {
    const conf = String(row.confirmation_number ?? '')
    const scannedBy =
      typeof row.scanned_by === 'string' ? row.scanned_by : (row.scanned_by as string | null) ?? null
    idScanLog.push(
      await idScanLogEntryFromRow(row, resByConf[conf], scannedBy ? profById[scannedBy] : undefined),
    )
  }
  return idScanLog
}

export async function idScanLogEntryFromRow(
  row: Record<string, unknown>,
  res: ReservationLite | undefined,
  profile: ProfileLite | undefined,
): Promise<IdScanLogEntry> {
  let phone: string | null = null
  let email: string | null = null
  let pii: StoredPii | null = null
  let piiError: string | null = null

  try {
    if (row.phone_encrypted) {
      const dec = await decryptJson<{ value?: string }>(row.phone_encrypted as EncryptedPayload)
      phone = dec.value?.trim() || null
    }
  } catch {
    /* skip */
  }
  try {
    if (row.email_encrypted) {
      const dec = await decryptJson<{ value?: string }>(row.email_encrypted as EncryptedPayload)
      email = dec.value?.trim() || null
    }
  } catch {
    /* skip */
  }
  try {
    if (row.pii_encrypted) {
      pii = await decryptJson<StoredPii>(row.pii_encrypted as EncryptedPayload)
    }
  } catch (e) {
    piiError = e instanceof Error ? e.message : 'Could not decrypt PII'
  }

  const guru = pii?.idGuru
  if (!phone?.trim() && guru?.phone?.trim()) phone = guru.phone.trim()
  if (!email?.trim() && guru?.email?.trim()) email = guru.email.trim()

  const scannedBy =
    typeof row.scanned_by === 'string' ? row.scanned_by : (row.scanned_by as string | null) ?? null
  const conf = String(row.confirmation_number ?? '')

  return {
    id: String(row.id),
    confirmationNumber: conf,
    scannedAt:
      (typeof row.scanned_at === 'string' ? row.scanned_at : null) ||
      (typeof row.created_at === 'string' ? row.created_at : '') ||
      '',
    manualEntry: Boolean(row.manual_entry),
    ocrProvider: typeof row.ocr_provider === 'string' ? row.ocr_provider : null,
    terminalId: typeof row.terminal_id === 'string' ? row.terminal_id : null,
    scannedBy,
    agentLabel: agentLabel(profile, scannedBy),
    displayName: idScanGuestDisplayName(pii, res?.guest_name),
    roomNumber: res?.room_number?.trim() || null,
    reservationGuestName: res?.guest_name?.trim() || null,
    checkInDate: res?.check_in_date?.trim() || null,
    checkOutDate: res?.check_out_date?.trim() || null,
    imageFrontPath: typeof row.image_front_path === 'string' ? row.image_front_path : null,
    imageBackPath: typeof row.image_back_path === 'string' ? row.image_back_path : null,
    phone,
    email,
    firstName: guru?.firstName?.trim() || null,
    middleName: guru?.middleName?.trim() || null,
    lastName: guru?.lastName?.trim() || null,
    fullName: pii?.fullName?.trim() || null,
    dateOfBirth: pii?.dateOfBirth?.trim() || null,
    idNumber: pii?.idNumber?.trim() || null,
    idType: pii?.idType?.trim() || null,
    issueDate: pii?.issueDate?.trim() || null,
    expiryDate: pii?.expiryDate?.trim() || null,
    streetAddress: guru?.streetAddress?.trim() || null,
    city: guru?.city?.trim() || null,
    state: guru?.state?.trim() || null,
    postalCode: guru?.postalCode?.trim() || null,
    address: pii?.address?.trim() || null,
    piiError,
  }
}
