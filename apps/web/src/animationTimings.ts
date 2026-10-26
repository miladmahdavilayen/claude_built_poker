// Every timing of the 3D table's presentation (table3d/) and the split-pot
// announcement (components/SplitPotAnnouncement.tsx), in one place so they
// can be tuned without touching the code that uses them. Milliseconds
// unless the name says otherwise. None of these ever hold up the game: the
// server deals and moves on at its own pace, and every animation here
// either finishes inside the time it has or is cut short by the next event.

export const TIMINGS = {
  /** The camera gliding to a newly taken seat (or back to the spectator view). */
  cameraMoveMs: 800,
  /** The dealer button sliding along the felt to its new seat at the start of a hand. */
  buttonSlideMs: 600,

  // The house dealer's clips (seconds of animation each; see table3d/houseDealer.ts).
  dealerShuffleS: 0.7,
  dealerRiffleS: 0.55,
  dealerBridgeS: 0.4,
  dealerCutS: 0.35,
  dealerBurnS: 0.3,
  dealerDealS: 0.14,
  dealerFlopS: 0.75,
  dealerStreetS: 0.4,
  dealerCollectS: 0.7,
  /** Crossfade between two dealer clips. */
  dealerCrossfadeS: 0.12,

  /** A card's flight from the house dealer's hand to its spot. */
  cardFlightMs: 360,
  /** A community card turning face up once it lands. */
  cardFlipMs: 260,
  /** Chips dropping onto a bet spot. */
  chipDropMs: 220,

  // The split-pot announcement, per pot.
  /** How long each pot's banner stays up. */
  splitBannerMs: 3000,
  /** The pot dividing into one pile per winner. */
  splitPileMs: 500,
  /** Each pile sliding to its winner. */
  splitSlideMs: 600,
  /** Delay between one pile leaving and the next. */
  splitStaggerMs: 150,
  /** The "+$X" label rising from a winner's seat. */
  splitFloatMs: 1600,
  /** A winner's stack counting up to its new total. */
  stackCountUpMs: 700,
  /** "Slow animations" (the table's View menu) stretches the split announcement by this much. */
  slowFactor: 1.8,
} as const;
