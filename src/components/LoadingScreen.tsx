type Props = {
  label?: string
}

/** Full-panel bootstrap loader while extension state is fetched. */
export function LoadingScreen({ label = 'Loading…' }: Props) {
  return (
    <div className="fdn-loading-screen" role="status" aria-live="polite" aria-busy="true">
      <div className="fdn-loading-screen__inner">
        <svg className="fdn-spinner" viewBox="0 0 24 24" aria-hidden>
          <circle className="fdn-spinner__track" cx="12" cy="12" r="10" />
          <circle className="fdn-spinner__arc" cx="12" cy="12" r="10" />
        </svg>
        <p className="fdn-loading-screen__label">{label}</p>
      </div>
    </div>
  )
}
