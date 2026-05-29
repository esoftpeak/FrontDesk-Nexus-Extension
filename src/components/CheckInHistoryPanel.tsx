import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IdScanLogEntry } from '../shared/protocol'
import { createIdScanImageSignedUrl } from '../lib/id-scan-storage'
import { localDateString } from '../lib/local-date'

type CheckInHistoryPanelProps = {
  signedIn: boolean
}

function formatScanWhen(iso: string): string {
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

function IdScanStorageImage({ storagePath, label }: { storagePath: string; label: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setUrl(null)
    setError(null)
    void createIdScanImageSignedUrl(storagePath)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load image')
      })
    return () => {
      cancelled = true
    }
  }, [storagePath])

  if (error) return <p className="fdn-muted fdn-id-log__img-msg">{error}</p>
  if (!url) return <p className="fdn-muted fdn-id-log__img-msg">Loading {label}…</p>
  return (
    <a
      className="fdn-id-log__img-link"
      href={url}
      target="_blank"
      rel="noreferrer"
      title="Open full size"
    >
      <img className="fdn-id-log__img" src={url} alt={`ID ${label}`} />
    </a>
  )
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  const v = value?.trim()
  if (!v) return null
  return (
    <div className="fdn-id-log__field">
      <span className="fdn-id-log__field-label">{label}</span>
      <span className="fdn-id-log__field-value">{v}</span>
    </div>
  )
}

