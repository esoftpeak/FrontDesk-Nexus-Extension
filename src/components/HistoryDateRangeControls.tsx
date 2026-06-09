import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import {
  addLocalDays,
  clampDateRange,
  daysInRange,
  formatHistoryNavLabel,
} from '../lib/local-date'

export type HistoryDateRangeControlsProps = {
  fromDate: string
  toDate: string
  today: string
  onFromDateChange: (value: string) => void
  onToDateChange: (value: string) => void
  agentFilter: string
  onAgentFilterChange: (value: string) => void
  roomFilter: string
  onRoomFilterChange: (value: string) => void
  loading: boolean
  onReload: () => void
  /** Hide date nav (e.g. while search mode is active on check-in history). */
  showDateNav?: boolean
  filtersDisabled?: boolean
  /** Extra buttons after Reload (e.g. Export CSV). */
  children?: ReactNode
}

export function HistoryDateRangeControls({
  fromDate,
  toDate,
  today,
  onFromDateChange,
  onToDateChange,
  agentFilter,
  onAgentFilterChange,
  roomFilter,
  onRoomFilterChange,
  loading,
  onReload,
  showDateNav = true,
  filtersDisabled = false,
  children,
}: HistoryDateRangeControlsProps) {
  const jumpDateRef = useRef<HTMLInputElement>(null)
  const navLabel = useMemo(() => formatHistoryNavLabel(fromDate, toDate), [fromDate, toDate])

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
      onFromDateChange(nextFrom)
      onToDateChange(nextTo)
    },
    [fromDate, toDate, today, onFromDateChange, onToDateChange],
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

  const jumpToDate = useCallback(
    (iso: string) => {
      if (!iso) return
      onFromDateChange(iso)
      onToDateChange(iso)
    },
    [onFromDateChange, onToDateChange],
  )

  return (
    <>
      {showDateNav ? (
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
            disabled={filtersDisabled}
            onChange={(e) => {
              const next = e.target.value
              onFromDateChange(next)
              if (next > toDate) onToDateChange(next)
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
            disabled={filtersDisabled}
            onChange={(e) => {
              const next = e.target.value
              onToDateChange(next)
              if (next < fromDate) onFromDateChange(next)
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
            onChange={(e) => onAgentFilterChange(e.target.value)}
          />
        </label>
        <label className="fdn-label fdn-label--compact">
          <span className="fdn-label__text">Room #</span>
          <input
            className="fdn-input"
            type="text"
            placeholder="Room"
            value={roomFilter}
            onChange={(e) => onRoomFilterChange(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="fdn-btn fdn-btn--secondary fdn-btn--xs fdn-id-log__reload"
          disabled={loading}
          onClick={onReload}
        >
          {loading ? 'Loading…' : 'Reload'}
        </button>
        {children}
      </div>
    </>
  )
}
