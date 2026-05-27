import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExtensionResponse,
  ExtensionState,
  GuestStayHistoryRecord,
  IdScanHistoryRow,
  KeyHistoryRow,
  NativeHostRxDebugBroadcast,
  NativeIdScanBroadcast,
} from './shared/protocol'
import type { IdScanDetailGuru, ParsedIdFields } from './shared/pms-types'
import { base64ToDataUrl } from './lib/imageDataUrl'
import { ageLabelFromDobString, mergeParsedWithGuru } from './lib/id-guru-fields'
import { ID_DOCUMENT_TYPES, normalizeIdDocumentType } from './lib/id-document-types'
import { normalizeUsStateCode, US_STATE_SELECT_OPTIONS } from './lib/us-states'
import { isCompleteUsZip, lookupUsZipCityState, normalizeUsZipInput } from './lib/zip-lookup'
import { guestProfileToFormState } from './lib/apply-guest-profile'
import { isCompletePhoneForLookup } from './lib/phone-lookup'
import { formatHotelDateTime } from './lib/hotel-dates'
import { GuestStaySummary } from './components/GuestStaySummary'
import { LoadingScreen } from './components/LoadingScreen'
import { PanelHeader } from './components/PanelHeader'
import { IconArrowLeft, IconId, IconKey, IconPayment, IconSignature } from './components/WorkspaceIcons'

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
  if (!phone.trim()) return 'Phone number is required.'
  return null
}
import { transformBase64ImageSync } from './lib/imageTransform'
import './sidepanel.css'

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
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [scanImages, setScanImages] = useState<{
    front: string
    back: string | null
  } | null>(null)
  const [scanFrontBusy, setScanFrontBusy] = useState(false)
  const [scanBackBusy, setScanBackBusy] = useState(false)
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
  const phoneHistoryTimerRef = useRef(0)
  const lastPhoneLookupRef = useRef<string | null>(null)
  const guestFormEmptyRef = useRef(true)
  const lastLoadedConfRef = useRef<string | null>(null)
  const idPanelRef = useRef<HTMLElement>(null)
  type WorkspaceTab = 'id' | 'payment' | 'signature' | 'key'
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

  function clearIdScan() {
    setParsed(emptyParsed)
    setIdDetail(emptyIdDetail)
    setPhone('')
    setEmailGuest('')
    setScanImages(null)
    setScanFrontBusy(false)
    setScanBackBusy(false)
    setLastOcrProvider(null)
    setLastDocumentData(null)
    setLastScanReceivedAt(null)
    setRotationDeg(0)
    setFlipH(false)
    setGuestRemark('')
    setCheckInRemark('')
    setFormError(null)
    zipLookupAbortRef.current?.abort()
    lastZipLookupRef.current = null
    setZipLookupBusy(false)
    setZipLookupNote(null)
    setGuestHistoryBusy(false)
    setGuestHistoryNote(null)
    lastPhoneLookupRef.current = null
    void chrome.storage.local.remove('fdn_last_native_scan')
  }

  async function onScanFront() {
    setScanFrontBusy(true)
    setFormError(null)
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'SCAN_FRONT' })) as {
        ok: boolean
        imageBase64?: string
        error?: string
      }
      if (!res.ok) {
        setFormError(res.error ?? 'Front scan failed')
        return
      }
      setScanImages({ front: res.imageBase64 ?? '', back: null })
    } finally {
      setScanFrontBusy(false)
    }
  }

  async function onScanBack() {
    setScanBackBusy(true)
    setFormError(null)
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'SCAN_BACK' })) as {
        ok: boolean
        imageBase64?: string
        ocrData?: Record<string, string>
        fullName?: string | null
        dateOfBirth?: string | null
        idNumber?: string | null
        idType?: string | null
        issueDate?: string | null
        expiryDate?: string | null
        address?: string | null
        error?: string
      }
      if (!res.ok) {
        setFormError(res.error ?? 'Back scan failed')
        return
      }
      const backB64 = res.imageBase64 ?? ''
      setScanImages((prev) => ({ front: prev?.front ?? '', back: backB64 }))
      const ocr = res.ocrData ?? {}
      setParsed({
        fullName: (typeof res.fullName === 'string' ? res.fullName : (ocr.fullName ?? null)) ?? null,
        dateOfBirth: (typeof res.dateOfBirth === 'string' ? res.dateOfBirth : (ocr.dateOfBirth ?? null)) ?? null,
        idNumber: (typeof res.idNumber === 'string' ? res.idNumber : (ocr.idNumber ?? null)) ?? null,
        idType: (typeof res.idType === 'string' ? res.idType : (ocr.idType ?? null)) ?? null,
        issueDate: (typeof res.issueDate === 'string' ? res.issueDate : (ocr.issueDate ?? null)) ?? null,
        expiryDate: (typeof res.expiryDate === 'string' ? res.expiryDate : (ocr.expiryDate ?? null)) ?? null,
        address: (typeof res.address === 'string' ? res.address : (ocr.address ?? null)) ?? null,
      })
      setLastOcrProvider('native_host')
      setLastScanReceivedAt(new Date().toISOString())
    } finally {
      setScanBackBusy(false)
    }
  }

  const applyGuestProfile = useCallback((record: GuestStayHistoryRecord) => {
    const next = guestProfileToFormState(record)
    setIdDetail((d) => ({
      ...next.idDetail,
      phoneCountryCode: d.phoneCountryCode,
      usaCaPhone: d.usaCaPhone ?? next.idDetail.usaCaPhone,
    }))
    setParsed(next.parsed)
    setPhone(next.phone)
    setEmailGuest(next.emailGuest)
    lastZipLookupRef.current = normalizeUsZipInput(next.idDetail.postalCode)
    setGuestHistoryNote(
      'Prior guest details loaded. Edit as needed, then Save — prior check-ins are not changed.',
    )
  }, [])

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
        if (guestFormEmptyRef.current) {
          applyGuestProfile(rows[0])
        } else {
          setGuestHistoryNote(null)
        }
      } catch {
        setGuestHistoryNote('Could not load prior guest details.')
      } finally {
        setGuestHistoryBusy(false)
      }
    },
    [applyGuestProfile],
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

  const applyNativeIdScan = useCallback(
    (m: NativeIdScanBroadcast) => {
      const detail = m.detail ?? emptyIdDetail
      setParsed({
        ...m.parsed,
        idType: normalizeIdDocumentType(m.parsed.idType),
      })
      setLastOcrProvider(m.ocrProvider)
      setIdDetail({
        ...detail,
        state: normalizeUsStateCode(detail.state) ?? detail.state,
      })
      lastZipLookupRef.current = normalizeUsZipInput(detail.postalCode) || null
      setZipLookupNote(null)
      setScanImages({
        front: m.images.front_image_base64,
        back: m.images.back_image_base64,
      })
      setLastDocumentData(m.documentData ?? null)
      setLastScanReceivedAt(m.receivedAt ?? new Date().toISOString())
      setRotationDeg(0)
      setFlipH(false)
      if (m.detail?.phone?.trim()) {
        const p = m.detail.phone.trim()
        setPhone(p)
        lastPhoneLookupRef.current = null
        void runPhoneHistoryLookup(p)
      }
      if (m.detail?.email?.trim()) setEmailGuest(m.detail.email.trim())
      if (m.autoSave.ok) {
        showChromeNotification('FrontDesk Nexus', 'Thales scan received — saved to Supabase.')
      } else if ('ok' in m.autoSave && !m.autoSave.ok && 'error' in m.autoSave && m.autoSave.error) {
        showChromeNotification(
          'FrontDesk Nexus — Scan not saved',
          `Thales scan received — ${m.autoSave.error}`,
        )
      } else {
        showChromeNotification('FrontDesk Nexus — Scan not saved', 'Thales scan received — unknown error')
      }
      void refresh()
      void refreshIdScanHistory()
    },
    [refresh, refreshIdScanHistory, runPhoneHistoryLookup],
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
      if (m.type === 'FDN_NATIVE_ID_SCAN') {
        applyNativeIdScan(msg as NativeIdScanBroadcast)
      }
    }
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    void chrome.storage.local.get('fdn_last_native_scan').then((r) => {
      const last = r.fdn_last_native_scan as NativeIdScanBroadcast | undefined
      if (last?.type === 'FDN_NATIVE_ID_SCAN') applyNativeIdScan(last)
    })
    return () => {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage)
    }
  }, [refresh, applyNativeIdScan])

  const scanPreviewUrls = useMemo(() => {
    if (!scanImages) return null
    try {
      return {
        front: base64ToDataUrl(scanImages.front),
        back: scanImages.back ? base64ToDataUrl(scanImages.back) : null,
      }
    } catch {
      return null
    }
  }, [scanImages])

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

  async function onLogout() {
    setBusy(true)
    await chrome.runtime.sendMessage({ type: 'AUTH_LOGOUT' })
    setManagerOverride(false)
    setBusy(false)
    void refresh()
  }

  async function onSave(fillTab = false) {
    const requiredErr = validateRequiredGuestFields(idDetail, phone)
    if (requiredErr) {
      setFormError(requiredErr)
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      let frontB64 = scanImages?.front ?? null
      let backB64 = scanImages?.back ?? null
      if ((frontB64 || backB64) && (rotationDeg !== 0 || flipH)) {
        try {
          if (frontB64) frontB64 = await transformBase64ImageSync(frontB64, rotationDeg, flipH)
          if (backB64) backB64 = await transformBase64ImageSync(backB64, rotationDeg, flipH)
        } catch (e) {
          setFormError(e instanceof Error ? e.message : 'Could not apply image rotation.')
          return
        }
      }
      const detailForSave: IdScanDetailGuru = {
        ...idDetail,
        phone: phone.trim() || idDetail.phone,
        email: emailGuest.trim() || idDetail.email,
      }
      const mergedParsed = mergeParsedWithGuru(parsed, detailForSave)
      const res = (await chrome.runtime.sendMessage({
        type: 'SAVE_ID_SCAN',
        parsed: mergedParsed,
        phone: phone.trim() || null,
        email: emailGuest.trim() || null,
        manualEntry,
        managerOverride,
        imageFrontBase64: frontB64,
        imageBackBase64: backB64,
        ocrProvider: manualEntry ? null : lastOcrProvider,
        detail: detailForSave,
        documentData: manualEntry ? null : lastDocumentData,
        guestRemark: guestRemark.trim() || null,
        checkInRemark: checkInRemark.trim() || null,
      })) as { ok: boolean; error?: string }
      if (!res.ok) {
        const err = res.error ?? 'Save failed'
        void chrome.notifications.create({
          type: 'basic',
          title: 'FrontDesk Nexus — Save failed',
          message: err,
          iconUrl: chrome.runtime.getURL('icon.png'),
        })
        if (err.includes('DNR')) setShowManagerModal(true)
        return
      }
      showChromeNotification('FrontDesk Nexus', 'Guest ID saved to Supabase.')
      setManagerOverride(false)
      setShowManagerModal(false)
      void refresh()
      void refreshIdScanHistory()

      if (fillTab) {
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
          const tabId = tabs[0]?.id
          if (tabId) {
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
                phone: phone.trim() || null,
                email: emailGuest.trim() || null,
                gender: (typeof docData.gender === 'string' ? docData.gender
                  : typeof (docData as Record<string, unknown>).sex === 'string'
                    ? (docData as Record<string, unknown>).sex as string
                    : null),
                dob: mergedParsed.dateOfBirth ?? null,
                id_number: mergedParsed.idNumber ?? null,
                expiry_date: mergedParsed.expiryDate ?? null,
                issue_date: mergedParsed.issueDate ?? null,
                document_type: mergedParsed.idType ?? null,
              },
            })
          }
        } catch (e) {
          console.warn('[FDN] Could not send fill command to tab:', e)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  async function onTransferToPms() {
    await onSave(true)
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
  const transferDisabled = busy || !state.auth.signedIn || !idTabReady

  const transferTooltip = !state.auth.signedIn
    ? 'Sign in to send guest data to the PMS'
    : !idTabReady
      ? 'First name, last name, and phone are required'
      : 'Save to database and fill the open PMS guest form'

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
            <section ref={idPanelRef} className="fdn-panel fdn-panel--id">
              {formError ? (
                <p className="fdn-form-error" role="alert">
                  {formError}
                </p>
              ) : null}
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
                {!manualEntry && scanPreviewUrls ? (
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
                {!manualEntry ? (
                  <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                    <button
                      type="button"
                      className="fdn-btn fdn-btn--secondary fdn-btn--xs"
                      disabled={scanFrontBusy || scanBackBusy}
                      title="Place ID face-up on scanner, then click"
                      onClick={() => void onScanFront()}
                    >
                      {scanFrontBusy ? 'Scanning…' : 'Scan Front'}
                    </button>
                    {scanImages?.front && !scanImages.back ? (
                      <button
                        type="button"
                        className="fdn-btn fdn-btn--primary fdn-btn--xs"
                        disabled={scanBackBusy || scanFrontBusy}
                        title="Flip ID over on scanner, then click"
                        onClick={() => void onScanBack()}
                      >
                        {scanBackBusy ? 'Scanning…' : 'Scan Back'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>

              {!manualEntry && scanPreviewUrls ? (
                <div className="fdn-id-preview fdn-id-preview--dual fdn-id-preview--compact">
                  <div className="fdn-id-preview__pair">
                    <div className="fdn-id-preview__cell">
                      <p className="fdn-id-preview__side">Front</p>
                      <div className="fdn-id-preview__main">
                        <img
                          className="fdn-id-preview__img"
                          src={scanPreviewUrls.front}
                          alt="ID front"
                          style={{
                            transform: `rotate(${rotationDeg}deg) scaleX(${flipH ? -1 : 1})`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="fdn-id-preview__cell">
                      <p className="fdn-id-preview__side">Back</p>
                      <div className="fdn-id-preview__main">
                        {scanPreviewUrls.back ? (
                          <img
                            className="fdn-id-preview__img"
                            src={scanPreviewUrls.back}
                            alt="ID back"
                            style={{
                              transform: `rotate(${rotationDeg}deg) scaleX(${flipH ? -1 : 1})`,
                            }}
                          />
                        ) : (
                          <p className="fdn-muted" style={{ fontSize: 11, padding: '8px 4px' }}>
                            {scanBackBusy ? 'Scanning back…' : 'Flip card, then click Scan Back'}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

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
                    value={idDetail.postalCode ?? ''}
                    onChange={(e) => {
                      const raw = e.target.value
                      lastZipLookupRef.current = null
                      setIdDetail((d) => ({ ...d, postalCode: raw.trim() || null }))
                      if (isCompleteUsZip(normalizeUsZipInput(raw))) void runZipLookup(raw)
                    }}
                    onBlur={() => {
                      const raw = idDetail.postalCode ?? ''
                      if (isCompleteUsZip(normalizeUsZipInput(raw))) void runZipLookup(raw)
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
                      className="fdn-input"
                      inputMode="tel"
                      autoComplete="tel"
                      required
                      aria-required="true"
                      placeholder="(555) 555-5555"
                      value={phone}
                      onChange={(e) => {
                        const v = e.target.value
                        setPhone(v)
                        schedulePhoneHistoryLookup(v)
                      }}
                      onBlur={() => {
                        if (isCompletePhoneForLookup(phone)) void runPhoneHistoryLookup(phone)
                      }}
                    />
                  </div>
                  {guestHistoryBusy ? (
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
                    onChange={(e) => setParsed({ ...parsed, idNumber: e.target.value || null })}
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
                {lastScanReceivedAt ? (
                  <span className="fdn-scan-time" title="Last ID scan received">
                    Scan {formatLocalFromIso(lastScanReceivedAt)}
                  </span>
                ) : null}
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

              <div className="fdn-panel__footer">
                <button
                  type="button"
                  className="fdn-btn fdn-btn--primary fdn-btn--with-icon"
                  disabled={transferDisabled}
                  title={transferTooltip}
                  onClick={() => void onTransferToPms()}
                >
                  <IconArrowLeft className="fdn-btn__icon" />
                  {busy ? 'Sending…' : 'To PMS'}
                </button>
                <button
                  type="button"
                  className="fdn-btn fdn-btn--secondary fdn-btn--xs"
                  disabled={busy || !state.auth.signedIn}
                  title="Save to Supabase without filling the PMS form"
                  onClick={() => void onSave(false)}
                >
                  Save DB only
                </button>
                <button
                  type="button"
                  className="fdn-btn fdn-btn--ghost fdn-btn--xs"
                  disabled={busy}
                  title="Clear all ID fields and scan images"
                  onClick={clearIdScan}
                >
                  Clear
                </button>
              </div>
            </section>
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
              {res?.confirmationNumber ? (
                <GuestStaySummary res={res} guest={guest} ezee={ezee} pmsLabel={pmsLabel} />
              ) : (
                <p className="fdn-stay-summary__empty">
                  Open a guest in {pmsLabel} — stay details load automatically when the guest drawer is open.
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
