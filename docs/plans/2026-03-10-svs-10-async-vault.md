# SVS-10: Async Vault (ERC-7540) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build SVS-10, a production-quality async vault program with request→fulfill→claim lifecycle, matching the SVS repo's conventions exactly.

**Architecture:** SVS-10 uses the SVS-2 stored-balance model (operator controls `total_assets`/`total_shares` at fulfillment time). Dual pricing: vault-priced (svs-math) or oracle-priced (svs-oracle) determined by whether oracle account is passed via remaining_accounts. Shares are Token-2022, assets use TokenInterface (SPL or Token-2022). Module system integrated via `remaining_accounts` + feature flag.

**Timing invariant:** `vault.total_shares` includes reserved-but-unminted shares between fulfill and claim. This means `shares_mint.supply <= vault.total_shares` during that window. The difference represents shares that have been accounted for in fulfillment but not yet minted to the receiver. This is by design — it prevents double-counting and ensures share price accuracy.

**Synchronous cancel (intentional ERC-7887 deviation):** SVS-10 uses synchronous cancel — assets (or shares) are returned immediately in the cancel transaction. ERC-7887's async cancel flow (where cancel itself goes through request→fulfill) is out of scope. This is an intentional simplification appropriate for Solana's execution model.

**Oracle front-running mitigation:** To prevent oracle manipulation, AsyncVault includes a `max_deviation_bps` field (default 500 = 5%). During oracle-priced fulfillment, the operator calls `svs_oracle::validate_deviation(oracle_price, vault_computed_price, max_deviation_bps)` to ensure the oracle price hasn't deviated excessively from the vault's own computed price. This limits the damage from stale or manipulated oracle feeds. **Empty vault exception:** When `total_assets == 0 && total_shares == 0`, the deviation check is skipped — the vault-computed price is purely synthetic from the virtual offset and doesn't represent real market conditions.

**Tech Stack:** Anchor 0.31.1, Rust, Token-2022, svs-math, svs-oracle, svs-module-hooks, TypeScript SDK, Commander CLI

**Reuse from credit_markets_vault:** The request→fulfill→claim state machine, PDA-signed CPI patterns, escrow token account lifecycle, and checked arithmetic patterns from our earlier implementation inform the design. Key differences: SVS-10 uses SVS naming (AsyncVault/operator/fulfill vs PoolState/manager/approve), dual pricing mode, OperatorApproval PDAs, virtual offset math via svs-math, and the SVS module system.

---

## Conventions Reference (from existing SVS-1 through SVS-4)

- **Vault PDA:** `["vault", asset_mint, vault_id.to_le_bytes()]`
- **Handler pattern:** All handlers named `handler()` in their respective files
- **Signer seeds:** `let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, asset_mint_key.as_ref(), vault_id_bytes.as_ref(), &[bump]]];`
- **Account types:** `InterfaceAccount<'info, Mint>`, `Interface<'info, TokenInterface>` for assets; `Program<'info, Token2022>` for shares
- **Math:** Use `svs_math::convert_to_shares/convert_to_assets` with `Rounding::Floor` for deposits, `Rounding::Floor` for redeems (always favor vault)
- **Oracle:** Use `svs_oracle::validate_oracle`, `svs_oracle::assets_to_shares`, `svs_oracle::shares_to_assets` with `PRICE_SCALE = 1e9`
- **Errors:** Extend `VaultError` enum matching SVS-1 naming style
- **Events:** Include `vault`, `caller`/`owner`, amounts — emit at end of handler
- **Module hooks:** `#[cfg(feature = "modules")]` blocks, `remaining_accounts` pattern, same hooks as SVS-1
- **Constants:** Named `VAULT_SEED`, `DEPOSIT_REQUEST_SEED`, etc. in `constants.rs`
- **Cargo.toml:** Same deps as SVS-1 + `svs-oracle`
- **lib.rs:** `pub mod` declarations, `#[program] pub mod svs_10 { ... }` with handler delegation
- **Tests:** `tests/svs-10.ts`, Mocha/Chai, `anchor.workspace.Svs10 as Program<Svs10>`

---

## Task 0: Scaffold Program

