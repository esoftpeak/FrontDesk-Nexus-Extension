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
