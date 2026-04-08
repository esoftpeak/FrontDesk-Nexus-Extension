function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da < db) return -1
    if (da > db) return 1
  }
  return 0
}

export async function checkMinExtensionVersion(): Promise<{
  blocked: boolean
  message: string | null
}> {
  const url = import.meta.env.VITE_MIN_EXTENSION_VERSION_CHECK_URL
  if (!url) return { blocked: false, message: null }

  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return { blocked: false, message: null }
    const j = (await res.json()) as { minVersion?: string }
    const min = j.minVersion
    if (!min || typeof min !== 'string') return { blocked: false, message: null }
    const current = chrome.runtime.getManifest().version
    if (compareSemver(current, min) < 0) {
      return {
        blocked: true,
        message: `Extension update required (minimum ${min}, current ${current}).`,
      }
    }
  } catch {
    /* offline / bad JSON — do not block operations */
  }
  return { blocked: false, message: null }
}
