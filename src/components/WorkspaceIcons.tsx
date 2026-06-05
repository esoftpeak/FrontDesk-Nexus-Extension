/** Lucide-aligned SVGs (same paths as Web portal / lucide-react). */

type IconProps = { className?: string; title?: string }

const base = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** Web `IdDataNavIcon` — ID card outline */
export function IconId({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d="M16 10h2" />
      <path d="M16 14h2" />
      <path d="M6.17 15a3 3 0 0 1 5.66 0" />
      <circle cx="9" cy="11" r="2" />
      <rect x="2" y="5" width="20" height="14" rx="2" />
    </svg>
  )
}

/** Web nav Cash — `Wallet` */
export function IconPayment({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </svg>
  )
}

/** Registration card signature — `PenLine` */
export function IconSignature({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d="M12 20h9" />
      <path d="M16.376 3.622a1 1 0 0 1 1.414 0l2.008 2.008a1 1 0 0 1 0 1.414l-9.619 9.619a2 2 0 0 1-.878.513l-3.285.657a.5.5 0 0 1-.61-.61l.657-3.285a2 2 0 0 1 .513-.878z" />
    </svg>
  )
}

/** Check-in history — `ScanLine` (portal ID Data log) */
export function IconHistory({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M7 12h10" />
    </svg>
  )
}

/** Hotel keys / room board — grid layout */
export function IconKeysBoard({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </svg>
  )
}

/** Classic skeleton key — head top-right, blade to bottom-left (matches portal key art). */
export function IconKey({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <g transform="rotate(-45 12 12)">
        <circle cx="18" cy="12" r="3.25" />
        <circle cx="18" cy="12" r="1" fill="currentColor" stroke="none" />
        <path d="M14.4 12H9.2V14.1H7.1V12H5.1V13.4H3V12" />
      </g>
    </svg>
  )
}

/** Do Not Rent — `Ban` (portal DNR nav) */
export function IconBan({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
    </svg>
  )
}

/** Reload stay from PMS — `RefreshCw` */
export function IconRefresh({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

/** Send guest data to PMS — `ArrowLeft` */
export function IconArrowLeft({ className, title }: IconProps) {
  return (
    <svg {...base} className={className} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  )
}
