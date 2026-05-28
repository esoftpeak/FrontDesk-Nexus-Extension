import type { EncryptedPayload } from './encryption'
import { decryptJson } from './encryption'
import type { GuestStayHistoryRecord } from '../shared/protocol'
import type { IdScanDetailGuru } from '../shared/pms-types'
import { normalizePhoneForLookup } from './phone-lookup'

export type { GuestStayHistoryRecord }

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

export async function guestStayRecordFromScanRow(
  r: Record<string, unknown>,
): Promise<GuestStayHistoryRecord | null> {
  let phone: string | null = null
  let email: string | null = null
  try {
    if (r.phone_encrypted) {
      const dec = await decryptJson<{ value: string }>(r.phone_encrypted as EncryptedPayload)
      phone = dec.value?.trim() || null
    }
  } catch {
    /* skip */
  }
  try {
    if (r.email_encrypted) {
      const dec = await decryptJson<{ value: string }>(r.email_encrypted as EncryptedPayload)
      email = dec.value?.trim() || null
    }
  } catch {
    /* skip */
  }

  let pii: StoredPii | null = null
  try {
    if (r.pii_encrypted) {
      pii = await decryptJson<StoredPii>(r.pii_encrypted as EncryptedPayload)
    }
  } catch {
    /* skip */
  }

  const guru = pii?.idGuru
  if (!phone?.trim() && guru?.phone?.trim()) phone = guru.phone.trim()
  if (!email?.trim() && guru?.email?.trim()) email = guru.email.trim()

  return {
    id: String(r.id),
    confirmationNumber: String(r.confirmation_number ?? ''),
    scannedAt:
      (typeof r.scanned_at === 'string' ? r.scanned_at : null) ||
      (typeof r.created_at === 'string' ? r.created_at : '') ||
      '',
    manualEntry: Boolean(r.manual_entry),
    phone,
    email,
    fullName: pii?.fullName?.trim() || null,
    firstName: guru?.firstName?.trim() || null,
    middleName: guru?.middleName?.trim() || null,
    lastName: guru?.lastName?.trim() || null,
    streetAddress: guru?.streetAddress?.trim() || null,
    city: guru?.city?.trim() || null,
    state: guru?.state?.trim() || null,
    postalCode: guru?.postalCode?.trim() || null,
    dateOfBirth: pii?.dateOfBirth?.trim() || null,
    idNumber: pii?.idNumber?.trim() || null,
    idType: pii?.idType?.trim() || null,
    issueDate: pii?.issueDate?.trim() || null,
    expiryDate: pii?.expiryDate?.trim() || null,
    address: pii?.address?.trim() || null,
  }
}

/** Fallback when `phone_number_hash` column is not migrated yet. */
export async function filterRecordsByPhone(
  rows: Record<string, unknown>[],
  phoneInput: string,
): Promise<GuestStayHistoryRecord[]> {
  const want = normalizePhoneForLookup(phoneInput)
  const out: GuestStayHistoryRecord[] = []
  for (const r of rows) {
    const rec = await guestStayRecordFromScanRow(r)
    if (!rec) continue
    if (rec.phone && normalizePhoneForLookup(rec.phone) === want) out.push(rec)
  }
  return out
}