export function CheckInHistoryPanel({ signedIn }: CheckInHistoryPanelProps) {
  const today = useMemo(() => localDateString(), [])
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [agentFilter, setAgentFilter] = useState('')
  const [roomFilter, setRoomFilter] = useState('')
  const [rows, setRows] = useState<IdScanLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadScans = useCallback(async () => {
    if (!signedIn) {
      setRows([])
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'GET_ID_SCANS_BY_DATE',
        fromDate,
        toDate,
      })) as { ok: boolean; idScanLog?: IdScanLogEntry[]; error?: string }
      if (!res.ok) {
        setRows([])
        setError(res.error ?? 'Could not load check-in history')
        return
      }
      setRows(res.idScanLog ?? [])
    } catch (e) {
      setRows([])
      setError(e instanceof Error ? e.message : 'Could not load check-in history')
    } finally {
      setLoading(false)
    }
  }, [signedIn, fromDate, toDate])

  useEffect(() => {
    void loadScans()
  }, [loadScans])

  const filteredRows = useMemo(() => {
    const roomTerm = roomFilter.trim().toLowerCase()
    const agentTerm = agentFilter.trim().toLowerCase()
    return rows.filter((r) => {
      if (roomTerm && !(r.roomNumber ?? '').toLowerCase().includes(roomTerm)) return false
      if (agentTerm && !r.agentLabel.toLowerCase().includes(agentTerm)) return false
      return true
    })
  }, [rows, roomFilter, agentFilter])

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

  if (!signedIn) {
    return (
      <section className="fdn-panel fdn-panel--history">
        <p className="fdn-muted">Sign in to view check-in history.</p>
      </section>
    )
  }

  return (
    <section className="fdn-panel fdn-panel--history" aria-label="Check-in history">
      <div className="fdn-id-log__toolbar">
        <div className="fdn-id-log__toolbar-head">
          <h2 className="fdn-id-log__title">Check-in history</h2>
          <p className="fdn-id-log__subtitle">Daily scan log by date range</p>
        </div>
        <div className="fdn-id-log__filters">
          <label className="fdn-label fdn-label--compact">
            <span className="fdn-label__text">From</span>
            <input
              className="fdn-input"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </label>
          <label className="fdn-label fdn-label--compact">
            <span className="fdn-label__text">To</span>
            <input
              className="fdn-input"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
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
            onClick={() => void loadScans()}
          >
            {loading ? 'Loading…' : 'Reload'}
          </button>
        </div>
        <p className="fdn-id-log__count">
          {loading
            ? 'Loading scans…'
            : `${filteredRows.length} of ${rows.length} scan${rows.length !== 1 ? 's' : ''}${
                roomFilter.trim() || agentFilter.trim() ? ' (filtered)' : ''
              }`}
        </p>
      </div>

      {error ? (
        <p className="fdn-form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="fdn-id-log__body">
        <div className="fdn-id-log__list-wrap">
          {loading && rows.length === 0 ? (
            <p className="fdn-muted fdn-id-log__empty">Loading ID scans…</p>
          ) : filteredRows.length === 0 ? (
            <p className="fdn-muted fdn-id-log__empty">No scans match these filters.</p>
          ) : (
            <table className="fdn-table fdn-table--compact fdn-id-log__table">
              <thead>
                <tr>
                  <th>Guest</th>
                  <th>Scanned</th>
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
                    <td className="fdn-id-log__cell-guest" title={r.displayName}>
                      {r.displayName}
                    </td>
                    <td className="fdn-id-log__cell-when">{formatScanWhen(r.scannedAt)}</td>
                    <td className="fdn-id-log__cell-conf" title={r.confirmationNumber}>
                      {r.confirmationNumber}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="fdn-id-log__detail">
          {!selected ? (
            <p className="fdn-muted fdn-id-log__detail-empty">Select a scan to view details.</p>
          ) : (
            <>
              <div className="fdn-id-log__detail-head">
                <h3 className="fdn-id-log__detail-name">{selected.displayName}</h3>
                <p className="fdn-id-log__detail-meta">
                  <span className="fdn-mono">{selected.confirmationNumber}</span>
                  {' · '}
                  {selected.agentLabel}
                  {' · '}
                  {formatScanWhen(selected.scannedAt)}
                  {selected.terminalId ? (
                    <>
                      {' · '}
                      <span className="fdn-mono">{selected.terminalId}</span>
                    </>
                  ) : null}
                </p>
              </div>

              {selected.piiError ? (
                <p className="fdn-form-error fdn-id-log__pii-error" role="alert">
                  {selected.piiError}
                </p>
              ) : null}

              {(selected.imageFrontPath || selected.imageBackPath) && (
                <div className="fdn-id-log__images">
                  {selected.imageFrontPath ? (
                    <div className="fdn-id-log__img-slot">
                      <p className="fdn-id-log__img-label">Front</p>
                      <IdScanStorageImage storagePath={selected.imageFrontPath} label="front" />
                    </div>
                  ) : null}
                  {selected.imageBackPath ? (
                    <div className="fdn-id-log__img-slot">
                      <p className="fdn-id-log__img-label">Back</p>
                      <IdScanStorageImage storagePath={selected.imageBackPath} label="back" />
                    </div>
                  ) : null}
                </div>
              )}

              <div className="fdn-id-log__kpi">
                <DetailField label="Full name" value={selected.fullName ?? selected.displayName} />
                <DetailField label="DOB" value={selected.dateOfBirth} />
                <DetailField label="ID #" value={selected.idNumber} />
              </div>

              <div className="fdn-id-log__section">
                <h4 className="fdn-id-log__section-title">Reservation</h4>
                {selected.roomNumber ||
                selected.reservationGuestName ||
                selected.checkInDate ||
                selected.checkOutDate ? (
                  <div className="fdn-id-log__grid">
                    <DetailField label="Guest (PMS)" value={selected.reservationGuestName} />
                    <DetailField label="Room" value={selected.roomNumber} />
                    <DetailField label="Check-in" value={selected.checkInDate} />
                    <DetailField label="Check-out" value={selected.checkOutDate} />
                  </div>
                ) : (
                  <p className="fdn-muted">No reservation (e.g. walk-in).</p>
                )}
              </div>

              <div className="fdn-id-log__section">
                <h4 className="fdn-id-log__section-title">Contact & address</h4>
                <div className="fdn-id-log__grid">
                  <DetailField label="Phone" value={selected.phone} />
                  <DetailField label="Email" value={selected.email} />
                  <DetailField label="Street" value={selected.streetAddress} />
                  <DetailField label="City" value={selected.city} />
                  <DetailField label="State" value={selected.state} />
                  <DetailField label="Postal" value={selected.postalCode} />
                </div>
              </div>

              <div className="fdn-id-log__section">
                <h4 className="fdn-id-log__section-title">ID document</h4>
                <div className="fdn-id-log__grid">
                  <DetailField label="Type" value={selected.idType} />
                  <DetailField label="Issue" value={selected.issueDate} />
                  <DetailField label="Expiry" value={selected.expiryDate} />
                  <DetailField label="Manual entry" value={selected.manualEntry ? 'Yes' : 'No'} />
                  <DetailField label="OCR" value={selected.ocrProvider} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
