import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IdScanLogEntry } from '../shared/protocol'
import { idScanLogEntryIsEditable } from '../lib/apply-guest-profile'
import { createIdScanImageSignedUrl } from '../lib/id-scan-storage'
import {
  addLocalDays,
  clampDateRange,
  daysInRange,
  formatHistoryNavLabel,
  localDateString,
} from '../lib/local-date'
import { classifyHistorySearchQuery } from '../lib/id-scan-history-search'

type CheckInHistoryPanelProps = {
  signedIn: boolean
  editBusy?: boolean
  onEditInScanner?: (entry: IdScanLogEntry) => void
}

const SEARCH_DEBOUNCE_MS = 350

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

export function CheckInHistoryPanel({
  signedIn,
  editBusy = false,
  onEditInScanner,
}: CheckInHistoryPanelProps) {
  const today = useMemo(() => localDateString(), [])
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [agentFilter, setAgentFilter] = useState('')
  const [roomFilter, setRoomFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [rows, setRows] = useState<IdScanLogEntry[]>([])
  const [searchRows, setSearchRows] = useState<IdScanLogEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const jumpDateRef = useRef<HTMLInputElement>(null)

  const searchActive = debouncedSearch.trim().length >= 2

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [searchQuery])

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

  const shiftRange = useCallback((deltaDays: number) => applyRangeShift(deltaDays), [applyRangeShift])

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

  const loadScans = useCallback(async () => {
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
        type: 'GET_ID_SCANS_BY_DATE',
        fromDate: from,
        toDate: to,
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
    if (searchActive) return
    void loadScans()
  }, [loadScans, searchActive])

  const runSearch = useCallback(async () => {
    if (!signedIn || !searchActive) return
    setSearchLoading(true)
    setError(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'SEARCH_ID_SCANS_HISTORY',
        query: debouncedSearch,
      })) as { ok: boolean; idScanLog?: IdScanLogEntry[]; error?: string }
      if (!res.ok) {
        setSearchRows([])
        setError(res.error ?? 'Search failed')
        return
      }
      setSearchRows(res.idScanLog ?? [])
    } catch (e) {
      setSearchRows([])
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setSearchLoading(false)
    }
  }, [signedIn, debouncedSearch, searchActive])

  useEffect(() => {
    if (!searchActive) {
      setSearchRows(null)
      setSearchLoading(false)
      return
    }
    void runSearch()
  }, [searchActive, runSearch])

  const sourceRows = searchActive ? (searchRows ?? []) : rows
  const listLoading = searchActive ? searchLoading : loading

  const filteredRows = useMemo(() => {
    const roomTerm = roomFilter.trim().toLowerCase()
    const agentTerm = agentFilter.trim().toLowerCase()
    return sourceRows.filter((r) => {
      if (roomTerm && !(r.roomNumber ?? '').toLowerCase().includes(roomTerm)) return false
      if (agentTerm && !r.agentLabel.toLowerCase().includes(agentTerm)) return false
      return true
    })
  }, [sourceRows, roomFilter, agentFilter])

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

  const navLabel = formatHistoryNavLabel(fromDate, toDate)
  const searchKind = classifyHistorySearchQuery(debouncedSearch)

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
          <p className="fdn-id-log__subtitle">
            {searchActive
              ? 'Search guests across recent check-ins'
              : 'Daily scan log by date range'}
          </p>
        </div>

        <label className="fdn-id-log__search">
          <span className="fdn-sr-only">Search guests</span>
          <input
            className="fdn-input fdn-id-log__search-input"
            type="text"
            role="searchbox"
            placeholder="Name, phone, ID #, or confirmation…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {searchQuery.trim() ? (
            <button
              type="button"
              className="fdn-btn fdn-btn--ghost fdn-btn--xs fdn-id-log__search-clear"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              ×
            </button>
          ) : null}
        </label>

        {!searchActive ? (
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
              onClick={() => shiftRange(-1)}
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
              onClick={() => shiftRange(1)}
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
        ) : null}

        <div className="fdn-id-log__filters">
          <label className="fdn-label fdn-label--compact">
            <span className="fdn-label__text">From</span>
            <input
              className="fdn-input"
              type="date"
              value={fromDate}
              max={toDate || today}
              disabled={searchActive}
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
              disabled={searchActive}
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
            disabled={listLoading}
            onClick={() => (searchActive ? void runSearch() : void loadScans())}
          >
            {listLoading ? 'Loading…' : 'Reload'}
          </button>
        </div>
        <p className="fdn-id-log__count">
          {listLoading
            ? searchActive
              ? 'Searching…'
              : 'Loading scans…'
            : searchActive
              ? `${filteredRows.length} match${filteredRows.length !== 1 ? 'es' : ''}${
                  searchKind ? ` (${searchKind})` : ''
                } — clear search to use date range`
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
          {listLoading && filteredRows.length === 0 ? (
            <p className="fdn-muted fdn-id-log__empty">
              {searchActive ? 'Searching check-ins…' : 'Loading ID scans…'}
            </p>
          ) : filteredRows.length === 0 ? (
            <p className="fdn-muted fdn-id-log__empty">
              {searchActive
                ? 'No guests match that search. Try another name, phone, or ID number.'
                : 'No scans match these filters.'}
            </p>
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
                <div className="fdn-id-log__detail-head-row">
                  <h3 className="fdn-id-log__detail-name">{selected.displayName}</h3>
                  {onEditInScanner ? (
                    <button
                      type="button"
                      className="fdn-btn fdn-btn--primary fdn-btn--xs fdn-id-log__edit-btn"
                      disabled={editBusy || !idScanLogEntryIsEditable(selected)}
                      title={
                        !idScanLogEntryIsEditable(selected)
                          ? 'Cannot load — guest details could not be decrypted'
                          : 'Open this check-in on the ID tab to edit, send to PMS, or save again'
                      }
                      onClick={() => onEditInScanner(selected)}
                    >
                      {editBusy ? 'Loading…' : 'Edit in scanner'}
                    </button>
                  ) : null}
                </div>
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
