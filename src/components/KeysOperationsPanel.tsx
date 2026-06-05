import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyBoardEntry, KeyLedgerEntry } from '../shared/protocol'
import { formatKeyHistoryShortYmdHm } from '../lib/key-board'
import { addLocalDays, localDateString } from '../lib/local-date'

type KeysOperationsPanelProps = {
  signedIn: boolean
  userRole: string | null
  hasManagerPin: boolean
  encoderConnected: boolean
}

type InnerTab = 'board' | 'history'

function compactNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`
}

function defaultCheckoutCompact(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(12, 0, 0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`
}

export function KeysOperationsPanel({
  signedIn,
  userRole,
  hasManagerPin,
  encoderConnected,
}: KeysOperationsPanelProps) {
  const today = useMemo(() => localDateString(), [])
  const isAdmin = userRole === 'admin'
  const hideForHousekeeper = userRole === 'housekeeper'

  const [innerTab, setInnerTab] = useState<InnerTab>('board')
  const [businessDate, setBusinessDate] = useState(today)
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [agentFilter, setAgentFilter] = useState('')
  const [roomFilter, setRoomFilter] = useState('')
  const [listSearch, setListSearch] = useState('')

  const [boardRows, setBoardRows] = useState<KeyBoardEntry[]>([])
  const [stats, setStats] = useState({ total: 0, withKey: 0, vacant: 0 })
  const [ledgerRows, setLedgerRows] = useState<KeyLedgerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null)

  const [editUnlocked, setEditUnlocked] = useState(false)
  const [showPinEntry, setShowPinEntry] = useState(false)
  const [pinInput, setPinInput] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [managerPinForWrite, setManagerPinForWrite] = useState<string | undefined>(undefined)

  const [blockBusy, setBlockBusy] = useState(false)
  const [encodeBusy, setEncodeBusy] = useState(false)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [showBlockForm, setShowBlockForm] = useState(false)
  const [blockHours, setBlockHours] = useState(4)
  const [blockReason, setBlockReason] = useState('')

  const jumpDateRef = useRef<HTMLInputElement>(null)

  const canEdit = isAdmin || editUnlocked

  useEffect(() => {
    setEditUnlocked(false)
    setShowPinEntry(false)
    setPinInput('')
    setPinError(null)
    setManagerPinForWrite(undefined)
  }, [signedIn, userRole])

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
      setManagerPinForWrite(pin)
      setShowPinEntry(false)
      setPinInput('')
    } catch (e) {
      setPinError(e instanceof Error ? e.message : 'Could not verify PIN')
    } finally {
      setPinBusy(false)
    }
  }, [pinInput])

  const loadBoard = useCallback(async () => {
    if (!signedIn) return
    setLoading(true)
    setError(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'GET_KEY_BOARD',
        businessDate,
        agentFilter: agentFilter.trim() || undefined,
      })) as {
        ok: boolean
        keyBoard?: KeyBoardEntry[]
        keyBoardStats?: { total: number; withKey: number; vacant: number }
        error?: string
      }
      if (!res.ok) {
        setBoardRows([])
        setError(res.error ?? 'Could not load room board')
        return
      }
      setBoardRows(res.keyBoard ?? [])
      if (res.keyBoardStats) setStats(res.keyBoardStats)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load room board')
    } finally {
      setLoading(false)
    }
  }, [signedIn, businessDate, agentFilter])

  const loadLedger = useCallback(async () => {
    if (!signedIn) return
    setLoading(true)
    setError(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'GET_KEY_LEDGER',
        fromDate,
        toDate,
        agentFilter: agentFilter.trim() || undefined,
        roomFilter: roomFilter.trim() || undefined,
      })) as { ok: boolean; keyLedger?: KeyLedgerEntry[]; error?: string }
      if (!res.ok) {
        setLedgerRows([])
        setError(res.error ?? 'Could not load key history')
        return
      }
      setLedgerRows(res.keyLedger ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load key history')
    } finally {
      setLoading(false)
    }
  }, [signedIn, fromDate, toDate, agentFilter, roomFilter])

  useEffect(() => {
    if (!signedIn || hideForHousekeeper) return
    if (innerTab === 'board') void loadBoard()
    else void loadLedger()
  }, [signedIn, hideForHousekeeper, innerTab, loadBoard, loadLedger])

  const filteredBoard = useMemo(() => {
    const q = listSearch.trim().toLowerCase()
    if (!q) return boardRows
    return boardRows.filter((r) => {
      const hay = [r.roomNumber, r.guestName, r.confirmationNumber, r.encodedBy]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [boardRows, listSearch])

  const filteredLedger = useMemo(() => {
    const q = listSearch.trim().toLowerCase()
    if (!q) return ledgerRows
    return ledgerRows.filter((r) => {
      const hay = [r.roomNumber, r.guestName, r.confirmationNumber, r.encodedBy]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [ledgerRows, listSearch])

  useEffect(() => {
    if (!filteredBoard.length) {
      setSelectedRoom(null)
      return
    }
    if (!selectedRoom || !filteredBoard.some((r) => r.roomNumber === selectedRoom)) {
      setSelectedRoom(filteredBoard[0]!.roomNumber)
    }
  }, [filteredBoard, selectedRoom])

  const selected = useMemo(
    () => filteredBoard.find((r) => r.roomNumber === selectedRoom) ?? null,
    [filteredBoard, selectedRoom],
  )

  const writePin = isAdmin ? undefined : managerPinForWrite

  const handleBlock = useCallback(async () => {
    if (!selected || !canEdit) return
    setBlockBusy(true)
    setActionNotice(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'CREATE_ROOM_BLOCK',
        roomNumber: selected.roomNumber,
        durationKind: 'hours',
        durationValue: blockHours,
        reason: blockReason.trim() || undefined,
        effectiveFromVacancy: Boolean(selected.hasKey),
        managerPin: writePin,
      })) as { ok: boolean; error?: string }
      if (!res.ok) {
        setActionNotice(res.error ?? 'Block failed')
        return
      }
      setShowBlockForm(false)
      setBlockReason('')
      setActionNotice(`Room ${selected.roomNumber} blocked.`)
      void loadBoard()
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : 'Block failed')
    } finally {
      setBlockBusy(false)
    }
  }, [selected, canEdit, blockHours, blockReason, writePin, loadBoard])

  const handleUnblock = useCallback(async () => {
    if (!selected?.blockId || !canEdit) return
    setBlockBusy(true)
    setActionNotice(null)
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'RELEASE_ROOM_BLOCK',
        blockId: selected.blockId,
        roomNumber: selected.roomNumber,
        managerPin: writePin,
      })) as { ok: boolean; error?: string }
      if (!res.ok) {
        setActionNotice(res.error ?? 'Unblock failed')
        return
      }
      setActionNotice(`Room ${selected.roomNumber} unblocked.`)
      void loadBoard()
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : 'Unblock failed')
    } finally {
      setBlockBusy(false)
    }
  }, [selected, canEdit, writePin, loadBoard])

  const handleEncode = useCallback(async () => {
    if (!selected || !canEdit || !encoderConnected) return
    setEncodeBusy(true)
    setActionNotice(null)
    const conf =
      selected.confirmationNumber?.trim() ||
      `WALK-${selected.roomNumber}-${Date.now().toString(36).toUpperCase()}`
    const checkin = selected.checkinTime?.trim() || compactNow()
    const checkout = selected.checkoutTime?.trim() || defaultCheckoutCompact()
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'KEYS_ADMIN_ENCODE',
        roomNumber: selected.roomNumber,
        checkinTime: checkin,
        checkoutTime: checkout,
        confirmationNumber: conf,
        guestName: selected.guestName,
        cardSerial: Math.max(1, (selected.cardSerial ?? 0) + 1),
        managerPin: writePin,
      })) as { ok: boolean; error?: string; dbWarning?: string }
      if (!res.ok) {
        setActionNotice(res.error ?? 'Encode failed')
        return
      }
      setActionNotice(`Key encoded for room ${selected.roomNumber}.`)
      void loadBoard()
      if (innerTab === 'history') void loadLedger()
    } catch (e) {
      setActionNotice(e instanceof Error ? e.message : 'Encode failed')
    } finally {
      setEncodeBusy(false)
    }
  }, [selected, canEdit, encoderConnected, writePin, loadBoard, loadLedger, innerTab])

  const handleExportCsv = useCallback(() => {
    if (!canEdit || filteredLedger.length === 0) return
    const header = ['Encoded', 'Room', 'Guest', 'Confirmation', 'Card #', 'In', 'Out', 'Agent']
    const csvRows = [
      header,
      ...filteredLedger.map((r) => [
        r.encodedAt,
        r.roomNumber,
        r.guestName ?? '',
        r.confirmationNumber,
        r.cardSerial ?? '',
        r.checkinTime ?? '',
        r.checkoutTime ?? '',
        r.encodedBy ?? '',
      ]),
    ]
    const csv = csvRows
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = `key_ledger_${fromDate}_to_${toDate}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(href), 10_000)
  }, [canEdit, filteredLedger, fromDate, toDate])

  if (!signedIn) {
    return (
      <section className="fdn-panel fdn-panel--keys-ops">
        <p className="fdn-muted">Sign in to view Keys.</p>
      </section>
    )
  }

  if (hideForHousekeeper) {
    return (
      <section className="fdn-panel fdn-panel--keys-ops">
        <p className="fdn-muted">Keys board is not available for your role.</p>
      </section>
    )
  }

  return (
    <section className="fdn-panel fdn-panel--keys-ops" aria-label="Keys operations">
      <div className="fdn-keys-ops__toolbar">
        <div className="fdn-id-log__toolbar-head">
          <h2 className="fdn-id-log__title">Keys</h2>
          <p className="fdn-id-log__subtitle">Room board and encode ledger</p>
        </div>

        {!isAdmin && !canEdit ? (
          <div className="fdn-sig-log__unlock">
            <p className="fdn-sig-log__unlock-text">
              View only. Manager PIN required to block rooms or encode from the board.
            </p>
            {hasManagerPin ? (
              showPinEntry ? (
                <div className="fdn-sig-log__pin-row">
                  <input
                    type="password"
                    className="fdn-input fdn-sig-log__pin-input"
                    placeholder="Manager PIN"
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
                  Enter manager PIN
                </button>
              )
            ) : (
              <p className="fdn-muted fdn-sig-log__unlock-hint">No manager PIN configured.</p>
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
          <p className="fdn-sig-log__role-badge">Unlocked — edits enabled</p>
        )}

        <div className="fdn-keys-ops__subtabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={innerTab === 'board'}
            className={
              innerTab === 'board' ? 'fdn-keys-ops__subtab fdn-keys-ops__subtab--active' : 'fdn-keys-ops__subtab'
            }
            onClick={() => setInnerTab('board')}
          >
            Room board
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={innerTab === 'history'}
            className={
              innerTab === 'history'
                ? 'fdn-keys-ops__subtab fdn-keys-ops__subtab--active'
                : 'fdn-keys-ops__subtab'
            }
            onClick={() => setInnerTab('history')}
          >
            Key history
          </button>
        </div>

        <label className="fdn-id-log__search">
          <span className="fdn-sr-only">Search</span>
          <input
            className="fdn-input fdn-id-log__search-input"
            type="text"
            role="searchbox"
            placeholder="Room, guest, confirmation…"
            value={listSearch}
            onChange={(e) => setListSearch(e.target.value)}
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

        {innerTab === 'board' ? (
          <div className="fdn-id-log__date-nav" role="group" aria-label="Business date">
            <button
              type="button"
              className="fdn-id-log__nav-btn"
              aria-label="Previous day"
              onClick={() => setBusinessDate((d) => addLocalDays(d, -1))}
            >
              ‹
            </button>
            <div className="fdn-id-log__date-display">
              <span className="fdn-id-log__date-label">{businessDate}</span>
              <button
                type="button"
                className="fdn-id-log__date-jump"
                aria-label="Jump to date"
                onClick={() => jumpDateRef.current?.showPicker?.() ?? jumpDateRef.current?.click()}
              >
                📅
              </button>
              <input
                ref={jumpDateRef}
                className="fdn-id-log__date-jump-input"
                type="date"
                value={businessDate}
                max={today}
                aria-hidden
                tabIndex={-1}
                onChange={(e) => setBusinessDate(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="fdn-id-log__nav-btn"
              aria-label="Next day"
              disabled={businessDate >= today}
              onClick={() => setBusinessDate((d) => addLocalDays(d, 1))}
            >
              ›
            </button>
            <button
              type="button"
              className="fdn-id-log__nav-btn fdn-keys-ops__today"
              onClick={() => setBusinessDate(today)}
            >
              Today
            </button>
          </div>
        ) : (
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
                max={today}
                onChange={(e) => setToDate(e.target.value)}
              />
            </label>
          </div>
        )}

        <div className="fdn-id-log__filters">
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
          {innerTab === 'history' ? (
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
          ) : null}
          <button
            type="button"
            className="fdn-btn fdn-btn--secondary fdn-btn--xs fdn-id-log__reload"
            disabled={loading}
            onClick={() => (innerTab === 'board' ? void loadBoard() : void loadLedger())}
          >
            {loading ? 'Loading…' : 'Reload'}
          </button>
          {innerTab === 'history' ? (
            <button
              type="button"
              className="fdn-btn fdn-btn--secondary fdn-btn--xs"
              disabled={!canEdit || filteredLedger.length === 0}
              onClick={handleExportCsv}
            >
              Export CSV
            </button>
          ) : null}
        </div>

        <p className="fdn-id-log__count">
          {loading
            ? 'Loading…'
            : innerTab === 'board'
              ? `${filteredBoard.length} rooms · ${stats.withKey} with key · ${stats.vacant} vacant`
              : `${filteredLedger.length} encode${filteredLedger.length !== 1 ? 's' : ''}`}
        </p>
      </div>

      {(error || actionNotice) && (
        <p
          className={error ? 'fdn-form-error' : 'fdn-banner fdn-banner--info'}
          role={error ? 'alert' : undefined}
        >
          {error ?? actionNotice}
        </p>
      )}

      {innerTab === 'board' ? (
        <div className="fdn-keys-ops__body">
          <div className="fdn-keys-ops__list-wrap">
            {loading && filteredBoard.length === 0 ? (
              <p className="fdn-muted fdn-id-log__empty">Loading room board…</p>
            ) : filteredBoard.length === 0 ? (
              <p className="fdn-muted fdn-id-log__empty">No rooms configured.</p>
            ) : (
              <table className="fdn-table fdn-table--compact fdn-id-log__table">
                <thead>
                  <tr>
                    <th>Rm</th>
                    <th>Guest</th>
                    <th>In</th>
                    <th>Out</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBoard.map((r) => (
                    <tr
                      key={r.roomNumber}
                      className={
                        selectedRoom === r.roomNumber
                          ? `fdn-id-log__row--active fdn-keys-ops__row${r.blocked ? ' fdn-keys-ops__row--blocked' : ''}${!r.hasKey ? ' fdn-keys-ops__row--vacant' : ''}`
                          : `fdn-id-log__row fdn-keys-ops__row${r.blocked ? ' fdn-keys-ops__row--blocked' : ''}${!r.hasKey ? ' fdn-keys-ops__row--vacant' : ''}`
                      }
                      onClick={() => setSelectedRoom(r.roomNumber)}
                    >
                      <td className="fdn-mono">{r.roomNumber}</td>
                      <td className="fdn-id-log__cell-guest" title={r.guestName ?? ''}>
                        {r.guestName ?? '—'}
                        {r.blocked ? (
                          <span className="fdn-keys-ops__badge" title={r.blockSummary ?? ''}>
                            Block
                          </span>
                        ) : null}
                      </td>
                      <td className="fdn-id-log__cell-when">
                        {formatKeyHistoryShortYmdHm(r.checkinTime) ?? '—'}
                      </td>
                      <td className="fdn-id-log__cell-when">
                        {formatKeyHistoryShortYmdHm(r.checkoutTime) ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="fdn-keys-ops__detail">
            {!selected ? (
              <p className="fdn-muted">Select a room.</p>
            ) : (
              <>
                <h3 className="fdn-keys-ops__detail-title">Room {selected.roomNumber}</h3>
                <dl className="fdn-dl fdn-dl--compact">
                  <dt>Guest</dt>
                  <dd>{selected.guestName ?? 'Vacant'}</dd>
                  <dt>Confirmation</dt>
                  <dd className="fdn-mono">{selected.confirmationNumber ?? '—'}</dd>
                  <dt>Agent</dt>
                  <dd>{selected.encodedBy ?? '—'}</dd>
                  {selected.roomStatus ? (
                    <>
                      <dt>HK status</dt>
                      <dd>{selected.roomStatus.replace(/_/g, ' ')}</dd>
                    </>
                  ) : null}
                  {selected.blockSummary ? (
                    <>
                      <dt>Block</dt>
                      <dd>{selected.blockSummary}</dd>
                    </>
                  ) : null}
                </dl>

                {canEdit ? (
                  <div className="fdn-keys-ops__actions">
                    <button
                      type="button"
                      className="fdn-btn fdn-btn--primary fdn-btn--xs"
                      disabled={encodeBusy || !encoderConnected}
                      title={!encoderConnected ? 'Connect RFID encoder' : 'Encode key for this room'}
                      onClick={() => void handleEncode()}
                    >
                      {encodeBusy ? '…' : 'Encode key'}
                    </button>
                    {selected.blocked && selected.blockId ? (
                      <button
                        type="button"
                        className="fdn-btn fdn-btn--secondary fdn-btn--xs"
                        disabled={blockBusy}
                        onClick={() => void handleUnblock()}
                      >
                        {blockBusy ? '…' : 'Unblock'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="fdn-btn fdn-btn--secondary fdn-btn--xs"
                        disabled={blockBusy}
                        onClick={() => setShowBlockForm((v) => !v)}
                      >
                        Block room
                      </button>
                    )}
                  </div>
                ) : null}

                {showBlockForm && canEdit && !selected.blocked ? (
                  <div className="fdn-keys-ops__block-form">
                    <label className="fdn-label fdn-label--compact">
                      <span className="fdn-label__text">Hours</span>
                      <input
                        className="fdn-input"
                        type="number"
                        min={1}
                        max={168}
                        value={blockHours}
                        onChange={(e) => setBlockHours(Number(e.target.value) || 4)}
                      />
                    </label>
                    <label className="fdn-label fdn-label--compact">
                      <span className="fdn-label__text">Reason</span>
                      <input
                        className="fdn-input"
                        type="text"
                        value={blockReason}
                        onChange={(e) => setBlockReason(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="fdn-btn fdn-btn--danger fdn-btn--xs"
                      disabled={blockBusy}
                      onClick={() => void handleBlock()}
                    >
                      {blockBusy ? '…' : 'Confirm block'}
                    </button>
                  </div>
                ) : null}

                {!encoderConnected && canEdit ? (
                  <p className="fdn-muted fdn-keys-ops__hint">Encoder offline — connect USB to encode.</p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="fdn-keys-ops__list-wrap fdn-keys-ops__list-wrap--ledger">
          {loading && filteredLedger.length === 0 ? (
            <p className="fdn-muted fdn-id-log__empty">Loading key history…</p>
          ) : filteredLedger.length === 0 ? (
            <p className="fdn-muted fdn-id-log__empty">No encodes in this range.</p>
          ) : (
            <table className="fdn-table fdn-table--compact fdn-id-log__table">
              <thead>
                <tr>
                  <th>Rm</th>
                  <th>Guest</th>
                  <th>Signed</th>
                  <th>Conf.</th>
                </tr>
              </thead>
              <tbody>
                {filteredLedger.map((r) => (
                  <tr key={r.id} className="fdn-id-log__row">
                    <td className="fdn-mono">{r.roomNumber}</td>
                    <td className="fdn-id-log__cell-guest">{r.guestName ?? '—'}</td>
                    <td className="fdn-id-log__cell-when">
                      {formatKeyHistoryShortYmdHm(r.encodedAt) ??
                        new Date(r.encodedAt).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                    </td>
                    <td className="fdn-id-log__cell-conf">{r.confirmationNumber}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  )
}
