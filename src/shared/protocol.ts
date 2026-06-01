import type {
  EzeeGuestDisplay,
  IdScanDetailGuru,
  ParsedIdFields,
  ReservationSnapshot,
  SynxisGuestDisplay,
} from './pms-types'

export type { IdScanDetailGuru }

/** Minimum time guest draft must sit before passive logout auto-save (portal bridge / session end). */
export const GUEST_DRAFT_AUTOSAVE_MIN_MS = 2 * 60 * 1000

/** Side panel → service worker: guest ID draft for logout auto-save. */
export type PendingGuestDraft = {
  canceled: boolean
  draftStartedAtMs: number
  parsed: ParsedIdFields
  phone: string | null
  email: string | null
  manualEntry: boolean
  managerOverride: boolean
  imageFrontBase64: string | null
  imageBackBase64: string | null
  ocrProvider?: string | null
  detail?: IdScanDetailGuru | null
  documentData?: Record<string, unknown> | null
  guestRemark?: string | null
  checkInRemark?: string | null
}

export const FDN_PENDING_GUEST_DRAFT_KEY = 'fdn_pending_guest_draft' as const

/** chrome.runtime / Port message contracts (see docs/MESSAGING.md) */
/** Prior scans for the current reservation confirmation (Supabase `id_scans`). */
export type IdScanHistoryRow = {
  id: string
  confirmationNumber: string
  scannedAt: string
  manualEntry: boolean
}

/** Check-in history log row (portal ID Data — by date). */
export type IdScanLogEntry = {
  id: string
  confirmationNumber: string
  scannedAt: string
  manualEntry: boolean
  ocrProvider: string | null
  terminalId: string | null
  scannedBy: string | null
  agentLabel: string
  displayName: string
  roomNumber: string | null
  reservationGuestName: string | null
  checkInDate: string | null
  checkOutDate: string | null
  imageFrontPath: string | null
  imageBackPath: string | null
  phone: string | null
  email: string | null
  firstName: string | null
  middleName: string | null
  lastName: string | null
  fullName: string | null
  dateOfBirth: string | null
  idNumber: string | null
  idType: string | null
  issueDate: string | null
  expiryDate: string | null
  streetAddress: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  address: string | null
  piiError: string | null
}

/** Prior guest profile from another stay (lookup by phone hash). */
export type GuestStayHistoryRecord = {
  id: string
  confirmationNumber: string
  scannedAt: string
  manualEntry: boolean
  phone: string | null
  email: string | null
  fullName: string | null
  firstName: string | null
  middleName: string | null
  lastName: string | null
  streetAddress: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  dateOfBirth: string | null
  idNumber: string | null
  idType: string | null
  issueDate: string | null
  expiryDate: string | null
  address: string | null
}

/** A single prior visit found by matching the scanned ID number hash across all reservations. */
export type ReturningGuestRecord = {
  id: string
  confirmationNumber: string
  scannedAt: string
  /** Decrypted from phone_encrypted — null if not saved or decryption failed. */
  phone: string | null
  /** Decrypted from email_encrypted — null if not saved or decryption failed. */
  email: string | null
}

/** Key card encoding records for the current reservation (Supabase `key_history`). */
export type KeyHistoryRow = {
  id: string
  confirmation_number: string
  room_number: string
  card_serial: number
  checkin_time: string
  checkout_time: string
  encoded_by_username: string | null
  created_at: string
}

