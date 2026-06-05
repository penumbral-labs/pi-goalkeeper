# Code Review Guidance

## Runtime event contracts

When reviewing `pi.on` handlers, only use fields documented by the `@earendil-works/pi-coding-agent` types for that
event.

- Do not read undocumented fields from payloads via type casts (for example `_event.args` on `tool_execution_end`).
- If an event needs data from a prior event, pass it through an explicit bridge keyed by `toolCallId` (for example cache
  `tool_call.input` and read it from `tool_execution_end`).
- Add a focused test that fails when a prior event is missing, so fallback behavior stays explicit.

## Persisted state validation

Treat reconstructed/custom entries as untrusted user data.

- Use strict checks for numbers in guards/validators (`Number.isInteger` + lower/upper bounds), never bare
  `typeof x === "number"` for persisted fields.
- Reject invalid timestamps and usage counters (`NaN`, `Infinity`, fractions, negative values) for `createdAt`,
  `updatedAt`, `tokenBudget`, `tokensUsed`, and `activeSeconds`.
- Keep checks local and aligned with related validators in the same file.
- Add/keep tests that exercise malformed reconstruction cases.

## Breaker and limiter counters

For all repeat-breakers, only increment counters when all identifying dimensions are equal.

- Do not key only on `signature`; include normalized error text whenever it changes breaker state.
- Reset error repetition counters when either operation signature or normalized text changes.
- Ensure `repeatedToolCall` and similar counters remain explicit about the dimensions they observe.

## Limit reason/status mapping

Avoid implicit fallthrough for terminal-status mapping.

- Map every new `GoalLimitReason` explicitly to the intended status instead of relying on a shared default.
- Add tests that pin the exact status exposed for each terminal reason (including `maxContinuationTurns`).

## Canonical serialization and helper contracts

Keep canonicalization helpers defensive and fully typed.

- Ensure functions like `stableJson` never return non-strings and that all branches preserve valid, deterministic
  output.
- Match JSON-like behavior for missing/undefined values where possible (`null`/omission semantics) and cover these paths
  with tests.
- Use direct event-handler registration with the typed API overload (`pi.on("tool_call", ...)`) instead of unsafe casts.

## Turn queue outcome and user feedback

Queueing follow-up turns is a user-facing operation and must report outcomes.

- Return an explicit queue result from queue helpers (`queued` + message + notification type).
- Emit user notifications only after queue decisions are final.
- On queuing failure, notify the user instead of failing silently.

## Snapshot integrity

Clone complex goal state consistently and efficiently.

- Deep-clone policy objects when exposing or serializing goal records if progress uses similar isolation guarantees.
- Reuse a single progress clone when multiple derived values are read from it in the same path (for example in
  continuation increments).
