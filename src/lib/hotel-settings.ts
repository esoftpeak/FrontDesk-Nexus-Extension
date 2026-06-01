/** Subset of portal `app_settings` key `hotel` used by the extension. */
export type ExtensionHotelSettings = {
  /** Minimum age to rent a room; 0 = do not warn on scan. Default 18. */
  minimumCheckInAge: number
  /** Maximum allowed guest balance before key encoding is blocked. -1 = disabled. */
  maxAllowedBalance: number
  /** Manager PIN to override key-encoding blocks. Empty string = override disabled. */
  managerOverridePin: string
  /** Minutes of inactivity before the extension auto-logs out. 0 = disabled. Default 480. */
  autoLogoutMinutes: number
}

export const DEFAULT_EXTENSION_HOTEL_SETTINGS: ExtensionHotelSettings = {
  minimumCheckInAge: 18,
  maxAllowedBalance: -1,
  managerOverridePin: '',
  autoLogoutMinutes: 480,
}

function clampMinimumCheckInAge(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return DEFAULT_EXTENSION_HOTEL_SETTINGS.minimumCheckInAge
  }
  return Math.max(0, Math.min(99, Math.floor(n)))
}

function clampMaxAllowedBalance(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return -1
  if (n < 0) return -1
  return Math.round(n * 100) / 100
}

function sanitizeManagerOverridePin(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.trim().slice(0, 32)
}

function clampAutoLogoutMinutes(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_EXTENSION_HOTEL_SETTINGS.autoLogoutMinutes
  if (n <= 0) return 0
  return Math.round(Math.max(1, n))
}

export function parseHotelSettingsValue(value: unknown): ExtensionHotelSettings {
  const v = (value ?? {}) as {
    minimumCheckInAge?: unknown
    maxAllowedBalance?: unknown
    managerOverridePin?: unknown
    autoLogoutMinutes?: unknown
  }
  return {
    minimumCheckInAge: clampMinimumCheckInAge(v.minimumCheckInAge),
    maxAllowedBalance: clampMaxAllowedBalance(v.maxAllowedBalance),
    managerOverridePin: sanitizeManagerOverridePin(v.managerOverridePin),
    autoLogoutMinutes: clampAutoLogoutMinutes(v.autoLogoutMinutes),
  }
}