export type ExtensionMessage =
  | { type: 'GET_STATE' }
  | { type: 'GET_ID_SCAN_HISTORY' }
  /** ID Data by date range (portal “By date” tab). */
  | { type: 'GET_ID_SCANS_BY_DATE'; fromDate: string; toDate: string }
  | { type: 'GET_KEY_HISTORY' }
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
  /** Folio / non-guest tab — clear stale eZee panel data in the service worker. */
  | { type: 'EZEE_SUPPRESS_GUEST_LOAD' }
  /** Content script on live.ipms247.com: user clicked "Print Guest Registration Card". */
  | { type: 'EZEE_PRINT_BASIC_CARD_CLICKED'; confirmation: string }
  /** Content script captured the Stimulsoft report URL — service worker opens the reg-card popup. */
  | { type: 'EZEE_OPEN_REG_CARD'; ezeeReportUrl: string; confirmation: string }
  /** Injected sign overlay on Stimulsoft popup — save PNG signature as PDF to Supabase. */
  | {
      type: 'EZEE_SAVE_SIGNATURE'
      signaturePng: string
      confirmation: string
      /** Real Stimulsoft PDF bytes (base64) if the JS API export succeeded. */
      cardPdfBase64?: string | null
      /** Stimulsoft canvas PNG (base64) if PDF export was unavailable. */
      cardImageBase64?: string | null
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
      detail?: IdScanDetailGuru | null
      documentData?: Record<string, unknown> | null
      guestRemark?: string | null
      checkInRemark?: string | null
      /** When set, updates this `id_scans` row instead of inserting a duplicate. */
      existingScanId?: string | null
    }
  | { type: 'INJECT_PMS'; fields: Record<string, string> }
  | { type: 'VERIFY_MANAGER'; email: string; password: string }
  /** Active DNR row for scanned / typed ID number (normalized + raw variants). */
  | { type: 'CHECK_DNR'; idNumber: string }
  /** Manager/admin adds guest to DNR after password verification (extension side panel). */
  | {
      type: 'ADD_DNR'
      guestName: string
      idNumber: string
      dateOfBirth: string | null
      reason: string
      managerEmail: string
      managerPassword: string
    }
  | {
      type: 'SAVE_SIGNATURE'
      /** Base64-encoded signed PDF bytes (from pdf-lib save()). */
      pdfBase64: string
      confirmationNumber: string
    }
  | {
      type: 'RFID_MAKE_KEY'
      /** Room number as displayed in PMS (e.g. "101", "600"). Python formats it to SDK 8-char. */
      roomNumber: string
      /** ISO datetime or SDK format (yyyyMMddHHmm). */
      checkinTime: string
      checkoutTime: string
      /** 1 = primary key card, 2–8 = duplicate copies. Defaults to 1. */
      cardSerial?: number
      /**
       * When set (portal admin walk-in / manual encode), `key_history` uses this confirmation
       * instead of the scraped PMS reservation. Requires signed-in extension session.
       */
      confirmationNumber?: string
      /** Reserved for future use; not persisted on `key_history` unless the table has a matching column. */
      guestName?: string | null
      /**
       * Admin-only: log `encoded_by_username` as **Admin** (PMS-style) and require `cachedRole === 'admin'`.
       */
      portalAdminEncode?: boolean
      /** Manager override PIN to bypass check-in / balance gates. */
      managerPin?: string
    }
  | { type: 'RFID_READ_CARD' }
  /**
   * Encode a cancel/disable payload onto an old card.
   * The guest taps the card on their room lock — the lock deactivates all previous keys.
   * Then a new key can be encoded normally.
   */
  /**
   * Lost key replacement: encode a new guest card [00] with serial 1 and a fresh check-in time.
   * When the guest taps the new card at the door, the lock automatically invalidates the old key.
   * No disable card needed.
   */
  | { type: 'RFID_MAKE_LOST_KEY'; roomNumber: string; checkoutTime: string }
  /** Force a real HandShake() check and return updated hardware state. */
  | { type: 'RFID_CHECK_CONNECTION' }
  /** Look up previous scans by ID number hash to detect returning guests. */
  | { type: 'GET_RETURNING_GUEST_HISTORY'; idNumber: string }
  /** Look up prior stays / ID profiles by phone number hash. */
  | { type: 'GET_GUEST_HISTORY_BY_PHONE'; phone: string }
export type ExtensionResponse =
  | {
      ok: true
      state?: ExtensionState
      idScanHistory?: IdScanHistoryRow[]
      idScanLog?: IdScanLogEntry[]
      keyHistory?: KeyHistoryRow[]
      signaturePath?: string
      returningGuestHistory?: ReturningGuestRecord[]
      guestStayHistory?: GuestStayHistoryRecord[]
      /** Present after `CHECK_DNR` or `ADD_DNR`. */
      dnrActive?: boolean
    }
  | { ok: false; error: string; keyBlock?: 'not_checked_in' | 'balance_over_threshold' }

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
  /** May be empty when {@link imagesInStorage} is true (images in chrome.storage.local). */
  images: { front_image_base64: string; back_image_base64: string }
  imageBase64Length: number
  ocrProvider: 'native_host'
  /** When true, load images via `fdn_scan_image_front` / `fdn_scan_image_back` keys. */
  imagesInStorage?: boolean
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
  /** Unix ms when each device status was last probed (side panel “last checked”). */
  hardwareCheckedAt: {
    id_scanner: number | null
    rfid_encoder: number | null
  }
  rfidError: string | null
  terminalId: string | null
  dnrHit: boolean
  /** From `app_settings` key `hotel`; 0 = no underage warning. */
  minimumCheckInAge: number
  /** Maximum allowed balance before key encoding is blocked; -1 = disabled. */
  maxAllowedBalance: number
  /** True when a manager override PIN is configured in hotel settings. */
  hasManagerPin: boolean
  lastError: string | null
}

/** Service worker → side panel: two-pass DL scan, front image received (back not yet scanned). */
export type ScanFrontBroadcast = {
  type: 'FDN_SCAN_FRONT_RESULT'
  /** Empty when {@link imagesInStorage} is true. */
  imageFrontBase64: string
  imagesInStorage?: boolean
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
