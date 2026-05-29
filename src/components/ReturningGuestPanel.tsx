import { useId } from 'react'
import type { GuestStayHistoryRecord } from '../shared/protocol'
import { guestStayDisplayName } from '../lib/guest-stay-history'

type ReturningGuestPanelProps = {
  stays: GuestStayHistoryRecord[]
  busy: boolean
  expanded: boolean
  onToggleExpanded: () => void
}

function formatCheckInWhen(iso: string): string {
  if (!iso.trim()) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function ReturningGuestPanel({
  stays,
  busy,
  expanded,
  onToggleExpanded,
}: ReturningGuestPanelProps) {
  const listId = useId()
  const count = stays.length
  if (count === 0 && !busy) return null

  const countLabel = count === 1 ? '1 prior check-in' : `${count} prior check-ins`

  return (
    <div
      className="fdn-returning-guest"
      role="region"
      aria-label="Returning guest prior check-ins"
    >
      <div className="fdn-returning-guest__head">
        <span className="fdn-returning-guest__badge" aria-hidden>
          Returning guest
        </span>
        {busy ? (
          <span className="fdn-returning-guest__meta fdn-muted">Looking up prior stays…</span>
        ) : (
          <span className="fdn-returning-guest__meta">{countLabel}</span>
        )}
        {!busy && count > 0 ? (
          <button
            type="button"
            className="fdn-btn fdn-btn--ghost fdn-returning-guest__toggle"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={onToggleExpanded}
          >
            {expanded ? 'Hide history' : 'See history'}
          </button>
        ) : null}
      </div>
      {expanded && count > 0 ? (
        <ol id={listId} className="fdn-returning-guest__list">
          {stays.slice(0, 8).map((row) => (
            <li key={row.id} className="fdn-returning-guest__item">
              <span className="fdn-returning-guest__when">{formatCheckInWhen(row.scannedAt)}</span>
              <span className="fdn-returning-guest__conf fdn-mono" title="Confirmation">
                {row.confirmationNumber || '—'}
              </span>
              <span className="fdn-returning-guest__name">{guestStayDisplayName(row)}</span>
              {row.manualEntry ? (
                <span className="fdn-returning-guest__flag" title="Manual entry">
                  Man.
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