**Files:**
- Create: `programs/svs-10/Cargo.toml`
- Create: `programs/svs-10/src/lib.rs`
- Create: `programs/svs-10/src/state.rs`
- Create: `programs/svs-10/src/constants.rs`
- Create: `programs/svs-10/src/error.rs`
- Create: `programs/svs-10/src/events.rs`
- Create: `programs/svs-10/src/math.rs`
- Create: `programs/svs-10/src/instructions/mod.rs`
- Modify: `Anchor.toml` — add svs_10 program ID
- Modify: `Cargo.toml` (workspace) — add `"programs/svs-10"` to members

**Step 1: Generate keypair and get program ID**

```bash
solana-keygen new -o target/deploy/svs_10-keypair.json --no-bip39-passphrase --force
solana address -k target/deploy/svs_10-keypair.json
```

**Step 2: Create `programs/svs-10/Cargo.toml`**

Model after SVS-1's Cargo.toml. Key differences:
- `name = "svs-10"`, `lib.name = "svs_10"`
- Add `svs-oracle = { path = "../../modules/svs-oracle" }` as non-optional dependency (oracle is core to async pricing)
- Same module optional deps as SVS-1

**Step 3: Create source files**

`constants.rs`:
```rust
pub const VAULT_SEED: &[u8] = b"vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const SHARE_ESCROW_SEED: &[u8] = b"share_escrow";
pub const DEPOSIT_REQUEST_SEED: &[u8] = b"deposit_request";
pub const REDEEM_REQUEST_SEED: &[u8] = b"redeem_request";
pub const CLAIMABLE_TOKENS_SEED: &[u8] = b"claimable_tokens";
pub const OPERATOR_APPROVAL_SEED: &[u8] = b"operator_approval";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;
pub const DEFAULT_MAX_DEVIATION_BPS: u16 = 500; // 5%
```

`state.rs`:

**AsyncVault** — main vault state account:
- `authority`, `operator`, `asset_mint`, `shares_mint`, `vault_id`
- `total_assets: u64`, `total_shares: u64`, `total_pending_deposits: u64`
- `decimals_offset: u8`, `paused: bool`, `max_staleness: i64`
- `max_deviation_bps: u16` (default 500 = 5%, used for oracle front-running mitigation)
- `bump: u8`
- `LEN` constant, `SEED_PREFIX = VAULT_SEED`

**DepositRequest** — per-user deposit request:
- `owner`, `receiver`, `vault`
- `assets_locked: u64`, `shares_claimable: u64`
- `status: RequestStatus`
- `requested_at: i64`, `fulfilled_at: i64`
- `bump: u8`
- `SEED_PREFIX = DEPOSIT_REQUEST_SEED`

**RedeemRequest** — per-user redeem request:
- `owner`, `receiver`, `vault`
- `shares_locked: u64`, `assets_claimable: u64`
- `status: RequestStatus`
- `requested_at: i64`, `fulfilled_at: i64`
- `bump: u8`
- `SEED_PREFIX = REDEEM_REQUEST_SEED`

**OperatorApproval** — per-user-per-operator delegation:
- `owner`, `operator`, `vault`
- `approved: bool`
- `bump: u8`
- `SEED_PREFIX = OPERATOR_APPROVAL_SEED`

**RequestStatus** enum: `Pending`, `Fulfilled`, `Claimed`, `Cancelled`

Note: `vault.total_shares` includes reserved-but-unminted shares. Between fulfill and claim, `shares_mint.supply <= vault.total_shares`. This is intentional — see Architecture section.

`error.rs` — Extend SVS-1 errors with async-specific: `RequestNotPending`, `RequestNotFulfilled`, `OperatorNotApproved`, `OracleStale`, `InsufficientLiquidity`, `OracleDeviationExceeded`.

`events.rs`:
- `VaultInitialized { vault, authority, operator, asset_mint, shares_mint, vault_id }`
- `DepositRequested { vault, owner, receiver, assets }`
- `DepositFulfilled { vault, owner, shares, assets }`
- `DepositClaimed { vault, owner, receiver, shares }`
- `DepositCancelled { vault, owner, assets_returned }`
- `RedeemRequested { vault, owner, receiver, shares }`
- `RedeemFulfilled { vault, owner, shares, assets }`
- `RedeemClaimed { vault, owner, receiver, assets }`
- `RedeemCancelled { vault, owner, shares_returned }`
- `OperatorSet { vault, owner, operator, approved }`
- `VaultStatusChanged { vault, paused }`
- `AuthorityTransferred { vault, old_authority, new_authority }`
- `VaultOperatorChanged { vault, old_operator, new_operator }`

