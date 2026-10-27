/**
 * An error message with a ✕ to get rid of it. Every error that doesn't
 * stop what you're doing gets one; only a blocking one (a page that
 * couldn't load at all) is shown without.
 */
export function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }): React.JSX.Element {
  return (
    <div className="error-banner error-banner--closable" role="alert">
      <span>{message}</span>
      <button type="button" className="error-banner-close" aria-label="Dismiss message" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
