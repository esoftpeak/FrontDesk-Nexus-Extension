export function splitGuestName(full: string | null): { firstName: string; lastName: string } {
  if (!full) return { firstName: '', lastName: '' }
  const t = full.trim()
  if (t.includes(',')) {
    const [last, ...rest] = t.split(',').map((s) => s.trim())
    return { lastName: last ?? '', firstName: rest.join(' ') }
  }
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0] ?? '', lastName: '' }
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') }
}
