import type { Card } from "@pokerclause/engine";
import { useEffect, useState } from "react";
import { API_BASE } from "../api.js";
import {
  checkHand,
  type FairnessCheck as Check,
  type FairnessRecord,
} from "../fairness.js";
import { PlayingCard } from "./PlayingCard.js";

/**
 * "Was this hand fair?" — for any player who wonders, in plain words, with
 * the actual check done right here in their own browser (fairness.ts), not
 * just the server saying so. Opened by "Verify hand fairness" once a hand is
 * over. The raw numbers are one tap further down, for anyone who wants to
 * check it themselves elsewhere.
 */
export function FairnessCheck({
  handId,
  commitment,
  board,
  myCards,
  players,
  onClose,
}: {
  handId: string | null;
  /** The fairness commitment shown on the table before the deal. */
  commitment: string | null;
  board: readonly string[];
  myCards: readonly string[];
  /** How many were dealt in — how much of the deck the hand could use. */
  players: number;
  onClose: () => void;
}): React.JSX.Element {
  const [record, setRecord] = useState<FairnessRecord | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handId) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`${API_BASE}/fairness/${handId}`);
        if (!res.ok) throw new Error();
        const r = (await res.json()) as FairnessRecord;
        if (!live) return;
        setRecord(r);
        if (
          r.revealed &&
          r.serverSeed &&
          r.clientSeeds &&
          r.handNumber !== undefined &&
          r.dealtDeck
        ) {
          const c = await checkHand({
            serverSeed: r.serverSeed,
            clientSeeds: r.clientSeeds,
            handNumber: r.handNumber,
            dealtDeck: r.dealtDeck,
            commitment: r.commitment,
          });
          if (live) setCheck(c);
        }
      } catch {
        if (live)
          setError(
            "Couldn’t fetch this hand’s record just now — try again in a moment.",
          );
      }
    })();
    return () => {
      live = false;
    };
  }, [handId]);

  const code = (commitment ?? record?.commitment ?? "").slice(0, 12);
  const fair = check ? check.commitmentMatches && check.deckMatches : null;
  // The top of the deck — everything this hand could have used: two cards a player, three burns, five on the board.
  const shown = check
    ? check.derivedDeck.slice(0, Math.min(52, Math.max(2, players) * 2 + 8))
    : [];
  const mine = new Set(myCards);
  const onBoard = new Set(board);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal fairness-modal"
        role="dialog"
        aria-label="Hand fairness"
        onClick={(e) => e.stopPropagation()}
      >
        <>
          <h3>
            {fair === null
              ? "Checking this hand…"
              : fair
                ? "✅ This hand was dealt fairly"
                : "⚠️ This hand did not check out"}
          </h3>
          {error && <p className="error">{error}</p>}
          {record && !record.revealed && (
            <p className="muted">
              The seal on this hand hasn’t been opened yet — try again in a
              moment.
            </p>
          )}
          <ol className="fairness-steps">
            <li className={check ? "fairness-step--done" : ""}>
              <strong>Sealed before the deal.</strong> The server picked a
              secret number and showed only its fingerprint — the{" "}
              <em>fairness commitment</em> <code>{code}…</code> at the top of
              the table — before any card was dealt. It can’t be changed
              afterwards, and gives nothing away about the cards.
            </li>
            <li className={check ? "fairness-step--done" : ""}>
              <strong>Shuffled with everyone’s seed.</strong> The deck was
              shuffled from that secret{" "}
              <em>plus a random seed belonging to each player at the table</em>{" "}
              — so neither the house nor any one player could choose the cards.
            </li>
            <li
              className={
                check
                  ? fair
                    ? "fairness-step--done"
                    : "fairness-step--fail"
                  : ""
              }
            >
              <strong>Opened and re-checked — on your device.</strong> Now the
              hand is over, the secret is revealed, and this browser just
              checked on its own:
              <ul className="fairness-results">
                <li>
                  {check ? (check.commitmentMatches ? "✅" : "❌") : "…"} The
                  secret’s fingerprint matches the fairness commitment shown
                  before the deal.
                </li>
                <li>
                  {check ? (check.deckMatches ? "✅" : "❌") : "…"} Shuffling
                  with the secret and the players’ seeds gives exactly the deck
                  that was dealt.
                </li>
              </ul>
            </li>
          </ol>
          {shown.length > 0 && (
            <div className="fairness-deck">
              <div className="fairness-deck-label">
                The top of the deck, as your device rebuilt it (this hand’s
                board and your cards highlighted):
              </div>
              <div className="fairness-deck-cards">
                {shown.map((c) => (
                  <span
                    key={c}
                    className={`fairness-card${onBoard.has(c) ? " fairness-card--board" : mine.has(c) ? " fairness-card--mine" : ""}`}
                  >
                    <PlayingCard card={c as Card} />
                  </span>
                ))}
              </div>
            </div>
          )}
          {record?.revealed && (
            <details className="fairness-raw">
              <summary>Check it yourself (the numbers)</summary>
              <p className="muted">
                SHA-256(server seed) must equal the fairness commitment.
                HMAC-SHA256(key = server seed, message = all player seeds joined
                + “:” + hand number) seeds the shuffle; the full method is in
                the project’s FAIRNESS.md.
              </p>
              <dl>
                <dt>Fairness commitment</dt>
                <dd>
                  <code>{record.commitment}</code>
                </dd>
                <dt>Server seed (revealed)</dt>
                <dd>
                  <code>{record.serverSeed}</code>
                </dd>
                <dt>Player seeds</dt>
                <dd>
                  <code>{record.clientSeeds?.join(" ")}</code>
                </dd>
                <dt>Hand number</dt>
                <dd>
                  <code>{record.handNumber}</code>
                </dd>
              </dl>
              <a
                href={`${API_BASE}/fairness/${handId ?? ""}`}
                target="_blank"
                rel="noreferrer"
              >
                Raw record (JSON)
              </a>
            </details>
          )}
        </>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
