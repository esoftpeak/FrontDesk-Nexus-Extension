import type { ParsedIdFields, ScrapedReservation } from './scrape-types'

/** chrome.runtime / Port message contracts (see docs/MESSAGING.md) */
export type ExtensionMessage =
  | { type: 'PMS_SCRAPE'; payload: ScrapedReservation }
  | { type: 'GET_STATE' }
  | { type: 'AUTH_DEV_LOGIN'; email: string; password: string }
  | { type: 'AUTH_LOGOUT' }
  | {
      type: 'BRIDGE_SET_SESSION'
      accessToken: string
      refreshToken: string
      expiresAt?: number
    }
  | { type: 'SET_SIMULATION'; enabled: boolean }
  | { type: 'SCAN_ID_START' }
  | {
      type: 'SAVE_ID_SCAN'
      parsed: ParsedIdFields
      phone: string | null
      email: string | null
      manualEntry: boolean
      managerOverride: boolean
      imageFrontBase64: string | null
      imageBackBase64: string | null
    }
  | { type: 'INJECT_PMS'; fields: Record<string, string> }
  | { type: 'VERIFY_MANAGER'; email: string; password: string }

export type ExtensionResponse =
  | { ok: true; state?: ExtensionState }
  | { ok: false; error: string }

export type HardwareDevice = 'id_scanner' | 'spectral_payout' | 'rfid_encoder'

export type HardwareStatus = Record<HardwareDevice, 'connected' | 'disconnected'>

export type ExtensionState = {
  auth: {
    signedIn: boolean
    email: string | null
    role: string | null
    userId: string | null
  }
  simulation: boolean
  versionBlocked: boolean
  versionMessage: string | null
  reservation: ScrapedReservation | null
  hardware: HardwareStatus
  terminalId: string | null
  dnrHit: boolean
  lastError: string | null
}

export const NATIVE_HOST_NAME = 'com.frontdesk_nexus.native_host'
