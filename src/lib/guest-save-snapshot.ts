import { normalizeScanBase64 } from './imageDataUrl'
import { normalizeIdDocumentType } from './id-document-types'
import { normalizeUsStateCode } from './us-states'
import { normalizeUsZipInput } from './zip-lookup'
import type { IdScanDetailGuru, ParsedIdFields } from '../shared/pms-types'

export type GuestSaveSnapshotInput = {
  parsed: ParsedIdFields
  phone: string
  email: string
  manualEntry: boolean
  managerOverride: boolean
  detail: IdScanDetailGuru
  guestRemark: string
  checkInRemark: string
  imageFront: string | null
  imageBack: string | null
  documentData: Record<string, unknown> | null
}

function normStr(v: string | null | undefined): string | null {
  const s = v?.trim()
  return s ? s : null
}

/** Stable JSON fingerprint of what would be written on SAVE_ID_SCAN. */
export function buildGuestSaveSnapshot(input: GuestSaveSnapshotInput): string {
  const d = input.detail
  const p = input.parsed
  const payload = {
    phone: input.phone.trim(),
    email: input.email.trim(),
    manualEntry: input.manualEntry,
    managerOverride: input.managerOverride,
    guestRemark: input.guestRemark.trim(),
    checkInRemark: input.checkInRemark.trim(),
    parsed: {
      fullName: normStr(p.fullName),
      dateOfBirth: normStr(p.dateOfBirth),
      idNumber: normStr(p.idNumber),
      idType: normalizeIdDocumentType(p.idType),
      issueDate: normStr(p.issueDate),
      expiryDate: normStr(p.expiryDate),
      address: normStr(p.address),
    },
    detail: {
      firstName: normStr(d.firstName),
      middleName: normStr(d.middleName),
      lastName: normStr(d.lastName),
      streetAddress: normStr(d.streetAddress),
      city: normStr(d.city),
      state: normalizeUsStateCode(d.state) ?? normStr(d.state),
      postalCode: normalizeUsZipInput(d.postalCode) || normStr(d.postalCode),
      phone: normStr(d.phone),
      email: normStr(d.email),
      phoneCountryCode: normStr(d.phoneCountryCode),
      usaCaPhone: d.usaCaPhone === true ? true : d.usaCaPhone === false ? false : null,
    },
    imageFront: input.imageFront ? normalizeScanBase64(input.imageFront) : null,
    imageBack: input.imageBack ? normalizeScanBase64(input.imageBack) : null,
    documentData: input.documentData ?? null,
  }
  return JSON.stringify(payload)
}
