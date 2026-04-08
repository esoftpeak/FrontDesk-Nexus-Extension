import type { ParsedIdFields } from '../shared/scrape-types'

/** Mock OCR when Edge Function is unavailable (simulation / dev). */
export function mockOcrResult(): ParsedIdFields {
  return {
    fullName: 'SAMPLE, JANE Q',
    dateOfBirth: '1990-01-15',
    idNumber: 'D1234567',
    idType: 'DRIVERS_LICENSE',
    issueDate: '2020-05-01',
    expiryDate: '2028-05-01',
    address: '123 Main St, Springfield, ST 12345',
  }
}

/**
 * POST images to Supabase Edge Function (no API key in extension — uses user JWT).
 */
export async function runOcrWithEdgeFunction(
  accessToken: string,
  frontBase64: string,
  backBase64: string,
): Promise<ParsedIdFields> {
  const fnUrl = import.meta.env.VITE_OCR_FUNCTION_URL
  if (!fnUrl) {
    return mockOcrResult()
  }

  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      front_image_base64: frontBase64,
      back_image_base64: backBase64,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OCR function failed (${res.status}): ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as Record<string, unknown>
  return {
    fullName: pickStr(data, ['fullName', 'full_name']),
    dateOfBirth: pickStr(data, ['dateOfBirth', 'dob', 'date_of_birth']),
    idNumber: pickStr(data, ['idNumber', 'id_number']),
    idType: pickStr(data, ['idType', 'id_type']),
    issueDate: pickStr(data, ['issueDate', 'issue_date']),
    expiryDate: pickStr(data, ['expiryDate', 'expiry_date', 'expiration_date']),
    address: pickStr(data, ['address']),
  }
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}
