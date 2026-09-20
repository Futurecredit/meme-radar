# Meme Radar Result-First Exit V2

## Global constraints

- Preserve strict formal-candidate safety gates; incomplete evidence may only create clearly labelled experimental signals.
- Never connect a wallet, sign, or submit a trade.
- Keep fixed-horizon factor attribution independent from event-exit performance.
- Do not modify the original 3791 deployment or its state.
- Use Node built-in tests and preserve compatibility with the legacy trades API view.

## Task 1: Screening funnel V2 and defaults

Produces: permissive unknown-at-prefilter behavior, strict formal candidate eligibility, isolated incomplete experimental signals, funnel counts/reasons, and new-install 5–60 minute defaults.

1. Add failing policy/scoring/scanner tests for unknown safety fields, explicit fatal risks, cohort separation, reference-only controls/rejects, and funnel accounting.
2. Run the focused tests and confirm expected failures.
3. Implement the smallest scoring, policy, scanner, and factor-lab cohort changes.
4. Run focused tests and the full npm test suite.
5. Commit.

Expected: focused tests and full suite pass.

## Task 2: V2 shadow positions and event exits

Produces: V2 persistence migration, position/reference separation, split 3% cost model, OHLC event replay, stop, principal recovery, trailing exit, safety exit, timeout, pending retry, and fixed-horizon isolation.

1. Add failing factor-lab V2 tests for migration, costs, every exit path, ambiguous candles, gaps, missing liquidity, no future backfill, and retention.
2. Run focused tests and confirm expected failures.
3. Implement V2 position primitives and persistence.
4. Add failing GMGN candle-path and collection-priority tests.
5. Implement allowlisted complete 1m OHLC batch reads and collection integration.
6. Run focused tests and full npm test.
7. Commit.

Expected: all exit semantics are deterministic and tests pass.

## Task 3: Reports, API, status, and export

Produces: immutable milestone/daily reports, capital/exit/report progress summaries, positions/samples/reports API views, legacy trades compatibility, sanitized export, and stable automation boundaries.

1. Add failing report and API tests.
2. Run them and confirm expected failures.
3. Implement report triggers, summaries, pagination, export, and sanitization.
4. Run focused tests and full npm test.
5. Commit.

Expected: endpoints expose only allowlisted non-sensitive data and tests pass.

## Task 4: Result-first homepage and rollout verification

Produces: required homepage ordering, top result dashboard, formal-candidate table, funnel reasons, separate real positions/reference samples, compact responsive tables, six-language strings, and isolated deployment verification.

1. Add failing UI structure/rendering tests.
2. Run them and confirm expected failures.
3. Implement the result-first layout and renderers.
4. Run focused tests, full tests, syntax checks, doctor, audit, and isolated smoke.
5. Commit, obtain a fresh whole-branch review, fix important findings with RED-GREEN tests, and rerun all verification.

Expected: all automated checks and isolated smoke pass before the 43892 instance is restarted.
