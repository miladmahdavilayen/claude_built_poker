-- One-time unit change: every chip amount was a whole number of dollars;
-- from here on every amount everywhere (engine, server, database, wire)
-- is an integer number of CENTS, so sub-dollar stakes like $0.10/$0.20
-- are representable while all pot math stays exact integer arithmetic.
-- See packages/shared/src/money.ts and DECISIONS.md.
--
-- Multiplies every stored amount by 100 — balances, the ledger, hand
-- history, table configs, and each hand's saved initial engine state (the
-- replay input: replaying old actions, now in cents, needs stacks and
-- blinds in cents too). Runs inside the migrator's transaction: if any
-- value would overflow its column, nothing changes.
UPDATE "users" SET "chips" = "chips" * 100;
--> statement-breakpoint
UPDATE "chip_ledger" SET "amount" = "amount" * 100;
--> statement-breakpoint
UPDATE "hands" SET "pot_total" = "pot_total" * 100, "rake_taken" = "rake_taken" * 100;
--> statement-breakpoint
UPDATE "hand_seats" SET "starting_stack" = "starting_stack" * 100, "net_result" = "net_result" * 100;
--> statement-breakpoint
UPDATE "hand_actions" SET "amount" = "amount" * 100, "pot_after" = "pot_after" * 100;
--> statement-breakpoint
UPDATE "hand_results" SET "amount" = "amount" * 100;
--> statement-breakpoint
UPDATE "tables" SET "config" = "config"
  || jsonb_build_object(
    'smallBlind', COALESCE(("config"->>'smallBlind')::bigint, 0) * 100,
    'bigBlind', COALESCE(("config"->>'bigBlind')::bigint, 0) * 100,
    'ante', COALESCE(("config"->>'ante')::bigint, 0) * 100,
    'minBuyIn', COALESCE(("config"->>'minBuyIn')::bigint, 0) * 100,
    'maxBuyIn', COALESCE(("config"->>'maxBuyIn')::bigint, 0) * 100,
    'rakeCap', COALESCE(("config"->>'rakeCap')::bigint, 0) * 100
  );
--> statement-breakpoint
UPDATE "hands" SET "initial_state" = "initial_state"
  || jsonb_build_object(
    'anteTotal', COALESCE(("initial_state"->>'anteTotal')::bigint, 0) * 100,
    'config', ("initial_state"->'config') || jsonb_build_object(
      'smallBlind', COALESCE(("initial_state"->'config'->>'smallBlind')::bigint, 0) * 100,
      'bigBlind', COALESCE(("initial_state"->'config'->>'bigBlind')::bigint, 0) * 100,
      'ante', COALESCE(("initial_state"->'config'->>'ante')::bigint, 0) * 100
    ),
    'betting', ("initial_state"->'betting') || jsonb_build_object(
      'currentBet', COALESCE(("initial_state"->'betting'->>'currentBet')::bigint, 0) * 100,
      'lastFullRaiseIncrement', COALESCE(("initial_state"->'betting'->>'lastFullRaiseIncrement')::bigint, 0) * 100,
      'lastFullBetAmount', COALESCE(("initial_state"->'betting'->>'lastFullBetAmount')::bigint, 0) * 100
    ),
    'seats', COALESCE((
      SELECT jsonb_agg(
        seat || jsonb_build_object(
          'stack', COALESCE((seat->>'stack')::bigint, 0) * 100,
          'committedThisStreet', COALESCE((seat->>'committedThisStreet')::bigint, 0) * 100,
          'committedThisHand', COALESCE((seat->>'committedThisHand')::bigint, 0) * 100,
          'lastActedAtBet', COALESCE((seat->>'lastActedAtBet')::bigint, 0) * 100
        ) ORDER BY ord
      )
      FROM jsonb_array_elements("initial_state"->'seats') WITH ORDINALITY AS s(seat, ord)
    ), '[]'::jsonb),
    'pots', COALESCE((
      SELECT jsonb_agg(
        pot || jsonb_build_object(
          'amount', COALESCE((pot->>'amount')::bigint, 0) * 100,
          'cappedAt', COALESCE((pot->>'cappedAt')::bigint, 0) * 100
        ) ORDER BY ord
      )
      FROM jsonb_array_elements("initial_state"->'pots') WITH ORDINALITY AS p(pot, ord)
    ), '[]'::jsonb)
  );
