import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExtensionState,
  GuestStayHistoryRecord,
  IdScanHistoryRow,
  KeyHistoryRow,
  NativeHostRxDebugBroadcast,
  NativeIdScanBroadcast,
  PanelToastBroadcast,
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

function formatSdkDateTime(s: string | null | undefined): string {
  if (!s?.trim()) return '—'
  if (s.length >= 12) {
    const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T${s.slice(8,10)}:${s.slice(10,12)}:00`)
    if (!Number.isNaN(d.getTime())) return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }
  return s
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
  const [notice, setNotice] = useState<string | null>(null)
  const [panelToast, setPanelToast] = useState<{
    confirmationNumber: string
    detail?: string
    variant: NonNullable<PanelToastBroadcast['variant']>
  } | null>(null)
  const panelToastTimerRef = useRef(0)
  const [scanImages, setScanImages] = useState<{
    front: string
    back: string
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

  // Reset key serial to 1 when a new reservation is loaded
  useEffect(() => {
    setKeyCardSerial(1)
  }, [state?.reservation?.confirmationNumber])

  function clearIdScan() {
    setParsed(emptyParsed)
    setIdDetail(emptyIdDetail)
    setPhone('')
    setEmailGuest('')
    setScanImages(null)
    setLastOcrProvider(null)
    setLastDocumentData(null)
    setLastScanReceivedAt(null)
    setRotationDeg(0)
    setFlipH(false)
    setGuestRemark('')
    setCheckInRemark('')
    setNotice(null)
    zipLookupAbortRef.current?.abort()
    lastZipLookupRef.current = null
    setZipLookupBusy(false)
    setZipLookupNote(null)
    setGuestHistoryBusy(false)
    setGuestHistoryNote(null)
    lastPhoneLookupRef.current = null
    void chrome.storage.local.remove('fdn_last_native_scan')
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
        setNotice('Thales scan received — saved to Supabase.')
      } else if ('ok' in m.autoSave && !m.autoSave.ok && 'error' in m.autoSave && m.autoSave.error) {
        setNotice(`Thales scan received — not saved: ${m.autoSave.error}`)
      } else {
        setNotice('Thales scan received — not saved: unknown error')
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
        const t = msg as PanelToastBroadcast
        if (!t.confirmationNumber) return
        window.clearTimeout(panelToastTimerRef.current)
        setPanelToast({
          confirmationNumber: t.confirmationNumber,
          detail: t.detail,
          variant: t.variant === 'warn' ? 'warn' : 'success',
        })
        void refresh()
        panelToastTimerRef.current = window.setTimeout(() => setPanelToast(null), 3000)
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
      window.clearTimeout(panelToastTimerRef.current)
    }
  }, [refresh, applyNativeIdScan])

  const scanPreviewUrls = useMemo(() => {
    if (!scanImages) return null
    try {
      return {
        front: base64ToDataUrl(scanImages.front),
        back: base64ToDataUrl(scanImages.back),
      }
    } catch {
      return null
    }
  }, [scanImages])

  async function onDevLogin(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setNotice(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'AUTH_DEV_LOGIN',
        email,
        password,
      })) as { ok: boolean; error?: string }
      if (!res.ok) setNotice(res.error ?? 'Login failed')
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
      setNotice(requiredErr)
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      let frontB64 = scanImages?.front ?? null
      let backB64 = scanImages?.back ?? null
      if ((frontB64 || backB64) && (rotationDeg !== 0 || flipH)) {
        try {
          if (frontB64) frontB64 = await transformBase64ImageSync(frontB64, rotationDeg, flipH)
          if (backB64) backB64 = await transformBase64ImageSync(backB64, rotationDeg, flipH)
        } catch (e) {
          setNotice(e instanceof Error ? e.message : 'Could not apply image rotation.')
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
      setNotice('Saved to Supabase.')
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
                first_name:   detailForSave.firstName   ?? null,
                middle_name:  detailForSave.middleName  ?? null,
                last_name:    detailForSave.lastName     ?? null,
                address:      detailForSave.streetAddress ?? null,
                city:         detailForSave.city         ?? null,
                state:        detailForSave.state        ?? null,
                postal_code:  detailForSave.postalCode   ?? null,
                phone:        phone.trim() || null,
                email:        emailGuest.trim() || null,
                gender:       (typeof docData.gender === 'string' ? docData.gender
                               : typeof (docData as Record<string,unknown>).sex === 'string'
                                 ? (docData as Record<string,unknown>).sex as string
                               : null),
                dob:           mergedParsed.dateOfBirth ?? null,
                id_number:     mergedParsed.idNumber ?? null,
                expiry_date:   mergedParsed.expiryDate ?? null,
                issue_date:    mergedParsed.issueDate ?? null,
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
        setNotice(res.error ?? 'Verification failed')
        return
      }
      setManagerOverride(true)
      setShowManagerModal(false)
      setNotice('Manager verified — you can save with override.')
    } finally {
      setBusy(false)
    }
  }


  async function onGetGuestData() {
    setBusy(true)
    setNotice(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'LOAD_SYNXIS_RESERVATION',
      })) as { ok: boolean; error?: string; state?: ExtensionState; message?: string }
      if (!res.ok) {
        setNotice(res.error ?? 'Could not load reservation.')
        return
      }
      if (res.state) setState(res.state)
      setNotice(res.message ?? 'Guest data loaded.')
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  async function onGetEzeeGuestData() {
    setBusy(true)
    setNotice(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'LOAD_EZEE_RESERVATION',
      })) as { ok: boolean; error?: string; state?: ExtensionState; message?: string }
      if (!res.ok) {
        setNotice(res.error ?? 'Could not load eZee reservation.')
        return
      }
      if (res.state) setState(res.state)
      setNotice(res.message ?? 'eZee guest data loaded.')
      void refresh()
    } finally {
      setBusy(false)
    }
  }

  async function onMakeKey() {
    if (!res?.roomNumber || !res?.checkInDate || !res?.checkOutDate) return
    setKeyBusy(true)
    setKeyNotice(null)
    try {
      const result = (await chrome.runtime.sendMessage({
        type: 'RFID_MAKE_KEY',
        roomNumber: res.roomNumber,
        checkinTime: res.checkInDate,
        checkoutTime: res.checkOutDate,
        cardSerial: keyCardSerial,
      })) as { ok: boolean; error?: string; dbWarning?: string; state?: ExtensionState } | undefined
      if (!result) {
        setKeyNotice('No response from native host — reload the extension and try again.')
        return
      }
      if (!result.ok) {
        setKeyNotice(result.error ?? 'Key encoding failed')
        return
      }
      if (result.dbWarning) {
        setKeyNotice(`Card encoded — room ${res.roomNumber}, serial ${keyCardSerial}. Warning: ${result.dbWarning}`)
      } else {
        setKeyNotice(`Key encoded — room ${res.roomNumber}, serial ${keyCardSerial}.`)
      }
      if (result.state) setState(result.state)
      void refreshKeyHistory()
    } catch (e) {
      setKeyNotice(e instanceof Error ? e.message : 'Key encoding failed — check device connection.')
    } finally {
      setKeyBusy(false)
    }
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

  const toastBanner =
    panelToast != null ? (
      <div
        className={`fdn-panel-toast fdn-panel-toast--${panelToast.variant}`}
        role="status"
        aria-live="polite"
      >
        <div className="fdn-panel-toast__label">Confirmation</div>
        <div className="fdn-panel-toast__conf">{panelToast.confirmationNumber}</div>
        {panelToast.detail ? (
          <div className="fdn-panel-toast__detail">{panelToast.detail}</div>
        ) : null}
      </div>
    ) : null

  if (!state) {
    return (
      <div className="fdn-root">
        {toastBanner}
        <p className="fdn-muted">Loading…</p>
      </div>
    )
  }

  if (state.versionBlocked) {
    return (
      <div className="fdn-root">
        {toastBanner}
        <div className="fdn-banner fdn-banner--danger">{state.versionMessage}</div>
      </div>
    )
  }

  const res = state.reservation
  const guest = state.synxisGuestDisplay
  const ezee = state.ezeeGuestDisplay
  const hw = state.hardware
  const idAgeLabel = ageLabelFromDobString(parsed.dateOfBirth)

  return (
    <div className="fdn-root">
      {toastBanner}

      <header className="fdn-header">
        <h1 className="fdn-title">FrontDesk Nexus</h1>
      </header>

      <section className="fdn-card" style={{ marginBottom: 8 }}>
        <div className="fdn-modules">
          <span className="fdn-mod">ID · in progress</span>
          <span className="fdn-mod fdn-mod--off">Payment</span>
          <span className="fdn-mod fdn-mod--off">Signature</span>
          {hw.rfid_encoder !== 'connected' ? (
            <span className="fdn-mod fdn-mod--off">Key · offline</span>
          ) : keyHistory.length > 0 ? (
            <span className="fdn-mod">Key · {keyHistory.length} encoded</span>
          ) : (
            <span className="fdn-mod fdn-mod--off">Key · ready</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11, color: '#8b949e', flexWrap: 'wrap', alignItems: 'center' }}>
          <span>
            <span className={hw.id_scanner === 'connected' ? 'fdn-dot fdn-dot--ok' : 'fdn-dot fdn-dot--bad'} />
            ID scanner · {hw.id_scanner}
          </span>
          <span>
            <span className={hw.rfid_encoder === 'connected' ? 'fdn-dot fdn-dot--ok' : 'fdn-dot fdn-dot--bad'} />
            RFID · {hw.rfid_encoder}
          </span>
          {state.auth.signedIn && (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              <strong style={{ color: '#e8eaed', fontSize: 11 }}>{state.auth.email}</strong>
              <span className="fdn-badge">{state.auth.role ?? 'role?'}</span>
              <button type="button" className="fdn-btn fdn-btn--ghost" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => void onLogout()}>
                Sign out
              </button>
            </span>
          )}
        </div>
      </section>

      {!state.auth.signedIn && (
        <section className="fdn-card">
          <h2 className="fdn-h2">Sign in</h2>
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

      <section className="fdn-card fdn-card--idguru">
        <h2 className="fdn-h2">ID scan (ID Guru–style)</h2>
        <label className="fdn-check">
          <input
            type="checkbox"
            checked={manualEntry}
            onChange={(e) => setManualEntry(e.target.checked)}
          />
          Manual entry mode (no scanner / OCR)
        </label>
        {managerOverride && <p className="fdn-note">Manager override active for DNR gate.</p>}
        {!manualEntry && lastOcrProvider && (
          <p className="fdn-muted fdn-line">
            Last scan source: <strong>{lastOcrProvider}</strong>
          </p>
        )}

        {!manualEntry && scanPreviewUrls ? (
          <div className="fdn-id-preview fdn-id-preview--dual">
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
                  <img
                    className="fdn-id-preview__img"
                    src={scanPreviewUrls.back}
                    alt="ID back"
                    style={{
                      transform: `rotate(${rotationDeg}deg) scaleX(${flipH ? -1 : 1})`,
                    }}
                  />
                </div>
              </div>
            </div>
            <div className="fdn-id-preview__toolbar" aria-label="Adjust image orientation (both sides)">
              <button
                type="button"
                className="fdn-id-preview__tool"
                title="Rotate clockwise"
                onClick={() => setRotationDeg((d) => (d + 90) % 360)}
              >
                ↻
              </button>
              <button
                type="button"
                className="fdn-id-preview__tool"
                title="Rotate counter-clockwise"
                onClick={() => setRotationDeg((d) => (d - 90 + 360) % 360)}
              >
                ↺
              </button>
              <button
                type="button"
                className="fdn-id-preview__tool"
                title="Flip horizontal mirror"
                onClick={() => setFlipH((f) => !f)}
              >
                ⇄
              </button>
              <button
                type="button"
                className="fdn-id-preview__tool"
                title="Straighten (reset rotation + flip)"
                onClick={() => {
                  setRotationDeg(0)
                  setFlipH(false)
                }}
              >
                ⊡
              </button>
            </div>
          </div>
        ) : null}

        <div className="fdn-grid fdn-grid--idguru">
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
          <div className="fdn-field fdn-field--full fdn-checkin-times">
            <span className="fdn-field__label">Check-in &amp; timestamps</span>
            <dl className="fdn-kv">
              <dt>ID data received (this scan)</dt>
              <dd title="ISO: local display below">{formatLocalFromIso(lastScanReceivedAt)}</dd>
            </dl>
          </div>
          <label className="fdn-label fdn-label--full">
            Guest remark
            <textarea
              className="fdn-input fdn-textarea"
              rows={2}
              value={guestRemark}
              onChange={(e) => setGuestRemark(e.target.value)}
            />
          </label>
          <label className="fdn-label fdn-label--full">
            Check-in remark
            <textarea
              className="fdn-input fdn-textarea"
              rows={2}
              value={checkInRemark}
              onChange={(e) => setCheckInRemark(e.target.value)}
            />
          </label>
        </div>

        <div className="fdn-id-history">
          <h3 className="fdn-h3 fdn-id-history__title">History (this reservation)</h3>
          {idScanHistory.length === 0 ? (
            <p className="fdn-muted">No prior scans for this confirmation.</p>
          ) : (
            <table className="fdn-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Manual</th>
                  <th>Scan id</th>
                </tr>
              </thead>
              <tbody>
                {idScanHistory.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.scannedAt
                        ? new Date(row.scannedAt).toLocaleString(undefined, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </td>
                    <td>{row.manualEntry ? 'Yes' : 'No'}</td>
                    <td className="fdn-mono">{row.id.slice(0, 8)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="fdn-actions">
          <button
            type="button"
            className="fdn-btn fdn-btn--primary"
            disabled={busy || !state.auth.signedIn}
            onClick={() => void onSave(true)}
          >
            Save DB &amp; PMS
          </button>
          <button
            type="button"
            className="fdn-btn fdn-btn--secondary"
            disabled={busy || !state.auth.signedIn}
            onClick={() => void onSave(false)}
          >
            Save DB
          </button>
          <button
            type="button"
            className="fdn-btn fdn-btn--secondary"
            disabled={busy}
            onClick={clearIdScan}
          >
            Clear
          </button>
        </div>
        {notice && <div className="fdn-banner fdn-banner--info" style={{ marginTop: 8 }}>{notice}</div>}
      </section>

      <section className="fdn-card">
        <h2 className="fdn-h2">Guest Data (SynXis API)</h2>
        <div className="fdn-actions">
          <button
            type="button"
            className="fdn-btn fdn-btn--secondary"
            disabled={busy}
            onClick={() => void onGetGuestData()}
          >
            Get Guest Data
          </button>
        </div>
        {res?.pms === 'ezee' ? (
          <p className="fdn-muted">Active reservation is from eZee — use the eZee section below for details.</p>
        ) : !guest && !res?.confirmationNumber ? (
          <p className="fdn-muted">Click Get Guest Data to load SynXis guest and attach ID scans to a confirmation.</p>
        ) : (
          <dl className="fdn-dl">
            {guest ? (
              <>
                <dt>1. Last, first</dt>
                <dd>{guest.nameLine}</dd>
                <dt>2. Loyalty membershipId</dt>
                <dd>{guest.membershipId ?? '—'}</dd>
                <dt>3. Addresses</dt>
                <dd>
                  {guest.addresses.length === 0
                    ? '—'
                    : guest.addresses.map((a, i) => (
                        <div key={i}>
                          {a.country}, {a.city}, {a.postalCode}, type {a.type}
                        </div>
                      ))}
                </dd>
                <dt>4. Email</dt>
                <dd>{guest.email ?? '—'}</dd>
                <dt>5. Phone</dt>
                <dd>{guest.phone ?? '—'}</dd>
                <dt>6. pmsConfirmationCode</dt>
                <dd>{guest.pmsConfirmationCode ?? '—'}</dd>
                <dt>7. Stay (check-in + nights)</dt>
                <dd>{guest.staySummary ?? '—'}</dd>
              </>
            ) : null}
            {res && res.pms === 'synxis' ? (
              <>
                <dt>PMS</dt>
                <dd>{res.pms}</dd>
                <dt>Room</dt>
                <dd>{res.roomNumber ?? '—'}</dd>
                <dt>Restricted</dt>
                <dd>{res.restricted ? 'Yes — proceed with caution' : 'No'}</dd>
              </>
            ) : null}
          </dl>
        )}
      </section>

      <section className="fdn-card">
        <h2 className="fdn-h2">Guest Data (eZee)</h2>
        <div className="fdn-actions">
          <button
            type="button"
            className="fdn-btn fdn-btn--secondary"
            disabled={busy}
            onClick={() => void onGetEzeeGuestData()}
          >
            Get Guest Data
          </button>
        </div>
        {res?.pms === 'synxis' ? (
          <p className="fdn-muted">Active reservation is from SynXis — use the SynXis section above.</p>
        ) : !ezee && !res?.confirmationNumber ? (
          <p className="fdn-muted">
            Open Arrivals and select a guest so the right-side drawer opens, or click Get Guest Data with the
            drawer visible.
          </p>
        ) : (
          <dl className="fdn-dl">
            {ezee ? (
              <>
                <dt>Guest</dt>
                <dd>{ezee.nameLine ?? '—'}</dd>
                <dt>Address</dt>
                <dd>{ezee.addressLine ?? '—'}</dd>
                <dt>Reservation #</dt>
                <dd>{ezee.reservationNumber}</dd>
                <dt>Status</dt>
                <dd>{ezee.status ?? '—'}</dd>
                <dt>Room</dt>
                <dd>{ezee.roomNumber ?? '—'}</dd>
                <dt>Stay</dt>
                <dd>{ezee.staySummary ?? '—'}</dd>
                <dt>Email</dt>
                <dd>{ezee.email ?? '—'}</dd>
                <dt>Phone</dt>
                <dd>{ezee.phone ?? '—'}</dd>
                <dt>Total</dt>
                <dd>{ezee.total ?? '—'}</dd>
                <dt>Paid</dt>
                <dd>{ezee.paid ?? '—'}</dd>
                <dt>Balance</dt>
                <dd>{ezee.balance ?? '—'}</dd>
              </>
            ) : null}
            {res && res.pms === 'ezee' ? (
              <>
                <dt>PMS</dt>
                <dd>{res.pms}</dd>
                <dt>Room (snapshot)</dt>
                <dd>{res.roomNumber ?? '—'}</dd>
                <dt>Check-in / out</dt>
                <dd>
                  {res.checkInDate ?? '—'} → {res.checkOutDate ?? '—'}
                </dd>
                <dt>Total / paid / balance (snapshot)</dt>
                <dd>
                  {res.reservationTotal ?? '—'} / {res.amountPaid ?? '—'} / {res.dueAmount ?? '—'}
                </dd>
              </>
            ) : null}
          </dl>
        )}
      </section>

      <section className="fdn-card">
        <h2 className="fdn-h2">Key Card Encoder</h2>

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
            <dl className="fdn-dl">
              <dt>Room</dt>
              <dd>{res.roomNumber}</dd>
              <dt>Check-in</dt>
              <dd>{formatHotelDateTime(res.checkInDate, 14)}</dd>
              <dt>Check-out</dt>
              <dd>{formatHotelDateTime(res.checkOutDate, 12)}</dd>
            </dl>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <span style={{ fontSize: 12, color: '#c9d1d9' }}>Key #{keyCardSerial}</span>
              <button
                type="button"
                className="fdn-btn fdn-btn--secondary"
                style={{ padding: '3px 10px', fontSize: 12 }}
                onClick={() => setKeyCardSerial((n) => n + 1)}
              >
                Next key
              </button>
            </div>

            <div className="fdn-actions">
              <button
                type="button"
                className="fdn-btn fdn-btn--primary"
                disabled={keyBusy || hw.rfid_encoder !== 'connected' || !state.auth.signedIn}
                onClick={() => void onMakeKey()}
              >
                {keyBusy ? 'Encoding…' : 'Encode Key'}
              </button>
              <button
                type="button"
                className="fdn-btn fdn-btn--secondary"
                disabled={readCardBusy || hw.rfid_encoder !== 'connected'}
                onClick={() => void onReadCard()}
              >
                {readCardBusy ? 'Reading…' : 'Read Card'}
              </button>
            </div>

            {keyNotice && (
              <div className={`fdn-banner ${keyNotice.startsWith('Key encoded') ? 'fdn-banner--info' : 'fdn-banner--danger'}`} style={{ marginTop: 8 }}>
                {keyNotice}
              </div>
            )}
          </>
        )}

        {readCardResult && (
          <div className={`fdn-banner ${readCardResult.ok ? 'fdn-banner--info' : 'fdn-banner--danger'}`} style={{ marginTop: 8 }}>
            {readCardResult.ok ? (
              readCardResult.roomNumber ? (
                <dl className="fdn-dl" style={{ margin: 0 }}>
                  <dt>Room</dt>
                  <dd>
                    <strong>{readCardResult.roomNumber}</strong>
                    {readCardResult.cardSerial && readCardResult.cardSerial > 1 && (
                      <span style={{ marginLeft: 8, opacity: 0.7 }}>Serial {readCardResult.cardSerial}</span>
                    )}
                  </dd>
                  <dt>Check-in</dt>
                  <dd>{formatHotelDateTime(readCardResult.checkinTime, 14)}</dd>
                  <dt>Check-out</dt>
                  <dd>{formatHotelDateTime(readCardResult.checkoutTime, 12)}</dd>
                </dl>
              ) : (
                <>
                  <strong>Card detected</strong>
                  <div style={{ marginTop: 4, fontSize: '0.75rem', opacity: 0.7 }}>
                    Encoded by another system — room number unavailable
                  </div>
                </>
              )
            ) : (
              `Read failed — ${readCardResult.error}`
            )}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <h3 className="fdn-h3" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em', color: '#8b949e', margin: '0 0 6px' }}>
            Key history (this reservation)
          </h3>
          {keyHistory.length === 0 ? (
            <p className="fdn-muted">No keys encoded for this reservation yet.</p>
          ) : (
            <table className="fdn-table">
              <thead>
                <tr>
                  <th>Encoded at</th>
                  <th>Room</th>
                  <th>Check-in</th>
                  <th>Check-out</th>
                  <th>Serial</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {keyHistory.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.created_at
                        ? new Date(row.created_at).toLocaleString(undefined, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : '—'}
                    </td>
                    <td>{row.room_number}</td>
                    <td>{formatSdkDateTime(row.checkin_time)}</td>
                    <td>{formatSdkDateTime(row.checkout_time)}</td>
                    <td>{row.card_serial}</td>
                    <td className="fdn-mono">{row.encoded_by_username ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

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
