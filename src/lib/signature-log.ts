import type { SupabaseClient } from '@supabase/supabase-js'
import type { SignatureLogEntry } from '../shared/protocol'

export type ReservationLite = {
  confirmation_number: string
  room_number: string | null
  guest_name: string | null
  check_in_date: string | null
  check_out_date: string | null
}

export async function buildSignatureLogFromRows(
  client: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<SignatureLogEntry[]> {
  if (rows.length === 0) return []

  const confirmationNumbers = [
    ...new Set(rows.map((r) => String(r.confirmation_number ?? ''))),
  ].filter(Boolean)

  const resByConf: Record<string, ReservationLite> = {}
  if (confirmationNumbers.length > 0) {
    const { data: resRows, error: resErr } = await client
      .from('reservations')
      .select('confirmation_number, room_number, guest_name, check_in_date, check_out_date')
      .in('confirmation_number', confirmationNumbers)
    if (resErr) console.warn('[FDN] reservations for signature log', resErr.message)
    for (const r of (resRows ?? []) as ReservationLite[]) {
      resByConf[r.confirmation_number] = r
    }
  }

  return rows.map((row) => {
    const conf = String(row.confirmation_number ?? '')
    const res = resByConf[conf]
    return {
      id: String(row.id),
      confirmationNumber: conf,
      storagePath: String(row.storage_path ?? ''),
      signedByUsername:
        typeof row.signed_by_username === 'string' ? row.signed_by_username : null,
      terminalId: typeof row.terminal_id === 'string' ? row.terminal_id : null,
      createdAt: typeof row.created_at === 'string' ? row.created_at : '',
      roomNumber: res?.room_number?.trim() || null,
      guestName: res?.guest_name?.trim() || null,
      checkInDate: res?.check_in_date?.trim() || null,
      checkOutDate: res?.check_out_date?.trim() || null,
    }
  })
}
