import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FDN_PENDING_GUEST_DRAFT_KEY,
  GUEST_DRAFT_AUTOSAVE_MIN_MS,
  type ExtensionResponse,
  type ExtensionState,
  type GuestStayHistoryRecord,
  type IdScanLogEntry,
  type IdScanHistoryRow,
  type KeyHistoryRow,
  type NativeHostRxDebugBroadcast,
  type NativeIdScanBroadcast,
  type PendingGuestDraft,
  type ScanFrontBroadcast,
} from './shared/protocol'
import type { IdScanDetailGuru, ParsedIdFields } from './shared/pms-types'
import { base64ToBlobUrl, normalizeScanBase64, revokeBlobUrl } from './lib/imageDataUrl'
import { transformBase64ImageSync } from './lib/imageTransform'
import { fetchStorageImageAsBase64 } from './lib/id-scan-storage'
import {
  clearScanImagesFromStorage,
  FDN_SCAN_IMAGE_BACK_KEY,
  FDN_SCAN_IMAGE_FRONT_KEY,
  FDN_SCAN_PHASE_KEY,
  isCompleteTwoSidedScan,
  readScanImagesFromStorage,
  readScanPhase,
  resolveScanImages,
} from './lib/scan-image-storage'
import './sidepanel.css'
import { IdScanAlerts } from './components/IdScanAlerts'
import { ageLabelFromDobString, mergeParsedWithGuru } from './lib/id-guru-fields'
import { ageYearsFromDobString, isGuestUnderMinimumAge } from './lib/id-age'
import { ID_DOCUMENT_TYPES, normalizeIdDocumentType } from './lib/id-document-types'
import { normalizeUsStateCode, US_STATE_SELECT_OPTIONS } from './lib/us-states'
import { isCompleteUsZip, lookupUsZipCityState, normalizeUsZipInput } from './lib/zip-lookup'
import {
  guestProfileToFormState,
  idScanLogEntryToFormState,
} from './lib/apply-guest-profile'
import {
  mergeHistoryRecordWithLatestContact,
  priorGuestStaysForConfirmation,
} from './lib/guest-stay-history'
import { ReturningGuestPanel } from './components/ReturningGuestPanel'
import {
  formatUsPhoneDisplay,
  isCompletePhoneForLookup,
  validatePhoneNumber,
} from './lib/phone-lookup'
import { formatHotelDateTime } from './lib/hotel-dates'
import { GuestStaySummary } from './components/GuestStaySummary'
import { CheckInHistoryPanel } from './components/CheckInHistoryPanel'
import { LoadingScreen } from './components/LoadingScreen'
import { PanelHeader } from './components/PanelHeader'
import {
  IconArrowLeft,
  IconBan,
  IconHistory,
  IconId,
  IconKey,
  IconPayment,
  IconRefresh,
  IconSignature,
} from './components/WorkspaceIcons'

/** After this idle period, prompt then auto Save & Clear (same as manual Save & Clear). */
const GUEST_IDLE_SAVE_CLEAR_MS = 5 * 60 * 1000
const GUEST_IDLE_SAVE_CLEAR_COUNTDOWN_S = 30

