import { createExtensionSupabase } from './supabase-factory'

const ID_IMAGE_BUCKETS = ['id-images', 'id-scans'] as const

export async function createIdScanImageSignedUrl(
  storagePath: string,
  expiresSec = 3600,
): Promise<string> {
  const supabase = createExtensionSupabase()
  let lastMessage = 'Could not create signed URL'
  for (const bucket of ID_IMAGE_BUCKETS) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(storagePath, expiresSec)
    if (error) {
      lastMessage = error.message
      continue
    }
    if (data?.signedUrl) return data.signedUrl
  }
  throw new Error(lastMessage)
}
