/** Local calendar date as YYYY-MM-DD (browser timezone). */
export function localDateString(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse YYYY-MM-DD in local timezone (noon avoids DST edge cases). */
export function parseLocalDateString(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map((x) => Number.parseInt(x, 10))
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0)
}

export function addLocalDays(dateStr: string, days: number): string {
  const d = parseLocalDateString(dateStr)
  d.setDate(d.getDate() + days)
  return localDateString(d)
}

export function clampDateRange(from: string, to: string): { from: string; to: string } {
  if (!from || !to) return { from, to }
  if (from <= to) return { from, to }
  return { from: to, to: from }
}

/** Inclusive day count between two YYYY-MM-DD strings. */
export function daysInRange(from: string, to: string): number {
  const a = parseLocalDateString(from).getTime()
  const b = parseLocalDateString(to).getTime()
  return Math.round(Math.abs(b - a) / 86_400_000) + 1
}

/**
 * Inclusive local-calendar range → UTC ISO bounds for `timestamptz` queries.
 * Avoids missing evening rows when DB stores UTC and filters used naive `T23:59:59`.
 */
export function localDateRangeToUtcIso(from: string, to: string): { startIso: string; endIso: string } {
  const { from: f, to: t } = clampDateRange(from, to)
  const start = parseLocalDateString(f)
  start.setHours(0, 0, 0, 0)
  const end = parseLocalDateString(t)
  end.setHours(23, 59, 59, 999)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

export function formatHistoryNavLabel(from: string, to: string): string {
  if (!from && !to) return '—'
  const f = from ? parseLocalDateString(from) : null
  const t = to ? parseLocalDateString(to) : null
  if (from === to && f) {
    return f.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: '2-digit',
    })
  }
  if (f && t) {
    const sameYear = f.getFullYear() === t.getFullYear()
    const start = f.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    })
    const end = t.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    return `${start} – ${end}`
  }
  return from || to
}
