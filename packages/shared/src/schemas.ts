import { z } from 'zod';

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
  })
  .strict();
export type TakeSeatIntent = z.infer<typeof TakeSeatSchema>;

/** Owner-only: rebuys a specific seat's occupant — see DECISIONS.md ("owner-only chip economy"). Self-serve rebuy no longer exists. */
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
    actionSeconds: z.number().int().min(5).max(120).default(25),
    timeBankSeconds: z.number().int().min(0).max(600).default(60),
    runItTwiceEnabled: z.boolean().default(false),
    rakePercent: z.number().min(0).max(20).default(0),
    rakeCap: z.number().int().nonnegative().default(0),
    noFlopNoDrop: z.boolean().default(true),
    isPrivate: z.boolean().default(false),
    disableChatInHand: z.boolean().default(false),
  })
  .strict();
export type CreateTableInput = z.infer<typeof CreateTableSchema>;

export const GuestSignupSchema = z
  .object({
    displayName: z.string().min(1).max(24),
  })
  .strict();
export type GuestSignupInput = z.infer<typeof GuestSignupSchema>;

export const GoogleSignInSchema = z
  .object({
    /** The raw ID token (JWT) from Google's client-side Sign In With Google library — verified server-side, never trusted as-is. */
    idToken: z.string().min(1),
  })
  .strict();
export type GoogleSignInInput = z.infer<typeof GoogleSignInSchema>;

export const RegisterSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    displayName: z.string().min(1).max(24),
  })
  .strict();
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(200),
  })
  .strict();
export type LoginInput = z.infer<typeof LoginSchema>;

export const AdminAdjustChipsSchema = z
  .object({
    userId: z.string().min(1),
    amount: z.number().int(),
    reason: z.string().min(1).max(200),
  })
  .strict();
export type AdminAdjustChipsInput = z.infer<typeof AdminAdjustChipsSchema>;
