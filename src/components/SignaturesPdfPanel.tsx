import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SignatureLogEntry } from '../shared/protocol'
import { fetchDecryptSignaturePdf } from '../lib/signature-pdf'
import {
  addLocalDays,
  clampDateRange,
  daysInRange,
  formatHistoryNavLabel,
  localDateString,
} from '../lib/local-date'

type SignaturesPdfPanelProps = {
  signedIn: boolean
  userRole: string | null
  hasManagerPin: boolean
}

function formatSignedWhen(iso: string): string {
  if (!iso?.trim()) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function SignaturesPdfPanel({
  signedIn,
  userRole,
  hasManagerPin,
}: SignaturesPdfPanelProps) {
  const today = useMemo(() => localDateString(), [])
  const isAdmin = userRole === 'admin'

  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [agentFilter, setAgentFilter] = useState('')
  const [roomFilter, setRoomFilter] = useState('')
  const [listSearch, setListSearch] = useState('')
  const [rows, setRows] = useState<SignatureLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewBlobUrlRef = useRef<string | null>(null)

  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const [editUnlocked, setEditUnlocked] = useState(false)
  const [showPinEntry, setShowPinEntry] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)

  const jumpDateRef = useRef<HTMLInputElement>(null)

  const canEdit = isAdmin || editUnlocked

  useEffect(() => {
    setEditUnlocked(false)
    setShowPinEntry(false)
    setPinInput('')
    setPinError(null)
  }, [signedIn, userRole])

  const applyRangeShift = useCallback(
    (deltaDays: number) => {
      const { from, to } = clampDateRange(fromDate, toDate)
      let nextFrom = addLocalDays(from, deltaDays)
      let nextTo = addLocalDays(to, deltaDays)
      if (nextTo > today) {
        const span = daysInRange(from, to)
        nextTo = today
        nextFrom = addLocalDays(today, -(span - 1))
      }
      setFromDate(nextFrom)
      setToDate(nextTo)
    },
    [fromDate, toDate, today],
  )

  const shiftRangeByWeek = useCallback(
    (direction: -1 | 1) => {
      const { from, to } = clampDateRange(fromDate, toDate)
      const span = daysInRange(from, to)
      applyRangeShift(direction * Math.min(7, span))
    },
    [fromDate, toDate, applyRangeShift],
  )

  const jumpToDate = useCallback((iso: string) => {
    if (!iso) return
    setFromDate(iso)
    setToDate(iso)
  }, [])

  const loadSignatures = useCallback(async () => {
    if (!signedIn) {
      setRows([])
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { from, to } = clampDateRange(fromDate, toDate)
      const res = (await chrome.runtime.sendMessage({
        type: 'GET_SIGNATURES_BY_DATE',
        fromDate: from,
        toDate: to,
        agentFilter: agentFilter.trim() || undefined,
      })) as { ok: boolean; signatureLog?: SignatureLogEntry[]; error?: string }
      if (!res.ok) {
        setRows([])
        setError(res.error ?? 'Could not load signature PDFs')
        return
      }
      setRows(res.signatureLog ?? [])
    } catch (e) {
      setRows([])
      setError(e instanceof Error ? e.message : 'Could not load signature PDFs')
    } finally {
      setLoading(false)
    }
  }, [signedIn, fromDate, toDate, agentFilter])

  useEffect(() => {
    void loadSignatures()
  }, [loadSignatures])

  const filteredRows = useMemo(() => {
    const roomTerm = roomFilter.trim().toLowerCase()
    let list = rows
    if (roomTerm) {
      list = list.filter((r) => (r.roomNumber ?? '').toLowerCase().includes(roomTerm))
    }
    const q = listSearch.trim().toLowerCase()
    if (!q) return list
    return list.filter((r) => {
      const hay = [
        r.confirmationNumber,
        r.guestName,
        r.roomNumber,
        r.signedByUsername,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [rows, roomFilter, listSearch])

  useEffect(() => {
    if (!filteredRows.length) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !filteredRows.some((r) => r.id === selectedId)) {
      setSelectedId(filteredRows[0]!.id)
    }
  }, [filteredRows, selectedId])

  const selected = useMemo(
    () => filteredRows.find((r) => r.id === selectedId) ?? null,
    [filteredRows, selectedId],
  )

  useEffect(() => {
    if (!selected?.storagePath) {
      if (previewBlobUrlRef.current) {
        URL.revokeObjectURL(previewBlobUrlRef.current)
        previewBlobUrlRef.current = null
      }
      setPreviewUrl(null)
      setPreviewLoading(false)
      setPreviewError(null)
      return
    }

    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)

    void fetchDecryptSignaturePdf(selected.storagePath)
      .then((blob) => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        if (previewBlobUrlRef.current) URL.revokeObjectURL(previewBlobUrlRef.current)
        previewBlobUrlRef.current = url
        setPreviewUrl(url)
      })
      .catch((e) => {
        if (!cancelled) {
          setPreviewError(e instanceof Error ? e.message : 'Could not load PDF')
          setPreviewUrl(null)
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })

    return () => {
      cancelled = true
      if (previewBlobUrlRef.current) {
        URL.revokeObjectURL(previewBlobUrlRef.current)
        previewBlobUrlRef.current = null
      }
      setPreviewUrl(null)
    }
  }, [selected?.id, selected?.storagePath])

  const verifyPin = useCallback(async () => {
    const pin = pinInput.trim()
    if (!pin) return
    setPinBusy(true)
    setPinError(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'VERIFY_MANAGER_PIN',
        pin,
      })) as { ok: boolean; error?: string }
      if (!res.ok) {
        setPinError(res.error ?? 'Invalid PIN')
        return
      }
      setEditUnlocked(true)
      setShowPinEntry(false)
      setPinInput('')
    } catch (e) {
      setPinError(e instanceof Error ? e.message : 'Could not verify PIN')
    } finally {
      setPinBusy(false)
    }
  }, [pinInput])

  const handleDownload = useCallback(async () => {
    if (!selected || !canEdit) return
    setDownloading(true)
    setDownloadError(null)
    try {
      const blob = await fetchDecryptSignaturePdf(selected.storagePath)
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = `signature_${selected.confirmationNumber}_${selected.createdAt.slice(0, 10)}.pdf`
      a.click()
      setTimeout(() => URL.revokeObjectURL(href), 10_000)
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setDownloading(false)
    }
  }, [selected, canEdit])

  const handleExportCsv = useCallback(() => {
    if (!canEdit || filteredRows.length === 0) return
    const header = ['Date Signed', 'Agent', 'Confirmation #', 'Room #', 'Guest']
    const csvRows = [
      header,
      ...filteredRows.map((s) => [
        new Date(s.createdAt).toLocaleString(),
        s.signedByUsername ?? '',
        s.confirmationNumber,
        s.roomNumber ?? '',
        s.guestName ?? '',
      ]),
    ]
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = `signature_log_${fromDate}_to_${toDate}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(href), 10_000)
  }, [canEdit, filteredRows, fromDate, toDate])

  const navLabel = formatHistoryNavLabel(fromDate, toDate)
  const headerGuest =
    selected?.guestName?.trim() || selected?.confirmationNumber || 'Select a PDF'

  if (!signedIn) {
    return (
      <section className="fdn-panel fdn-panel--signature">
        <p className="fdn-muted">Sign in to view signature PDFs.</p>
      </section>
    )
  }

  return (
    <section className="fdn-panel fdn-panel--signature" aria-label="Signature PDFs">
      <div className="fdn-sig-log__toolbar">
        <div className="fdn-id-log__toolbar-head">
          <h2 className="fdn-id-log__title">Signature PDFs</h2>
          <p className="fdn-id-log__subtitle">Filter by date, select a row to preview</p>
        </div>

        {!isAdmin && !canEdit ? (
          <div className="fdn-sig-log__unlock">
            <p className="fdn-sig-log__unlock-text">
              View-only mode. Admin PIN required to download or export.
            </p>
            {hasManagerPin ? (
              showPinEntry ? (
                <div className="fdn-sig-log__pin-row">
                  <input
                    type="password"
                    className="fdn-input fdn-sig-log__pin-input"
                    placeholder="Admin PIN"
                    value={pinInput}
                    autoFocus
                    onChange={(e) => setPinInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void verifyPin()
                    }}
                  />
                  <button
                    type="button"
                    className="fdn-btn fdn-btn--primary fdn-btn--xs"
                    disabled={!pinInput.trim() || pinBusy}
                    onClick={() => void verifyPin()}
                  >
                    {pinBusy ? '…' : 'Unlock'}
                  </button>
                  <button
                    type="button"
                    className="fdn-btn fdn-btn--secondary fdn-btn--xs"
                    onClick={() => {
                      setShowPinEntry(false)
                      setPinInput('')
                      setPinError(null)
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="fdn-btn fdn-btn--secondary fdn-btn--xs"
                  onClick={() => {
                    setShowPinEntry(true)
                    setPinError(null)
                  }}
                >
                  Enter admin PIN
                </button>
              )
            ) : (
              <p className="fdn-muted fdn-sig-log__unlock-hint">No admin PIN configured.</p>
            )}
            {pinError ? (
              <p className="fdn-form-error fdn-sig-log__pin-error" role="alert">
                {pinError}
              </p>
            ) : null}
          </div>
        ) : isAdmin ? (
          <p className="fdn-sig-log__role-badge fdn-sig-log__role-badge--admin">Admin — full access</p>
        ) : (
          <p className="fdn-sig-log__role-badge">Unlocked — download &amp; export enabled</p>
        )}

        <label className="fdn-id-log__search">
          <span className="fdn-sr-only">Search PDF list</span>
          <input
            className="fdn-input fdn-id-log__search-input"
            type="text"
            role="searchbox"
            placeholder="Confirmation, guest, room, agent…"
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {listSearch.trim() ? (
            <button
              type="button"
              className="fdn-btn fdn-btn--ghost fdn-btn--xs fdn-id-log__search-clear"
              onClick={() => setListSearch('')}
              aria-label="Clear search"
            >
              ×
            </button>
          ) : null}
        </label>

        <div className="fdn-id-log__date-nav" role="group" aria-label="Date navigation">
          <button
            type="button"
            className="fdn-id-log__nav-btn"
            title="Previous week"
            aria-label="Previous week"
            onClick={() => shiftRangeByWeek(-1)}
          >
            «
          </button>
          <button
            type="button"
            className="fdn-id-log__nav-btn"
            title="Previous day"
            aria-label="Previous day"
            onClick={() => applyRangeShift(-1)}
          >
            ‹
          </button>
          <div className="fdn-id-log__date-display">
            <span className="fdn-id-log__date-label">{navLabel}</span>
            <button
              type="button"
              className="fdn-id-log__date-jump"
              title="Jump to date"
              aria-label="Jump to date"
              onClick={() => jumpDateRef.current?.showPicker?.() ?? jumpDateRef.current?.click()}
            >
              📅
            </button>
            <input
              ref={jumpDateRef}
              className="fdn-id-log__date-jump-input"
              type="date"
              value={fromDate === toDate ? fromDate : fromDate}
              max={today}
              aria-hidden
              tabIndex={-1}
              onChange={(e) => jumpToDate(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="fdn-id-log__nav-btn"
            title="Next day"
            aria-label="Next day"
            disabled={toDate >= today}
            onClick={() => applyRangeShift(1)}
          >
            ›
          </button>
          <button
            type="button"
            className="fdn-id-log__nav-btn"
            title="Next week"
            aria-label="Next week"
            disabled={toDate >= today}
            onClick={() => shiftRangeByWeek(1)}
          >
            »
          </button>
        </div>

        <div className="fdn-id-log__filters">
          <label className="fdn-label fdn-label--compact">
            <span className="fdn-label__text">From</span>
            <input
              className="fdn-input"
              type="date"
              value={fromDate}
              max={toDate || today}
              onChange={(e) => {
                const next = e.target.value
                setFromDate(next)
                if (next > toDate) setToDate(next)
              }}
            />
          </label>
          <label className="fdn-label fdn-label--compact">
            <span className="fdn-label__text">To</span>
            <input
              className="fdn-input"
              type="date"
              value={toDate}
              min={fromDate}
              max={today}
              onChange={(e) => {
                const next = e.target.value
                setToDate(next)
                if (next < fromDate) setFromDate(next)
              }}
            />
          </label>
          <label className="fdn-label fdn-label--compact">
            <span className="fdn-label__text">Agent</span>
            <input
              className="fdn-input"
              type="text"
              placeholder="Filter…"
              value={agentFilter}
              onChange={(e) => setAgentFilter(e.target.value)}
            />
          </label>
          <label className="fdn-label fdn-label--compact">
            <span className="fdn-label__text">Room #</span>
            <input
              className="fdn-input"
              type="text"
              placeholder="Room"
              value={roomFilter}
              onChange={(e) => setRoomFilter(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="fdn-btn fdn-btn--secondary fdn-btn--xs fdn-id-log__reload"
            disabled={loading}
            onClick={() => void loadSignatures()}
          >
            {loading ? 'Loading…' : 'Reload'}
          </button>
          <button
            type="button"
            className="fdn-btn fdn-btn--secondary fdn-btn--xs fdn-sig-log__export"
            disabled={!canEdit || filteredRows.length === 0}
            title={!canEdit ? 'Enter admin PIN to export' : 'Export CSV'}
            onClick={handleExportCsv}
          >
            Export CSV
          </button>
        </div>

        <p className="fdn-id-log__count">
          {loading
            ? 'Loading PDFs…'
            : `${filteredRows.length} PDF${filteredRows.length !== 1 ? 's' : ''} in range${
                roomFilter.trim() || listSearch.trim() ? ' (filtered)' : ''
              }`}
        </p>
      </div>

      {(error || previewError || downloadError) && (
        <p className="fdn-form-error" role="alert">
          {error ?? previewError ?? downloadError}
        </p>
      )}

      <div className="fdn-sig-log__body">
        <div className="fdn-sig-log__list-wrap">
          {loading && filteredRows.length === 0 ? (
            <p className="fdn-muted fdn-id-log__empty">Loading signatures…</p>
          ) : filteredRows.length === 0 ? (
            <p className="fdn-muted fdn-id-log__empty">No PDFs for these filters.</p>
          ) : (
            <table className="fdn-table fdn-table--compact fdn-id-log__table">
              <thead>
                <tr>
                  <th>Room</th>
                  <th>Guest</th>
                  <th>Signed</th>
                  <th className="fdn-id-log__col-conf">Conf.</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => (
                  <tr
                    key={r.id}
                    className={selectedId === r.id ? 'fdn-id-log__row--active' : 'fdn-id-log__row'}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <td className="fdn-mono fdn-sig-log__cell-room">{r.roomNumber ?? '—'}</td>
                    <td className="fdn-id-log__cell-guest" title={r.guestName ?? ''}>
                      {r.guestName ?? '—'}
                    </td>
                    <td className="fdn-id-log__cell-when">{formatSignedWhen(r.createdAt)}</td>
                    <td className="fdn-id-log__cell-conf" title={r.confirmationNumber}>
                      {r.confirmationNumber}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="fdn-sig-log__preview">
          <div className="fdn-sig-log__preview-head">
            <div className="fdn-sig-log__preview-title-wrap">
              <h3 className="fdn-sig-log__preview-title" title={headerGuest}>
                {headerGuest}
              </h3>
              {selected ? (
                <p className="fdn-sig-log__preview-meta">
                  <span className="fdn-mono">{selected.confirmationNumber}</span>
                  {selected.signedByUsername ? <> · {selected.signedByUsername}</> : null}
                  {' · '}
                  {formatSignedWhen(selected.createdAt)}
                </p>
              ) : null}
            </div>
            <div className="fdn-sig-log__preview-actions">
              <button
                type="button"
                className="fdn-btn fdn-btn--secondary fdn-btn--xs"
                disabled={!selected || !canEdit || downloading || previewLoading}
                title={!canEdit ? 'Enter admin PIN to download' : 'Download PDF'}
                onClick={() => void handleDownload()}
              >
                {downloading ? '…' : 'Download'}
              </button>
              {previewUrl && canEdit ? (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="fdn-btn fdn-btn--secondary fdn-btn--xs fdn-sig-log__open-link"
                >
                  Open
                </a>
              ) : (
                <button
                  type="button"
                  className="fdn-btn fdn-btn--secondary fdn-btn--xs"
                  disabled
                  title={!canEdit ? 'Enter admin PIN to open' : 'Open PDF'}
                >
                  Open
                </button>
              )}
            </div>
          </div>

          <div className="fdn-sig-log__preview-frame-wrap">
            {!selected ? (
              <p className="fdn-muted fdn-sig-log__preview-empty">
                Select a row above to preview the registration card PDF.
              </p>
            ) : previewLoading ? (
              <p className="fdn-muted fdn-sig-log__preview-empty">Decrypting PDF…</p>
            ) : previewUrl ? (
              <iframe
                className="fdn-sig-log__iframe"
                title="PDF preview"
                src={previewUrl}
              />
            ) : (
              <p className="fdn-muted fdn-sig-log__preview-empty">Could not load preview.</p>
            )}
          </div>
        </div>
      </div>

      <details className="fdn-sig-log__capture-hint">
        <summary>How to capture a new signature</summary>
        <ol className="fdn-steps fdn-steps--compact">
          <li>Open the guest in PMS and print or open the registration card.</li>
          <li>Sign on the overlay that appears on the card popup.</li>
          <li>Tap <strong>Save Signature</strong> — it uploads automatically.</li>
        </ol>
      </details>
    </section>
  )
}
