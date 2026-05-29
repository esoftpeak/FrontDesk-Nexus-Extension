import type { IdScanDetailGuru, ParsedIdFields } from '../shared/pms-types'
import { ageYearsFromDobString } from './id-age'

/** AAMVA PDF417 uses these sentinel strings to indicate an absent field. */
const AAMVA_SENTINELS = new Set(['NONE', 'UNAVAILABLE', 'N/A', 'NA'])

function pick(
  doc: Record<string, unknown>,
  msg: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const k of keys) {
    const d = doc[k]
    if (typeof d === 'string' && d.trim() && !AAMVA_SENTINELS.has(d.trim().toUpperCase())) return d.trim()
    const v = msg[k]
    if (typeof v === 'string' && v.trim() && !AAMVA_SENTINELS.has(v.trim().toUpperCase())) return v.trim()
  }
  return null
}

/**
 * Flatten AUTO_SCAN_RESULT / document_data into ID Guru–style fields (Python may use snake_case or camelCase).
 */
export function idGuruDetailFromAutoScan(
  msg: Record<string, unknown>,
  document_data: Record<string, unknown>,
): IdScanDetailGuru {
  const doc = document_data
  return {
    firstName: pick(doc, msg, 'first_name', 'firstName', 'given_name', 'givenName'),
    middleName: pick(doc, msg, 'middle_name', 'middleName', 'middle_initial', 'middleInitial', 'middle'),
    lastName: pick(doc, msg, 'last_name', 'lastName', 'family_name', 'familyName', 'surname'),
    streetAddress: pick(
      doc,
      msg,
      'street_address',
      'streetAddress',
      'address_line1',
      'addressLine1',
      'street',
      'address_street',
    ),
    city: pick(doc, msg, 'city', 'address_city', 'locality'),
    state: pick(doc, msg, 'state', 'region', 'address_state', 'jurisdiction_code'),
    postalCode: pick(doc, msg, 'postal_code', 'postalCode', 'zip', 'zip_code', 'zipCode'),
    phone: pick(doc, msg, 'phone', 'phone_number', 'phoneNumber', 'mobile', 'telephone'),
    email: pick(doc, msg, 'email', 'email_address', 'emailAddress'),
    phoneCountryCode: pick(doc, msg, 'phone_country_code', 'phoneCountryCode', 'country_calling_code'),
    usaCaPhone:
      typeof msg.usa_ca_phone === 'boolean'
        ? msg.usa_ca_phone
        : typeof doc.usa_ca_phone === 'boolean'
          ? doc.usa_ca_phone
          : typeof msg.usaCaPhone === 'boolean'
            ? msg.usaCaPhone
            : null,
  }
}

/** Build ParsedIdFields.fullName and address line from Guru detail when present. */
export function mergeParsedWithGuru(parsed: ParsedIdFields, g: IdScanDetailGuru): ParsedIdFields {
  const first = g.firstName
  const mid = g.middleName
  const last = g.lastName
  let fullName = parsed.fullName
  if (last && first) {
    fullName = mid ? `${last}, ${first} ${mid}` : `${last}, ${first}`
  } else if (first || last) {
    fullName = [last, first].filter(Boolean).join(', ') || first || last
  }

  const parts = [g.streetAddress, g.city, g.state, g.postalCode].filter(Boolean)
  const addressLine = parts.length ? parts.join(', ') : parsed.address

  return {
    ...parsed,
    fullName,
    address: addressLine,
  }
}

/** Best-effort age label from DOB string (M/D/Y, Y-M-D, etc.). */
export function ageLabelFromDobString(dob: string | null): string | null {
  const age = ageYearsFromDobString(dob)
  return age !== null ? `${age} Year(s)` : null
}
