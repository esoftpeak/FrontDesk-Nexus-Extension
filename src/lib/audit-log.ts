import type { SupabaseClient } from '@supabase/supabase-js'

export type AuditInsert = {
  action_type: string
  username: string | null
  user_role: string | null
  confirmation_number?: string | null
  description?: string | null
  old_value?: Record<string, unknown> | null
  new_value?: Record<string, unknown> | null
  user_id: string
}

export async function insertAuditRow(
  client: SupabaseClient,
  row: AuditInsert,
): Promise<{ error: Error | null }> {
  const { error } = await client.from('audit_log').insert({
    action_type: row.action_type,
    username: row.username,
    user_role: row.user_role,
    terminal_id: null,
    confirmation_number: row.confirmation_number ?? null,
    description: row.description ?? null,
    old_value: row.old_value ?? null,
    new_value: row.new_value ?? null,
    user_id: row.user_id,
    context: {},
  })
  return { error: error ? new Error(error.message) : null }
}
