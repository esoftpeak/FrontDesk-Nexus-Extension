import type {
  EzeeGuestDisplay,
  IdScanDetailGuru,
  ParsedIdFields,
  ReservationSnapshot,
  SynxisGuestDisplay,
} from './pms-types'

export type { IdScanDetailGuru }

/** chrome.runtime / Port message contracts (see docs/MESSAGING.md) */
/** Prior scans for the current reservation confirmation (Supabase `id_scans`). */
export type IdScanHistoryRow = {
  id: string
  confirmationNumber: string
  scannedAt: string
  manualEntry: boolean
}

export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'GET_ID_SCAN_HISTORY' }
  | { type: 'LOAD_SYNXIS_RESERVATION' }
  /** Manual scrape: eZee tab with Arrivals drawer open (same payload as auto). */
  | { type: 'LOAD_EZEE_RESERVATION' }
  /** Content script on sph.synxis.com: Guest Stay Record detected, confirmation extracted from DOM. */
  | { type: 'SYNXIS_AUTO_GUEST_DETECTED'; confirmation: string; roomHint?: string | null }
  /** Content script on sph.synxis.com: user clicked "Print Basic Registration Card" in the toolbar. */
  | { type: 'SYNXIS_PRINT_BASIC_CARD_CLICKED' }
  /** Content script on live.ipms247.com: Ant Design guest drawer scraped. */
  | {
      type: 'EZEE_AUTO_GUEST_DETECTED'
      snapshot: ReservationSnapshot
      guestDisplay: EzeeGuestDisplay
    }
  /** Content script on live.ipms247.com: user clicked "Print Guest Registration Card". */
  | { type: 'EZEE_PRINT_BASIC_CARD_CLICKED'; confirmation: string }
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
      detail?: IdScanDetailGuru | null
      documentData?: Record<string, unknown> | null
      guestRemark?: string | null
      checkInRemark?: string | null
    }
  | { type: 'INJECT_PMS'; fields: Record<string, string> }
  | { type: 'VERIFY_MANAGER'; email: string; password: string }
  | {
      type: 'SAVE_SIGNATURE'
      /** Base64-encoded signed PDF bytes (from pdf-lib save()). */
      pdfBase64: string
      confirmationNumber: string
    }

export type ExtensionResponse =
  | { ok: true; state?: ExtensionState; idScanHistory?: IdScanHistoryRow[]; signaturePath?: string }
  | { ok: false; error: string }

/** Service worker → side panel: log native inbound (opens in side panel DevTools). */
export type NativeHostRxDebugBroadcast = {
  type: 'FDN_NATIVE_HOST_RX'
  receivedAt: string
  source: 'AUTO_SCAN_RESULT' | 'SCAN_RESULT' | 'ERROR' | 'other'
  topLevelKeys: string[]
  imageFrontB64Length?: number
  imageBackB64Length?: number
  legacySingleImageB64Length?: number
  documentDataKeys: string[]
  /** String / primitive preview (truncated); no full images. */
  documentDataPreview?: Record<string, string>
  parsedPreview?: Record<string, string | null>
  errorMessage?: string
  unhandledType?: string
}

/** Service worker → side panel: Thales/SDK host pushed a completed ID scan (no button). */
export type NativeIdScanBroadcast = {
  type: 'FDN_NATIVE_ID_SCAN'
  /** ISO time when the extension received this scan (for UI + audit). */
  receivedAt?: string
  parsed: ParsedIdFields
  images: { front_image_base64: string; back_image_base64: string }
  imageBase64Length: number
  ocrProvider: 'native_host'
  /** Result of automatic save (reservation + auth + DNR rules). */
  autoSave: { ok: true } | { ok: false; error: string }
  /** Structured fields from Python `document_data` / AUTO_SCAN_RESULT. */
  detail?: IdScanDetailGuru | null
  /** Raw snapshot for debugging / future use (not shown by default in UI). */
  documentData?: Record<string, unknown> | null
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
