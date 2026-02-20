# OTCSwap Issues and Suggested Solutions

This document lists only the issues and fix directions, with short concrete examples.

## 1) Expired Order Resurrection
**Problem**  
If cleanup fails for an expired order, the contract recreates it as a new `Active` order with a fresh timestamp.  

**Example**  
Alice creates an order on day 1. It expires by day 8. Cleanup fails on day 15, and the contract recreates the order. Bob can now fill it on day 16 at stale pricing.

**Suggested Solution**  
Never recreate failed-cleanup orders as fillable. Keep them in a non-fillable state (`Expired`/`CleanupPending`) and preserve original expiry semantics.

## 2) Principal Can Be Orphaned After Max Retries
**Problem**  
After repeated cleanup failures, the contract can delete the order record while the escrowed sell tokens remain stuck in the contract.

**Example**  
Alice’s token is paused during cleanup retries. After max attempts, the order is deleted, but Alice’s tokens are still in the contract with no direct recovery path.

**Suggested Solution**  
Do not delete state that binds escrow to maker unless principal is actually recovered. Add maker-only recovery/withdraw flow for unrecovered escrow.

## 3) Cleanup “Success” Can Be False
**Problem**  
Cleanup transfer logic can treat `transfer == true` as success even when no tokens actually move.

**Example**  
A malicious token reports success on transfer but sends zero tokens. Cleaner still gets paid and order is treated as cleaned.

**Suggested Solution**  
Use `SafeERC20.safeTransfer` and, where exactness matters, validate post-transfer balance deltas.

## 4) Mixed Fee Accounting Across Tokens
**Problem**  
A single `accumulatedFees` number tracks fees from potentially different fee tokens.

**Example**  
Alice pays fee in token A, Bob pays fee in token B after owner changes fee config. Their balances are mixed into one scalar, breaking accounting invariants.

**Suggested Solution**  
Track fees per token: `mapping(address => uint256) accumulatedFeesByToken`.

## 5) No-Return Token Compatibility Gap in Cleanup
**Problem**  
Cleanup transfer path assumes strict boolean-return ERC20 behavior; legacy no-return tokens can fail this path.

**Example**  
Alice uses a legacy token whose `transfer` returns no value. Cleanup keeps failing and order enters retry/deletion path.

**Suggested Solution**  
Unify cleanup transfer path with `SafeERC20`-compatible transfer handling.

## 6) Maker Cannot Cancel After Grace Period
**Problem**  
Maker loses direct control after grace window and must rely on third-party cleanup.

**Example**  
Alice’s order is still active but past grace. She cannot cancel herself even though her funds are still escrowed.

**Suggested Solution**  
Allow maker cancellation of active orders at any time, or provide maker-only withdrawal for expired active orders.

## 7) Cleanup Head-of-Line Blocking Risk
**Problem**  
Cleanup processes from a single queue head, which can prevent cleaning eligible later orders in edge queue states.

**Example**  
Order #1 is not cleanable yet; order #2 is cleanable. Cleaner can’t target #2 directly and must wait.

**Suggested Solution**  
Add targeted cleanup (`cleanupOrder(orderId)` and optional batched ids) with eligibility checks.

## 8) Fee-on-Transfer Sell Token Breaks Escrow Exactness
**Problem**  
Contract records `sellAmount` but may receive less if sell token charges transfer fee.

**Example**  
Alice creates an order to sell 100 units; contract receives 95 due to token tax. Later release of 100 can fail.

**Suggested Solution**  
Either disallow fee-on-transfer tokens in allowlist policy, or measure received amount and store actual escrowed amount.

## 9) Fee-on-Transfer Buy Token Underpays Maker
**Problem**  
`fillOrder` assumes maker receives exact `buyAmount`, but fee-on-transfer buy token can deliver less.

**Example**  
Bob fills Alice’s order with buy token taxed 50%. Alice expects 200, receives 100, but Bob still receives full sell side.

**Suggested Solution**  
Require exact maker receipt (balance-delta check) or restrict allowlist to non-fee-on-transfer tokens.

## 10) Actual Taker Not Persisted in Storage for Open Orders
**Problem**  
Open order (`taker = 0`) fill does not persist the real taker in order storage.

**Example**  
Bob fills Alice’s open order. Event shows Bob, but storage still shows zero taker, reducing forensic clarity for state-only consumers.

**Suggested Solution**  
On successful fill of open order, write `order.taker = msg.sender`.

## 11) Misleading Cleanup Transfer Attempt Event
**Problem**  
`TokenTransferAttempt` logs `orderId = 0` regardless of actual order.

**Example**  
Cleaner processes order #42, event logs order id 0, making monitoring and incident debugging misleading.

**Suggested Solution**  
Include actual order id in the event emission path.

## 12) Duplicate Allowlist Entries Possible at Construction
**Problem**  
Constructor can push duplicate addresses into `allowedTokensList`.

**Example**  
Owner passes `[USDC, USDC, WETH]`. Mapping is correct, list has duplicates and confuses UI consumers.

**Suggested Solution**  
Only push token into list if it was not already marked allowed.

## 13) Over-Complex Self-Call Transfer Architecture
**Problem**  
`fillOrder` relies on external self-calls and nested try/catch, increasing complexity and maintenance risk.

**Example**  
Alice/Bob fill path traverses self-call wrappers instead of direct safe transfers, making behavior harder to reason about and audit.

**Suggested Solution**  
Simplify with direct `SafeERC20` transfers and clear state-transition ordering.

## 14) Duplicate Allowance Precheck
**Problem**  
`createOrder` checks sell-token allowance twice.

**Example**  
Alice submits order; contract does the same allowance read twice, adding unnecessary gas and complexity.

**Suggested Solution**  
Remove duplicate precheck.

## 15) Unbounded Owner Batch in `updateAllowedTokens`
**Problem**  
No explicit cap on batch size in allowlist updates.

**Example**  
Owner attempts very large token batch update; tx can hit gas limits and operationally fail.

**Suggested Solution**  
Add a constant batch limit and enforce `tokens.length <= MAX_ALLOWED_TOKENS_BATCH`.