`math.rs` — Same wrapper pattern as SVS-1: re-export `svs_math` with Anchor error conversion.

`lib.rs` — Declare all modules, stub all instructions in `#[program] pub mod svs_10`. This includes the 4 view instructions: `pending_deposit_request`, `claimable_deposit_request`, `pending_redeem_request`, `claimable_redeem_request`.

`instructions/mod.rs` — Declare all instruction modules, pub use all.

**Step 4: Add to workspace and Anchor.toml**

Add `"programs/svs-10"` to workspace members in root `Cargo.toml`.
Add program ID entries to `[programs.devnet]` and `[programs.localnet]` in `Anchor.toml`.
Add `svs-10.ts` to test script.

**Step 5: Build to verify scaffold compiles**

```bash
anchor build -p svs_10
cargo fmt --all
cargo clippy --all-targets
```

**Step 6: Commit**

```bash
git add programs/svs-10/ Anchor.toml Cargo.toml
git commit -m "feat(svs-10): scaffold async vault program"
```

---

## Task 1: Initialize Instruction

**Files:**
- Create: `programs/svs-10/src/instructions/initialize.rs`
- Modify: `programs/svs-10/src/instructions/mod.rs`
- Modify: `programs/svs-10/src/lib.rs`

**Step 1: Implement `initialize` handler**

Signature: `initialize(ctx, vault_id, name, symbol, uri)` — matches SVS-1's initialize signature.

Creates: AsyncVault PDA, Token-2022 shares mint (via invoke_signed), asset vault ATA, share escrow PDA token account.

Follow SVS-1's initialize.rs pattern exactly:
- `#[derive(Accounts)] #[instruction(vault_id: u64)]`
- Create shares mint via `create_account` + `initialize_mint2` (Token-2022)
- Asset vault as ATA: `associated_token::mint = asset_mint, associated_token::authority = vault` (no custom PDA — same pattern as SVS-1)
- Share escrow as PDA token account: `seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()]`, `token::mint = shares_mint`, `token::authority = vault`, `token::token_program = token_2022_program`
- Set all AsyncVault fields including `operator` (passed as separate Signer or SystemAccount)
- Set `decimals_offset = MAX_DECIMALS - asset_decimals` (same virtual offset as SVS-1 to prevent inflation attacks on first deposit)
- Set `total_pending_deposits = 0`
- Set `max_deviation_bps = DEFAULT_MAX_DEVIATION_BPS`
- Set `name`, `symbol`, `uri` on the shares mint metadata

Key difference from SVS-1: Also init `share_escrow` token account for locked shares during redemption.

**Step 2: Build**

```bash
anchor build -p svs_10
cargo fmt --all
cargo clippy --all-targets
```

**Step 3: Commit**

```bash
git commit -m "feat(svs-10): implement initialize instruction"
```

---

## Task 2: Request Deposit + Cancel Deposit

**Files:**
- Create: `programs/svs-10/src/instructions/request_deposit.rs`
- Create: `programs/svs-10/src/instructions/cancel_deposit.rs`

**Step 1: Implement `request_deposit(assets: u64, receiver: Pubkey)`**

- Validate: `assets > 0`, `assets >= MIN_DEPOSIT_AMOUNT`, `!vault.paused`
- Transfer assets from user to `asset_vault` via `transfer_checked`
- Init DepositRequest PDA: `seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()]`
- Set fields: owner, receiver, assets_locked, shares_claimable=0, status=Pending, requested_at, bump
- Increment `vault.total_pending_deposits` by `assets`
- Module hooks (feature-gated): `check_deposit_access`, `check_deposit_caps`
- Emit `DepositRequested`

**Step 2: Implement `cancel_deposit()`**

- Validate: `request.status == Pending`, signer == request.owner
- Transfer `assets_locked` from `asset_vault` back to user (vault PDA signs)
- Decrement `vault.total_pending_deposits` by `request.assets_locked`
- Close DepositRequest PDA (`close = owner`)
- Emit `DepositCancelled { vault, owner, assets_returned: request.assets_locked }`

**Step 3: Build**

```bash
anchor build -p svs_10
cargo fmt --all
cargo clippy --all-targets
```

**Step 4: Commit**

```bash
git commit -m "feat(svs-10): add deposit request and cancel flows"
```

---

