/** Normalize phone to 10 US digits for hash / lookup (strips +1, punctuation). */
export function normalizePhoneForLookup(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  if (digits.length > 10) return digits.slice(-10)
  return digits
}

/** Minimum length to query guest stay history. */
export function isCompletePhoneForLookup(phone: string | null | undefined): boolean {
  return normalizePhoneForLookup(phone).length >= 10
}

/** US/CA display: (555) 555-5555 */
export function formatUsPhoneDisplay(phone: string): string {
  const d = normalizePhoneForLookup(phone)
  if (d.length !== 10) return phone.trim()
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/**
 * Validate phone before save. When `usaCa` is true (default), requires exactly 10 US/CA digits.
 */
export function validatePhoneNumber(
  phone: string,
  opts?: { usaCa?: boolean },
): string | null {
  const trimmed = phone.trim()
  if (!trimmed) return 'Phone number is required.'

  const digits = normalizePhoneForLookup(trimmed)
  const usaCa = opts?.usaCa !== false

  if (usaCa) {
    if (digits.length !== 10) {
      return 'Enter a valid 10-digit US/CA phone number.'
    }
    if (/^(\d)\1{9}$/.test(digits)) {
      return 'Enter a valid phone number.'
    }
    return null
  }

  if (digits.length < 10) return 'Enter at least 10 digits for the phone number.'
  if (digits.length > 15) return 'Phone number is too long.'
  return null
}
