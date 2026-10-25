import { z } from 'zod';
import { MAX_BALANCE_CENTS } from './money.js';
import { MAX_SIGNATURE_DATA_URL_LENGTH } from './waiver.js';

// .strict() everywhere: unknown fields are rejected, per spec.

export const ActionTypeSchema = z.enum(['fold', 'check', 'call', 'bet', 'raise']);

export const PlayerActionIntentSchema = z
  .object({
    handId: z.string().min(1),
    actionSeq: z.number().int().nonnegative(),
    type: ActionTypeSchema,
    amountTo: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PlayerActionIntent = z.infer<typeof PlayerActionIntentSchema>;

/** Voluntary post-fold-win card reveal — see LiveTable.revealHand. `handId` guards it the same way PlayerActionIntentSchema's does: it must match the hand this seat actually won, even though the hand itself has already moved to 'hand-complete' by the time this can be sent. */
export const RevealHandSchema = z
  .object({
    handId: z.string().min(1),
  })
  .strict();
export type RevealHandIntent = z.infer<typeof RevealHandSchema>;

export const PreActionSchema = z
  .object({
    handId: z.string().min(1),
    type: z.enum(['check-fold', 'call-any', 'check']),
  })
  .strict();
export type PreActionIntent = z.infer<typeof PreActionSchema>;

export const TakeSeatSchema = z
  .object({
    tableId: z.string().min(1),
    seatId: z.number().int().min(0).max(8),
    buyIn: z.number().int().positive(),
    /** Optional: lets the owner pick a display name for themselves right before sitting down, instead of being stuck with the fixed name their account was created with. */
    displayName: z.string().min(1).max(24).optional(),
  })
  .strict();
export type TakeSeatIntent = z.infer<typeof TakeSeatSchema>;

/** Owner-only: rebuys (adds chips to) a specific seat's occupant, any time — mid-hand for a player still in the hand, the chips land the moment that hand ends. See DECISIONS.md ("owner-only chip economy"). Self-serve rebuy no longer exists. */
export const AdminRebuySchema = z
  .object({
    seatId: z.number().int().min(0).max(8),
    amount: z.number().int().positive(),
  })
  .strict();
export type AdminRebuyIntent = z.infer<typeof AdminRebuySchema>;

/** Owner-only: generates a one-time, seat-and-amount-specific invite link for a human. See DECISIONS.md. */
export const AssignSeatSchema = z
  .object({
    seatId: z.number().int().min(0).max(8),
    buyIn: z.number().int().positive(),
    /** Owner-private label for this invite (e.g. "Dave from work") — shown only to the owner, in parentheses next to the redeemer's own chosen display name. Never seen by anyone else. */
    nickname: z.string().max(40).optional(),
  })
  .strict();
export type AssignSeatIntent = z.infer<typeof AssignSeatSchema>;

/** Redeems an owner-generated seat-assignment link — the buy-in comes from the token itself, never from the redeemer. */
export const RedeemAssignmentSchema = z
  .object({
    token: z.string().min(1),
  })
  .strict();
export type RedeemAssignmentIntent = z.infer<typeof RedeemAssignmentSchema>;

export const AddBotSchema = z
  .object({
    seatId: z.number().int().min(0).max(8),
    /** One of the persona ids in @pokerclause/sim's ALL_BOT_POLICIES (validated server-side against that list, not here). */
    persona: z.string().min(1),
    buyIn: z.number().int().positive(),
  })
  .strict();
export type AddBotIntent = z.infer<typeof AddBotSchema>;

export const RemoveBotSchema = z
  .object({
    seatId: z.number().int().min(0).max(8),
  })
  .strict();
export type RemoveBotIntent = z.infer<typeof RemoveBotSchema>;

export const JoinTableSchema = z
  .object({
    tableId: z.string().min(1),
    /** Required for a private table, unless the caller is already seated there. */
    inviteCode: z.string().min(1).optional(),
  })
  .strict();
export type JoinTableIntent = z.infer<typeof JoinTableSchema>;

// The server never interprets `data` — it's an opaque relay for whatever
// SDP offer/answer or ICE candidate the two browsers' WebRTC stacks agree
// on between themselves. See RtcSignalData in apps/web for the client-side
// shape both ends actually use.
export const RtcSignalSchema = z
  .object({
    to: z.string().min(1),
    data: z.unknown(),
  })
  .strict();
export type RtcSignalIntent = z.infer<typeof RtcSignalSchema>;

export const ChatMessageSchema = z
  .object({
    message: z.string().min(1).max(500),
  })
  .strict();
export type ChatMessageIntent = z.infer<typeof ChatMessageSchema>;

export const MissedBlindChoiceSchema = z
  .object({
    choice: z.enum(['post', 'wait']),
  })
  .strict();
export type MissedBlindChoiceIntent = z.infer<typeof MissedBlindChoiceSchema>;

export const CreateTableSchema = z
  .object({
    name: z.string().min(1).max(60),
    smallBlind: z.number().int().positive(),
    bigBlind: z.number().int().positive(),
    ante: z.number().int().nonnegative().default(0),
    maxSeats: z.number().int().min(2).max(9),
    straddleEnabled: z.boolean().default(false),
    minBuyInBB: z.number().int().positive().default(40),
    maxBuyInBB: z.number().int().positive().default(100),
    /** Optional absolute buy-in range in cents — overrides minBuyInBB/maxBuyInBB when given. */
    minBuyIn: z.number().int().positive().optional(),
    maxBuyIn: z.number().int().positive().optional(),
    actionSeconds: z.number().int().min(5).max(120).default(25),
    timeBankSeconds: z.number().int().min(0).max(600).default(60),
    runItTwiceEnabled: z.boolean().default(false),
    rakePercent: z.number().min(0).max(20).default(0),
    rakeCap: z.number().int().nonnegative().default(0),
    noFlopNoDrop: z.boolean().default(true),
    isPrivate: z.boolean().default(false),
    disableChatInHand: z.boolean().default(false),
    /** An open-invite table: one shareable link, anyone holding it picks their own seat (always private — kept off the lobby). */
    openSeating: z.boolean().default(false),
    /** An open-invite table's starting chips (cents) for each new player — the table's maximum buy-in when not given. */
    openSeatStack: z.number().int().positive().max(MAX_BALANCE_CENTS).optional(),
  })
  .strict();
export type CreateTableInput = z.infer<typeof CreateTableSchema>;

/**
 * Owner-only, any time — including mid-hand. Every field is optional; only
 * the ones present change. Blinds/ante/straddle can't change under a hand
 * already in progress (the engine reads them on every street), so mid-hand
 * those queue and apply from the next deal — see LiveTable.updateSettings.
 * All amounts are integer cents.
 */
export const UpdateTableSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    smallBlind: z.number().int().positive().optional(),
    bigBlind: z.number().int().positive().optional(),
    ante: z.number().int().nonnegative().optional(),
    straddleEnabled: z.boolean().optional(),
    minBuyIn: z.number().int().positive().optional(),
    maxBuyIn: z.number().int().positive().optional(),
    actionSeconds: z.number().int().min(5).max(120).optional(),
    timeBankSeconds: z.number().int().min(0).max(600).optional(),
    isPrivate: z.boolean().optional(),
    disableChatInHand: z.boolean().optional(),
    /** Open-invite tables only: what a guest new to the table sits down with. */
    openSeatStack: z.number().int().positive().max(MAX_BALANCE_CENTS).optional(),
  })
  .strict();
