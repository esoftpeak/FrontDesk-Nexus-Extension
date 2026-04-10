import type { ParsedIdFields, ReservationSnapshot, SynxisGuestDisplay } from './pms-types'

/** chrome.runtime / Port message contracts (see docs/MESSAGING.md) */
export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'LOAD_SYNXIS_RESERVATION' }
  /** Content script on sph.synxis.com: Guest Stay Record detected, confirmation extracted from DOM. */
  | { type: 'SYNXIS_AUTO_GUEST_DETECTED'; confirmation: string }
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
  reservation: ReservationSnapshot | null
  /** Parsed guest fields for side panel (SynXis reservation-summary). */
  synxisGuestDisplay: SynxisGuestDisplay | null
  hardware: HardwareStatus
  terminalId: string | null
  dnrHit: boolean
  lastError: string | null
}

export const NATIVE_HOST_NAME = 'com.frontdesk_nexus.native_host'

/** Service worker → side panel: transient success / warning banner. */
export type PanelToastBroadcast = {
  type: 'FDN_PANEL_TOAST'
  confirmationNumber: string
  detail?: string
  variant?: 'success' | 'warn'
}