function formatCheckedAgo(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return 'not checked'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function formatRoleLabel(role: string | null | undefined): string {
  if (!role?.trim()) return 'Staff'
  const r = role.trim()
  return r.charAt(0).toUpperCase() + r.slice(1).toLowerCase()
}

function ocrProviderShortLabel(provider: string): string {
  if (provider === 'native_host') return 'scan'
  return provider.length > 8 ? `${provider.slice(0, 7)}…` : provider
}

function guestNameFromIdForm(
  idDetail: IdScanDetailGuru,
  parsed: ParsedIdFields,
): string {
  const parts = [idDetail.firstName, idDetail.middleName, idDetail.lastName]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(' ')
    .trim()
  if (parts) return parts
  return parsed.fullName?.trim() ?? ''
}

function accountDisplayName(email: string | null | undefined): string {
  if (!email?.trim()) return 'Signed in'
  const local = email.split('@')[0]?.trim()
  if (!local) return email
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ')
}

function showChromeNotification(title: string, message: string) {
  void chrome.notifications.create({
    type: 'basic',
    title,
    message,
    iconUrl: chrome.runtime.getURL('icon.png'),
  })
}

function RequiredMark() {
  return (
    <span className="fdn-required" title="Required">
      *
    </span>
  )
}

/** Label line with optional asterisk inline (matches Phone & country style). */
function LabelText({
  children,
  required,
  className,
}: {
  children: React.ReactNode
  required?: boolean
  className?: string
}) {
  const cls = ['fdn-label__text', className].filter(Boolean).join(' ')
  return (
    <span className={cls}>
      {children}
      {required ? <RequiredMark /> : null}
    </span>
  )
}

function validateRequiredGuestFields(
  idDetail: IdScanDetailGuru,
  phone: string,
): string | null {
  if (!idDetail.firstName?.trim()) return 'First name is required.'
  if (!idDetail.lastName?.trim()) return 'Last name is required.'
  return validatePhoneNumber(phone, { usaCa: idDetail.usaCaPhone !== false })
}

function hasUnsavedGuestDraft(
  idDetail: IdScanDetailGuru,
  phone: string,
  emailGuest: string,
  parsed: ParsedIdFields,
  scanImages: { front: string; back: string | null } | null,
  guestRemark: string,
  checkInRemark: string,
): boolean {
  if (scanImages?.front) return true
  if (idDetail.firstName?.trim() || idDetail.lastName?.trim()) return true
  if (phone.trim() || emailGuest.trim()) return true
  if (parsed.idNumber?.trim()) return true
  if (guestRemark.trim() || checkInRemark.trim()) return true
  return false
}

const emptyParsed: ParsedIdFields = {
  fullName: null,
  dateOfBirth: null,
  idNumber: null,
  idType: null,
  issueDate: null,
  expiryDate: null,
  address: null,
}

function formatLocalFromIso(iso: string | null | undefined): string {
  if (!iso?.trim()) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Same cap as portal `AdminPortalEncodeModal` (1–8 keys per stay). */
const MAX_ROOM_KEYS = 8

function nextKeySerialFromHistory(
  history: KeyHistoryRow[],
  confirmation: string | null | undefined,
): number {
  const conf = confirmation?.trim()
  if (!conf) return 1
  let max = 0
  for (const row of history) {
    if (row.confirmation_number?.trim() !== conf) continue
    const s = typeof row.card_serial === 'number' ? row.card_serial : 0
    if (s > max) max = s
  }
  return Math.min(MAX_ROOM_KEYS, Math.max(1, max + 1))
}

const emptyIdDetail: IdScanDetailGuru = {
  firstName: null,
  middleName: null,
  lastName: null,
  streetAddress: null,
  city: null,
  state: null,
  postalCode: null,
  phone: null,
  email: null,
  phoneCountryCode: null,
  usaCaPhone: null,
}

function App() {
  const [state, setState] = useState<ExtensionState | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [parsed, setParsed] = useState<ParsedIdFields>(emptyParsed)
  const [phone, setPhone] = useState('')
  const [emailGuest, setEmailGuest] = useState('')
  const [manualEntry, setManualEntry] = useState(false)
  const [managerOverride, setManagerOverride] = useState(false)
  const [managerEmail, setManagerEmail] = useState('')
  const [managerPassword, setManagerPassword] = useState('')
  const [showManagerModal, setShowManagerModal] = useState(false)
  const [showAddDnrModal, setShowAddDnrModal] = useState(false)
  const [dnrActive, setDnrActive] = useState(false)
  const [dnrCheckBusy, setDnrCheckBusy] = useState(false)
  const [dnrReason, setDnrReason] = useState('')
  const [dnrManagerEmail, setDnrManagerEmail] = useState('')
  const [dnrManagerPassword, setDnrManagerPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [scanImages, setScanImages] = useState<{
    front: string
    back: string | null
  } | null>(null)
  const [lastOcrProvider, setLastOcrProvider] = useState<string | null>(null)
  const [idDetail, setIdDetail] = useState<IdScanDetailGuru>(emptyIdDetail)
  const [guestRemark, setGuestRemark] = useState('')
  const [checkInRemark, setCheckInRemark] = useState('')
  const [rotationDeg, setRotationDeg] = useState(0)
  const [flipH, setFlipH] = useState(false)
  const [idScanHistory, setIdScanHistory] = useState<IdScanHistoryRow[]>([])
  const [lastScanReceivedAt, setLastScanReceivedAt] = useState<string | null>(null)
  const [keyHistory, setKeyHistory] = useState<KeyHistoryRow[]>([])
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyNotice, setKeyNotice] = useState<string | null>(null)
  const [keyCardSerial, setKeyCardSerial] = useState<number>(1)
  const [readCardBusy, setReadCardBusy] = useState(false)
  const [cancelCardBusy, setCancelCardBusy] = useState(false)
  const [rfidCheckBusy, setRfidCheckBusy] = useState(false)
  const [pmsRefreshBusy, setPmsRefreshBusy] = useState(false)
  const [historyEditBusy, setHistoryEditBusy] = useState(false)
  const [, setRfidTick] = useState(0)
  const [readCardResult, setReadCardResult] = useState<{
    ok: boolean
    cardData?: string
    roomNumber?: string | null
    cardSerial?: number | null
    checkinTime?: string | null
    checkoutTime?: string | null
    error?: string
  } | null>(null)
  /** From native host `document_data` — passed through on Save (not SynXis/eZee). */
  const [lastDocumentData, setLastDocumentData] = useState<Record<string, unknown> | null>(null)
  const [zipLookupBusy, setZipLookupBusy] = useState(false)
  const [zipLookupNote, setZipLookupNote] = useState<string | null>(null)
  const zipLookupAbortRef = useRef<AbortController | null>(null)
  const lastZipLookupRef = useRef<string | null>(null)
  const [guestHistoryBusy, setGuestHistoryBusy] = useState(false)
  const [guestHistoryNote, setGuestHistoryNote] = useState<string | null>(null)
  const [returningGuestRows, setReturningGuestRows] = useState<GuestStayHistoryRecord[]>([])
  const [returningGuestBusy, setReturningGuestBusy] = useState(false)
  const [returningGuestExpanded, setReturningGuestExpanded] = useState(false)
  const priorReturningGuestStays = useMemo(
    () => priorGuestStaysForConfirmation(returningGuestRows, state?.reservation?.confirmationNumber),
    [returningGuestRows, state?.reservation?.confirmationNumber],
  )
  const phoneHistoryTimerRef = useRef(0)
  const lastPhoneLookupRef = useRef<string | null>(null)
  const guestFormEmptyRef = useRef(true)
  const guestDraftCanceledRef = useRef(false)
  const guestDraftStartedAtRef = useRef<number | null>(null)
  const contactFieldsRef = useRef({ phone: '', email: '' })
  const [phoneTouched, setPhoneTouched] = useState(false)
  const lastLoadedConfRef = useRef<string | null>(null)
  const lastScanReceivedAtRef = useRef<string | null>(null)
  const scanImagesRef = useRef<{ front: string; back: string | null } | null>(null)
  const lastAppliedNativeScanAtRef = useRef<string | null>(null)
  /** ISO time when the current front-only pass started — blocks stale complete-scan replay. */
  const frontScanStartedAtRef = useRef<string | null>(null)
  /** `front` = first side captured; `complete` = both sides + OCR applied. */
  const idScanPassRef = useRef<'idle' | 'front' | 'complete'>('idle')
  const scanPreviewBlobUrlsRef = useRef<{ front: string | null; back: string | null }>({
    front: null,
    back: null,
  })
  const idPanelRef = useRef<HTMLElement>(null)
  /** Ref to the latest `persistGuestIdScan` — allows `applyScanFrontPreview` to save without
   *  a forward reference, since `persistGuestIdScan` is defined later in the component. */
  const persistGuestIdScanRef = useRef<
    (opts: { clearAfter: boolean; silent: boolean; notification?: string | null }) => Promise<{ ok: boolean; error?: string }>
  >(() => Promise.resolve({ ok: false }))
  const canIdleSaveClearRef = useRef<() => boolean>(() => false)
  /** Seconds remaining in the idle auto-save countdown; null = not active. */
  const [autoSaveCountdown, setAutoSaveCountdown] = useState<number | null>(null)
  /** Timestamp of the last user interaction with the ID form, for idle detection. */
  const lastFormInteractionRef = useRef<number>(Date.now())
  type WorkspaceTab = 'id' | 'history' | 'payment' | 'signature' | 'key'
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('id')

  const refreshIdScanHistory = useCallback(async () => {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_ID_SCAN_HISTORY' })) as {
      ok?: boolean
      idScanHistory?: IdScanHistoryRow[]
    }
    if (res.ok && res.idScanHistory) setIdScanHistory(res.idScanHistory)
  }, [])

  const refreshKeyHistory = useCallback(async () => {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_KEY_HISTORY' })) as {
      ok?: boolean
      keyHistory?: KeyHistoryRow[]
    }
    if (res.ok && res.keyHistory) setKeyHistory(res.keyHistory)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'GET_STATE',
      })) as { ok?: boolean; state?: ExtensionState }
      if (res?.state) setState(res.state)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 2000)
    return () => clearInterval(t)
  }, [refresh])

  useEffect(() => () => zipLookupAbortRef.current?.abort(), [])

  useEffect(() => () => window.clearTimeout(phoneHistoryTimerRef.current), [])

  useEffect(() => {
    guestFormEmptyRef.current =
      !idDetail.firstName?.trim() && !idDetail.lastName?.trim()
  }, [idDetail.firstName, idDetail.lastName])

  useEffect(() => {
    contactFieldsRef.current = { phone, email: emailGuest }
  }, [phone, emailGuest])

  const phoneValidationError = useMemo(
    () =>
      phoneTouched || formError
        ? validatePhoneNumber(phone, { usaCa: idDetail.usaCaPhone !== false })
        : null,
    [phone, phoneTouched, formError, idDetail.usaCaPhone],
  )

  useEffect(() => {
    void refreshIdScanHistory()
  }, [refreshIdScanHistory, state?.reservation?.confirmationNumber])

  useEffect(() => {
    void refreshKeyHistory()
  }, [refreshKeyHistory, state?.reservation?.confirmationNumber])

  // Keep "Key #N" in sync with key_history for this confirmation (portal-style serial).
  useEffect(() => {
    setKeyCardSerial(nextKeySerialFromHistory(keyHistory, state?.reservation?.confirmationNumber))
  }, [state?.reservation?.confirmationNumber, keyHistory])

  // New PMS guest load: show full stay on Key tab and drop stale read-card UI from a prior room.
  useEffect(() => {
    const conf = state?.reservation?.confirmationNumber?.trim() ?? null
    if (!conf || conf === lastLoadedConfRef.current) return
    lastLoadedConfRef.current = conf
    setReadCardResult(null)
    if (state?.reservation?.roomNumber) setActiveTab('key')
  }, [state?.reservation?.confirmationNumber, state?.reservation?.roomNumber])

  useEffect(() => {
    if (activeTab !== 'id') return
    idPanelRef.current?.scrollTo({ top: 0 })
  }, [activeTab, scanImages, lastScanReceivedAt])

  const clearIdScan = useCallback(() => {
    setParsed(emptyParsed)
    setIdDetail(emptyIdDetail)
    setPhone('')
    setEmailGuest('')
    setScanImages(null)
    setLastOcrProvider(null)
    setLastDocumentData(null)
    setLastScanReceivedAt(null)
    lastScanReceivedAtRef.current = null
    scanImagesRef.current = null
    lastAppliedNativeScanAtRef.current = null
    frontScanStartedAtRef.current = null
    idScanPassRef.current = 'idle'
    setRotationDeg(0)
    setFlipH(false)
    setGuestRemark('')
    setCheckInRemark('')
    setFormError(null)
    setPhoneTouched(false)
    setManualEntry(false)
    zipLookupAbortRef.current?.abort()
    lastZipLookupRef.current = null
    setZipLookupBusy(false)
    setZipLookupNote(null)
    setGuestHistoryBusy(false)
    setGuestHistoryNote(null)
    setReturningGuestRows([])
    setReturningGuestBusy(false)
    setReturningGuestExpanded(false)
    setDnrActive(false)
    setDnrCheckBusy(false)
    setShowAddDnrModal(false)
    setDnrReason('')
    lastPhoneLookupRef.current = null
    window.clearTimeout(phoneHistoryTimerRef.current)
    guestDraftStartedAtRef.current = null
    void chrome.storage.local.remove([
      'fdn_last_native_scan',
      'lastScanResult',
      FDN_PENDING_GUEST_DRAFT_KEY,
    ])
    void clearScanImagesFromStorage()
  }, [])

  const prevSignedInRef = useRef<boolean | null>(null)
  const dnrCheckTimerRef = useRef(0)

  const refreshDnrStatus = useCallback(async (idNumber: string | null | undefined) => {
    const id = idNumber?.trim()
    if (!id) {
      setDnrActive(false)
      return false
    }
    setDnrCheckBusy(true)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'CHECK_DNR',
        idNumber: id,
      })) as ExtensionResponse
      if (res.ok) {
        const active = !!res.dnrActive
        setDnrActive(active)
        return active
      }
    } catch {
      /* ignore */
    } finally {
      setDnrCheckBusy(false)
    }
    return false
  }, [])

  const minimumCheckInAge = state?.minimumCheckInAge ?? 18
  const guestAgeYears = useMemo(
    () => ageYearsFromDobString(parsed.dateOfBirth),
    [parsed.dateOfBirth],
  )
  const guestUnderage = useMemo(
    () => isGuestUnderMinimumAge(parsed.dateOfBirth, minimumCheckInAge),
    [parsed.dateOfBirth, minimumCheckInAge],
  )

  const notifyIdScanAlerts = useCallback(
    (opts: { dnr: boolean; underage: boolean; ageYears: number | null }) => {
      const parts: string[] = []
      if (opts.dnr) parts.push('Guest is blacklisted (Do Not Rent)')
      if (opts.underage && minimumCheckInAge > 0) {
        parts.push(
          opts.ageYears !== null
            ? `Underage: ${opts.ageYears} yrs (minimum ${minimumCheckInAge})`
            : `May be under minimum age (${minimumCheckInAge})`,
        )
      }
      if (parts.length === 0) return
      showChromeNotification('FrontDesk Nexus — ID scan alert', parts.join('. '))
    },
    [minimumCheckInAge],
  )

  const runIdScanAlertChecks = useCallback(
    async (idNumber: string | null | undefined, dob: string | null | undefined) => {
      const underage = isGuestUnderMinimumAge(dob, minimumCheckInAge)
      const ageYears = ageYearsFromDobString(dob)
      let dnr = false
      if (idNumber?.trim() && state?.auth.signedIn) {
        dnr = await refreshDnrStatus(idNumber)
      } else {
        setDnrActive(false)
      }
      notifyIdScanAlerts({ dnr, underage, ageYears })
    },
    [minimumCheckInAge, state?.auth.signedIn, refreshDnrStatus, notifyIdScanAlerts],
  )

  useEffect(() => {
    if (!state?.auth.signedIn) {
      setDnrActive(false)
      return
    }
    const id = parsed.idNumber?.trim()
    if (!id) {
      setDnrActive(false)
      return
    }
    window.clearTimeout(dnrCheckTimerRef.current)
    dnrCheckTimerRef.current = window.setTimeout(() => {
      void refreshDnrStatus(id)
    }, 400)
    return () => window.clearTimeout(dnrCheckTimerRef.current)
  }, [parsed.idNumber, state?.auth.signedIn, refreshDnrStatus])

  const hasIdScanContext =
    !!parsed.idNumber?.trim() || !!parsed.dateOfBirth?.trim() || !!lastScanReceivedAt

  const applyGuestProfile = useCallback((record: GuestStayHistoryRecord) => {
    const next = guestProfileToFormState(record)
    setIdDetail((d) => ({
      ...next.idDetail,
      postalCode: normalizeUsZipInput(next.idDetail.postalCode) || null,
      phoneCountryCode: d.phoneCountryCode,
      usaCaPhone: d.usaCaPhone ?? next.idDetail.usaCaPhone,
    }))
    setParsed(next.parsed)
    setPhone(next.phone)
    setEmailGuest(next.emailGuest)
    setPhoneTouched(false)
    lastZipLookupRef.current = normalizeUsZipInput(next.idDetail.postalCode)
    setGuestHistoryNote(
      'Prior guest details loaded. Edit as needed — prior check-ins are not changed until Save & Clear.',
    )
  }, [])

  const applyContactFromRecord = useCallback(
    (
      record: GuestStayHistoryRecord,
      opts: { currentPhone: string; currentEmail: string },
    ) => {
      let filled = false
      if (!opts.currentPhone.trim() && record.phone?.trim()) {
        const p = record.phone.trim()
        setPhone(p)
        setIdDetail((d) => ({ ...d, phone: p }))
        lastPhoneLookupRef.current = null
        filled = true
      }
      if (!opts.currentEmail.trim() && record.email?.trim()) {
        const e = record.email.trim()
        setEmailGuest(e)
        setIdDetail((d) => ({ ...d, email: e }))
        filled = true
      }
      if (filled) {
        setGuestHistoryNote('Prior guest phone/email loaded from ID Data.')
      }
      return filled
    },
    [],
  )

  const loadReturningGuestById = useCallback(
    async (
      idNumber: string | null | undefined,
      scanContact?: { phone?: string; email?: string },
      opts?: { fromLiveScan?: boolean },
    ) => {
      const raw = idNumber?.trim()
      if (!raw) {
        setReturningGuestRows([])
        setReturningGuestExpanded(false)
        return
      }

      setReturningGuestBusy(true)
      setReturningGuestExpanded(false)
      try {
        const res = (await chrome.runtime.sendMessage({
          type: 'GET_RETURNING_GUEST_HISTORY',
          idNumber: raw,
        })) as {
          ok?: boolean
          guestStayHistory?: GuestStayHistoryRecord[]
        }
        const rows = res.ok ? (res.guestStayHistory ?? []) : []
        setReturningGuestRows(rows)

        if (rows.length === 0) return

        const record = mergeHistoryRecordWithLatestContact(rows)
        if (!record) return

        const currentPhone = scanContact?.phone?.trim() || contactFieldsRef.current.phone
        const currentEmail = scanContact?.email?.trim() || contactFieldsRef.current.email

        if (opts?.fromLiveScan) {
          applyContactFromRecord(record, { currentPhone, currentEmail })
          return
        }

        if (guestFormEmptyRef.current) {
          applyGuestProfile(record)
          return
        }

        applyContactFromRecord(record, { currentPhone, currentEmail })
      } catch {
        setReturningGuestRows([])
        setGuestHistoryNote('Could not load prior guest contact from ID number.')
      } finally {
        setReturningGuestBusy(false)
      }
    },
    [applyContactFromRecord, applyGuestProfile],
  )

  const loadHistoryEntryIntoScanner = useCallback(
    async (entry: IdScanLogEntry) => {
      const hasDraft = hasUnsavedGuestDraft(
        idDetail,
        phone,
        emailGuest,
        parsed,
        scanImages,
        guestRemark,
        checkInRemark,
      )
      if (hasDraft) {
        const ok = window.confirm(
          'Replace the current guest on the ID form with this history record?',
        )
        if (!ok) return
      }

      setHistoryEditBusy(true)
      setFormError(null)
      try {
        const next = idScanLogEntryToFormState(entry)
        const receivedAt = entry.scannedAt?.trim() || new Date().toISOString()

        guestDraftCanceledRef.current = false
        guestDraftStartedAtRef.current = Date.now()
        setAutoSaveCountdown(null)
        lastFormInteractionRef.current = Date.now()

        setManualEntry(entry.manualEntry)
        setParsed(next.parsed)
        setIdDetail({
          ...next.idDetail,
          postalCode: normalizeUsZipInput(next.idDetail.postalCode) || null,
        })
        setPhone(next.phone)
        setEmailGuest(next.emailGuest)
        setPhoneTouched(false)
        setLastOcrProvider(entry.ocrProvider)
        setLastDocumentData(null)
        setGuestHistoryNote(null)
        setReturningGuestRows([])
        setReturningGuestExpanded(false)
        setRotationDeg(0)
        setFlipH(false)
        lastZipLookupRef.current = normalizeUsZipInput(next.idDetail.postalCode) || null
        setZipLookupNote(null)
        lastAppliedNativeScanAtRef.current = receivedAt
        frontScanStartedAtRef.current = null

        const [frontB64, backB64] = await Promise.all([
          entry.imageFrontPath
            ? fetchStorageImageAsBase64(entry.imageFrontPath).catch(() => null)
            : Promise.resolve(null),
          entry.imageBackPath
            ? fetchStorageImageAsBase64(entry.imageBackPath).catch(() => null)
            : Promise.resolve(null),
        ])

        if (frontB64) {
          const images = { front: frontB64, back: backB64 }
          scanImagesRef.current = images
          idScanPassRef.current = backB64 ? 'complete' : 'front'
          setScanImages(images)
        } else {
          scanImagesRef.current = null
          idScanPassRef.current = 'complete'
          setScanImages(null)
        }

        setLastScanReceivedAt(receivedAt)
        lastScanReceivedAtRef.current = receivedAt

        void clearScanImagesFromStorage()
        void chrome.storage.local.remove([
          'fdn_last_native_scan',
          'lastScanResult',
          FDN_PENDING_GUEST_DRAFT_KEY,
        ])

        setActiveTab('id')

        if (entry.idNumber?.trim()) {
          void loadReturningGuestById(
            entry.idNumber,
            { phone: next.phone, email: next.emailGuest },
            { fromLiveScan: true },
          )
        } else {
          setReturningGuestRows([])
          setReturningGuestExpanded(false)
        }

        void runIdScanAlertChecks(entry.idNumber, entry.dateOfBirth)

        const label = entry.displayName?.trim() || 'Guest'
        showChromeNotification(
          'FrontDesk Nexus',
          `${label} loaded from history — edit, use To PMS, then Save or Save & Clear.`,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not load history into scanner'
        setFormError(msg)
        setActiveTab('id')
      } finally {
        setHistoryEditBusy(false)
      }
    },
    [
      idDetail,
      phone,
      emailGuest,
      parsed,
      scanImages,
      guestRemark,
      checkInRemark,
      loadReturningGuestById,
      runIdScanAlertChecks,
    ],
  )

  const runPhoneHistoryLookup = useCallback(
    async (phoneInput: string) => {
      if (!isCompletePhoneForLookup(phoneInput)) {
        setGuestHistoryNote(null)
        return
      }
      const key = phoneInput.replace(/\D/g, '').slice(-10)
      if (lastPhoneLookupRef.current === key) return
      lastPhoneLookupRef.current = key
      setGuestHistoryBusy(true)
      setGuestHistoryNote(null)
      try {
        const res = (await chrome.runtime.sendMessage({
          type: 'GET_GUEST_HISTORY_BY_PHONE',
          phone: phoneInput.trim(),
        })) as { ok?: boolean; guestStayHistory?: GuestStayHistoryRecord[] }
        const rows = res.ok ? (res.guestStayHistory ?? []) : []
        if (rows.length === 0) {
          setGuestHistoryNote(null)
          return
        }
        const record = mergeHistoryRecordWithLatestContact(rows)
        if (!record) return
        if (guestFormEmptyRef.current) {
          applyGuestProfile(record)
          return
        }
        const filled = applyContactFromRecord(record, {
          currentPhone: contactFieldsRef.current.phone,
          currentEmail: contactFieldsRef.current.email,
        })
        if (!filled) setGuestHistoryNote(null)
      } catch {
        setGuestHistoryNote('Could not load prior guest details.')
      } finally {
        setGuestHistoryBusy(false)
      }
    },
    [applyContactFromRecord, applyGuestProfile],
  )

  const schedulePhoneHistoryLookup = useCallback(
    (phoneInput: string) => {
      window.clearTimeout(phoneHistoryTimerRef.current)
      lastPhoneLookupRef.current = null
      if (!isCompletePhoneForLookup(phoneInput)) {
        setGuestHistoryNote(null)
        return
      }
      if (!state?.auth.signedIn) {
        setGuestHistoryNote('Sign in to look up prior guest by phone.')
        return
      }
      phoneHistoryTimerRef.current = window.setTimeout(() => {
        void runPhoneHistoryLookup(phoneInput)
      }, 450)
    },
    [runPhoneHistoryLookup, state?.auth.signedIn],
  )

  /** ZIP lookup fills city/state only — never ZIP (state/city edits must not be reversed). */
  const cancelZipLookup = useCallback(() => {
    zipLookupAbortRef.current?.abort()
    zipLookupAbortRef.current = null
    setZipLookupBusy(false)
  }, [])

  const runZipLookup = useCallback(async (zipInput: string) => {
    const zip = normalizeUsZipInput(zipInput)
    if (!isCompleteUsZip(zip)) {
      setZipLookupNote(null)
      return
    }
    if (lastZipLookupRef.current === zip) return

    cancelZipLookup()
    const controller = new AbortController()
    zipLookupAbortRef.current = controller
    setZipLookupBusy(true)
    setZipLookupNote(null)

    try {
      const result = await lookupUsZipCityState(zip, controller.signal)
      if (controller.signal.aborted) return
      if (!result) {
        lastZipLookupRef.current = null
        setZipLookupNote('No city/state found for this ZIP.')
        return
      }
      lastZipLookupRef.current = zip
      setIdDetail((d) => ({
        ...d,
        city: result.city,
        state: result.stateCode,
      }))
      setZipLookupNote(null)
    } catch (err) {
      if (controller.signal.aborted) return
      lastZipLookupRef.current = null
      setZipLookupNote('ZIP lookup failed — check connection.')
      console.warn('[FrontDesk Nexus] ZIP lookup', err)
    } finally {
      if (!controller.signal.aborted) setZipLookupBusy(false)
    }
  }, [cancelZipLookup])

  const applyScanFrontPreview = useCallback(async (frontB64: string) => {
    const b64 = normalizeScanBase64(frontB64)
    if (!b64) return

    const prev = scanImagesRef.current
    if (
      idScanPassRef.current === 'front' &&
      prev?.front === b64 &&
      !prev?.back?.trim()
    ) {
      return
    }

    if (
      idScanPassRef.current === 'complete' &&
      lastScanReceivedAtRef.current &&
      prev?.back?.trim() &&
      prev.front === b64
    ) {
      return
    }

    // A new scan is replacing a previous complete scan — save the old data first.
    if (idScanPassRef.current === 'complete' && scanImagesRef.current?.front) {
      await persistGuestIdScanRef.current({ clearAfter: false, silent: true, notification: null })
    }

    const startedAt = new Date().toISOString()
    frontScanStartedAtRef.current = startedAt
    lastAppliedNativeScanAtRef.current = null
    lastScanReceivedAtRef.current = null
    idScanPassRef.current = 'front'
    scanImagesRef.current = { front: b64, back: null }
    lastFormInteractionRef.current = Date.now()
    setAutoSaveCountdown(null)
    setActiveTab('id')
    setScanImages({ front: b64, back: null })
    setRotationDeg(0)
    setFlipH(false)
    setParsed(emptyParsed)
    setIdDetail(emptyIdDetail)
    setPhone('')
    setEmailGuest('')
    setLastOcrProvider(null)
    setLastScanReceivedAt(null)
    setLastDocumentData(null)
    setFormError(null)
    setGuestHistoryNote(null)
    setReturningGuestRows([])
    setReturningGuestExpanded(false)
  }, [])

  const applyNativeIdScan = useCallback(
    async (m: NativeIdScanBroadcast) => {
      const receivedAt = m.receivedAt ?? new Date().toISOString()
      if (lastAppliedNativeScanAtRef.current === receivedAt) return

      if (
        frontScanStartedAtRef.current &&
        receivedAt < frontScanStartedAtRef.current
      ) {
        return
      }

      const resolvedImages = await resolveScanImages(m.images)
      const front = resolvedImages?.front ?? normalizeScanBase64(m.images.front_image_base64)
      const back =
        resolvedImages?.back ??
        (normalizeScanBase64(m.images.back_image_base64) || null)

      if (!isCompleteTwoSidedScan(front, back)) {
        if (front) await applyScanFrontPreview(front)
        return
      }

      // A new complete scan is replacing a previous complete scan — save the old data first.
      if (idScanPassRef.current === 'complete' && scanImagesRef.current?.front) {
        await persistGuestIdScanRef.current({ clearAfter: false, silent: true, notification: null })
      }

      const phase = await readScanPhase()
      if (phase === 'front' && idScanPassRef.current === 'front') {
        frontScanStartedAtRef.current = null
      }

      lastAppliedNativeScanAtRef.current = receivedAt
      idScanPassRef.current = 'complete'
      frontScanStartedAtRef.current = null

      const nextImages = { front, back: back! }
      lastScanReceivedAtRef.current = receivedAt
      scanImagesRef.current = nextImages
      lastFormInteractionRef.current = Date.now()
      setAutoSaveCountdown(null)
      setActiveTab('id')
      setScanImages(nextImages)
      setRotationDeg(0)
      setFlipH(false)

      guestDraftCanceledRef.current = false
      const detail = m.detail ?? emptyIdDetail

      try {
        setParsed({
          ...m.parsed,
          idType: normalizeIdDocumentType(m.parsed.idType),
        })
        setLastOcrProvider(m.ocrProvider)
        setIdDetail({
          ...detail,
          state: normalizeUsStateCode(detail.state) ?? detail.state,
          postalCode: normalizeUsZipInput(detail.postalCode) || null,
        })
        lastZipLookupRef.current = normalizeUsZipInput(detail.postalCode) || null
        setZipLookupNote(null)
        setLastDocumentData(m.documentData ?? null)
        setLastScanReceivedAt(receivedAt)
        if (m.detail?.phone?.trim()) {
          const p = m.detail.phone.trim()
          setPhone(p)
          lastPhoneLookupRef.current = null
        }
        if (m.detail?.email?.trim()) setEmailGuest(m.detail.email.trim())

        if (m.parsed.idNumber?.trim()) {
          void loadReturningGuestById(
            m.parsed.idNumber,
            {
              phone: m.detail?.phone?.trim(),
              email: m.detail?.email?.trim(),
            },
            { fromLiveScan: true },
          )
        }

        void runIdScanAlertChecks(m.parsed.idNumber, m.parsed.dateOfBirth)
        if (!isGuestUnderMinimumAge(m.parsed.dateOfBirth, minimumCheckInAge)) {
          showChromeNotification(
            'FrontDesk Nexus',
            'ID scan received — use To PMS, then Save & Clear when check-in is done.',
          )
        }
      } catch (err) {
        console.warn(
          '[FrontDesk Nexus] ID auto-fill failed — images kept for manual entry',
          err,
        )
        setLastScanReceivedAt(receivedAt)
        setLastOcrProvider(m.ocrProvider)
        setLastDocumentData(m.documentData ?? null)
      }

      void refresh()
      void refreshIdScanHistory()
    },
    [
      refresh,
      refreshIdScanHistory,
      loadReturningGuestById,
      runIdScanAlertChecks,
      minimumCheckInAge,
      applyScanFrontPreview,
    ],
  )

  const applyNativeIdScanRef = useRef(applyNativeIdScan)
  useEffect(() => {
    applyNativeIdScanRef.current = applyNativeIdScan
  }, [applyNativeIdScan])

  const applyScanFrontPreviewRef = useRef(applyScanFrontPreview)
  useEffect(() => {
    applyScanFrontPreviewRef.current = applyScanFrontPreview
  }, [applyScanFrontPreview])

  const applyScanFrontResult = useCallback(
    async (d: ScanFrontBroadcast) => {
      let b64 = normalizeScanBase64(d.imageFrontBase64)
      if (!b64 && d.imagesInStorage) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const stored = await readScanImagesFromStorage()
          b64 = stored?.front ?? ''
          if (b64) break
          await new Promise((r) => window.setTimeout(r, 40 * (attempt + 1)))
        }
      }
      if (!b64) {
        console.warn('[FrontDesk Nexus] front scan — no image in message or storage')
        return
      }
      await applyScanFrontPreview(b64)
    },
    [applyScanFrontPreview],
  )

  useEffect(() => {
    const onRuntimeMessage = (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return
      const m = msg as { type?: string }
      if (m.type === 'FDN_NATIVE_HOST_RX') {
        const d = msg as NativeHostRxDebugBroadcast
        console.log(
          '%c[FrontDesk Nexus] Native host inbound',
          'color:#58a6ff;font-weight:600',
          d.receivedAt,
          d.source,
        )
        console.log('[FrontDesk Nexus] NativeHostRxDebugBroadcast (no image base64):', d)
        return
      }
      if (m.type === 'FDN_PANEL_TOAST') {
        void refresh()
        return
      }
      if (m.type === 'FDN_SCAN_FRONT_RESULT') {
        void applyScanFrontResult(msg as ScanFrontBroadcast)
        return
      }
      if (m.type === 'FDN_NATIVE_ID_SCAN') {
        void applyNativeIdScanRef.current(msg as NativeIdScanBroadcast)
      }
    }
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local') return

      const imageChanged =
        changes[FDN_SCAN_IMAGE_FRONT_KEY]?.newValue !== undefined ||
        changes[FDN_SCAN_IMAGE_BACK_KEY]?.newValue !== undefined
      const phaseChanged = changes[FDN_SCAN_PHASE_KEY]?.newValue === 'front'

      if (imageChanged || phaseChanged) {
        void readScanImagesFromStorage().then(async (stored) => {
          if (!stored?.front) return
          if (idScanPassRef.current === 'complete' && lastScanReceivedAtRef.current) return

          const front = stored.front
          const back = stored.back

          if (!isCompleteTwoSidedScan(front, back)) {
            await applyScanFrontPreviewRef.current(front)
            return
          }

          if (changes.fdn_last_native_scan?.newValue) {
            const last = changes.fdn_last_native_scan.newValue as NativeIdScanBroadcast
            if (last?.type === 'FDN_NATIVE_ID_SCAN') {
              void applyNativeIdScanRef.current(last)
            }
          }
        })
        return
      }

      if (changes.fdn_last_native_scan?.newValue) {
        const last = changes.fdn_last_native_scan.newValue as NativeIdScanBroadcast
        if (last?.type === 'FDN_NATIVE_ID_SCAN') void applyNativeIdScanRef.current(last)
      }
    }
    chrome.storage.onChanged.addListener(onStorageChanged)
    return () => {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage)
      chrome.storage.onChanged.removeListener(onStorageChanged)
    }
  }, [applyScanFrontResult, refresh])

  // Restore in-progress front preview when the side panel opens mid two-pass scan.
  useEffect(() => {
    void (async () => {
      const [stored, phase, meta] = await Promise.all([
        readScanImagesFromStorage(),
        readScanPhase(),
        chrome.storage.local.get('fdn_last_native_scan'),
      ])
      if (!stored?.front) return
      if (scanImagesRef.current?.front) return

      if (isCompleteTwoSidedScan(stored.front, stored.back)) {
        const last = meta.fdn_last_native_scan as NativeIdScanBroadcast | undefined
        if (last?.type === 'FDN_NATIVE_ID_SCAN') {
          await applyNativeIdScanRef.current(last)
        }
        return
      }

      if (phase === 'front' || !stored.back) {
        await applyScanFrontPreviewRef.current(stored.front)
      }
    })()
  }, [])

  const scanPreviewUrls = useMemo(() => {
    revokeBlobUrl(scanPreviewBlobUrlsRef.current.front)
    revokeBlobUrl(scanPreviewBlobUrlsRef.current.back)
    if (!scanImages) {
      scanPreviewBlobUrlsRef.current = { front: null, back: null }
      return { front: null, back: null }
    }
    try {
      const next = {
        front: scanImages.front?.trim() ? base64ToBlobUrl(scanImages.front) : null,
        back: scanImages.back?.trim() ? base64ToBlobUrl(scanImages.back) : null,
      }
      scanPreviewBlobUrlsRef.current = next
      return next
    } catch {
      scanPreviewBlobUrlsRef.current = { front: null, back: null }
      return { front: null, back: null }
    }
  }, [scanImages])

  useEffect(
    () => () => {
      revokeBlobUrl(scanPreviewBlobUrlsRef.current.front)
      revokeBlobUrl(scanPreviewBlobUrlsRef.current.back)
    },
    [],
  )

  async function onDevLogin(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setFormError(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'AUTH_DEV_LOGIN',
        email,
        password,
      })) as { ok: boolean; error?: string }
      if (!res.ok) setFormError(res.error ?? 'Login failed')
      else void refresh()
    } finally {
      setBusy(false)
    }
  }

  function buildGuestFormPayload(): {
    detailForSave: IdScanDetailGuru
    mergedParsed: ParsedIdFields
  } | null {
    const requiredErr = validateRequiredGuestFields(idDetail, phone)
    if (requiredErr) {
      setFormError(requiredErr)
      return null
    }
    const detailForSave: IdScanDetailGuru = {
      ...idDetail,
      phone: phone.trim() || idDetail.phone,
      email: emailGuest.trim() || idDetail.email,
    }
    const mergedParsed = mergeParsedWithGuru(parsed, detailForSave)
    return { detailForSave, mergedParsed }
  }

  async function prepareScanImagesForPersist(): Promise<
    { front: string | null; back: string | null } | { error: string }
  > {
    let frontB64 = scanImages?.front ?? null
    let backB64 = scanImages?.back ?? null
    if ((frontB64 || backB64) && (rotationDeg !== 0 || flipH)) {
      try {
        if (frontB64) frontB64 = await transformBase64ImageSync(frontB64, rotationDeg, flipH)
        if (backB64) backB64 = await transformBase64ImageSync(backB64, rotationDeg, flipH)
      } catch (e) {
        return { error: e instanceof Error ? e.message : 'Could not apply image rotation.' }
      }
    }
    return { front: frontB64, back: backB64 }
  }

  async function fillOpenPmsTab(
    detailForSave: IdScanDetailGuru,
    mergedParsed: ParsedIdFields,
    phoneTrim: string,
    emailTrim: string,
  ): Promise<void> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = tabs[0]?.id
    if (!tabId) {
      throw new Error('No active browser tab — open the PMS guest page first.')
    }
    const docData = lastDocumentData ?? {}
    await chrome.tabs.sendMessage(tabId, {
      type: 'FDN_FILL_GUEST_FORM',
      payload: {
        first_name: detailForSave.firstName ?? null,
        middle_name: detailForSave.middleName ?? null,
        last_name: detailForSave.lastName ?? null,
        address: detailForSave.streetAddress ?? null,
        city: detailForSave.city ?? null,
        state: detailForSave.state ?? null,
        postal_code: detailForSave.postalCode ?? null,
        phone: phoneTrim || null,
        email: emailTrim || null,
        gender:
          typeof docData.gender === 'string'
            ? docData.gender
            : typeof (docData as Record<string, unknown>).sex === 'string'
              ? ((docData as Record<string, unknown>).sex as string)
              : null,
        dob: mergedParsed.dateOfBirth ?? null,
        id_number: mergedParsed.idNumber ?? null,
        expiry_date: mergedParsed.expiryDate ?? null,
        issue_date: mergedParsed.issueDate ?? null,
        document_type: mergedParsed.idType ?? null,
      },
    })
  }

  async function onTransferToPms() {
    const built = buildGuestFormPayload()
    if (!built) return
    setBusy(true)
    setFormError(null)
    try {
      await fillOpenPmsTab(
        built.detailForSave,
        built.mergedParsed,
        phone.trim(),
        emailGuest.trim(),
      )
      showChromeNotification(
        'FrontDesk Nexus',
        'Guest data sent to PMS. Use Save & Clear when check-in is complete.',
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not fill PMS form.'
      setFormError(msg)
      void chrome.notifications.create({
        type: 'basic',
        title: 'FrontDesk Nexus — PMS fill failed',
        message: msg,
        iconUrl: chrome.runtime.getURL('icon.png'),
      })
    } finally {
      setBusy(false)
    }
  }

  const persistGuestIdScan = useCallback(
    async (opts: { clearAfter: boolean; silent: boolean; notification?: string | null }): Promise<{ ok: boolean; error?: string }> => {
      const requiredErr = validateRequiredGuestFields(idDetail, phone)
      if (requiredErr) return { ok: false, error: requiredErr }

      const detailForSave: IdScanDetailGuru = {
        ...idDetail,
        phone: phone.trim() || idDetail.phone,
        email: emailGuest.trim() || idDetail.email,
      }
      const mergedParsed = mergeParsedWithGuru(parsed, detailForSave)

      const images = await prepareScanImagesForPersist()
      if ('error' in images) {
        if (!opts.silent) setFormError(images.error)
        return { ok: false, error: images.error }
      }

      const res = (await chrome.runtime.sendMessage({
        type: 'SAVE_ID_SCAN',
        parsed: mergedParsed,
        phone: phone.trim() || null,
        email: emailGuest.trim() || null,
        manualEntry,
        managerOverride,
        imageFrontBase64: images.front,
        imageBackBase64: images.back,
        ocrProvider: manualEntry ? null : lastOcrProvider,
        detail: detailForSave,
        documentData: manualEntry ? null : lastDocumentData,
        guestRemark: guestRemark.trim() || null,
        checkInRemark: checkInRemark.trim() || null,
      })) as { ok: boolean; error?: string }

      if (!res.ok) return { ok: false, error: res.error ?? 'Save failed' }

      guestDraftCanceledRef.current = false
      guestDraftStartedAtRef.current = null
      void chrome.storage.local.remove([FDN_PENDING_GUEST_DRAFT_KEY])

      if (opts.notification === null) {
        // suppressed — caller handles feedback (or doesn't want any)
      } else if (opts.notification != null) {
        showChromeNotification('FrontDesk Nexus', opts.notification)
      } else if (!opts.silent) {
        showChromeNotification('FrontDesk Nexus', 'Guest ID saved — form cleared for next guest.')
      } else {
        showChromeNotification('FrontDesk Nexus', 'Guest check-in saved automatically before sign-out.')
      }
      setManagerOverride(false)
      setShowManagerModal(false)
      void refresh()
      void refreshIdScanHistory()
      if (opts.clearAfter) clearIdScan()
      return { ok: true }
    },
    [
      idDetail,
      phone,
      emailGuest,
      parsed,
      scanImages,
      rotationDeg,
      flipH,
      manualEntry,
      managerOverride,
      lastOcrProvider,
      lastDocumentData,
      guestRemark,
      checkInRemark,
      clearIdScan,
      refresh,
      refreshIdScanHistory,
    ],
  )

  useEffect(() => {
    persistGuestIdScanRef.current = persistGuestIdScan
  }, [persistGuestIdScan])

  useEffect(() => {
    canIdleSaveClearRef.current = () => {
      if (
        !hasUnsavedGuestDraft(
          idDetail,
          phone,
          emailGuest,
          parsed,
          scanImages,
          guestRemark,
          checkInRemark,
        )
      ) {
        return false
      }
      return validateRequiredGuestFields(idDetail, phone) === null
    }
  }, [idDetail, phone, emailGuest, parsed, scanImages, guestRemark, checkInRemark])

  const tryAutoSaveGuestDraftBeforeLogout = useCallback(
    async (requireMinAge: boolean): Promise<void> => {
      if (guestDraftCanceledRef.current) return
      if (
        !hasUnsavedGuestDraft(
          idDetail,
          phone,
          emailGuest,
          parsed,
          scanImages,
          guestRemark,
          checkInRemark,
        )
      ) {
        return
      }
      if (requireMinAge) {
        const started = guestDraftStartedAtRef.current
        if (!started || Date.now() - started < GUEST_DRAFT_AUTOSAVE_MIN_MS) return
      }
      if (validateRequiredGuestFields(idDetail, phone)) return

      const res = await persistGuestIdScan({ clearAfter: true, silent: true })
      if (!res.ok && res.error?.includes('DNR')) setShowManagerModal(true)
    },
    [
      idDetail,
      phone,
      emailGuest,
      parsed,
      scanImages,
      guestRemark,
      checkInRemark,
      persistGuestIdScan,
    ],
  )

  useEffect(() => {
    if (!state) return
    const signedIn = state.auth.signedIn
    if (prevSignedInRef.current === true && !signedIn) {
      void tryAutoSaveGuestDraftBeforeLogout(true).finally(() => clearIdScan())
    }
    prevSignedInRef.current = signedIn
  }, [state, clearIdScan, tryAutoSaveGuestDraftBeforeLogout])

  useEffect(() => {
    const dirty = hasUnsavedGuestDraft(
      idDetail,
      phone,
      emailGuest,
      parsed,
      scanImages,
      guestRemark,
      checkInRemark,
    )
    if (dirty && !guestDraftCanceledRef.current) {
      if (!guestDraftStartedAtRef.current) guestDraftStartedAtRef.current = Date.now()
    } else if (!dirty) {
      guestDraftStartedAtRef.current = null
    }
  }, [idDetail, phone, emailGuest, parsed, scanImages, guestRemark, checkInRemark])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        if (guestDraftCanceledRef.current) {
          await chrome.storage.local.remove([FDN_PENDING_GUEST_DRAFT_KEY])
          return
        }
        if (
          !hasUnsavedGuestDraft(
            idDetail,
            phone,
            emailGuest,
            parsed,
            scanImages,
            guestRemark,
            checkInRemark,
          )
        ) {
          await chrome.storage.local.remove([FDN_PENDING_GUEST_DRAFT_KEY])
          return
        }
        if (validateRequiredGuestFields(idDetail, phone)) return

        const detailForSave: IdScanDetailGuru = {
          ...idDetail,
          phone: phone.trim() || idDetail.phone,
          email: emailGuest.trim() || idDetail.email,
        }
        const mergedParsed = mergeParsedWithGuru(parsed, detailForSave)

        const images = await prepareScanImagesForPersist()
        if ('error' in images) return

        const draft: PendingGuestDraft = {
          canceled: false,
          draftStartedAtMs: guestDraftStartedAtRef.current ?? Date.now(),
          parsed: mergedParsed,
          phone: phone.trim() || null,
          email: emailGuest.trim() || null,
          manualEntry,
          managerOverride,
          imageFrontBase64: images.front,
          imageBackBase64: images.back,
          ocrProvider: manualEntry ? null : lastOcrProvider,
          detail: detailForSave,
          documentData: manualEntry ? null : lastDocumentData,
          guestRemark: guestRemark.trim() || null,
          checkInRemark: checkInRemark.trim() || null,
        }
        await chrome.storage.local.set({ [FDN_PENDING_GUEST_DRAFT_KEY]: draft })
      })()
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [
    idDetail,
    phone,
    emailGuest,
    parsed,
    scanImages,
    rotationDeg,
    flipH,
    manualEntry,
    managerOverride,
    lastOcrProvider,
    lastDocumentData,
    guestRemark,
    checkInRemark,
  ])

  // Idle Save & Clear: after 5 min with no form interaction, warn 30s then save + clear (if required fields are valid).
  useEffect(() => {
    const handle = window.setInterval(() => {
      if (!canIdleSaveClearRef.current()) return
      if (Date.now() - lastFormInteractionRef.current < GUEST_IDLE_SAVE_CLEAR_MS) return
      setAutoSaveCountdown((prev) => prev ?? GUEST_IDLE_SAVE_CLEAR_COUNTDOWN_S)
    }, 30_000)
    return () => clearInterval(handle)
  }, [])

  // Countdown tick: Save & Clear when it reaches 0.
  useEffect(() => {
    if (autoSaveCountdown === null) return
    if (autoSaveCountdown <= 0) {
      void persistGuestIdScanRef.current({
        clearAfter: true,
        silent: false,
        notification:
          'Guest check-in saved — form cleared after 5 minutes of inactivity.',
      }).then(() => {
        setAutoSaveCountdown(null)
        lastFormInteractionRef.current = Date.now()
      })
      return
    }
    const t = window.setTimeout(
      () => setAutoSaveCountdown((n) => (n !== null ? n - 1 : null)),
      1000,
    )
    return () => window.clearTimeout(t)
  }, [autoSaveCountdown])

  async function onSave() {
    const requiredErr = validateRequiredGuestFields(idDetail, phone)
    if (requiredErr) {
      setFormError(requiredErr)
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const res = await persistGuestIdScan({
        clearAfter: false,
        silent: false,
        notification: 'Guest ID saved — scan and form kept for this guest.',
      })
      if (!res.ok) {
        const err = res.error ?? 'Save failed'
        void chrome.notifications.create({
          type: 'basic',
          title: 'FrontDesk Nexus — Save failed',
          message: err,
          iconUrl: chrome.runtime.getURL('icon.png'),
        })
        if (err.includes('DNR')) setShowManagerModal(true)
        else if (err !== 'Save failed') setFormError(err)
      }
    } finally {
      setBusy(false)
    }
  }

  async function onSaveAndClear() {
    const requiredErr = validateRequiredGuestFields(idDetail, phone)
    if (requiredErr) {
      setFormError(requiredErr)
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const res = await persistGuestIdScan({ clearAfter: true, silent: false })
      if (!res.ok) {
        const err = res.error ?? 'Save failed'
        void chrome.notifications.create({
          type: 'basic',
          title: 'FrontDesk Nexus — Save failed',
          message: err,
          iconUrl: chrome.runtime.getURL('icon.png'),
        })
        if (err.includes('DNR')) setShowManagerModal(true)
        else if (err !== 'Save failed') setFormError(err)
      }
    } finally {
      setBusy(false)
    }
  }

  function onIdFormInteraction() {
    lastFormInteractionRef.current = Date.now()
    if (autoSaveCountdown !== null) setAutoSaveCountdown(null)
  }

  function onCancelGuest() {
    guestDraftCanceledRef.current = true
    guestDraftStartedAtRef.current = null
    void chrome.storage.local.remove([FDN_PENDING_GUEST_DRAFT_KEY])
    clearIdScan()
    setManagerOverride(false)
    setShowManagerModal(false)
  }

  async function onLogout() {
    setBusy(true)
    await tryAutoSaveGuestDraftBeforeLogout(false)
    await chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' })
    clearIdScan()
    setManagerOverride(false)
    setBusy(false)
    void refresh()
  }

  async function onVerifyManager(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'VERIFY_MANAGER',
        email: managerEmail,
        password: managerPassword,
      })) as { ok: boolean; error?: string }
      if (!res.ok) {
        setFormError(res.error ?? 'Verification failed')
        return
      }
      setManagerOverride(true)
      setShowManagerModal(false)
      setFormError(null)
      showChromeNotification('FrontDesk Nexus', 'Manager verified — you can save with override.')
    } finally {
      setBusy(false)
    }
  }

  function openAddDnrModal() {
    const id = parsed.idNumber?.trim()
    if (!id) {
      setFormError('Scan or enter an ID number before adding to DNR.')
      return
    }
    if (dnrActive) {
      setFormError('This guest is already on the active DNR list.')
      return
    }
    setFormError(null)
    setDnrReason('')
    setDnrManagerEmail('')
    setDnrManagerPassword('')
    setShowAddDnrModal(true)
  }

  async function onAddDnrSubmit(e: React.FormEvent) {
    e.preventDefault()
    const id = parsed.idNumber?.trim()
    const guestName = guestNameFromIdForm(idDetail, parsed)
    if (!id) {
      setFormError('ID number is required.')
      return
    }
    if (!guestName) {
      setFormError('Guest name is required (first/last name or full name on ID).')
      return
    }
    if (!dnrReason.trim()) {
      setFormError('DNR reason is required.')
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'ADD_DNR',
        guestName,
        idNumber: id,
        dateOfBirth: parsed.dateOfBirth?.trim() || null,
        reason: dnrReason.trim(),
        managerEmail: dnrManagerEmail.trim(),
        managerPassword: dnrManagerPassword,
      })) as ExtensionResponse
      if (res.ok === false) {
        setFormError(res.error ?? 'Could not add DNR')
        return
      }
      setDnrActive(true)
      setShowAddDnrModal(false)
      setDnrReason('')
      setDnrManagerEmail('')
      setDnrManagerPassword('')
      showChromeNotification(
        'FrontDesk Nexus',
        `${guestName} added to Do Not Rent list.`,
      )
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  /** Encode one key (portal: IN time = encode moment; checkout from stay). */
  async function runEncodeKey(serial: number): Promise<boolean> {
    if (!res?.roomNumber || !res?.checkOutDate) {
      setKeyNotice('Load a reservation with room and check-out before encoding.')
      return false
    }
    if (serial < 1 || serial > MAX_ROOM_KEYS) {
      setKeyNotice(`This stay allows up to ${MAX_ROOM_KEYS} keys.`)
      return false
    }

    setKeyBusy(true)
    setKeyNotice(null)
    try {
      const result = (await chrome.runtime.sendMessage({
        type: 'RFID_MAKE_KEY',
        roomNumber: res.roomNumber,
        checkinTime: res.checkInDate ?? new Date().toISOString(),
        checkoutTime: res.checkOutDate,
        cardSerial: serial,
      })) as { ok: boolean; error?: string; dbWarning?: string; state?: ExtensionState } | undefined

      if (!result) {
        setKeyNotice('No response from native host — reload the extension and try again.')
        return false
      }
      if (!result.ok) {
        setKeyNotice(result.error ?? 'Key encoding failed')
        return false
      }

      const base = `Key ${serial} encoded — room ${res.roomNumber}.`
      if (result.dbWarning) {
        setKeyNotice(`${base} Warning: ${result.dbWarning}`)
      } else if (serial >= MAX_ROOM_KEYS) {
        setKeyNotice(`${base} Maximum keys for this stay.`)
      } else {
        setKeyNotice(
          `${base} Remove this card, place blank card ${serial + 1}, then press Next key.`,
        )
      }

      if (result.state) setState(result.state)
      setKeyCardSerial(Math.min(MAX_ROOM_KEYS + 1, serial + 1))
      void refreshKeyHistory()
      return true
    } catch (e) {
      setKeyNotice(e instanceof Error ? e.message : 'Key encoding failed — check device connection.')
      return false
    } finally {
      setKeyBusy(false)
    }
  }

  async function onMakeKey() {
    await runEncodeKey(keyCardSerial)
  }

  async function onNextKey() {
    if (keyCardSerial <= 1) {
      setKeyNotice('Encode the first key with Encode Key, then use Next key for each additional card.')
      return
    }
    await runEncodeKey(keyCardSerial)
  }

  async function onReadCard() {
    setReadCardBusy(true)
    setReadCardResult(null)
    try {
      const result = (await chrome.runtime.sendMessage({ type: 'RFID_READ_CARD' })) as
        | { ok: boolean; cardData?: string; roomNumber?: string | null; cardSerial?: number | null; checkinTime?: string | null; checkoutTime?: string | null; error?: string }
        | undefined
      if (!result) {
        setReadCardResult({ ok: false, error: 'No response from native host' })
        return
      }
      setReadCardResult(result)
    } catch (e) {
      setReadCardResult({ ok: false, error: e instanceof Error ? e.message : 'Read failed' })
    } finally {
      setReadCardBusy(false)
    }
  }

  async function onLostKey() {
    const roomNumber = res?.roomNumber
    if (!roomNumber) {
      setKeyNotice('Load a reservation first to use Lost Key.')
      return
    }
    if (!res?.checkOutDate) {
      setKeyNotice('Reservation check-out date is required for Lost Key.')
      return
    }
    if (!window.confirm('This will invalidate the existing key. Continue?')) return

    setCancelCardBusy(true)
    setKeyNotice(null)
    try {
      const result = (await chrome.runtime.sendMessage({
        type: 'RFID_MAKE_LOST_KEY',
        roomNumber,
        checkoutTime: res.checkOutDate,
      })) as { ok: boolean; error?: string; dbWarning?: string; newCheckinTime?: string; state?: ExtensionState } | undefined
      if (!result) {
        setKeyNotice('Lost key failed — no response from encoder.')
        return
      }
      if (!result.ok) {
        setKeyNotice(`Lost key failed — ${result.error ?? 'unknown error'}`)
        return
      }
      if (result.state) setState(result.state)
      void refreshKeyHistory()
      const notice = result.dbWarning
        ? `Lost key encoded. Warning: ${result.dbWarning}`
        : `Lost key replacement ready for Room ${roomNumber}. Give card to guest — when they tap the lock, the old key is automatically deactivated.`
      setKeyNotice(notice)
    } catch (e) {
      setKeyNotice(`Lost key error — ${e instanceof Error ? e.message : 'unknown error'}`)
    } finally {
      setCancelCardBusy(false)
    }
  }

  useEffect(() => {
    const t = setInterval(() => setRfidTick(n => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])

  async function onCheckRfid() {
    setRfidCheckBusy(true)
    try {
      const resp = (await chrome.runtime.sendMessage({ type: 'RFID_CHECK_CONNECTION' })) as ExtensionResponse
      if (resp?.ok && 'state' in resp && resp.state) setState(resp.state)
    } finally {
      setRfidCheckBusy(false)
    }
  }

  /** Re-scrape the open PMS guest (SynXis / eZee) so room and checkout load for key encoding. */
  async function onRefreshPmsStay() {
    if (!state?.auth.signedIn) {
      setKeyNotice('Sign in to refresh stay details from the PMS.')
      return
    }
    setPmsRefreshBusy(true)
    setKeyNotice(null)
    try {
      const pms = state?.reservation?.pms
      let resp = (await chrome.runtime.sendMessage({
        type: pms === 'ezee' ? 'LOAD_EZEE_RESERVATION' : 'LOAD_SYNXIS_RESERVATION',
      })) as ExtensionResponse
      if (!resp.ok && !pms) {
        resp = (await chrome.runtime.sendMessage({ type: 'LOAD_EZEE_RESERVATION' })) as ExtensionResponse
        if (!resp.ok) {
          resp = (await chrome.runtime.sendMessage({ type: 'LOAD_SYNXIS_RESERVATION' })) as ExtensionResponse
        }
      }
      if (resp?.ok && 'state' in resp && resp.state) setState(resp.state)
      if (!resp.ok) {
        const errMsg =
          'error' in resp && typeof resp.error === 'string'
            ? resp.error
            : 'Could not read guest from the PMS tab. Open the guest drawer and try again.'
        setKeyNotice(errMsg)
      } else {
        void refreshKeyHistory()
        showChromeNotification(
          'FrontDesk Nexus',
          'Stay details refreshed from PMS — you can encode keys when room and checkout are shown.',
        )
      }
    } finally {
      setPmsRefreshBusy(false)
    }
  }

  if (!state) {
    return (
      <div className="fdn-root fdn-root--loading">
        <LoadingScreen />
      </div>
    )
  }

  if (state.versionBlocked) {
    return (
      <div className="fdn-root">
        <div className="fdn-banner fdn-banner--danger">{state.versionMessage}</div>
      </div>
    )
  }

  const res = state.reservation
  const guest = state.synxisGuestDisplay
  const ezee = state.ezeeGuestDisplay
  const hw = state.hardware
  const hwChecked = state.hardwareCheckedAt
  const idCheckedAgo = formatCheckedAgo(hwChecked?.id_scanner)
  const keyCheckedAgo = formatCheckedAgo(hwChecked?.rfid_encoder)
  const idAgeLabel = ageLabelFromDobString(parsed.dateOfBirth)
  const pmsLabel = res?.pms === 'ezee' ? 'eZee' : res?.pms === 'synxis' ? 'SynXis' : 'PMS'
  const idTabReady = Boolean(idDetail.firstName?.trim() && idDetail.lastName?.trim() && phone.trim())
  const guestActionsDisabled = busy || !state.auth.signedIn || !idTabReady

  const transferTooltip = !state.auth.signedIn
    ? 'Sign in to send guest data to the PMS'
    : !idTabReady
      ? 'First name, last name, and phone are required'
      : 'Fill the open PMS guest form only — does not save to ID Data'

  const saveTooltip = !state.auth.signedIn
    ? 'Sign in to save ID Data'
    : !idTabReady
      ? 'First name, last name, and phone are required'
      : 'Save to ID Data — keep scan and form for this guest'

  const saveAndClearTooltip = !state.auth.signedIn
    ? 'Sign in to save ID Data'
    : !idTabReady
      ? 'First name, last name, and phone are required'
      : 'Save to ID Data and clear the form for the next guest'

  const cancelTooltip = 'Discard this guest — nothing is saved to ID Data'

  const workspaceTabs: {
    id: WorkspaceTab
    label: string
    hint: string
    status: 'ready' | 'idle' | 'warn'
    Icon: typeof IconId
  }[] = [
      {
        id: 'id',
        label: 'ID',
        hint: 'Guest ID scan & details',
        status: scanImages || manualEntry || idTabReady ? 'ready' : 'idle',
        Icon: IconId,
      },
      {
        id: 'history',
        label: 'History',
        hint: 'Check-in history by date',
        status: state.auth.signedIn ? 'idle' : 'warn',
        Icon: IconHistory,
      },
      {
        id: 'payment',
        label: 'Payment',
        hint: 'Folio & balance',
        status: res?.dueAmount || ezee?.balance ? 'ready' : 'idle',
        Icon: IconPayment,
      },
      {
        id: 'signature',
        label: 'Signature',
        hint: 'Registration card signature',
        status: 'idle',
        Icon: IconSignature,
      },
      {
        id: 'key',
        label: 'Key',
        hint: 'Encode room keys',
        status:
          hw.rfid_encoder !== 'connected' ? 'warn' : keyHistory.length > 0 ? 'ready' : res?.roomNumber ? 'idle' : 'warn',
        Icon: IconKey,
      },
    ]

  return (
    <div className="fdn-root">
      <PanelHeader
        signedIn={state.auth.signedIn}
        email={state.auth.email}
        role={state.auth.role}
        displayName={
          state.auth.signedIn ? accountDisplayName(state.auth.email) : 'Guest'
        }
        roleLabel={formatRoleLabel(state.auth.role)}
        idScanner={hw.id_scanner}
        rfidEncoder={hw.rfid_encoder}
        idCheckedAgo={idCheckedAgo}
        keyCheckedAgo={keyCheckedAgo}
        rfidCheckBusy={rfidCheckBusy}
        onLogout={() => void onLogout()}
        onRefreshId={() => void refresh()}
        onCheckKey={() => void onCheckRfid()}
      />

      {!state.auth.signedIn && (
        <section className="fdn-card fdn-card--compact">
          <h2 className="fdn-h2">Sign in</h2>
          {formError ? (
            <p className="fdn-form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <form className="fdn-form" onSubmit={(e) => void onDevLogin(e)}>
            <label className="fdn-label">
              Email
              <input
                className="fdn-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </label>
            <label className="fdn-label">
              Password
              <input
                className="fdn-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className="fdn-btn fdn-btn--primary" disabled={busy}>
              Sign in
            </button>
          </form>
        </section>
      )}

      <div className="fdn-shell">
        <nav className="fdn-sidebar" aria-label="Workspace">
          {workspaceTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={[
                'fdn-nav-btn',
                activeTab === tab.id ? 'fdn-nav-btn--active' : '',
                tab.status === 'ready' ? 'fdn-nav-btn--ready' : '',
                tab.status === 'warn' ? 'fdn-nav-btn--warn' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={`${tab.label} — ${tab.hint}`}
              aria-label={tab.label}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              onClick={() => setActiveTab(tab.id)}
            >
              <tab.Icon className="fdn-nav-btn__icon" />
            </button>
          ))}
        </nav>

        <main className="fdn-main">
          {activeTab === 'id' ? (
            <section
              ref={idPanelRef}
              className="fdn-panel fdn-panel--id"
              onPointerDown={onIdFormInteraction}
              onInput={onIdFormInteraction}
            >
              {formError ? (
                <p className="fdn-form-error" role="alert">
                  {formError}
                </p>
              ) : null}
              {autoSaveCountdown !== null && (
                <div className="fdn-autosave-banner" role="status">
                  <span>Save &amp; Clear in {autoSaveCountdown}s (5 min idle)…</span>
                  <button
                    type="button"
                    className="fdn-autosave-banner__cancel"
                    onClick={onIdFormInteraction}
                  >
                    Keep editing
                  </button>
                </div>
              )}
              <div className="fdn-panel__toolbar">
                <label className="fdn-check fdn-check--compact">
                  <input
                    type="checkbox"
                    checked={manualEntry}
                    onChange={(e) => setManualEntry(e.target.checked)}
                  />
                  Manual entry
                </label>
                {managerOverride ? <span className="fdn-tag fdn-tag--warn">Mgr override</span> : null}
                {!manualEntry && lastOcrProvider ? (
                  <span className="fdn-tag fdn-tag--ocr" title={`OCR source: ${lastOcrProvider}`}>
                    {ocrProviderShortLabel(lastOcrProvider)}
                  </span>
                ) : null}
                {lastScanReceivedAt && !manualEntry ? (
                  <span className="fdn-tag fdn-tag--scan-time" title="Last ID scan received">
                    {formatLocalFromIso(lastScanReceivedAt)}
                  </span>
                ) : null}
                {priorReturningGuestStays.length > 0 ? (
                  <span className="fdn-tag fdn-tag--returning" title="This ID was used on a prior stay">
                    Returning guest
                  </span>
                ) : null}
                {dnrCheckBusy ? (
                  <span className="fdn-tag fdn-tag--dnr-pending" title="Checking DNR list">
                    DNR…
                  </span>
                ) : dnrActive ? (
                  <span className="fdn-tag fdn-tag--dnr" title="Guest is on the Do Not Rent list">
                    Blacklisted
                  </span>
                ) : null}
                {guestUnderage && minimumCheckInAge > 0 ? (
                  <span
                    className="fdn-tag fdn-tag--underage"
                    title={`Guest is under minimum check-in age (${minimumCheckInAge})`}
                  >
                    Underage
                  </span>
                ) : null}
                <button
                  type="button"
                  className={[
                    'fdn-dnr-btn',
                    dnrActive ? 'fdn-dnr-btn--active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  title={
                    dnrActive
                      ? 'Guest is already on the DNR list'
                      : 'Add guest to Do Not Rent (manager/admin password required)'
                  }
                  aria-label="Add to Do Not Rent list"
                  disabled={
                    !state.auth.signedIn ||
                    busy ||
                    dnrActive ||
                    !parsed.idNumber?.trim()
                  }
                  onClick={() => openAddDnrModal()}
                >
                  <IconBan className="fdn-dnr-btn__icon" />
                </button>
              </div>

              {hasIdScanContext ? (
                <IdScanAlerts
                  dnrCheckBusy={dnrCheckBusy}
                  dnrActive={dnrActive}
                  underage={guestUnderage}
                  guestAgeYears={guestAgeYears}
                  minimumCheckInAge={minimumCheckInAge}
                  hasDob={!!parsed.dateOfBirth?.trim()}
                />
              ) : null}

              {parsed.idNumber?.trim() || returningGuestBusy || priorReturningGuestStays.length > 0 ? (
                <ReturningGuestPanel
                  stays={priorReturningGuestStays}
                  busy={returningGuestBusy}
                  expanded={returningGuestExpanded}
                  onToggleExpanded={() => setReturningGuestExpanded((open) => !open)}
                />
              ) : null}

              <div
                className="fdn-id-preview-dock fdn-id-preview-dock--top"
                aria-label="ID card scan preview"
              >
                  <div className="fdn-id-preview-dock__head">
                    <span className="fdn-id-preview-dock__title">ID card</span>
                    {!manualEntry && (scanPreviewUrls.front || scanPreviewUrls.back) ? (
                      <div className="fdn-id-preview__tools-inline" aria-label="Adjust image orientation">
                        <button
                          type="button"
                          className="fdn-id-preview__tool fdn-id-preview__tool--xs"
                          title="Rotate clockwise"
                          onClick={() => setRotationDeg((d) => (d + 90) % 360)}
                        >
                          ↻
                        </button>
                        <button
                          type="button"
                          className="fdn-id-preview__tool fdn-id-preview__tool--xs"
                          title="Flip horizontal"
                          onClick={() => setFlipH((f) => !f)}
                        >
                          ⇄
                        </button>
                        <button
                          type="button"
                          className="fdn-id-preview__tool fdn-id-preview__tool--xs"
                          title="Reset orientation"
                          onClick={() => {
                            setRotationDeg(0)
                            setFlipH(false)
                          }}
                        >
                          ⊡
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="fdn-id-preview-dock__pair">
                    <div className="fdn-id-preview-slot">
                      <p className="fdn-id-preview-slot__label">Front</p>
                      <div
                        className={[
                          'fdn-id-preview-slot__frame',
                          scanPreviewUrls.front ? 'fdn-id-preview-slot__frame--filled' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {scanPreviewUrls.front ? (
                          <img
                            className="fdn-id-preview-slot__img"
                            src={scanPreviewUrls.front}
                            alt="ID front"
                            style={{
                              transform: `rotate(${rotationDeg}deg) scaleX(${flipH ? -1 : 1})`,
                            }}
                          />
                        ) : (
                          <span className="fdn-id-preview-slot__placeholder">
                            {manualEntry ? 'Manual entry — no scan' : 'Waiting for front scan…'}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="fdn-id-preview-slot">
                      <p className="fdn-id-preview-slot__label">Back</p>
                      <div
                        className={[
                          'fdn-id-preview-slot__frame',
                          scanPreviewUrls.back ? 'fdn-id-preview-slot__frame--filled' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {scanPreviewUrls.back ? (
                          <img
                            className="fdn-id-preview-slot__img"
                            src={scanPreviewUrls.back}
                            alt="ID back"
                            style={{
                              transform: `rotate(${rotationDeg}deg) scaleX(${flipH ? -1 : 1})`,
                            }}
                          />
                        ) : (
                          <span className="fdn-id-preview-slot__placeholder">
                            {manualEntry
                              ? 'Manual entry — no scan'
                              : scanPreviewUrls.front
                                ? 'Flip card — scan back…'
                                : 'Waiting for back scan…'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

              <div className="fdn-id-form-body">
              <div className="fdn-grid fdn-grid--idguru fdn-grid--dense">
                <div className="fdn-grid--three-names">
                  <label className="fdn-label">
                    <LabelText required>First name</LabelText>
                    <input
                      required
                      aria-required="true"
                      className="fdn-input"
                      value={idDetail.firstName ?? ''}
                      onChange={(e) =>
                        setIdDetail((d) => ({ ...d, firstName: e.target.value.trim() || null }))
                      }
                    />
                  </label>
                  <label className="fdn-label">
                    <LabelText>Middle name</LabelText>
                    <input
                      className="fdn-input"
                      value={idDetail.middleName ?? ''}
                      onChange={(e) =>
                        setIdDetail((d) => ({ ...d, middleName: e.target.value.trim() || null }))
                      }
                    />
                  </label>
                  <label className="fdn-label">
                    <LabelText required>Last name</LabelText>
                    <input
                      className="fdn-input"
                      required
                      aria-required="true"
                      value={idDetail.lastName ?? ''}
                      onChange={(e) =>
                        setIdDetail((d) => ({ ...d, lastName: e.target.value.trim() || null }))
                      }
                    />
                  </label>
                </div>
                <label className="fdn-label fdn-label--full">
                  Street address
                  <input
                    className="fdn-input"
                    value={idDetail.streetAddress ?? ''}
                    onChange={(e) =>
                      setIdDetail((d) => ({ ...d, streetAddress: e.target.value.trim() || null }))
                    }
                  />
                </label>
                <label className="fdn-label">
                  City
                  <input
                    className="fdn-input"
                    value={idDetail.city ?? ''}
                    onChange={(e) => {
                      cancelZipLookup()
                      lastZipLookupRef.current = null
                      setIdDetail((d) => ({ ...d, city: e.target.value.trim() || null }))
                    }}
                  />
                </label>
                <label className="fdn-label">
                  State
                  <select
                    className="fdn-input fdn-select"
                    value={normalizeUsStateCode(idDetail.state) ?? ''}
                    onChange={(e) => {
                      cancelZipLookup()
                      setIdDetail((d) => ({ ...d, state: e.target.value.trim() || null }))
                    }}
                  >
                    <option value="">—</option>
                    {US_STATE_SELECT_OPTIONS.map(({ code, name }) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fdn-label">
                  Zip / postal
                  <input
                    className="fdn-input"
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={5}
                    value={idDetail.postalCode ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value
                      const zip = normalizeUsZipInput(raw)
                      lastZipLookupRef.current = null
                      setIdDetail((d) => ({ ...d, postalCode: zip || null }))
                      if (isCompleteUsZip(zip)) void runZipLookup(zip)
                    }}
                    onBlur={() => {
                      const zip = normalizeUsZipInput(idDetail.postalCode)
                      if (isCompleteUsZip(zip)) void runZipLookup(zip)
                    }}
                  />
                  {zipLookupBusy ? (
                    <span className="fdn-zip-hint">Looking up city &amp; state…</span>
                  ) : zipLookupNote ? (
                    <span className="fdn-zip-hint fdn-zip-hint--warn">{zipLookupNote}</span>
                  ) : null}
                </label>
                <div className="fdn-field fdn-field--full">
                  <LabelText required className="fdn-field__label">
                    Phone &amp; country
                  </LabelText>
                  <div className="fdn-phone-inline">
                    <label className="fdn-check fdn-check--phone-flag">
                      <input
                        type="checkbox"
                        checked={idDetail.usaCaPhone === true}
                        onChange={(e) =>
                          setIdDetail((d) => ({ ...d, usaCaPhone: e.target.checked ? true : null }))
                        }
                      />
                      USA/CA
                    </label>
                    <input
                      className="fdn-input fdn-input--country-code"
                      placeholder="+1"
                      value={idDetail.phoneCountryCode ?? ''}
                      onChange={(e) =>
                        setIdDetail((d) => ({ ...d, phoneCountryCode: e.target.value.trim() || null }))
                      }
                    />
                    <input
                      className={[
                        'fdn-input',
                        phoneValidationError ? 'fdn-input--invalid' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      inputMode="tel"
                      autoComplete="tel"
                      required
                      aria-required="true"
                      aria-invalid={phoneValidationError ? true : undefined}
                      placeholder="(555) 555-5555"
                      value={phone}
                      onChange={(e) => {
                        const v = e.target.value
                        setPhone(v)
                        setPhoneTouched(true)
                        schedulePhoneHistoryLookup(v)
                      }}
                      onBlur={() => {
                        setPhoneTouched(true)
                        if (idDetail.usaCaPhone !== false && isCompletePhoneForLookup(phone)) {
                          setPhone(formatUsPhoneDisplay(phone))
                        }
                        if (isCompletePhoneForLookup(phone)) void runPhoneHistoryLookup(phone)
                      }}
                    />
                  </div>
                  {phoneValidationError ? (
                    <span className="fdn-zip-hint fdn-zip-hint--warn" role="alert">
                      {phoneValidationError}
                    </span>
                  ) : guestHistoryBusy ? (
                    <span className="fdn-zip-hint">Looking up prior guest…</span>
                  ) : guestHistoryNote ? (
                    <span className="fdn-zip-hint">{guestHistoryNote}</span>
                  ) : null}
                </div>
                <label className="fdn-label">
                  Email (guest)
                  <input className="fdn-input" value={emailGuest} onChange={(e) => setEmailGuest(e.target.value)} />
                </label>
                <label className="fdn-label">
                  ID type
                  <select
                    className="fdn-input fdn-select"
                    value={
                      parsed.idType && (ID_DOCUMENT_TYPES as readonly string[]).includes(parsed.idType)
                        ? parsed.idType
                        : ''
                    }
                    onChange={(e) =>
                      setParsed({ ...parsed, idType: e.target.value.trim() || null })
                    }
                  >
                    <option value="">—</option>
                    {ID_DOCUMENT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="fdn-label">
                  ID number
                  <input
                    className="fdn-input"
                    value={parsed.idNumber ?? ''}
                    onChange={(e) => {
                      const idNumber = e.target.value.trim() || null
                      setParsed({ ...parsed, idNumber })
                      if (!idNumber) {
                        setReturningGuestRows([])
                        setReturningGuestExpanded(false)
                      }
                    }}
                    onBlur={() => {
                      if (parsed.idNumber?.trim()) void loadReturningGuestById(parsed.idNumber)
                    }}
                  />
                </label>
                <label className="fdn-label">
                  ID issue date
                  <input
                    className="fdn-input"
                    value={parsed.issueDate ?? ''}
                    onChange={(e) => setParsed({ ...parsed, issueDate: e.target.value || null })}
                  />
                </label>
                <label className="fdn-label">
                  ID expiration
                  <input
                    className="fdn-input"
                    value={parsed.expiryDate ?? ''}
                    onChange={(e) => setParsed({ ...parsed, expiryDate: e.target.value || null })}
                  />
                </label>
                <label className="fdn-label">
                  Date of birth
                  <input
                    className="fdn-input"
                    value={parsed.dateOfBirth ?? ''}
                    onChange={(e) => setParsed({ ...parsed, dateOfBirth: e.target.value || null })}
                  />
                </label>
                <label className="fdn-label">
                  Age (from DOB)
                  <input className="fdn-input" readOnly value={idAgeLabel ?? ''} title="Computed from DOB" />
                </label>
              </div>

              <details className="fdn-details">
                <summary>Scan history ({idScanHistory.length})</summary>
                {idScanHistory.length === 0 ? (
                  <p className="fdn-muted">No prior scans for this confirmation.</p>
                ) : (
                  <table className="fdn-table fdn-table--compact">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Man.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {idScanHistory.slice(0, 4).map((row) => (
                        <tr key={row.id}>
                          <td>
                            {row.scannedAt
                              ? new Date(row.scannedAt).toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                              : '—'}
                          </td>
                          <td>{row.manualEntry ? 'Y' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </details>
              </div>

              <div className="fdn-panel__footer">
                <button
                  type="button"
                  className="fdn-btn fdn-btn--secondary fdn-btn--with-icon"
                  disabled={guestActionsDisabled}
                  title={transferTooltip}
                  onClick={() => void onTransferToPms()}
                >
                  <IconArrowLeft className="fdn-btn__icon" />
                  {busy ? 'Sending…' : 'To PMS'}
                </button>
                <button
                  type="button"
                  className="fdn-btn fdn-btn--secondary"
                  disabled={guestActionsDisabled}
                  title={saveTooltip}
                  onClick={() => void onSave()}
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="fdn-btn fdn-btn--primary"
                  disabled={guestActionsDisabled}
                  title={saveAndClearTooltip}
                  onClick={() => void onSaveAndClear()}
                >
                  {busy ? 'Saving…' : 'Save & Clear'}
                </button>
                <button
                  type="button"
                  className="fdn-btn fdn-btn--danger fdn-panel__footer-cancel"
                  disabled={busy}
                  title={cancelTooltip}
                  onClick={onCancelGuest}
                >
                  Cancel
                </button>
              </div>
            </section>
          ) : null}

          {activeTab === 'history' ? (
            <CheckInHistoryPanel
              signedIn={state.auth.signedIn}
              editBusy={historyEditBusy}
              onEditInScanner={(entry) => void loadHistoryEntryIntoScanner(entry)}
            />
          ) : null}

          {activeTab === 'payment' ? (
            <section className="fdn-panel fdn-panel--payment">
              <p className="fdn-panel__lead">Folio and stay details are on the Key tab after you sync a guest.</p>
              <p className="fdn-help">Card capture and payment posting will live here in a future release.</p>
            </section>
          ) : null}

          {activeTab === 'signature' ? (
            <section className="fdn-panel fdn-panel--signature">
              <p className="fdn-panel__lead">Guest signature is captured on the PMS registration card.</p>
              <ol className="fdn-steps">
                <li>Open the guest in {pmsLabel} and print or open the registration card.</li>
                <li>Sign on the overlay that appears on the card popup.</li>
                <li>Tap <strong>Save Signature</strong> — it uploads to FrontDesk Nexus automatically.</li>
              </ol>
            </section>
          ) : null}

          {activeTab === 'key' ? (
            <section className="fdn-panel fdn-panel--key">
              <div className="fdn-key-tab__stay-toolbar">
                <button
                  type="button"
                  className="fdn-btn fdn-btn--secondary fdn-btn--with-icon fdn-key-tab__refresh"
                  disabled={pmsRefreshBusy || !state.auth.signedIn}
                  title={
                    !state.auth.signedIn
                      ? 'Sign in to load stay from PMS'
                      : `Re-read the open guest in ${pmsLabel} (confirmation, room, checkout)`
                  }
                  onClick={() => void onRefreshPmsStay()}
                >
                  <IconRefresh className="fdn-btn__icon" />
                  {pmsRefreshBusy ? 'Scanning PMS…' : 'Refresh stay'}
                </button>
              </div>
              {res?.confirmationNumber ? (
                <GuestStaySummary res={res} guest={guest} ezee={ezee} pmsLabel={pmsLabel} />
              ) : (
                <p className="fdn-stay-summary__empty">
                  Open a guest in {pmsLabel}, then tap <strong>Refresh stay</strong> if room or checkout
                  did not load automatically.
                </p>
              )}

              <h2 className="fdn-h2">Key encoder</h2>

              {hw.rfid_encoder !== 'connected' && (
                <p className="fdn-note">
                  {state.rfidError
                    ? `Encoder offline — ${state.rfidError}`
                    : 'Encoder offline — check USB cable and close INNGuru GMS if running, then reload the extension.'}
                </p>
              )}

              {!res?.roomNumber ? (
                <p className="fdn-muted">Load a reservation first to enable key encoding.</p>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
                    <span style={{ fontSize: 12, color: '#c9d1d9' }}>
                      Key #{Math.min(keyCardSerial, MAX_ROOM_KEYS)}
                      {keyCardSerial > MAX_ROOM_KEYS ? ' (max reached)' : ''}
                    </span>
                    <button
                      type="button"
                      className="fdn-btn fdn-btn--secondary"
                      style={{ padding: '3px 10px', fontSize: 12 }}
                      disabled={
                        keyBusy ||
                        hw.rfid_encoder !== 'connected' ||
                        !state.auth.signedIn ||
                        keyCardSerial <= 1 ||
                        keyCardSerial > MAX_ROOM_KEYS
                      }
                      title={
                        keyCardSerial <= 1
                          ? 'Encode key 1 first'
                          : 'Swap in a blank card and encode the next copy'
                      }
                      onClick={() => void onNextKey()}
                    >
                      {keyBusy ? 'Encoding…' : 'Next key'}
                    </button>
                  </div>

                  {keyCardSerial > 1 && keyCardSerial <= MAX_ROOM_KEYS ? (
                    <p className="fdn-help" style={{ marginTop: 6 }}>
                      Remove the last card, place a blank card on the encoder, then press Next key (key{' '}
                      {keyCardSerial} of {MAX_ROOM_KEYS}).
                    </p>
                  ) : keyCardSerial === 1 ? (
                    <p className="fdn-help" style={{ marginTop: 6 }}>
                      First card: press Encode Key. Additional cards: swap blank, then Next key.
                    </p>
                  ) : null}

                  <div className="fdn-actions">
                    <button
                      type="button"
                      className="fdn-btn fdn-btn--primary"
                      disabled={
                        keyBusy ||
                        hw.rfid_encoder !== 'connected' ||
                        !state.auth.signedIn ||
                        keyCardSerial > MAX_ROOM_KEYS
                      }
                      onClick={() => void onMakeKey()}
                    >
                      {keyBusy
                        ? 'Encoding…'
                        : keyCardSerial <= 1
                          ? 'Encode Key'
                          : `Encode key ${keyCardSerial}`}
                    </button>
                    <button
                      type="button"
                      className="fdn-btn fdn-btn--secondary"
                      disabled={readCardBusy || hw.rfid_encoder !== 'connected'}
                      onClick={() => void onReadCard()}
                    >
                      {readCardBusy ? 'Reading…' : 'Read Card'}
                    </button>
                    <button
                      type="button"
                      className="fdn-btn fdn-btn--danger"
                      disabled={cancelCardBusy || hw.rfid_encoder !== 'connected' || !res?.roomNumber}
                      title="Lost key: encodes a new guest card with a fresh check-in time. When guest taps door, lock automatically invalidates the old key."
                      onClick={() => void onLostKey()}
                    >
                      {cancelCardBusy ? 'Encoding…' : 'Lost Key'}
                    </button>
                  </div>

                  {keyNotice && (
                    <div className={`fdn-banner ${keyNotice.startsWith('Key encoded') || keyNotice.startsWith('Lost key card ready') ? 'fdn-banner--info' : 'fdn-banner--danger'}`} style={{ marginTop: 8 }}>
                      {keyNotice}
                    </div>
                  )}
                </>
              )}

              {readCardResult ? (
                <div
                  className={`fdn-banner ${readCardResult.ok ? 'fdn-banner--info' : 'fdn-banner--danger'} fdn-read-card`}
                  style={{ marginTop: 8 }}
                >
                  <p className="fdn-read-card__title">Last card read (encoder)</p>
                  {readCardResult.ok ? (
                    readCardResult.roomNumber ? (
                      <dl className="fdn-dl fdn-dl--compact" style={{ margin: 0 }}>
                        <dt>Room</dt>
                        <dd>
                          <strong>{readCardResult.roomNumber}</strong>
                          {readCardResult.cardSerial && readCardResult.cardSerial > 1 ? (
                            <span className="fdn-read-card__meta"> · Serial {readCardResult.cardSerial}</span>
                          ) : null}
                          {res?.roomNumber && readCardResult.roomNumber !== res.roomNumber ? (
                            <span className="fdn-read-card__warn"> · Different from loaded stay (Rm {res.roomNumber})</span>
                          ) : null}
                        </dd>
                        <dt>Check-in</dt>
                        <dd>{formatHotelDateTime(readCardResult.checkinTime, 14)}</dd>
                        <dt>Check-out</dt>
                        <dd>{formatHotelDateTime(readCardResult.checkoutTime, 12)}</dd>
                      </dl>
                    ) : (
                      <>
                        <strong>Card detected</strong>
                        <div className="fdn-help">Encoded by another system — room number unavailable</div>
                      </>
                    )
                  ) : (
                    `Read failed — ${readCardResult.error}`
                  )}
                </div>
              ) : null}

              <details className="fdn-details">
                <summary>Key history ({keyHistory.length})</summary>
                {keyHistory.length === 0 ? (
                  <p className="fdn-muted">No keys encoded yet.</p>
                ) : (
                  <table className="fdn-table fdn-table--compact">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>#</th>
                        <th>By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keyHistory.slice(0, 5).map((row) => (
                        <tr key={row.id}>
                          <td>
                            {row.created_at
                              ? new Date(row.created_at).toLocaleString(undefined, {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                              : '—'}
                          </td>
                          <td>{row.card_serial}</td>
                          <td className="fdn-mono">{row.encoded_by_username?.slice(0, 8) ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </details>
            </section>
          ) : null}
        </main>
      </div>

      {showAddDnrModal ? (
        <div className="fdn-modal-backdrop" role="dialog" aria-modal="true">
          <div className="fdn-modal">
            <h3 className="fdn-h3">Add to Do Not Rent</h3>
            <p className="fdn-help">
              Flag this guest on the property DNR list. A manager or admin must confirm with their
              password. This does not save the current ID scan.
            </p>
            <dl className="fdn-dnr-summary">
              <div>
                <dt>Guest</dt>
                <dd>{guestNameFromIdForm(idDetail, parsed) || '—'}</dd>
              </div>
              <div>
                <dt>ID number</dt>
                <dd className="fdn-mono">{parsed.idNumber?.trim() ?? '—'}</dd>
              </div>
              {parsed.dateOfBirth?.trim() ? (
                <div>
                  <dt>DOB</dt>
                  <dd>{parsed.dateOfBirth}</dd>
                </div>
              ) : null}
            </dl>
            <form className="fdn-form" onSubmit={(e) => void onAddDnrSubmit(e)}>
              <label className="fdn-label">
                Reason
                <textarea
                  className="fdn-input fdn-textarea"
                  required
                  rows={3}
                  value={dnrReason}
                  onChange={(e) => setDnrReason(e.target.value)}
                  placeholder="Why should this guest not be rented?"
                />
              </label>
              <label className="fdn-label">
                Manager or admin email
                <input
                  className="fdn-input"
                  type="email"
                  autoComplete="username"
                  required
                  value={dnrManagerEmail}
                  onChange={(e) => setDnrManagerEmail(e.target.value)}
                />
              </label>
              <label className="fdn-label">
                Password
                <input
                  className="fdn-input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={dnrManagerPassword}
                  onChange={(e) => setDnrManagerPassword(e.target.value)}
                />
              </label>
              <div className="fdn-actions">
                <button type="submit" className="fdn-btn fdn-btn--danger" disabled={busy}>
                  {busy ? 'Adding…' : 'Add to DNR'}
                </button>
                <button
                  type="button"
                  className="fdn-btn fdn-btn--ghost"
                  disabled={busy}
                  onClick={() => setShowAddDnrModal(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showManagerModal && (
        <div className="fdn-modal-backdrop" role="dialog" aria-modal="true">
          <div className="fdn-modal">
            <h3 className="fdn-h3">Manager approval</h3>
            <p className="fdn-help">DNR match — verify a manager or admin to allow save.</p>
            <form className="fdn-form" onSubmit={(e) => void onVerifyManager(e)}>
              <label className="fdn-label">
                Manager email
                <input
                  className="fdn-input"
                  value={managerEmail}
                  onChange={(e) => setManagerEmail(e.target.value)}
                />
              </label>
              <label className="fdn-label">
                Password
                <input
                  className="fdn-input"
                  type="password"
                  value={managerPassword}
                  onChange={(e) => setManagerPassword(e.target.value)}
                />
              </label>
              <div className="fdn-actions">
                <button type="submit" className="fdn-btn fdn-btn--primary" disabled={busy}>
                  Verify
                </button>
                <button
                  type="button"
                  className="fdn-btn fdn-btn--ghost"
                  onClick={() => setShowManagerModal(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