## Task 3: Fulfill Deposit + Claim Deposit

**Files:**
- Create: `programs/svs-10/src/instructions/fulfill_deposit.rs`
- Create: `programs/svs-10/src/instructions/claim_deposit.rs`

**Step 1: Implement `fulfill_deposit()`**

- Validate: signer == `vault.operator`, `request.status == Pending`
- **Access re-check (feature-gated):** Call `check_deposit_access` module hook to verify access hasn't been revoked between request and fulfillment.
  - Note: `check_deposit_access` is reused for both deposit and redeem access checks (same function, different context). This matches SVS-1 behavior.
- **Dual pricing mode:**
  - Check `ctx.remaining_accounts` for an oracle account (svs-oracle OraclePrice PDA)
  - If oracle present: `svs_oracle::validate_oracle(price, updated_at, clock, vault.max_staleness)`, then `shares = svs_oracle::assets_to_shares(assets_locked, price)`. Also call `svs_oracle::validate_deviation(oracle_price, vault_computed_price, vault.max_deviation_bps)` to prevent front-running. **Empty vault exception:** Skip deviation check when `total_assets == 0 && total_shares == 0` — the vault-computed price is purely synthetic from the virtual offset, so deviation comparison is meaningless.
  - If no oracle: `shares = svs_math::convert_to_shares(assets_locked, total_assets, total_shares, decimals_offset, Rounding::Floor)`
- Module hooks (feature-gated): `apply_entry_fee` on computed shares
- Update request: `shares_claimable = net_shares`, `status = Fulfilled`, `fulfilled_at = clock`
- Update vault: `total_assets += assets_locked`, `total_shares += net_shares`
- Decrement `vault.total_pending_deposits` by `request.assets_locked`
- Emit `DepositFulfilled`

Note: No token movement at fulfillment — shares are minted at claim time. `vault.total_shares` now includes these reserved-but-unminted shares. This means `shares_mint.supply <= vault.total_shares` until claim is called. This is intentional and must be tested (see Task 8).

**Step 2: Implement `claim_deposit()`**

- Validate: `request.status == Fulfilled`
- Auth check: signer == `request.receiver` OR signer has valid OperatorApproval with `approval.approved == true`
  - OperatorApproval passed as optional account (use `Option<Account<'info, OperatorApproval>>`)
- Mint `shares_claimable` to receiver's share account (vault PDA signs)
- Module hooks (feature-gated): `set_share_lock` if lock module configured
- Close DepositRequest PDA (`close = owner`, rent to request.owner)
- Emit `DepositClaimed`

**Step 3: Build**

```bash
anchor build -p svs_10
cargo fmt --all
cargo clippy --all-targets
```

**Step 4: Commit**

```bash
git commit -m "feat(svs-10): implement fulfill and claim deposit"
```

---

## Task 4: Request Redeem + Cancel Redeem

**Files:**
- Create: `programs/svs-10/src/instructions/request_redeem.rs`
- Create: `programs/svs-10/src/instructions/cancel_redeem.rs`

**Step 1: Implement `request_redeem(shares: u64, receiver: Pubkey)`**

- Validate: `shares > 0`, `!vault.paused`
- Module hooks (feature-gated): `check_deposit_access` (reused for redeem access — same function, different context, matches SVS-1), `check_share_lock` (reject if locked)
- Transfer shares from user to `share_escrow` (Token-2022 transfer_checked)
- Init RedeemRequest PDA: `seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), user.key().as_ref()]`
- Set fields: owner, receiver, shares_locked, assets_claimable=0, status=Pending, requested_at, bump
- Emit `RedeemRequested`

**Step 2: Implement `cancel_redeem()`**

- Validate: `request.status == Pending`, signer == request.owner
- Transfer `shares_locked` from `share_escrow` back to user (vault PDA signs)
- Close RedeemRequest PDA (`close = owner`)
- Emit `RedeemCancelled { vault, owner, shares_returned: request.shares_locked }`

**Step 3: Build**

```bash
anchor build -p svs_10
cargo fmt --all
cargo clippy --all-targets
```

**Step 4: Commit**

```bash
git commit -m "feat(svs-10): add redeem request and cancel flows"
```

---

## Task 5: Fulfill Redeem + Claim Redeem

**Files:**
- Create: `programs/svs-10/src/instructions/fulfill_redeem.rs`
- Create: `programs/svs-10/src/instructions/claim_redeem.rs`

