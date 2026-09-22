import { StreamMedia } from './StreamMedia.js';

export interface SpeakerBarTile {
  id: string;
  stream: MediaStream;
  isLocal: boolean;
  label: string;
}

/**
 * Replaces every seat's own video once there are more than 4 human
 * cameras on and the viewer's screen is phone-sized (see Table.tsx's
 * `speakerBarActive` and useActiveSpeakers.ts) — a small, decoupled bar
 * showing only the (at most 2) people currently speaking, instead of one
 * small video box per seat cluttering the felt.
 */
export function SpeakerBar({ tiles }: { tiles: SpeakerBarTile[] }): React.JSX.Element {
  return (
    <div className="speaker-bar">
      {tiles.map((t) => (
        <div key={t.id} className="speaker-bar-tile">
          <StreamMedia stream={t.stream} isLocal={t.isLocal} />
          <span className="speaker-bar-label">{t.label}</span>
        </div>
      ))}
    </div>
  );
}
