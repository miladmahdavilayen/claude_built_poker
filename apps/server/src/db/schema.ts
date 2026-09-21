import { relations } from 'drizzle-orm';
import { boolean, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['player', 'admin']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  /** Google's stable per-user `sub` claim. Null for guests and email/password accounts. */
  googleId: text('google_id').unique(),
  displayName: text('display_name').notNull(),
  isGuest: boolean('is_guest').notNull().default(true),
  role: userRoleEnum('role').notNull().default('player'),
  avatarSeed: text('avatar_seed').notNull(),
  clientSeed: text('client_seed').notNull(),
  chips: integer('chips').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chipLedgerReasonEnum = pgEnum('chip_ledger_reason', ['buy_in', 'cash_out', 'pot_win', 'rake', 'admin_adjust']);

/** Double-entry: every chip movement is a paired debit/credit row sharing a groupId. */
export const chipLedger = pgTable('chip_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  /** 'house' pseudo-account (userId null) is the other side of buy-ins/cash-outs/rake. */
  isHouse: boolean('is_house').notNull().default(false),
  amount: integer('amount').notNull(), // positive = credit, negative = debit
  reason: chipLedgerReasonEnum('reason').notNull(),
  tableId: uuid('table_id'),
  handId: uuid('hand_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tableStatusEnum = pgEnum('table_status', ['open', 'closed']);

export const tables = pgTable('tables', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  config: jsonb('config').notNull(), // TableSettings
  status: tableStatusEnum('status').notNull().default('open'),
  inviteCode: text('invite_code'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const hands = pgTable('hands', {
  id: uuid('id').primaryKey().defaultRandom(),
  tableId: uuid('table_id').notNull().references(() => tables.id, { onDelete: 'cascade' }),
  handNumber: integer('hand_number').notNull(),
  buttonSeat: integer('button_seat').notNull(),
  boardCards: jsonb('board_cards').notNull().$type<string[]>(),
  potTotal: integer('pot_total').notNull(),
  rakeTaken: integer('rake_taken').notNull().default(0),
  /** Full initial TableState the hand was dealt from — replayHand(initialState, deck, actions) must reproduce this hand exactly. */
  initialState: jsonb('initial_state').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export const handSeats = pgTable(
  'hand_seats',
  {
    handId: uuid('hand_id').notNull().references(() => hands.id, { onDelete: 'cascade' }),
    seat: integer('seat').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    startingStack: integer('starting_stack').notNull(),
    holeCards: jsonb('hole_cards').notNull().$type<string[]>(),
    netResult: integer('net_result').notNull(),
    showedDown: boolean('showed_down').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.handId, t.seat] })],
);

export const handActions = pgTable(
  'hand_actions',
  {
    handId: uuid('hand_id').notNull().references(() => hands.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    street: text('street').notNull(),
    seat: integer('seat').notNull(),
    action: text('action').notNull(),
    amount: integer('amount'),
    potAfter: integer('pot_after').notNull(),
    msToAct: integer('ms_to_act'),
  },
  (t) => [primaryKey({ columns: [t.handId, t.seq] })],
);

export const handResults = pgTable('hand_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  handId: uuid('hand_id').notNull().references(() => hands.id, { onDelete: 'cascade' }),
  potIndex: integer('pot_index').notNull(),
  winnerSeat: integer('winner_seat').notNull(),
  amount: integer('amount').notNull(),
  handRankName: text('hand_rank_name'),
  bestFiveCards: jsonb('best_five_cards').$type<string[]>(),
});

export const rngCommits = pgTable('rng_commits', {
  handId: uuid('hand_id').primaryKey().references(() => hands.id, { onDelete: 'cascade' }),
  commitment: text('commitment').notNull(),
  serverSeed: text('server_seed'), // null until revealed
  clientSeeds: jsonb('client_seeds').notNull().$type<string[]>(),
  nonce: integer('nonce').notNull(),
  deckOrder: jsonb('deck_order').$type<string[]>(), // set once revealed
  revealedAt: timestamp('revealed_at', { withTimezone: true }),
});

export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tableId: uuid('table_id').notNull().references(() => tables.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  message: text('message').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const handsRelations = relations(hands, ({ many, one }) => ({
  seats: many(handSeats),
  actions: many(handActions),
  results: many(handResults),
  rngCommit: one(rngCommits, { fields: [hands.id], references: [rngCommits.handId] }),
  table: one(tables, { fields: [hands.tableId], references: [tables.id] }),
}));

export const tablesRelations = relations(tables, ({ many }) => ({
  hands: many(hands),
  chatMessages: many(chatMessages),
}));
