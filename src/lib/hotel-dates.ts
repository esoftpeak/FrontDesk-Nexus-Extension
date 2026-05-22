/**
 * Hotel stay dates: SynXis sends UTC midnight ISO for calendar boundaries.
 * Use the calendar date from the ISO string, not local `Date` shifts.
 */

/** `2026-05-22T00:00:00Z` → `2026-05-22` */
export function calendarDateFromUtcIso(iso: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim())
  if (!m) return null
  const mo = Number(m[2])
  const day = Number(m[3])
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Format a local calendar `YYYY-MM-DD` for display (no UTC shift). */
export function formatCalendarDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim())
  if (!m) return isoDate
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return isoDate
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
  }).format(d)
}

/**
 * Normalise check-in/out to SDK `yyyyMMddHHmm`.
 * UTC midnight ISO → hotel calendar date + `defaultHour` (local wall clock).
 */
export function toSdkDatetimeHotel(s: string, defaultHour: number): string {
  const t = s.trim()
  if (!t) return t
  if (/^\d{12}$/.test(t)) return t

  const cal = calendarDateFromUtcIso(t) ?? (/^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null)
  if (cal && (t.endsWith('Z') || /T00:00:00/.test(t) || t === cal)) {
    const [y, mo, d] = cal.split('-').map(Number)
    const date = new Date(y, mo - 1, d, defaultHour, 0, 0, 0)
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`
  }

  const d = new Date(t)
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`
  }
  return t
}

function formatLocalDateTime(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Date-only stay boundary → local wall time for display (matches encoder defaults). */
function formatCalendarDateWithHour(isoDate: string, hour: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim())
  if (!m) return isoDate
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, 0, 0, 0)
  if (Number.isNaN(d.getTime())) return isoDate
  return formatLocalDateTime(d)
}

/**
 * Human-readable check-in/out for UI (ISO, SDK 12-char, or free text).
 * Date-only values use `defaultHour` (check-in 14:00, check-out 12:00) so format matches timed strings.
 */
export function formatHotelDateTime(
  s: string | null | undefined,
  defaultHour: number = 12,
): string {
  if (!s?.trim()) return '—'
  const t = s.trim()
  if (/^\d{12}$/.test(t)) {
    const d = new Date(
      `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:00`,
    )
    if (!Number.isNaN(d.getTime())) return formatLocalDateTime(d)
  }
  const cal = calendarDateFromUtcIso(t) ?? (/^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null)
  if (cal && (t.endsWith('Z') || /T00:00:00/.test(t) || t === cal)) {
    return formatCalendarDateWithHour(cal, defaultHour)
  }
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? t : formatLocalDateTime(d)
}
