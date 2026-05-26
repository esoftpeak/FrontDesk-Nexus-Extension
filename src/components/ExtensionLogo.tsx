type Props = {
  className?: string
  /** Smaller mark for compact header strip */
  compact?: boolean
}

/** Brand mark in the side panel header (`public/icon.png`). */
export function ExtensionLogo({ className, compact }: Props) {
  const size = compact ? 32 : 36
  return (
    <img
      src={chrome.runtime.getURL('icon.png')}
      alt="FrontDesk Nexus"
      width={size}
      height={size}
      className={['fdn-header__logo', compact ? 'fdn-header__logo--sm' : '', className]
        .filter(Boolean)
        .join(' ')}
      decoding="async"
    />
  )
}
