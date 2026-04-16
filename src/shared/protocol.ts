import type {
  EzeeGuestDisplay,
  ParsedIdFields,
  ReservationSnapshot,
  SynxisGuestDisplay,
} from './pms-types'

/** chrome.runtime / Port message contracts (see docs/MESSAGING.md) */
export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'LOAD_SYNXIS_RESERVATION' }
  /** Manual scrape: eZee tab with Arrivals drawer open (same payload as auto). */
  | { type: 'LOAD_EZEE_RESERVATION' }
  /** Content script on sph.synxis.com: Guest Stay Record detected, confirmation extracted from DOM. */
  | { type: 'SYNXIS_AUTO_GUEST_DETECTED'; confirmation: string; roomHint?: string | null }
  /** Content script on live.ipms247.com: Ant Design guest drawer scraped. */
  | {
      type: 'EZEE_AUTO_GUEST_DETECTED'
      snapshot: ReservationSnapshot
      guestDisplay: EzeeGuestDisplay
    }
  | { type: 'AUTH_DEV_LOGIN'; email: string; password: string }
  | { type: 'AUTH_LOGOUT' }
  | {
      type: 'BRIDGE_SET_SESSION'
      accessToken: string
      refreshToken: string
      expiresAt?: number
    }
  | {
      type: 'SAVE_ID_SCAN'
      parsed: ParsedIdFields
      phone: string | null
      email: string | null
      manualEntry: boolean
      managerOverride: boolean
      imageFrontBase64: string | null
      imageBackBase64: string | null
      /** `native_host` when data came from Thales/native host; omit for manual entry. */
      ocrProvider?: string | null
    }
  | { type: 'INJECT_PMS'; fields: Record<string, string> }
  | { type: 'VERIFY_MANAGER'; email: string; password: string }

export type ExtensionResponse =
  | { ok: true; state?: ExtensionState }
  | { ok: false; error: string }

/** Service worker → side panel: Thales/SDK host pushed a completed ID scan (no button). */
export type NativeIdScanBroadcast = {
  type: 'FDN_NATIVE_ID_SCAN'
  parsed: ParsedIdFields
  images: { front_image_base64: string; back_image_base64: string }
  imageBase64Length: number
  ocrProvider: 'native_host'
  /** Result of automatic save (reservation + auth + DNR rules). */
  autoSave: { ok: true } | { ok: false; error: string }
}

export type HardwareDevice = 'id_scanner' | 'spectral_payout' | 'rfid_encoder'

export type HardwareStatus = Record<HardwareDevice, 'connected' | 'disconnected'>

export type ExtensionState = {
  auth: {
    signedIn: boolean
    email: string | null
    role: string | null
    userId: string | null
  }
  versionBlocked: boolean
  versionMessage: string | null
  reservation: ReservationSnapshot | null
  /** Parsed guest fields for side panel (SynXis reservation-summary). */
  synxisGuestDisplay: SynxisGuestDisplay | null
  /** eZee Arrivals drawer scrape. */
  ezeeGuestDisplay: EzeeGuestDisplay | null
  hardware: HardwareStatus
  terminalId: string | null
  dnrHit: boolean
  lastError: string | null
}

/** Native Messaging host id — must match Windows registry + host manifest `name`. */
export const NATIVE_HOST_NAME = 'com.frontdesk.nexus'

/** Service worker → side panel: transient success / warning banner. */
export type PanelToastBroadcast = {
  type: 'FDN_PANEL_TOAST'
  confirmationNumber: string
  detail?: string
  variant?: 'success' | 'warn'
}
