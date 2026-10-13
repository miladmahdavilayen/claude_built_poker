import { useState } from 'react';
import { downloadGameReport } from '../api.js';

/**
 * "Download YAML" / "Download PDF" for one game's books — see
 * apps/server/src/http/routes/reports.ts. `path` is a table's current game
 * or a stored report. Shows the saved filename (which carries the table,
 * hand number and time) or the server's error.
 */
export function ReportDownloads({ path, accessToken, testIdPrefix }: { path: string; accessToken: string; testIdPrefix?: string }): React.JSX.Element {
  const [busy, setBusy] = useState<'yaml' | 'pdf' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const download = (format: 'yaml' | 'pdf'): void => {
    setBusy(format);
    setMessage(null);
    downloadGameReport(path, format, accessToken)
      .then((filename) => setMessage({ ok: true, text: `Saved ${filename}` }))
      .catch((err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : 'Download failed.' }))
      .finally(() => setBusy(null));
  };

  return (
    <div className="report-downloads">
      <div className="report-downloads-buttons">
        <button type="button" disabled={busy !== null} onClick={() => download('pdf')} data-testid={testIdPrefix ? `${testIdPrefix}-pdf` : undefined}>
          {busy === 'pdf' ? 'Preparing…' : 'Download PDF'}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => download('yaml')} data-testid={testIdPrefix ? `${testIdPrefix}-yaml` : undefined}>
          {busy === 'yaml' ? 'Preparing…' : 'Download YAML'}
        </button>
      </div>
      {message && <div className={message.ok ? 'owner-menu-ok report-downloads-message' : 'error-banner'}>{message.text}</div>}
    </div>
  );
}
