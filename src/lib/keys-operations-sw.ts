import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  KeyBoardEntry,
  KeyLedgerEntry,
  RoomBlockEntry,
} from '../shared/protocol'
import { insertAuditRow } from './audit-log'
import { localDateRangeToUtcIso } from './local-date'
import {
  boardGuestDisplay,
  keyHistoryAgent,
  keyHistoryCheckin,
  keyHistoryCheckout,
  keyHistoryEventTime,
  keyHistoryGuestName,
  keyHistoryVisibleOnBusinessDate,
  occupancyByRoomForDate,
  reservationGuestMaps,
  type KeyBoardHistoryRow,
  type ReservationGuestPick,
} from './key-board'
export type RoomBlockRow = {
  id: string
  room_number: string
  blocked_until: string | null
  reason: string | null
  created_at: string
  released_at: string | null
  effective_from_vacancy?: boolean | null
}

export function isActiveRoomBlock(block: RoomBlockRow, now = new Date()): boolean {
  if (block.released_at) return false
  if (!block.blocked_until) return true
  return new Date(block.blocked_until).getTime() > now.getTime()
}

export function keysWriteAuthorized(
  role: string | null,
  managerPin: string | undefined,
  configuredManagerPin: string,
): boolean {
  if (role === 'admin') return true
  const pin = managerPin?.trim()
  if (!pin || !configuredManagerPin) return false
  return pin === configuredManagerPin
}

export async function fetchKeyBoardData(
  client: SupabaseClient,
  businessDate: string,
  agentFilter?: string,
): Promise<{ board: KeyBoardEntry[]; stats: { total: number; withKey: number; vacant: number } }> {
  const { data: roomRows, error: roomErr } = await client
    .from('rooms')
    .select('room_number')
    .eq('is_active', true)
    .order('room_number')
  if (roomErr) throw new Error(roomErr.message)

  const rooms = (roomRows ?? []).map((r) => String((r as { room_number: string }).room_number))

  let keyQuery = client.from('key_history').select('*').order('created_at', { ascending: false })
  const { data: keyData, error: keyErr } = await keyQuery
  if (keyErr) throw new Error(keyErr.message)

  let keys = (keyData ?? []) as KeyBoardHistoryRow[]
  if (agentFilter?.trim()) {
    const term = agentFilter.trim().toLowerCase()
    keys = keys.filter((k) => (keyHistoryAgent(k) ?? '').toLowerCase().includes(term))
  }

  const confs = new Set<string>()
  for (const k of keys) {
    if (!keyHistoryVisibleOnBusinessDate(k, businessDate)) continue
    const c = k.confirmation_number?.trim()
    if (c) confs.add(c)
  }

  let resGuests = new Map<string, string>()
  let checkedOut = new Set<string>()
  let roomByConfirmation = new Map<string, string>()

  if (confs.size > 0) {
    const { data: resRows, error: resErr } = await client
      .from('reservations')
      .select('confirmation_number, guest_name, reservation_status, updated_at, room_number')
      .in('confirmation_number', [...confs])
    if (resErr) throw new Error(resErr.message)
    const maps = reservationGuestMaps((resRows ?? []) as ReservationGuestPick[])
    resGuests = maps.guests
    checkedOut = maps.checkedOut
    roomByConfirmation = maps.roomByConfirmation
  }

  const byRoom = occupancyByRoomForDate(keys, businessDate, checkedOut, roomByConfirmation)

  const { data: blockRows } = await client
    .from('room_blocks')
    .select('*')
    .is('released_at', null)

  const blocksByRoom = new Map<string, RoomBlockRow>()
  const now = new Date()
  for (const b of (blockRows ?? []) as RoomBlockRow[]) {
    if (!isActiveRoomBlock(b, now)) continue
    const cur = blocksByRoom.get(b.room_number)
    if (!cur || new Date(b.created_at).getTime() > new Date(cur.created_at).getTime()) {
      blocksByRoom.set(b.room_number, b)
    }
  }

  const { data: hkRows } = await client.from('room_operational_status').select('room_number, status')
  const hkByRoom = new Map<string, string>()
  for (const r of hkRows ?? []) {
    const rn = String((r as { room_number: string }).room_number)
    hkByRoom.set(rn, String((r as { status: string }).status))
  }

  const board: KeyBoardEntry[] = rooms.map((room) => {
    const key = byRoom.get(room) ?? null
    const block = blocksByRoom.get(room)
    return {
      roomNumber: room,
      guestName: key ? boardGuestDisplay(key, resGuests) : null,
      confirmationNumber: key?.confirmation_number?.trim() || null,
      checkinTime: key ? keyHistoryCheckin(key) : null,
      checkoutTime: key ? keyHistoryCheckout(key) : null,
      encodedBy: key ? keyHistoryAgent(key) : null,
      cardSerial: key?.card_serial ?? null,
      blocked: Boolean(block),
      blockSummary: block
        ? block.blocked_until
          ? `Blocked until ${new Date(block.blocked_until).toLocaleString()}`
          : 'Blocked indefinitely'
        : null,
      blockId: block?.id ?? null,
      deferredBlock: Boolean(block?.effective_from_vacancy),
      roomStatus: hkByRoom.get(room) ?? null,
      hasKey: Boolean(key),
    }
  })

  const withKey = board.filter((r) => r.hasKey).length
  return {
    board,
    stats: { total: board.length, withKey, vacant: board.length - withKey },
  }
}

