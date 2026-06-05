/** Room board helpers — ported from Web `keyHistory.ts` / `KeyHistoryPage.tsx`. */

export type KeyBoardHistoryRow = {
  id: string
  confirmation_number: string
  room_number: string | null
  checkin_time?: string | null
  checkout_time?: string | null
  card_serial?: number | null
  guest_name?: string | null
  encoded_by_username?: string | null
  agent_username?: string | null
  encoded_by?: string | null
  encoded_at?: string | null
  created_at?: string | null
  success?: boolean | null
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const COMPACT_12 = /^\d{12}$/

function tryParseCompactYmdHmLocal(raw: string): Date | null {
  const t = raw.trim()
  if (!COMPACT_12.test(t)) return null
  const y = Number(t.slice(0, 4))
  const mo = Number(t.slice(4, 6))
  const d = Number(t.slice(6, 8))
  const h = Number(t.slice(8, 10))
  const mi = Number(t.slice(10, 12))
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const dt = new Date(y, mo - 1, d, h, mi, 0, 0)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

export function parseKeyHistoryDay(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  const t = value.trim()
  const compactDt = tryParseCompactYmdHmLocal(t)
  if (compactDt) {
    const y = compactDt.getFullYear()
    const mo = String(compactDt.getMonth() + 1).padStart(2, '0')
    const d = String(compactDt.getDate()).padStart(2, '0')
    return `${y}-${mo}-${d}`
  }
  const iso = t.slice(0, 10)
  if (DATE_ONLY.test(iso)) return iso
  const parsed = new Date(t)
  if (Number.isNaN(parsed.getTime())) return null
  const y = parsed.getFullYear()
  const mo = String(parsed.getMonth() + 1).padStart(2, '0')
  const d = String(parsed.getDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

export function keyHistoryCheckin(row: KeyBoardHistoryRow): string | null {
  const v = row.checkin_time
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function keyHistoryCheckout(row: KeyBoardHistoryRow): string | null {
  const v = row.checkout_time
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function keyHistoryGuestName(row: KeyBoardHistoryRow): string | null {
  const v = row.guest_name
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function keyHistoryAgent(row: KeyBoardHistoryRow): string | null {
  return row.encoded_by_username ?? row.agent_username ?? row.encoded_by ?? null
}

export function keyHistoryEventTime(row: KeyBoardHistoryRow): string {
  return row.encoded_at ?? row.created_at ?? ''
}

const LOCALE_SHORT: Intl.DateTimeFormatOptions = {
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
}

export function formatKeyHistoryShortYmdHm(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  const t = value.trim()
  const dt = tryParseCompactYmdHmLocal(t)
  if (dt) return new Intl.DateTimeFormat(undefined, LOCALE_SHORT).format(dt)
  const parsed = new Date(t)
  if (Number.isNaN(parsed.getTime())) return null
  return new Intl.DateTimeFormat(undefined, LOCALE_SHORT).format(parsed)
}

export function keyHistoryVisibleOnBusinessDate(
  row: KeyBoardHistoryRow,
  businessDate: string,
): boolean {
  const cin = parseKeyHistoryDay(keyHistoryCheckin(row))
  const cout = parseKeyHistoryDay(keyHistoryCheckout(row))
  if (cin && cout && cin <= businessDate && cout >= businessDate) return true
  if (cin && !cout && cin <= businessDate) return true

  const created = parseKeyHistoryDay(row.created_at ?? undefined)
  if (created === businessDate) return true
  const encoded = parseKeyHistoryDay(row.encoded_at ?? undefined)
  if (encoded === businessDate) return true

  const event = parseKeyHistoryDay(keyHistoryEventTime(row))
  if (event === businessDate) return true

  return false
}

export function formatGuestDisplay(name: string | null | undefined): string {
  if (!name?.trim()) return ''
  const t = name.trim()
  if (t.includes(',')) return t.toUpperCase()
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!.toUpperCase()
    const first = parts.slice(0, -1).join(' ')
    return `${last}, ${first}`
  }
  return t
}

export type ReservationGuestPick = {
  confirmation_number: string
  guest_name: string | null
  reservation_status: string | null
  updated_at: string
  room_number: string | null
}

export function reservationGuestMaps(rows: ReservationGuestPick[]): {
  guests: Map<string, string>
  checkedOut: Set<string>
  roomByConfirmation: Map<string, string>
} {
  const latest = new Map<string, ReservationGuestPick>()
  for (const r of rows) {
    const cur = latest.get(r.confirmation_number)
    if (!cur || new Date(r.updated_at) > new Date(cur.updated_at)) {
      latest.set(r.confirmation_number, r)
    }
  }
  const guests = new Map<string, string>()
  const checkedOut = new Set<string>()
  const roomByConfirmation = new Map<string, string>()
  for (const [, r] of latest) {
    if (r.guest_name?.trim()) guests.set(r.confirmation_number, r.guest_name.trim())
    const rn = (r.room_number ?? '').trim()
    if (rn) roomByConfirmation.set(r.confirmation_number, rn)
    if (r.reservation_status === 'checked_out') checkedOut.add(r.confirmation_number)
  }
  return { guests, checkedOut, roomByConfirmation }
}

export function occupancyByRoomForDate(
  keys: KeyBoardHistoryRow[],
  businessDate: string,
  hideConfirmations: Set<string>,
  roomByConfirmation: Map<string, string>,
): Map<string, KeyBoardHistoryRow> {
  const latestKeyByConf = new Map<string, KeyBoardHistoryRow>()
  for (const k of keys) {
    if (!keyHistoryVisibleOnBusinessDate(k, businessDate)) continue
    const conf = k.confirmation_number?.trim()
    if (!conf || hideConfirmations.has(conf)) continue
    if (!latestKeyByConf.has(conf)) latestKeyByConf.set(conf, k)
  }

  const byRoom = new Map<string, KeyBoardHistoryRow>()
  for (const [conf, k] of latestKeyByConf) {
    const resRoom = roomByConfirmation.get(conf)?.trim() ?? ''
    const keyRoom = (k.room_number ?? '').trim()
    const room = resRoom || keyRoom
    if (!room) continue

    const displayKey: KeyBoardHistoryRow =
      resRoom && resRoom !== keyRoom ? { ...k, room_number: resRoom } : k

    const prev = byRoom.get(room)
    if (!prev) {
      byRoom.set(room, displayKey)
      continue
    }
    if (keyHistoryEventTime(displayKey).localeCompare(keyHistoryEventTime(prev)) > 0) {
      byRoom.set(room, displayKey)
    }
  }
  return byRoom
}

export function boardGuestDisplay(
  k: KeyBoardHistoryRow,
  resGuests: Map<string, string>,
): string {
  const fromKey = formatGuestDisplay(keyHistoryGuestName(k))
  if (fromKey) return fromKey
  return formatGuestDisplay(resGuests.get(k.confirmation_number) ?? null)
}
