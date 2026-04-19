import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExtensionState,
  IdScanHistoryRow,
  NativeIdScanBroadcast,
  PanelToastBroadcast,
} from './shared/protocol'
import type { IdScanDetailGuru, ParsedIdFields } from './shared/pms-types'
import { base64ToDataUrl } from './lib/imageDataUrl'
import { ageLabelFromDobString, mergeParsedWithGuru } from './lib/id-guru-fields'
import { transformBase64ImageSync } from './lib/imageTransform'
import { splitGuestName } from './lib/name-format'
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
  const [scanImageB64Length, setScanImageB64Length] = useState<number | null>(null)
  const [lastOcrProvider, setLastOcrProvider] = useState<string | null>(null)
  const [idDetail, setIdDetail] = useState<IdScanDetailGuru>(emptyIdDetail)
  const [guestRemark, setGuestRemark] = useState('')
  const [checkInRemark, setCheckInRemark] = useState('')
  const [rotationDeg, setRotationDeg] = useState(0)
  const [flipH, setFlipH] = useState(false)
  const [idScanHistory, setIdScanHistory] = useState<IdScanHistoryRow[]>([])

  const refreshIdScanHistory = useCallback(async () => {
    const res = (await chrome.runtime.sendMessage({ type: 'GET_ID_SCAN_HISTORY' })) as {
      ok?: boolean
      idScanHistory?: IdScanHistoryRow[]
    }
    if (res.ok && res.idScanHistory) setIdScanHistory(res.idScanHistory)
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

  useEffect(() => {
    void refreshIdScanHistory()
  }, [refreshIdScanHistory, state?.reservation?.confirmationNumber])

  const applyNativeIdScan = useCallback(
    (m: NativeIdScanBroadcast) => {
      setParsed(m.parsed)
      setLastOcrProvider(m.ocrProvider)
      setIdDetail(m.detail ?? emptyIdDetail)
      setScanImages({
        front: m.images.front_image_base64,
        back: m.images.back_image_base64,
      })
      setScanImageB64Length(m.imageBase64Length)
      setRotationDeg(0)
      setFlipH(false)
      if (m.detail?.phone?.trim()) setPhone(m.detail.phone.trim())
      if (m.detail?.email?.trim()) setEmailGuest(m.detail.email.trim())
      if (m.autoSave.ok) {
        setNotice('Thales scan received — saved to Supabase.')
      } else {
        setNotice(`Thales scan received — not saved: ${m.autoSave.error}`)
      }
      void refresh()
      void refreshIdScanHistory()
    },
    [refresh, refreshIdScanHistory],
  )

  useEffect(() => {
    const onRuntimeMessage = (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return
      const m = msg as { type?: string }
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

  async function onSave() {
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
        documentData: null,
        guestRemark: guestRemark.trim() || null,
        checkInRemark: checkInRemark.trim() || null,
      })) as { ok: boolean; error?: string }
      if (!res.ok) {
        const err = res.error ?? 'Save failed'
        setNotice(err)
        if (err.includes('DNR')) setShowManagerModal(true)
        return
      }
      setNotice('Saved to Supabase.')
      setManagerOverride(false)
      setShowManagerModal(false)
      void refresh()
      void refreshIdScanHistory()
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

  async function onInjectPms() {
    const split = splitGuestName(parsed.fullName)
    const firstName = idDetail.firstName?.trim() || split.firstName
    const lastName = idDetail.lastName?.trim() || split.lastName
    const structuredAddr = [
      idDetail.streetAddress,
      idDetail.city,
      idDetail.state,
      idDetail.postalCode,
    ]
      .filter(Boolean)
      .join(', ')
    setBusy(true)
    setNotice(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'INJECT_PMS',
        fields: {
          firstName,
          lastName,
          middleName: idDetail.middleName ?? '',
          phone: phone.trim(),
          email: emailGuest.trim(),
          address: structuredAddr || (parsed.address ?? ''),
        },
      })) as { ok: boolean; error?: string; inject?: { ok: boolean; error?: string; applied?: string[] } }
      if (!res.ok) {
        setNotice(res.error ?? 'Inject failed')
        return
      }
      const inj = res.inject
      if (inj && 'ok' in inj && inj.ok) {
        setNotice(`Injected fields: ${(inj.applied ?? []).join(', ')}`)
      } else if (inj && 'ok' in inj && !inj.ok) {
        setNotice(inj.error ?? 'PMS inject reported failure')
      }
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

  return (
    <div className="fdn-root">
      {toastBanner}

      <header className="fdn-header">
        <h1 className="fdn-title">FrontDesk Nexus</h1>
        <p className="fdn-sub">Side panel · Module 1 (ID)</p>
      </header>

      <section className="fdn-card">
        <h2 className="fdn-h2">Session</h2>
        {state.auth.signedIn ? (
          <>
            <p className="fdn-line">
              <strong>{state.auth.email}</strong>
              <span className="fdn-badge">{state.auth.role ?? 'role?'}</span>
            </p>
            <button type="button" className="fdn-btn fdn-btn--ghost" onClick={() => void onLogout()}>
              Log out
            </button>
          </>
        ) : (
          <form className="fdn-form" onSubmit={(e) => void onDevLogin(e)}>
            <p className="fdn-help">
              Production uses the portal session bridge. Use this for development only.
            </p>
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
        )}
      </section>

      <section className="fdn-card">
        <h2 className="fdn-h2">Hardware</h2>
        <ul className="fdn-hw">
          <li>
            ID scanner{' '}
            <span className={hw.id_scanner === 'connected' ? 'fdn-dot fdn-dot--ok' : 'fdn-dot fdn-dot--bad'} />
            {hw.id_scanner}
          </li>
          <li>
            Spectral Payout{' '}
            <span className={hw.spectral_payout === 'connected' ? 'fdn-dot fdn-dot--ok' : 'fdn-dot fdn-dot--bad'} />
            {hw.spectral_payout}
          </li>
          <li>
            RFID encoder{' '}
            <span className={hw.rfid_encoder === 'connected' ? 'fdn-dot fdn-dot--ok' : 'fdn-dot fdn-dot--bad'} />
            {hw.rfid_encoder}
          </li>
        </ul>
      </section>

      <section className="fdn-card">
        <h2 className="fdn-h2">Guest Data (SynXis API)</h2>
        <p className="fdn-help">
          Uses a fixed sample reservation-summary request. Stay signed into SynXis in this browser so
          sph.synxis.com can send cookies with the request.
        </p>
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
        <p className="fdn-help">
          Reads the Ant Design guest drawer on live.ipms247.com (not an iframe). The extension auto-loads
          within a few seconds when you open a guest; use the button if the drawer is already open.
        </p>
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
        <h2 className="fdn-h2">Module status</h2>
        <div className="fdn-modules">
          <span className="fdn-mod">ID · in progress</span>
          <span className="fdn-mod fdn-mod--off">Payment</span>
          <span className="fdn-mod fdn-mod--off">Signature</span>
          <span className="fdn-mod fdn-mod--off">Key</span>
        </div>
      </section>

      <section className="fdn-card fdn-card--idguru">
        <h2 className="fdn-h2">ID scan (ID Guru–style)</h2>
        <p className="fdn-help">
          The native app captures <strong>front</strong> then <strong>back</strong> (or the reverse); it must
          label which image is which and send <code>image_front_base64</code> + <code>image_back_base64</code> in
          one <code>AUTO_SCAN_RESULT</code> with merged <code>document_data</code>. Legacy single{' '}
          <code>image_base64</code> is still accepted (duplicated to both sides). Rotate/flip applies to{' '}
          <strong>both</strong> previews on save. History lists prior <code>id_scans</code> for this confirmation.
        </p>
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
            {scanImageB64Length != null ? ` · image base64 length ${scanImageB64Length}` : null}
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
          <label className="fdn-label">
            First name
            <input
              className="fdn-input"
              value={idDetail.firstName ?? ''}
              onChange={(e) =>
                setIdDetail((d) => ({ ...d, firstName: e.target.value.trim() || null }))
              }
            />
          </label>
          <label className="fdn-label">
            Middle name
            <input
              className="fdn-input"
              value={idDetail.middleName ?? ''}
              onChange={(e) =>
                setIdDetail((d) => ({ ...d, middleName: e.target.value.trim() || null }))
              }
            />
          </label>
          <label className="fdn-label">
            Last name
            <input
              className="fdn-input"
              value={idDetail.lastName ?? ''}
              onChange={(e) =>
                setIdDetail((d) => ({ ...d, lastName: e.target.value.trim() || null }))
              }
            />
          </label>
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
              onChange={(e) => setIdDetail((d) => ({ ...d, city: e.target.value.trim() || null }))}
            />
          </label>
          <label className="fdn-label">
            State
            <input
              className="fdn-input"
              value={idDetail.state ?? ''}
              onChange={(e) => setIdDetail((d) => ({ ...d, state: e.target.value.trim() || null }))}
            />
          </label>
          <label className="fdn-label">
            Zip / postal
            <input
              className="fdn-input"
              value={idDetail.postalCode ?? ''}
              onChange={(e) =>
                setIdDetail((d) => ({ ...d, postalCode: e.target.value.trim() || null }))
              }
            />
          </label>
          <label className="fdn-label">
            Phone
            <span className="fdn-inline fdn-inline--phone">
              <input className="fdn-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <label className="fdn-check fdn-check--inline">
                <input
                  type="checkbox"
                  checked={idDetail.usaCaPhone === true}
                  onChange={(e) =>
                    setIdDetail((d) => ({ ...d, usaCaPhone: e.target.checked ? true : null }))
                  }
                />
                USA/CA
              </label>
            </span>
          </label>
          <label className="fdn-label">
            Country code
            <input
              className="fdn-input"
              placeholder="+1"
              value={idDetail.phoneCountryCode ?? ''}
              onChange={(e) =>
                setIdDetail((d) => ({ ...d, phoneCountryCode: e.target.value.trim() || null }))
              }
            />
          </label>
          <label className="fdn-label">
            Email (guest)
            <input className="fdn-input" value={emailGuest} onChange={(e) => setEmailGuest(e.target.value)} />
          </label>
          <label className="fdn-label">
            ID type
            <input
              className="fdn-input"
              value={parsed.idType ?? ''}
              onChange={(e) => setParsed({ ...parsed, idType: e.target.value || null })}
            />
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
          <label className="fdn-label fdn-label--full">
            Full name (combined)
            <input
              className="fdn-input"
              value={parsed.fullName ?? ''}
              onChange={(e) => setParsed({ ...parsed, fullName: e.target.value || null })}
            />
          </label>
          <label className="fdn-label fdn-label--full">
            Address (single line)
            <input
              className="fdn-input"
              value={parsed.address ?? ''}
              onChange={(e) => setParsed({ ...parsed, address: e.target.value || null })}
            />
          </label>
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
          <p className="fdn-muted fdn-id-history__hint">
            Same confirmation as the loaded guest; future: match by document number across stays.
          </p>
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
            onClick={() => void onSave()}
          >
            Save to Supabase
          </button>
          <button
            type="button"
            className="fdn-btn fdn-btn--secondary"
            disabled={busy || !state.auth.signedIn}
            onClick={() => void onInjectPms()}
          >
            Save &amp; write to PMS (inject)
          </button>
        </div>
      </section>

      {notice && <div className="fdn-banner fdn-banner--info">{notice}</div>}
      {state.lastError && <div className="fdn-banner fdn-banner--danger">{state.lastError}</div>}

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
