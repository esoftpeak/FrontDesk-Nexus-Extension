/**
 * Map extension ID fields → eZee Add Reservation "Identity Information" controls.
 * PMS dropdown options (per property) commonly include "Driving License" and "Passport".
 */

/** Extension / panel label → eZee ID Type dropdown option text. */
export function mapIdTypeToEzeeDropdownOption(idType: string | null | undefined): string | null {
  const t = idType?.trim()
  if (!t) return null
  const n = t.toLowerCase().replace(/['’]/g, '').replace(/\s+/g, ' ')

  if (n.includes('passport') || n === 'pp') return 'Passport'

  if (
    n.includes('driver') ||
    n.includes('driving') ||
    n === 'dl' ||
    n.includes('drivers license')
  ) {
    return 'Driving License'
  }

  if (
    n.includes('identification') ||
    n.includes('identity') ||
    n.includes('state id') ||
    n.includes('id card')
  ) {
    return 'Identification Card'
  }

  return t
}

/**
 * Normalize expiry to eZee date input format MM-DD-YYYY (see Add Reservation date picker).
 */
export function formatEzeeExpiryForPicker(raw: string | null | undefined): string | null {
  const t = raw?.trim()
  if (!t) return null

  const mdy = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (mdy) {
    const mm = mdy[1].padStart(2, '0')
    let dd = Number(mdy[2])
    let yyyy = mdy[3]
    if (yyyy.length === 2) yyyy = `20${yyyy}`
    const maxDay = new Date(Number(yyyy), Number(mm), 0).getDate()
    if (dd < 1) dd = 1
    if (dd > maxDay) dd = maxDay
    return `${mm}-${String(dd).padStart(2, '0')}-${yyyy}`
  }

  const my = t.match(/^(\d{1,2})[/.-](\d{2})$/)
  if (my) {
    const mm = my[1].padStart(2, '0')
    const yyyy = `20${my[2]}`
    const maxDay = new Date(Number(yyyy), Number(mm), 0).getDate()
    return `${mm}-${String(maxDay).padStart(2, '0')}-${yyyy}`
  }

  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    return `${iso[2]}-${iso[3]}-${iso[1]}`
  }

  return null
}
