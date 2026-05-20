/** US state / DC codes → full names (PMS dropdowns use full names). */
export const US_STATES_BY_CODE: Record<string, string> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  DC: 'District of Columbia',
}

const NAME_TO_CODE = Object.fromEntries(
  Object.entries(US_STATES_BY_CODE).map(([code, name]) => [name.toUpperCase(), code]),
) as Record<string, string>

export const US_STATE_SELECT_OPTIONS = Object.entries(US_STATES_BY_CODE)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name))

/** Normalize OCR / manual state to a 2-letter code when possible. */
export function normalizeUsStateCode(input: string | null | undefined): string | null {
  const raw = input?.trim()
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (upper.length === 2 && US_STATES_BY_CODE[upper]) return upper
  return NAME_TO_CODE[upper] ?? null
}

export function usStateDisplayName(code: string | null | undefined): string | null {
  const c = normalizeUsStateCode(code)
  return c ? (US_STATES_BY_CODE[c] ?? null) : null
}
