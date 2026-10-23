/**
 * The friendly-game waiver — its text lives here, once, so the page a
 * player reads (apps/web's Waiver page) and the signed PDF kept on record
 * (apps/server's waiverPdf.ts) can never say different things. No
 * dependencies: the browser imports this directly (`@pokerclause/shared/waiver`).
 *
 * Changing a word means bumping WAIVER_VERSION: everyone is asked to read
 * and sign the new version, and each signed copy records which one it was.
 */
export const WAIVER_VERSION = 2;

export const WAIVER_TITLE = 'Friendly game agreement';

export const WAIVER_INTRO = [
  'PokerClause is a private app for a small circle of friends — a friendly home game, played only for fun.',
  'By typing your initials and signing below, you understand and agree that:',
];

export const WAIVER_TERMS: readonly { lead: string; text: string }[] = [
  {
    lead: 'It’s play money only.',
    text: 'Chips have no cash value and can’t be bought, sold or cashed out. No one — including the app’s owner — makes any money or gains any benefit from it.',
  },
  { lead: 'It’s provided as is.', text: 'There’s no promise it works, stays online, or keeps your account or balance.' },
  {
    lead: 'You play at your own risk',
    text: 'and give up any right to sue or bring any claim against the app or its owner over anything to do with it, to the fullest extent the law allows.',
  },
  { lead: 'The owner may change, pause or remove', text: 'the app or your account at any time.' },
  {
    lead: 'The owner keeps this signed agreement.',
    text: 'A copy of it — with your initials, signature, and the date, time, IP address and device you signed from — stays with the app’s owner permanently, even if you delete your account.',
  },
];

/** The signature image: a PNG data URL, at most this many characters (~280 KB). */
export const MAX_SIGNATURE_DATA_URL_LENGTH = 380_000;
