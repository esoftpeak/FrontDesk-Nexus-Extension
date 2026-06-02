/**
 * Hotel stay dates: SynXis sends UTC midnight ISO for calendar boundaries.
 * Use the calendar date from the ISO string, not local `Date` shifts.
 */

/** True when SynXis `stay.checkInDate` is a wall-clock time, not a stay date. */
export function isHotelTimeOnlyString(s: string): boolean {
  const t = s.trim()
  if (!t) return false
  if (/^\d{1,2}:\d{2}(\s*:\d{2})?(\s*[AP]M)?$/i.test(t)) return true
  if (/^\d{1,2}:\d{2}\s*[AP]M$/i.test(t)) return true
  return false
}

/** US `M/D/YYYY` or `MM/DD/YYYY` → `YYYY-MM-DD` (SynXis stay summary text). */
export function parseUsSlashDateToYmd(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim())
  if (!m) return null
  const mo = parseInt(m[1]!, 10)
  const day = parseInt(m[2]!, 10)
  const y = parseInt(m[3]!, 10)
  if (mo < 1 || mo > 12 || day < 1 || day > 31 || y < 1990 || y > 2100) return null
  return `${y}-${pad2(mo)}-${pad2(day)}`
}

/**
 * Normalize a stay boundary for DB / encoder (prefer `YYYY-MM-DD` or UTC ISO).
 * Rejects time-only and bare `M/D` (JS defaults missing years to 2001).
 */
export function normalizeHotelStayDate(
  isoUtc: string | null | undefined,
  fallback: string | null | undefined,
): string | null {
  if (isoUtc?.trim()) {
    const cal = calendarDateFromUtcIso(isoUtc)
    if (cal) return cal
  }

  const raw = (fallback ?? '').trim()
  if (!raw || isHotelTimeOnlyString(raw)) return null

  const fromIso = calendarDateFromUtcIso(raw)
  if (fromIso) return fromIso

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const slash = parseUsSlashDateToYmd(raw)
  if (slash) return slash

  // `5/22` or `05/22` without a year → May 22, 2001 in JS — ignore.
  if (/^\d{1,2}\/\d{1,2}$/.test(raw)) return null

  if (/^\d{12}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  }

  return null
}

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
 * Local datetime with an explicit time (e.g. `2026-06-02T08:28:00`, no Z, not midnight)
 * is used as-is — `defaultHour` is NOT applied.
 */
export function toSdkDatetimeHotel(s: string, defaultHour: number): string {
  const t = s.trim()
  if (!t) return t
  if (/^\d{12}$/.test(t)) return t

  // Local ISO datetime with a real time component — preserve it exactly
  const localDt = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(t)
  if (localDt && !t.endsWith('Z') && !/T00:00:00/.test(t)) {
    return `${localDt[1]}${localDt[2]}${localDt[3]}${localDt[4]}${localDt[5]}`
  }

  const normalized = normalizeHotelStayDate(null, t)
  if (normalized) {
    const [y, mo, d] = normalized.split('-').map(Number)
    const date = new Date(y, mo - 1, d, defaultHour, 0, 0, 0)
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`
  }

  const cal = calendarDateFromUtcIso(t) ?? (/^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null)
  if (cal && (t.endsWith('Z') || /T00:00:00/.test(t) || t === cal)) {
    const [y, mo, d] = cal.split('-').map(Number)
    const date = new Date(y, mo - 1, d, defaultHour, 0, 0, 0)
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}${pad2(date.getMinutes())}`
  }

  // Do not `new Date(t)` on arbitrary PMS strings — MM/DD without year becomes year 2001.
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
 * Local datetime with an explicit time is displayed as-is — `defaultHour` is NOT applied.
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
  // Local ISO datetime with a real time component — display as-is, ignore defaultHour
  const localDt = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(t)
  if (localDt && !t.endsWith('Z') && !/T00:00:00/.test(t)) {
    const [, y, mo, d, h, min] = localDt
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(min), 0, 0)
    if (!Number.isNaN(date.getTime())) return formatLocalDateTime(date)
  }
  const normalized = normalizeHotelStayDate(null, t)
  if (normalized) {
    return formatCalendarDateWithHour(normalized, defaultHour)
  }

  const cal = calendarDateFromUtcIso(t) ?? (/^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null)
  if (cal && (t.endsWith('Z') || /T00:00:00/.test(t) || t === cal)) {
    return formatCalendarDateWithHour(cal, defaultHour)
  }

  return t
}