**Step 1: Implement `fulfill_redeem()`**

- Validate: signer == `vault.operator`, `request.status == Pending`
- **Access re-check (feature-gated):** Call `check_deposit_access` module hook (reused for redeem access, same function as deposit, matches SVS-1) to verify access hasn't been revoked between request and fulfillment.
- **Dual pricing:**
  - Oracle present: `assets = svs_oracle::shares_to_assets(shares_locked, price)`. Also call `svs_oracle::validate_deviation(oracle_price, vault_computed_price, vault.max_deviation_bps)`. **Empty vault exception:** Skip deviation check when `total_assets == 0 && total_shares == 0` (same rationale as fulfill_deposit).
  - No oracle: `assets = svs_math::convert_to_assets(shares_locked, total_assets, total_shares, decimals_offset, Rounding::Floor)`
- Module hooks (feature-gated): `apply_exit_fee` on computed assets
- **Liquidity isolation check:** Require `asset_vault.amount - vault.total_pending_deposits >= net_assets` (`InsufficientLiquidity`). This prevents fulfilling redeems with assets that are reserved for pending deposits.
- Burn shares from `share_escrow` (vault PDA signs burn via Token-2022)
- Transfer `net_assets` from `asset_vault` to `claimable_tokens` PDA token account
  - `claimable_tokens`: `seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), request.owner.as_ref()]`, init_if_needed, `token::mint = asset_mint`, `token::authority = vault`
- Update request: `assets_claimable = net_assets`, `status = Fulfilled`, `fulfilled_at`
- Update vault: `total_assets -= net_assets`, `total_shares -= shares_locked`
- Emit `RedeemFulfilled`

**Step 2: Implement `claim_redeem()`**

- Validate: `redeem_request.status == Fulfilled`, read `redeem_request.assets_claimable` for the transfer amount
- Auth check: signer == `request.receiver` OR valid OperatorApproval with `approval.approved == true`
- **Close order matters — execute in this sequence:**
  1. Transfer assets from `claimable_tokens` to receiver wallet (vault PDA signs)
  2. Close `claimable_tokens` token account (rent to request.owner)
  3. Close RedeemRequest PDA (rent to request.owner)
- Emit `RedeemClaimed`

Note: Only 2 accounts are closed in claim_redeem: `claimable_tokens` token account and `RedeemRequest` PDA. Tests should verify rent recovery amounts.

**Step 3: Build**

```bash
anchor build -p svs_10
cargo fmt --all
cargo clippy --all-targets
```

**Step 4: Commit**

```bash
git commit -m "feat(svs-10): implement fulfill and claim redeem"
```

---

## Task 6: Admin Instructions (pause, unpause, transfer_authority, set_vault_operator, set_operator)

**Files:**
- Create: `programs/svs-10/src/instructions/admin.rs`
- Create: `programs/svs-10/src/instructions/set_operator.rs`

**Step 1: Implement admin handlers**

Follow SVS-1's `admin.rs` pattern exactly:
- `pause()`, `unpause()`, `transfer_authority(new_authority)` — same as SVS-1
- Add `set_vault_operator(new_operator)` — authority changes `vault.operator`
- Emit `VaultStatusChanged`, `AuthorityTransferred`
- Emit `VaultOperatorChanged { vault, old_operator, new_operator }` in `set_vault_operator`

**Step 2: Implement `set_operator(operator: Pubkey, approved: bool)`**

- User creates/updates OperatorApproval PDA: `seeds = [OPERATOR_APPROVAL_SEED, vault.key(), owner.key(), operator.key()]`
- Use `init_if_needed` for first creation, update `approved` field on subsequent calls
- If `approved == false`, close the PDA to recover rent
- Emit `OperatorSet { vault, owner, operator, approved }`

**Step 3: Build**

```bash
anchor build -p svs_10
cargo fmt --all
cargo clippy --all-targets
```

**Step 4: Commit**

```bash
git commit -m "feat(svs-10): implement admin and operator instructions"
```

---

## Task 7: View Instructions + Module Admin Instructions

**Files:**
- Create: `programs/svs-10/src/instructions/view.rs`
- Create: `programs/svs-10/src/instructions/module_admin.rs`

**Step 1: Implement view instructions**

Create `programs/svs-10/src/instructions/view.rs` with 4 on-chain view instructions matching SVS-1's view.rs pattern. Each uses `set_return_data()` for CPI composability:

