import type { GuestStayHistoryRecord } from './guest-stay-history'
import { normalizeIdDocumentType } from './id-document-types'
import { normalizeUsStateCode } from './us-states'
import type { IdScanLogEntry } from '../shared/protocol'
import type { IdScanDetailGuru, ParsedIdFields } from '../shared/pms-types'

/** Copy a prior scan profile into editable form state (does not modify the prior row). */
export function guestProfileToFormState(record: GuestStayHistoryRecord): {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  phone: string
  emailGuest: string
} {
  const idDetail: IdScanDetailGuru = {
    firstName: record.firstName,
    middleName: record.middleName,
    lastName: record.lastName,
    streetAddress: record.streetAddress,
    city: record.city,
    state: normalizeUsStateCode(record.state) ?? record.state,
    postalCode: record.postalCode,
    phone: record.phone,
    email: record.email,
    phoneCountryCode: null,
    usaCaPhone: record.phone ? true : null,
  }
  const parsed: ParsedIdFields = {
    fullName: record.fullName,
    dateOfBirth: record.dateOfBirth,
    idNumber: record.idNumber,
    idType: normalizeIdDocumentType(record.idType),
    issueDate: record.issueDate,
    expiryDate: record.expiryDate,
    address: record.address,
  }
  return {
    idDetail,
    parsed,
    phone: record.phone?.trim() ?? '',
    emailGuest: record.email?.trim() ?? '',
  }
}

/** Map check-in history row into ID tab form state (same shape as a live scan). */
export function idScanLogEntryToFormState(entry: IdScanLogEntry): {
  idDetail: IdScanDetailGuru
  parsed: ParsedIdFields
  phone: string
  emailGuest: string
} {
  const record: GuestStayHistoryRecord = {
    id: entry.id,
    confirmationNumber: entry.confirmationNumber,
    scannedAt: entry.scannedAt,
    manualEntry: entry.manualEntry,
    phone: entry.phone,
    email: entry.email,
    fullName: entry.fullName,
    firstName: entry.firstName,
    middleName: entry.middleName,
    lastName: entry.lastName,
    streetAddress: entry.streetAddress,
    city: entry.city,
    state: entry.state,
    postalCode: entry.postalCode,
    dateOfBirth: entry.dateOfBirth,
    idNumber: entry.idNumber,
    idType: entry.idType,
    issueDate: entry.issueDate,
    expiryDate: entry.expiryDate,
    address: entry.address,
  }
  return guestProfileToFormState(record)
}

/** True when enough decrypted fields exist to repopulate the ID scanner form. */
export function idScanLogEntryIsEditable(entry: IdScanLogEntry): boolean {
  if (entry.firstName?.trim() || entry.lastName?.trim() || entry.idNumber?.trim()) return true
  if (entry.phone?.trim() || entry.fullName?.trim()) return true
  return !entry.piiError
}
