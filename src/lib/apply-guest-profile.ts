import type { GuestStayHistoryRecord } from './guest-stay-history'
import { normalizeIdDocumentType } from './id-document-types'
import { normalizeUsStateCode } from './us-states'
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
