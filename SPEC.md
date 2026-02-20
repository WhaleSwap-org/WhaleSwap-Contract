# WhaleSwap OTCSwap Contract Specification

## 1. Purpose and Scope

This document specifies the on-chain behavior of the WhaleSwap OTC smart contract only.

It intentionally excludes:
- web app UX,
- indexer/server behavior,
- off-chain pricing/routing concerns.

This spec supersedes the original Liberdus-constrained OTC concept. In WhaleSwap, both sides of an order can be any token in the allowlist.

## 2. High-Level Model

The contract is an escrow-based, all-or-nothing order book for ERC20 swaps.

- Maker creates an order by escrowing `sellToken` and paying an order creation fee.
- Taker fills by paying `buyToken` to maker and receives escrowed `sellToken`.
- Orders expire after `ORDER_EXPIRY` and become cleanup-eligible after `ORDER_EXPIRY + GRACE_PERIOD`.
- Cleanup is permissionless and rewards the cleaner with the order’s creation fee.

## 3. Roles

- `owner`: configures fee token/amount, updates allowlist, can disable new orders.
- `maker`: creates/cancels orders.
- `taker`: fills eligible orders.
- `cleaner`: removes cleanup-eligible orders and receives cleanup fee credits.
- `claimer`: any address with claimable token balance can withdraw.

## 4. Configuration and Constants

- `ORDER_EXPIRY = 7 days`
- `GRACE_PERIOD = 7 days`
- `isDisabled`: when true, creation of new orders is blocked.
- `feeToken` and `orderCreationFeeAmount`: active fee config for new orders only.
- Allowlist:
  - both `sellToken` and `buyToken` MUST be allowlisted.
  - no Liberdus-token-side requirement.

## 5. Core Data Structures

### 5.1 Orders

Each order MUST store:
- maker
- optional authorized taker (`address(0)` means open order)
- sell token + amount
- buy token + amount
- creation timestamp
- status
- per-order fee token and fee amount snapshot at creation time

### 5.2 Token-Scoped Fee Accounting

Fee accounting MUST be per token:

- `accumulatedFeesByToken[feeToken]`

A single global fee accumulator is NOT allowed.

### 5.3 Claimable Withdrawal Ledger

The contract MUST maintain claimable balances by user and token, e.g.:

- `claimable[user][token]`

All cancel/cleanup payouts MUST be credited here (not transferred inline).

### 5.4 Claimable Token Enumeration (No Indexer Requirement)

To support frontend discovery of all claimable tokens for a user without events/indexers, the contract MUST maintain:

- `claimableTokensByUser[user] -> address[]`
- `hasClaimableToken[user][token] -> bool`

Rules:
- when crediting `claimable[user][token]`, if `hasClaimableToken[user][token] == false`, set it true and append token to `claimableTokensByUser[user]`.
- this list is independent of the trading allowlist and MUST keep working even if a token is later removed from allowed trading tokens.
- zero-balance entries MUST NOT remain in `claimableTokensByUser`.
- when `claimable[user][token]` becomes zero (for example after withdraw), token MUST be removed from `claimableTokensByUser[user]`.
- removal SHOULD use swap-and-pop plus an index mapping for O(1) maintenance, e.g. `claimableTokenIndex[user][token]`.
  - swap-and-pop means: move the last array element into the removed element’s slot, update that moved element’s index, then `pop()` the last slot.

Required reads:
- `getClaimableTokens(user) -> address[]`
- `claimable(user, token) -> uint256`

## 6. Functional Specification

### 6.1 `createOrder(...)`

Requirements:
- contract not disabled
- tokens valid and allowlisted
- non-zero amounts
- `sellToken != buyToken`
- maker approved and funded for:
  - `sellAmount` of `sellToken`
  - creation fee in current `feeToken`

Effects:
- transfer in sell escrow
- transfer in order fee
- increment `accumulatedFeesByToken[order.feeToken]` by per-order fee amount
- create active order

### 6.2 `fillOrder(orderId)`

Requirements:
- order exists and is active
- current time `<= order.timestamp + ORDER_EXPIRY`
- caller is authorized taker (or order is open)
- taker approved/funded for `buyAmount`