- `pending_deposit_request(ctx)` — returns `deposit_request.assets_locked` if status == Pending, else 0
- `claimable_deposit_request(ctx)` — returns `deposit_request.shares_claimable` if status == Fulfilled, else 0
- `pending_redeem_request(ctx)` — returns `redeem_request.shares_locked` if status == Pending, else 0
- `claimable_redeem_request(ctx)` — returns `redeem_request.assets_claimable` if status == Fulfilled, else 0

Each instruction takes the vault and the relevant request PDA as accounts, serializes the result via `set_return_data()`, and returns `Ok(())`.

**Step 2: Implement module admin handlers (feature-gated)**

Copy SVS-1's `module_admin.rs` pattern. Same instruction set:
- `initialize_fee_config`, `update_fee_config`
- `initialize_cap_config`, `update_cap_config`
- `initialize_lock_config`, `update_lock_config`
- `initialize_access_config`, `update_access_config`

All module configs use `AsyncVault` instead of `Vault`. Same PDA seeds (module seeds are vault-key-based).

**Step 3: Build with modules feature**

```bash
anchor build -p svs_10 -- --features modules
cargo fmt --all
cargo clippy --all-targets
```

**Step 4: Commit**

```bash
git commit -m "feat(svs-10): add view instructions and module admin"
```

---

## Task 8: Integration Tests

**Files:**
- Create: `tests/svs-10.ts`

**Step 1: Write comprehensive test suite**

Structure matching existing test patterns:
```typescript
describe("svs-10 (Async Vault - ERC-7540)", () => {
  // Setup: create asset mint, fund users, derive PDAs

  describe("Initialization", () => {
    it("initializes vault correctly");
    it("initializes with correct name, symbol, uri on shares mint");
    it("rejects invalid decimals");
    it("sets decimals_offset = MAX_DECIMALS - asset_decimals");
    it("sets max_deviation_bps to default");
  });

  describe("Deposit Flow", () => {
    it("user requests deposit");
    it("increments total_pending_deposits on request");
    it("operator fulfills deposit (vault-priced)");
    it("decrements total_pending_deposits on fulfill");
    it("receiver claims deposit (shares minted)");
    it("request PDA closed after claim");
    it("verify shares_mint.supply <= vault.total_shares between fulfill and claim");
  });

  describe("Deposit Cancellation", () => {
    it("user cancels pending deposit");
    it("assets returned to user");
    it("decrements total_pending_deposits on cancel");
    it("rejects cancel on fulfilled request");
  });

  describe("Redeem Flow", () => {
    it("user requests redemption");
    it("operator fulfills redemption");
    it("enforces liquidity isolation (asset_vault.amount - total_pending_deposits >= assets_to_transfer)");
    it("receiver claims redemption");
    it("claimable_tokens and RedeemRequest PDAs closed after claim (2 accounts)");
    it("verifies rent recovery on close");
  });

  describe("Redeem Cancellation", () => {
    it("user cancels pending redemption");
    it("shares returned to user");
  });

  describe("Oracle-Priced Fulfillment", () => {
    it("fulfill_deposit with oracle price");
    it("fulfill_redeem with oracle price");
    it("rejects stale oracle");
    it("rejects oracle price exceeding max_deviation_bps from vault price");
    it("skips deviation check on empty vault (total_assets == 0 && total_shares == 0)");
  });

  describe("Operator Approval", () => {
    it("user sets operator approval");
    it("operator claims deposit on behalf of user");
    it("operator claims redemption on behalf of user");
    it("unapproved operator rejected");
    it("user revokes operator");
  });

  describe("Admin", () => {
    it("pauses vault");
    it("rejects requests when paused");
    it("unpauses vault");
    it("transfers authority");
    it("changes vault operator and emits VaultOperatorChanged");
  });

  describe("View Instructions", () => {
    it("pending_deposit_request returns correct amount");
    it("claimable_deposit_request returns correct amount");
    it("pending_redeem_request returns correct amount");
    it("claimable_redeem_request returns correct amount");
    it("returns 0 for wrong status");
  });

  describe("Permission Checks", () => {
    it("rejects fulfill from non-operator");
    it("rejects cancel from non-owner");
    it("rejects claim from non-receiver without approval");
    it("rejects duplicate request (PDA exists)");
  });

  describe("Edge Cases", () => {
    it("rejects zero amount deposit");
    it("rejects deposit below minimum");
    it("rounding favors vault on fulfill");
    it("handles empty vault first deposit (vault-priced mode)");
  });

  describe("Module Integration", () => {
    it("fees applied on fulfill_deposit (entry fee)");
    it("fees applied on fulfill_redeem (exit fee)");
    it("caps enforced on request_deposit");
    it("locks set on claim_deposit, checked on request_redeem");
    it("access checked on request and re-checked on fulfill");
    it("combined: fee + cap + lock behavior in single flow");
    it("graceful skip when module config not passed in remaining_accounts");
  });
});
```

