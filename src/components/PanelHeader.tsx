import { ExtensionLogo } from './ExtensionLogo'

type Props = {
  signedIn: boolean
  email: string | null
  role: string | null
  displayName: string
  roleLabel: string
  confLine: string | null
  roomNumber: string | null
  idScanner: 'connected' | 'disconnected'
  rfidEncoder: 'connected' | 'disconnected'
  idCheckedAgo: string
  keyCheckedAgo: string
  rfidCheckBusy: boolean
  onLogout: () => void
  onRefreshId: () => void
  onCheckKey: () => void
}

function LogOutIcon() {
  return (
    <svg
      className="fdn-header__logout-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

export function PanelHeader({
  signedIn,
  email,
  role,
  displayName,
  roleLabel,
  confLine,
  roomNumber,
  idScanner,
  rfidEncoder,
  idCheckedAgo,
  keyCheckedAgo,
  rfidCheckBusy,
  onLogout,
  onRefreshId,
  onCheckKey,
}: Props) {
  const idOn = idScanner === 'connected'
  const keyOn = rfidEncoder === 'connected'

  return (
    <header className="fdn-header fdn-header--compact">
      <div className="fdn-header__row fdn-header__row--main">
        <ExtensionLogo compact />
        <div className="fdn-header__meta">
          {signedIn ? (
            <span className="fdn-header__user" title={email ?? undefined}>
              <span className="fdn-header__name">{displayName}</span>
              <span className="fdn-header__sep">·</span>
              <span
                className={[
                  'fdn-header__role',
                  role?.toLowerCase() === 'admin' ? 'fdn-header__role--admin' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {roleLabel}
              </span>
            </span>
          ) : (
            <span className="fdn-header__user fdn-header__user--muted">Not signed in</span>
          )}
          <span className="fdn-header__stay">
            {confLine ? <span>#{confLine}</span> : null}
            {confLine && roomNumber ? <span className="fdn-header__sep">·</span> : null}
            {roomNumber ? <span>Rm {roomNumber}</span> : null}
            {!confLine && !roomNumber ? <span className="fdn-header__stay--empty">No stay</span> : null}
          </span>
        </div>
        {signedIn ? (
          <button
            type="button"
            className="fdn-header__logout"
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOutIcon />
          </button>
        ) : null}
      </div>

      <div className="fdn-header__row fdn-header__row--hw" role="group" aria-label="Hardware status">
        <button
          type="button"
          className={`fdn-hw-pill ${idOn ? 'fdn-hw-pill--ok' : 'fdn-hw-pill--bad'}`}
          title={`ID scanner — ${idOn ? 'connected' : 'offline'} · ${idCheckedAgo}`}
          onClick={onRefreshId}
        >
          <span className={`fdn-hw-pill__dot ${idOn ? 'fdn-hw-pill__dot--ok' : 'fdn-hw-pill__dot--bad'}`} />
          <span className="fdn-hw-pill__label">ID</span>
          <span className="fdn-hw-pill__state">{idOn ? 'on' : 'off'}</span>
          <span className="fdn-hw-pill__time">{idCheckedAgo}</span>
        </button>
        <button
          type="button"
          className={`fdn-hw-pill ${keyOn ? 'fdn-hw-pill--ok' : 'fdn-hw-pill--bad'}`}
          title={`Key encoder — ${keyOn ? 'connected' : 'offline'} · ${keyCheckedAgo}`}
          disabled={rfidCheckBusy}
          onClick={onCheckKey}
        >
          <span className={`fdn-hw-pill__dot ${keyOn ? 'fdn-hw-pill__dot--ok' : 'fdn-hw-pill__dot--bad'}`} />
          <span className="fdn-hw-pill__label">Key</span>
          <span className="fdn-hw-pill__state">{rfidCheckBusy ? '…' : keyOn ? 'on' : 'off'}</span>
          <span className="fdn-hw-pill__time">{rfidCheckBusy ? 'chk' : keyCheckedAgo}</span>
        </button>
      </div>
    </header>
  )
}