export type UpdateTableSettingsIntent = z.infer<typeof UpdateTableSettingsSchema>;

/** Owner-only: removes a seat's occupant (seat stays) or deletes the seat entirely — see LiveTable.removeSeatOccupant/deleteSeat. */
export const SeatTargetSchema = z
  .object({
    seatId: z.number().int().min(0).max(8),
  })
  .strict();
export type SeatTargetIntent = z.infer<typeof SeatTargetSchema>;

export const GuestSignupSchema = z
  .object({
    displayName: z.string().min(1).max(24),
    /** The owner's invite this guest session is for — a seat invite's `assign` token, or an open-invite table's code. No guest session exists without one. */
    inviteToken: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    /** The guest ticked "I agree" to the guest terms (see GUEST_TERMS in waiver.ts) — required, and of the version they were shown. */
    acceptTerms: z.literal(true),
    termsVersion: z.number().int().min(1),
    /** A random secret this browser keeps per open-invite link — the same guest comes back by it (their chips too), even once their session is gone. */
    guestKey: z.string().regex(/^[A-Za-z0-9_-]{22,128}$/).optional(),
  })
  .strict();
export type GuestSignupInput = z.infer<typeof GuestSignupSchema>;

export const GoogleSignInSchema = z
  .object({
    /** The raw ID token (JWT) from Google's client-side Sign In With Google library — verified server-side, never trusted as-is. */
    idToken: z.string().min(1),
    /** An owner-generated access key — required only when this Google account isn't registered yet. See apps/server's signupKeys.ts. */
    signupKey: z.string().max(64).optional(),
  })
  .strict();
export type GoogleSignInInput = z.infer<typeof GoogleSignInSchema>;

/** Checks an access key before the landing page offers Google sign-up — the real check (and use) happens on registration itself. */
export const SignupKeySchema = z
  .object({
    key: z.string().min(1).max(64),
  })
  .strict();