Target: 45+ tests covering all instructions, view instructions, module integration, and edge cases.

**Step 2: Run tests**

```bash
anchor test -- tests/svs-10.ts
```

**Step 3: Fix any failures, then commit**

```bash
git commit -m "test(svs-10): comprehensive integration tests"
```

---

## Task 9: TypeScript SDK Extension

**Files:**
- Create: `sdk/core/src/async-vault.ts`
- Create: `sdk/core/src/async-vault-pda.ts`
- Modify: `sdk/core/src/index.ts`

**Step 1: Create PDA helpers (`async-vault-pda.ts`)**

```typescript
export const VAULT_SEED = Buffer.from("vault");
export const DEPOSIT_REQUEST_SEED = Buffer.from("deposit_request");
export const REDEEM_REQUEST_SEED = Buffer.from("redeem_request");
// ... all PDA derivation functions
export function deriveAsyncVaultAddresses(programId, assetMint, vaultId) { ... }
```

**Step 2: Create `AsyncVault` class (`async-vault.ts`)**

Follow `SolanaVault` class pattern:
- `static load(program, assetMint, vaultId)` — fetch and wrap vault state
- `requestDeposit(user, { assets, receiver? })`
- `cancelDeposit(user)`
- `fulfillDeposit(operator, { owner })` — vault-priced
- `fulfillDepositWithOracle(operator, { owner, oracleAccount })` — oracle-priced
- `claimDeposit(claimant, { owner? })` — owner or approved operator
- `requestRedeem(user, { shares, receiver? })`
- `cancelRedeem(user)`
- `fulfillRedeem(operator, { owner })`
- `claimRedeem(claimant, { owner? })`
- `setOperator(user, { operator, approved })`
- `pause(authority)`, `unpause(authority)`
- `setVaultOperator(authority, { operator })`
- View helpers: `pendingDepositRequest(owner)`, `claimableDepositRequest(owner)`, `pendingRedeemRequest(owner)`, `claimableRedeemRequest(owner)`

**Step 3: Export from index.ts**

Add `export * from "./async-vault";` and `export * from "./async-vault-pda";`

**Step 4: Bump SDK version**

Bump the SDK version in `sdk/core/package.json` to reflect the new async vault support.

**Step 5: Commit**

```bash
git commit -m "feat(sdk): add AsyncVault class for SVS-10"
```

---

## Task 10: CLI Commands

**Files:**
- Create: `sdk/core/src/cli/commands/async/` directory
- Create: `sdk/core/src/cli/commands/async/request-deposit.ts`
- Create: `sdk/core/src/cli/commands/async/cancel-deposit.ts`
- Create: `sdk/core/src/cli/commands/async/fulfill-deposit.ts`
- Create: `sdk/core/src/cli/commands/async/claim-deposit.ts`
- Create: `sdk/core/src/cli/commands/async/request-redeem.ts`
- Create: `sdk/core/src/cli/commands/async/cancel-redeem.ts`
- Create: `sdk/core/src/cli/commands/async/fulfill-redeem.ts`
- Create: `sdk/core/src/cli/commands/async/claim-redeem.ts`
- Create: `sdk/core/src/cli/commands/async/set-operator.ts`
- Create: `sdk/core/src/cli/commands/async/index.ts`
- Modify: `sdk/core/src/cli/index.ts` — register async commands

**Step 1: Create CLI commands**

Follow existing command pattern (e.g., `deposit.ts`):
- Each command uses `createContext` middleware
- Resolves vault address from arg/config
- Loads IDL and creates Program
- Calls `AsyncVault` SDK methods

**Step 2: Register in CLI index**

```typescript
import { registerAsyncCommands } from "./commands/async";
// In createCli():
registerAsyncCommands(program);
```

