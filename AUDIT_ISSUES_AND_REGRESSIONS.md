# OTCSwap Security Issues, Fixes, and Regression Coverage

This document maps each identified issue to:
- a concise impact summary,
- a suggested fix direction, and
- the regression test that covers it.

All tests referenced below are in:
`/Users/erebus/Documents/code/liberdus/whaleswap-contract/test/SecurityRegressions.test.js`

Current expected state: these regressions are intentionally failing until contract fixes are implemented.

## Findings Matrix

| ID | Severity | Issue | Suggested Fix | Regression Test |
|---|---|---|---|---|
| F-01 | High | Expired order can be resurrected as fillable after failed cleanup retry (timestamp reset + status Active). | Never recreate failed-cleanup orders as fillable. Keep them non-fillable (`Expired/CleanupPending`) and preserve original expiry semantics. | `should never allow filling an order that was already expired before cleanup retry` (line 28) |
| F-02 | High | Maker principal can be orphaned after max retries (order deleted while escrow remains in contract). | Do not delete active order state unless principal is recovered; add explicit maker recovery path for unrecovered escrow. | `should not orphan maker principal after max cleanup retries` (line 74) |
| F-03 | High | Cleanup treats token `transfer` return `true` as success even if no tokens move. | Use `SafeERC20.safeTransfer` and/or post-transfer balance-delta checks when required for correctness. | `should not mark cleanup as successful when token reports transfer true but moves nothing` (line 117) |
| F-04 | High | Global `accumulatedFees` mixes units across different fee tokens/decimals. | Replace with per-token accounting: `mapping(address => uint256) accumulatedFeesByToken`. | `should not let fees in token B mask insolvency in token A during cleanup payout` (line 164) |
| F-05 | High | Legacy no-return token behavior in cleanup path can force retry loops and eventual principal-loss flow. | Remove `attemptTransfer` bool-return assumption; use `SafeERC20`-compatible transfers in cleanup path. | `should cleanup legacy no-return transfer tokens without retry loops or principal loss` (line 218) |
| F-06 | Medium | Maker cannot cancel active order after grace period; recovery depends on third-party cleanup. | Allow maker cancellation of active orders at any time, or add maker-only withdrawal path for expired active orders. | `should allow maker to cancel active orders after grace to recover principal directly` (line 259) |
| F-07 | Medium | FIFO cleanup API can block cleanup of later expired orders when head is not cleanable. | Support targeted cleanup (`cleanupOrder(orderId)` / batch by ids) or scanning logic that can skip head safely. | `should allow cleanup of expired orders even when queue head is not yet cleanable` (line 296) |
| F-08 | High | `createOrder` assumes exact `sellAmount` escrowed; fee-on-transfer sell token underfunds escrow. | Enforce non-FOT allowlist policy or record/validate actual received amount via balance delta. | `should escrow full sellAmount even when sellToken is fee-on-transfer` (line 345) |
| F-09 | High | `fillOrder` assumes maker receives exact `buyAmount`; fee-on-transfer buy token underpays maker. | Enforce non-FOT tokens or verify maker balance delta equals `buyAmount` before finalizing fill. | `should enforce maker receives full buyAmount when buyToken is fee-on-transfer` (line 379) |
| F-10 | Low | Filled open orders do not persist actual taker in storage (event-only). | On fill of open order, write `order.taker = msg.sender` before emit/finalization. | `should persist actual taker in order storage when open order is filled` (line 419) |
| F-11 | Low | `TokenTransferAttempt` emits `orderId = 0` always (misleading diagnostics). | Pass actual `orderId` into transfer-attempt logging, or remove this event path. | `should emit TokenTransferAttempt with the actual cleaned orderId` (line 455) |
| F-12 | Low | Constructor allowlist can include duplicates in `allowedTokensList`. | In constructor, push only when token was previously not allowed. | `should de-duplicate constructor allowlist entries` (line 508) |
| F-13 | Medium | Self-call `try/catch` transfer architecture adds complexity/overhead in fill path. | Simplify fill path to direct `SafeERC20` transfers with clear ordering and invariant checks. | `should avoid self-call try/catch transfer architecture in fill path` (line 530) |
| F-14 | Low | Duplicate sell-token allowance precheck in `createOrder`. | Remove duplicate check. | `should not duplicate sell-token allowance precheck in createOrder` (line 538) |
| F-15 | Low | `updateAllowedTokens` has no explicit batch cap (owner-side gas-limit risk). | Add `MAX_ALLOWED_TOKENS_BATCH` and enforce `tokens.length <= MAX_ALLOWED_TOKENS_BATCH`. | `should enforce a bounded batch size in updateAllowedTokens to avoid gas-limit lockouts` (line 545) |

## Notes On Test Types

- Most entries are runtime behavioral regressions.
- F-13, F-14, F-15 are source-policy guard tests (static assertions on contract source shape), intentionally used to enforce specific remediation choices.

## Run The Regression Suite

```bash
cd /Users/erebus/Documents/code/liberdus/whaleswap-contract
npx hardhat test test/SecurityRegressions.test.js
```
