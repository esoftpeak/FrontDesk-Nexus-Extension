/** Client-required ID types (exact labels for save / PMS). */
export const ID_DOCUMENT_TYPES = [
  'Drivers License',
  'Identification Card',
  'Passport',
] as const

export type IdDocumentType = (typeof ID_DOCUMENT_TYPES)[number]

const CANONICAL = new Set<string>(ID_DOCUMENT_TYPES)

/** Map OCR / SDK strings to one of the three allowed types. */
export function normalizeIdDocumentType(raw: string | null | undefined): IdDocumentType | null {
  const t = raw?.trim()
  if (!t) return null
  if (CANONICAL.has(t)) return t as IdDocumentType

  const n = t.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ')

  if (n.includes('passport') || n === 'pp') {
    return 'Passport'
  }

  if (
    n.includes('driver') ||
    n.includes('driving') ||
    n === 'dl' ||
    n === 'dr' ||
    n.includes('operator license')
  ) {
    return 'Drivers License'
  }

  if (
    n.includes('identification') ||
    n.includes('identity') ||
    n.includes('state id') ||
    n.includes('id card') ||
    n === 'id' ||
    n.includes('non-driver')
  ) {
    return 'Identification Card'
  }

  return null
}