**Step 3: Commit**

```bash
git commit -m "feat(cli): add SVS-10 async vault commands"
```

---

## Task 11: Documentation

**Files:**
- Create: `docs/SVS-10.md` — user-facing documentation
- Modify: `docs/README.md` — add SVS-10 to variant table
- Modify: `docs/TESTING.md` — add SVS-10 test counts
- Modify: `docs/ARCHITECTURE.md` — add SVS-10 architecture notes
- Modify: `CHANGELOG.md` — add SVS-10 entry

**Step 1: Write SVS-10.md**

Follow the format of existing SVS-1.md docs. Cover:
- Overview and use cases
- Account structures and PDAs
- Instruction reference (including 4 view instructions)
- Oracle integration and deviation protection
- Module compatibility matrix
- SDK usage examples
- CLI usage examples
- Synchronous cancel design decision (ERC-7887 deviation)

**Step 2: Update cross-references**

- `docs/README.md`: Add SVS-10 row to variant table
- `docs/TESTING.md`: Add test counts
- `docs/ARCHITECTURE.md`: Add SVS-10 section covering total_shares timing invariant, total_pending_deposits liquidity isolation, and oracle deviation protection
- `CHANGELOG.md`: Add entry under `## [Unreleased]`

**Step 3: Commit**

```bash
git commit -m "docs(svs-10): add documentation and update cross-references"
```

---

## Task 12: Devnet Deploy + Final Verification

**Step 1: Clean build all programs**

```bash
anchor build
cargo fmt --all
cargo clippy --all-targets
```

Verify no regressions — existing SVS-1 through SVS-4 tests still pass.

**Step 2: Run full test suite**

```bash
anchor test
```

All tests pass (existing 256 + new SVS-10 tests).

**Step 3: Deploy to devnet**

```bash
anchor deploy --provider.cluster devnet -p svs_10
```

**Step 4: Record program ID and example transactions**

Save in PR description.

**Step 5: Final commit**

```bash
git commit -m "chore(svs-10): devnet deployment"
```

---

## Module Compatibility Summary

| Module | Compatible | Integration Point | Notes |
|--------|-----------|-------------------|-------|
| svs-fees | Yes | `fulfill_deposit` (entry fee), `fulfill_redeem` (exit fee) | Fee applied at fulfillment, not request |
| svs-caps | Yes | `request_deposit` | Cap checked at request time using `total_assets + total_pending_deposits` |
| svs-locks | Yes | `claim_deposit` (set lock), `request_redeem` (check lock) | Lock set when shares are minted |
| svs-access | Yes | `request_deposit`, `request_redeem`, re-checked at `fulfill_deposit` and `fulfill_redeem` | Access re-checked at fulfillment via `check_deposit_access` (reused for both deposit and redeem) |
| svs-oracle | Yes | `fulfill_deposit`, `fulfill_redeem` | Oracle-priced mode via remaining_accounts, deviation protection via `max_deviation_bps` |
| svs-rewards | Partial | Not directly integrated | Reward accrual would need custom hook at claim time |

---

## PR Checklist

- [ ] All spec instructions implemented (13 core instructions + 4 view instructions)
- [ ] Dual pricing mode (vault-priced + oracle-priced) with deviation protection
- [ ] `total_pending_deposits` liquidity isolation in `cancel_deposit`, `fulfill_deposit`, `fulfill_redeem`
- [ ] OperatorApproval with simple `approved: bool` per-user delegation
- [ ] View instructions using `set_return_data()` for CPI composability
- [ ] Module system integrated (fees, caps, locks, access with re-check at fulfillment)
- [ ] Access re-checked at fulfillment (feature-gated `check_deposit_access`)
- [ ] 45+ integration tests passing (including module integration and view tests)
- [ ] SDK `AsyncVault` class with full API
- [ ] CLI commands for all operations
- [ ] Documentation (SVS-10.md + cross-references + ARCHITECTURE.md update)
- [ ] Asset vault uses ATA pattern (no custom ASSET_VAULT_SEED PDA)
- [ ] `claim_redeem` closes exactly 2 accounts: `claimable_tokens` + `RedeemRequest`
- [ ] Devnet deployment with program ID
- [ ] No regressions in existing SVS-1 through SVS-4 tests
- [ ] Clean git history with meaningful commits
- [ ] SDK version bumped
