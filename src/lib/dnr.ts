import type { SupabaseClient } from '@supabase/supabase-js'

/** Same normalization as save-time DNR lookup and `hashIdNumber` input. */
export function normalizeIdNumber(n: string | null | undefined): string {
  return (n ?? '').replace(/\s+/g, '').toUpperCase()
}

export function idVariantsForDnrLookup(idNumber: string | null | undefined): string[] {
  const raw = (idNumber ?? '').trim()
  if (!raw) return []
  const norm = normalizeIdNumber(raw)
  return [...new Set([raw, norm].filter((x) => x.length > 0))]
}

export async function checkActiveDnr(
  client: SupabaseClient,
  idNumber: string | null | undefined,
): Promise<boolean> {
  const variants = idVariantsForDnrLookup(idNumber)
  if (variants.length === 0) return false

  const { data: hits, error } = await client
    .from('dnr_entries')
    .select('id')
    .eq('status', 'active')
    .in('id_number', variants)

  if (error) {
    console.warn('[FDN SW] DNR check failed', error.message)
    return false
  }
  return (hits?.length ?? 0) > 0
}