Effects:
- atomic swap:
  - `buyToken` from taker to maker
  - `sellToken` from contract to taker
- mark order as filled
- order fee remains protocol fee (cleaner reward on cleanup)

### 6.3 `cancelOrder(orderId)`

Requirements:
- order exists and is active
- caller is maker

Effects:
- mark order as canceled
- DO NOT transfer tokens inline
- credit maker claim:
  - `claimable[maker][sellToken] += sellAmount`

Rationale:
- cancellation state progression must not be blocked by token transfer failures.

### 6.4 `cleanupExpiredOrders()`

Requirements:
- processes only cleanup-eligible orders (`now > timestamp + ORDER_EXPIRY + GRACE_PERIOD`)

Effects:
- cleanup MUST NOT transfer ERC20 tokens inline.
- cleanup MUST remove order state deterministically without retry resurrection.
- cleanup MUST credit all contract-held value attributable to this order into `claimable`.
- cleanup MUST credit claims based on order state:
  - `Active` order: credit maker `sellAmount` of `sellToken`.
  - `Canceled` order: do not double-credit if already credited at cancel time.
  - `Filled` order: no escrow principal credit is expected in the current all-or-nothing model.
  - if future versions hold value attributable to either side (maker or taker), cleanup MUST credit the rightful party instead of transferring inline.
- cleaner reward:
  - credit cleaner in order’s fee token:
    - `claimable[cleaner][order.feeToken] += order.orderCreationFee`
  - decrement:
    - `accumulatedFeesByToken[order.feeToken] -= order.orderCreationFee`
- delete order state.

### 6.5 `withdraw(token, amount)` (or equivalent claim function)

Requirements:
- caller has sufficient `claimable[caller][token]`

Effects:
- check-effects-interactions order:
  - reduce claimable first
  - transfer token to caller
- revert on transfer failure; claimable reduction MUST be rolled back on revert
- emits withdrawal event

This function is the only path for users/cleaners to receive cancel/cleanup payouts.

Frontend retrieval flow (no indexer):
- call `getClaimableTokens(user)`,
- for each returned token, call `claimable(user, token)`,
- all returned tokens are expected to have non-zero claimable balances.

## 7. Audit-Driven Security Requirements

### 7.1 No Transfer-Dependent State Progression in Cancel/Cleanup

Cancel and cleanup MUST be state-safe even if token transfers would fail due to:
- paused token,
- blacklist logic,
- non-standard token behavior,
- temporary token-side issues.

Therefore, cancel/cleanup payouts are ledger credits, not inline transfers.

### 7.2 No Cleanup Retry Resurrection

Failed cleanup transfer retries that recreate fillable orders are forbidden.

- No retry counter that re-creates orders with fresh timestamps.
- No mechanism that reopens expired market terms.

### 7.3 No Order Deletion Without Preserving Economic Ownership

If an order is deleted in cleanup, all owed value MUST already be represented in claimable balances.

### 7.4 Fee Accounting Must Be Token-Scoped

Fee liabilities/rewards MUST be computed per token. Mixed-token fee accounting is forbidden.

## 8. Invariants

For each order:
- `order.feeToken` and `order.orderCreationFee` are immutable snapshots.
- cleanup reward for that order is paid in that same `order.feeToken`.

For fee accounting:
- `accumulatedFeesByToken[token]` MUST never underflow.
- cleaner fee credits MUST be deducted from matching token bucket.

For claims:
- claimable balances are monotonic up on credit, down on withdraw.
- no double-crediting of the same economic amount.

For lifecycle:
- `Active -> Filled | Canceled -> Cleaned/Deleted`
- `Active -> Cleaned/Deleted` when cleanup-eligible
- deleted orders cannot be filled/canceled again.

## 9. Token Policy

The contract assumes ERC20 integration via `SafeERC20`.

If the protocol wants to support fee-on-transfer/rebasing/non-standard tokens, behavior MUST be explicitly specified and tested. Otherwise, governance should only allowlist tokens with standard transfer semantics.

## 10. Events (Required)

At minimum, emit events for:
- order created/filled/canceled/cleaned,
- fee config and allowlist updates,
- claim credited (beneficiary, token, amount, reason/orderId),
- claim withdrawn (beneficiary, token, amount).
