import type { ParsedIdFields } from '../shared/pms-types'

const ID_KEYS: (keyof ParsedIdFields)[] = [
  'fullName',
  'dateOfBirth',
  'idNumber',
  'idType',
  'issueDate',
  'expiryDate',
  'address',
]

const emptyParsed: ParsedIdFields = {
  fullName: null,
  dateOfBirth: null,
  idNumber: null,
  idType: null,
  issueDate: null,
  expiryDate: null,
  address: null,
}

function stringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

/**
 * Host sends the same field names as the side panel (`ParsedIdFields`, camelCase).
 * Values may live in `ocr_data` and/or on the `SCAN_RESULT` object; top-level wins.
 */
export function parsedFieldsFromHost(root: Record<string, unknown>): ParsedIdFields {
  const nested =
    root.ocr_data != null && typeof root.ocr_data === 'object' && !Array.isArray(root.ocr_data)
      ? (root.ocr_data as Record<string, unknown>)
      : {}
  const out: ParsedIdFields = { ...emptyParsed }
  for (const k of ID_KEYS) {
    out[k] = stringOrNull(root[k]) ?? stringOrNull(nested[k])
  }
  return out
}
