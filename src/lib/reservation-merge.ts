import type { ReservationSnapshot } from '../shared/pms-types'

export function normalizeRoom(value: string | null | undefined): string | null {
  const t = (value ?? '').trim()
  return t.length > 0 ? t : null
}

/** Parses DB `room_number` text: single room or chain `"113 → 304 → 823"`. */
export function parseRoomChainToHistory(value: string | null | undefined): string[] {
  const raw = (value ?? '').trim()
  if (!raw) return []
  if (raw.includes('→')) {
    return raw
      .split('→')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  }
  return [raw]
}

/** Same segments as stored in `room_number`, joined for the text column. */
export function formatRoomChainForColumn(history: string[]): string | null {
  if (history.length === 0) return null
  return history.join(' → ')
}

/**
 * Builds an ordered room history when the PMS-reported room changes.
 * DB column uses `formatRoomChainForColumn`; JSON keeps `fdn.roomNumberHistory` in sync.
 */
export function mergeRoomNumberHistory(args: {
  previousRoomColumn: string | null
  previousPayload: Record<string, unknown> | null | undefined
  newRoomFromPms: string | null
}): string[] {
  const newR = normalizeRoom(args.newRoomFromPms)
  const prevColRaw =
    args.previousRoomColumn != null && String(args.previousRoomColumn).trim().length > 0
      ? String(args.previousRoomColumn).trim()
      : null

  let history: string[] = []
  const payload = args.previousPayload
  const fdn = payload?.fdn
  if (fdn && typeof fdn === 'object' && !Array.isArray(fdn)) {
    const h = (fdn as Record<string, unknown>).roomNumberHistory
    if (Array.isArray(h)) {
      history = h.map((x) => String(x).trim()).filter((x) => x.length > 0)
    }
  }

  if (history.length === 0 && prevColRaw) {
    history = parseRoomChainToHistory(prevColRaw)
  }

  if (!newR) {
    return history
  }

  const last = history.length > 0 ? history[history.length - 1] : null
  if (last === newR) {
    return history
  }

  if (history.length === 0) {
    return [newR]
  }

  return [...history, newR]
}

/** Latest PMS snapshot wins for overlapping keys; extension metadata under fdn is merged. */
export function buildMergedScrapePayload(
  snap: ReservationSnapshot,
  existingPayload: Record<string, unknown> | null | undefined,
  roomNumberHistory: string[],
  loadedAt: string,
): Record<string, unknown> {
  const prev =
    existingPayload && typeof existingPayload === 'object' && !Array.isArray(existingPayload)
      ? { ...existingPayload }
      : {}
  const snapRec = { ...(snap as unknown as Record<string, unknown>) }
  const prevFdn =
    prev.fdn && typeof prev.fdn === 'object' && !Array.isArray(prev.fdn)
      ? { ...(prev.fdn as Record<string, unknown>) }
      : {}

  return {
    ...prev,
    ...snapRec,
    fdn: {
      ...prevFdn,
      roomNumberHistory,
      roomNumberHistoryUpdatedAt: loadedAt,
    },
  }
}