/** Owner-only: a new one-time access key for one new player. */
export const CreateSignupKeySchema = z
  .object({
    /** Who it's for, e.g. "Dave from work". */
    label: z.string().trim().min(1).max(60),
    /** Optional: only this Google email may register with it. */
    email: z.string().trim().email().max(254).optional(),
    expiresInDays: z.number().int().min(1).max(30).default(7),
  })
  .strict();

/** Agreeing to the friendly-game waiver (see waiver.ts): initials, a drawn signature, and what the browser can tell about the device. */
export const AcceptWaiverSchema = z
  .object({
    /** Letters only — e.g. "JD", or "J" for a one-name player. */
    initials: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{1,5}$/),
    /** The signature as drawn, a PNG data URL. */
    signature: z
      .string()
      .max(MAX_SIGNATURE_DATA_URL_LENGTH)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
    /** Which version of the text was on screen — must be the current one. */
    version: z.number().int().positive(),
    /** Reported by the browser — kept with the signed copy as-is, labelled as reported. */
    device: z
      .object({
        platform: z.string().max(100).optional(),
        language: z.string().max(40).optional(),
        timeZone: z.string().max(80).optional(),
        screen: z.string().max(40).optional(),
        touch: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

/** The owner's login. `email` is whatever ADMIN_EMAIL is — an email address in production, or a plain username (e.g. "admin" for local runs). */
export const LoginSchema = z
  .object({
    email: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(200),
  })
  .strict();
export type LoginInput = z.infer<typeof LoginSchema>;

export const AdminAdjustChipsSchema = z
  .object({
    userId: z.string().min(1),
    amount: z.number().int().min(-MAX_BALANCE_CENTS).max(MAX_BALANCE_CENTS),
    reason: z.string().min(1).max(200),
  })
  .strict();
export type AdminAdjustChipsInput = z.infer<typeof AdminAdjustChipsSchema>;

/** Admin dashboard: sets a balance to an exact amount. Still ledgered — as the difference from the current balance. */
export const AdminSetChipsSchema = z
  .object({
    userId: z.string().min(1),
    balance: z.number().int().min(0).max(MAX_BALANCE_CENTS),
    reason: z.string().min(1).max(200),
  })
  .strict();
export type AdminSetChipsInput = z.infer<typeof AdminSetChipsSchema>;

/** Admin dashboard: edits a user's display name. Chip changes go through AdminAdjustChipsSchema instead — a delta plus a reason, not a raw overwrite, so every change stays in the ledger. */
export const AdminUpdateUserSchema = z
  .object({
    displayName: z.string().min(1).max(24),
  })
  .strict();
export type AdminUpdateUserInput = z.infer<typeof AdminUpdateUserSchema>;

/** Admin dashboard's multi-select delete — the admin's own account is silently skipped rather than erroring the whole batch, same as the single-delete route's own CANNOT_DELETE_ADMIN guard. */
export const AdminBulkDeleteUsersSchema = z
  .object({
    userIds: z.array(z.string().min(1)).min(1).max(200),
  })
  .strict();
export type AdminBulkDeleteUsersInput = z.infer<typeof AdminBulkDeleteUsersSchema>;

/**
 * The stake levels a signed-in (Google) player can pick for a practice
 * table — fixed presets rather than free-form blinds, since a practice
 * table is the only kind of table they can play at. Amounts in cents;
 * buy-ins run 40–100 big blinds, like every seeded table.
 */
export const PRACTICE_STAKES = {
  low: { label: '$0.50/$1', smallBlind: 50, bigBlind: 100, minBuyIn: 4_000, maxBuyIn: 10_000 },
  medium: { label: '$1/$2', smallBlind: 100, bigBlind: 200, minBuyIn: 8_000, maxBuyIn: 20_000 },
  high: { label: '$5/$10', smallBlind: 500, bigBlind: 1_000, minBuyIn: 40_000, maxBuyIn: 100_000 },
} as const;
export type PracticeStakes = keyof typeof PRACTICE_STAKES;

/** A practice table seats the player plus 1–4 computer players — at most 5 seats. */
export const MAX_PRACTICE_BOTS = 4;

export const CreatePracticeTableSchema = z
  .object({
    bots: z.number().int().min(1).max(MAX_PRACTICE_BOTS),
    stakes: z.enum(['low', 'medium', 'high']),
    /** The player's own buy-in, in cents — must sit inside the chosen stakes' range. Every bot buys in for the same amount. */
    buyIn: z.number().int().positive(),
  })
  .strict();
export type CreatePracticeTableInput = z.infer<typeof CreatePracticeTableSchema>;
