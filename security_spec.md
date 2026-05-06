# Security Specification - Quantum Core

## Data Invariants
- `trades`: Every document must have `timestamp`, `score`, `pnl`, and `win`.
- `trades`: Field types must be strictly enforced (string for timestamp, number for scores/pnl, boolean for flags).
- Only authenticated users can read/write trade logs (given this is a professional trading tool).

## The Dirty Dozen (Attacker Payloads)
1. **The Ghost Field**: Adding `isVerified: true` to a trade.
2. **Type Poisoning**: Sending `pnl: "infinite"`.
3. **Identity Spoofing**: Attempting to write a trade as an unauthenticated user.
4. **Massive Payload**: Sending a 1MB string in a field.
5. **Missing Required**: Sending a trade without a `score`.
6. **Invalid ID**: Using `../illegal/path` as a trade ID.
7. **Negative OI**: (Though mathematically possible, let's assume we want valid ranges).
8. **Future Date**: `timestamp` set in 2099.
9. **Zero PnL Win**: Winning trade with negative PnL.
10. **Shadow Edit**: Authenticated user trying to edit someone else's log (if multi-user).
11. **Admin Escalation**: Trying to create an `admins` doc.
12. **Collection Sweep**: Trying to list all trades without proper filters.

## Test Runner
The following tests will be implemented in `firestore.rules.test.ts` to verify these protections.
