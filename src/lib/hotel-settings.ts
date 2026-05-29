/** Subset of portal `app_settings` key `hotel` used by the extension. */
export type ExtensionHotelSettings = {
  /** Minimum age to rent a room; 0 = do not warn on scan. Default 18. */
  minimumCheckInAge: number
}

export const DEFAULT_EXTENSION_HOTEL_SETTINGS: ExtensionHotelSettings = {
  minimumCheckInAge: 18,
}

function clampMinimumCheckInAge(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return DEFAULT_EXTENSION_HOTEL_SETTINGS.minimumCheckInAge
  }
  return Math.max(0, Math.min(99, Math.floor(n)))
}

export function parseHotelSettingsValue(value: unknown): ExtensionHotelSettings {
  const v = (value ?? {}) as { minimumCheckInAge?: unknown }
  return {
    minimumCheckInAge: clampMinimumCheckInAge(v.minimumCheckInAge),
  }
}
