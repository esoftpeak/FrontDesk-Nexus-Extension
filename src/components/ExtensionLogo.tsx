type Props = {
  className?: string
}

/** Brand mark in the side panel header (`public/favicon.svg`). */
export function ExtensionLogo({ className }: Props) {
  return (
    <img
      src={chrome.runtime.getURL('icon.png')}
      alt="FrontDesk Nexus"
      width={32}
      height={32}
      className={['fdn-topbar__logo', className].filter(Boolean).join(' ')}
      decoding="async"
    />
  )
}