export async function fetchKeyLedger(
  client: SupabaseClient,
  fromDate: string,
  toDate: string,
  agentFilter?: string,
  roomFilter?: string,
): Promise<KeyLedgerEntry[]> {
  const { startIso, endIso } = localDateRangeToUtcIso(fromDate, toDate)

  let q = client
    .from('key_history')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500)

  if (fromDate.trim()) q = q.gte('created_at', startIso)
  if (toDate.trim()) q = q.lte('created_at', endIso)

  const { data, error } = await q
  if (error) throw new Error(error.message)

  let rows = ((data ?? []) as KeyBoardHistoryRow[]).filter((r) => r.success !== false)

  if (agentFilter?.trim()) {
    const term = agentFilter.trim().toLowerCase()
    rows = rows.filter((r) => (keyHistoryAgent(r) ?? '').toLowerCase().includes(term))
  }
  if (roomFilter?.trim()) {
    const term = roomFilter.trim().toLowerCase()
    rows = rows.filter((r) => (r.room_number ?? '').toLowerCase().includes(term))
  }

  const confs = [...new Set(rows.map((r) => r.confirmation_number).filter(Boolean))]
  const guestByConf = new Map<string, string>()
  if (confs.length > 0) {
    const { data: resRows } = await client
      .from('reservations')
      .select('confirmation_number, guest_name')
      .in('confirmation_number', confs)
    for (const r of resRows ?? []) {
      const c = String((r as { confirmation_number: string }).confirmation_number)
      const g = (r as { guest_name: string | null }).guest_name
      if (g?.trim()) guestByConf.set(c, g.trim())
    }
  }

  return rows.map((r) => ({
    id: r.id,
    roomNumber: (r.room_number ?? '').trim() || '—',
    guestName:
      keyHistoryGuestName(r) ?? guestByConf.get(r.confirmation_number) ?? null,
    confirmationNumber: r.confirmation_number,
    cardSerial: r.card_serial ?? null,
    checkinTime: keyHistoryCheckin(r),
    checkoutTime: keyHistoryCheckout(r),
    encodedBy: keyHistoryAgent(r),
    encodedAt: keyHistoryEventTime(r) || r.created_at || '',
  }))
}

export async function createRoomBlockSw(
  client: SupabaseClient,
  params: {
    roomNumber: string
    blockedUntil: string | null
    reason: string | null
    userId: string
    username: string | null
    role: string | null
    effectiveFromVacancy: boolean
  },
): Promise<{ error: string | null }> {
  const { error } = await client
    .from('room_blocks')
    .insert({
      room_number: params.roomNumber.trim(),
      blocked_until: params.blockedUntil,
      reason: params.reason?.trim() || null,
      created_by: params.userId,
      effective_from_vacancy: params.effectiveFromVacancy,
    })
    .select('id')
    .maybeSingle()

  if (error) return { error: error.message }

  await insertAuditRow(client, {
    action_type: 'room_block_created',
    user_id: params.userId,
    username: params.username,
    user_role: params.role,
    description: `Room ${params.roomNumber} blocked from extension`,
    new_value: {
      room_number: params.roomNumber,
      blocked_until: params.blockedUntil,
      effective_from_vacancy: params.effectiveFromVacancy,
    },
  })

  return { error: null }
}

export async function releaseRoomBlockSw(
  client: SupabaseClient,
  params: {
    blockId: string
    roomNumber: string
    userId: string
    username: string | null
    role: string | null
  },
): Promise<{ error: string | null }> {
  const { error } = await client
    .from('room_blocks')
    .update({
      released_at: new Date().toISOString(),
      released_by: params.userId,
    })
    .eq('id', params.blockId)

  if (error) return { error: error.message }

  await insertAuditRow(client, {
    action_type: 'room_block_released',
    user_id: params.userId,
    username: params.username,
    user_role: params.role,
    description: `Room ${params.roomNumber} unblocked from extension`,
    new_value: { block_id: params.blockId },
  })

  return { error: null }
}

export function roomBlockToEntry(b: RoomBlockRow): RoomBlockEntry {
  return {
    id: b.id,
    roomNumber: b.room_number,
    blockedUntil: b.blocked_until,
    reason: b.reason,
    createdAt: b.created_at,
    effectiveFromVacancy: Boolean(b.effective_from_vacancy),
  }
}
