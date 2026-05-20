import { normalizeUsStateCode } from './us-states'

/** US ZIP or ZIP+4 → 5-digit ZIP for lookup. */
export function normalizeUsZipInput(input: string | null | undefined): string {
  const digits = (input ?? '').replace(/\D/g, '')
  return digits.length >= 5 ? digits.slice(0, 5) : digits
}

export function isCompleteUsZip(zip: string): boolean {
  return /^\d{5}$/.test(zip)
}

type ZippopotamPlace = {
  'place name'?: string
  'state abbreviation'?: string
}

type ZippopotamResponse = {
  places?: ZippopotamPlace[]
}

export type ZipLookupResult = {
  city: string
  stateCode: string
}

/**
 * Resolve US city + state from ZIP via Zippopotam (no API key).
 * @see https://zippopotam.us/
 */
export async function lookupUsZipCityState(
  zipInput: string,
  signal?: AbortSignal,
): Promise<ZipLookupResult | null> {
  const zip = normalizeUsZipInput(zipInput)
  if (!isCompleteUsZip(zip)) return null

  const res = await fetch(`https://api.zippopotam.us/us/${zip}`, { signal })
  if (!res.ok) return null

  const data = (await res.json()) as ZippopotamResponse
  const place = data.places?.[0]
  const city = place?.['place name']?.trim()
  const stateCode = normalizeUsStateCode(place?.['state abbreviation'])
  if (!city || !stateCode) return null

  return { city, stateCode }
}
