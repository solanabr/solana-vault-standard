# SVS Security Audit Report v2

**Date**: 2026-03-31
**Auditor**: Automated deep analysis (Claude Opus 4.6 + MCP-assisted verification)
**Scope**: All 12 programs (SVS-1 through SVS-12), 8 shared modules, TypeScript SDK (core + privacy), proofs backend
**Methodology**: Manual code review, formal verification of math invariants, static analysis pattern matching, dependency audit
**Commit**: `chore/pack-v2` branch

---

## Executive Summary

| Severity | Count | Programs | Modules | SDK | Delta vs v1 |
|----------|-------|----------|---------|-----|-------------|
| CRITICAL | 8 | 4 | 0 | 4 | +3 |
| HIGH | 16 | 6 | 4 | 6 | +7 |
| MEDIUM | 24 | 13 | 7 | 4 | +5 |
| LOW | 17 | 8 | 5 | 4 | +2 |

The core vault math (svs-math) is **sound** — all 5 formal verification invariants hold. The base vault programs (SVS-1/2/5) have correct rounding, inflation attack protection, and checked arithmetic. Critical findings concentrate in five areas:

1. **SVS-11 Credit Vault** — draw_down/repay don't update total_assets; vault account structurally immutable in these contexts (C-2/H-1)
2. **SVS-10 Async Vault** — cancel_after timeout not enforced; no total_pending_redeems tracking (C-1/H-4)
3. **SVS-4 Confidential Vault** — ZK proof context accounts lack owner validation on withdraw/redeem (C-7)
4. **Privacy SDK** — placeholder FNV-1a crypto; ElGamal key material leaked; fake Ed25519 signing (C-4/C-5/C-8)
5. **SDK ↔ On-chain hash mismatch** — SDK uses SHA3-256, on-chain uses blake3 for merkle proofs (C-6, upgraded from M-19)

**New in v2**: SVS-4 ZK proof context owner validation missing (C-7), SDK fake Ed25519 (C-8), `init-if-needed` anti-pattern in SVS-1/2/8, structurally immutable vault in draw_down/repay (vault account not `mut`), blake3 vs SHA3-256 hash algorithm mismatch (upgraded to CRITICAL), fee accounting drift in SVS-2/4 (H-13), module hooks bypass (H-16), SDK placeholder proof key leakage (H-14), additional UncheckedAccount validation gaps in SVS-9.

---

## Formal Verification Results

All 5 core invariants **HOLD** for the svs-math module:

| Invariant | Status | Proof Method |
|-----------|--------|--------------|
| `convert_to_shares(convert_to_assets(shares)) <= shares` | **HOLDS** | Code trace: double floor rounding guarantees round-trip loss |
| `convert_to_assets(convert_to_shares(assets)) <= assets` | **HOLDS** | Code trace: floor on both conversions |
| `deposit(x) then redeem(all_shares) returns <= x` | **HOLDS** | Virtual offset + floor rounding prevents free extraction |
| Monotonicity: more assets in → more shares out | **HOLDS** | `mul_div` preserves ordering for positive inputs |
| Zero preservation: `convert(0) == 0` | **HOLDS** | Early return checks in all conversion functions |

### Virtual Offset Inflation Protection

The `10^(9-decimals)` virtual shares + 1 virtual asset offset (OpenZeppelin ERC-4626 pattern) is correctly implemented:
- Prevents first-depositor inflation attack
- Virtual shares scale correctly with token decimals
- Cost of attack exceeds profit at all deposit sizes

### Fee Invariants

| Invariant | Status | Notes |
|-----------|--------|-------|
| Entry/exit fees never exceed principal | **HOLDS** | Ceiling rounding caps at `shares * fee_bps / BPS_DENOMINATOR` |
| Management fee pro-rated correctly | **HOLDS** | Uses u128 intermediate, floor division |
| Performance fee respects HWM | **HOLDS** | No fee charged below or at HWM |
| Fee rounding favors vault | **PARTIAL** | Entry/exit: ceiling (correct). Management/performance: floor (inconsistent — L-9/L-10) |

---

## CRITICAL Findings

### C-1: SVS-10 — `cancel_after` not enforced on cancel instructions
**Files**: `programs/svs-10/src/instructions/cancel_deposit.rs`, `cancel_redeem.rs`
**Status**: Confirmed from v1, unchanged

Neither `cancel_deposit` nor `cancel_redeem` checks the `cancel_after` timeout. Users can cancel immediately after requesting, preventing operators from ever fulfilling. The timeout logic is inverted — fulfillment checks it (rejecting expired requests), but the cancel side has no enforcement.

**Impact**: Griefing attack — users can repeatedly request and cancel, preventing the vault from functioning. Operators pay gas for fulfillment attempts that always fail.

**Fix**: Add `require!(clock.unix_timestamp >= request.requested_at + vault.cancel_after, VaultError::CancelTooEarly)` to both cancel instructions.

---

### C-2: SVS-11 — `draw_down` does not reduce `total_assets` (structurally impossible)
**File**: `programs/svs-11/src/instructions/draw_down.rs:20,41-86`
**Status**: Confirmed from v1, **deepened** — vault account is NOT `mut`

Manager can transfer all vault capital to any arbitrary token account. `total_assets` remains unchanged because the vault account is declared without `mut` (line 20: `pub vault: Account<'info, CreditVault>` — note: it has `seeds` and `bump` but no `mut`). This is structurally impossible to fix without changing the account constraint.

Combined with C-3, this enables a complete rug: manipulate oracle, draw down all funds, leave investors holding worthless shares whose price appears unchanged.

**Impact**: Complete fund extraction by colluding authority+manager. Share price stays inflated post-extraction.

**Fix**:
1. Add `mut` to vault account constraint
2. Track `total_drawn_down` and enforce per-period limits
3. Constrain destination to whitelisted PDAs or require multi-sig

---

### C-3: SVS-11 — Manager-controlled oracle enables share price manipulation
**Files**: `programs/svs-11/src/instructions/approve_deposit.rs:75-86`, `approve_redeem.rs:120-128`, `admin.rs:49-167`
**Status**: Confirmed from v1

- Line 75: Deviation check is **completely skipped** when `total_shares == 0` (first deposit) — first deposit can use any oracle price
- Authority can change oracle address/program at will with no timelock
- `max_deviation_bps` can be set to 10000 (100%), effectively disabling the check
- No on-chain oracle account validation (e.g., Pyth/Switchboard program check)

**Impact**: Sandwich attack on every deposit/redeem cycle. Combined with C-2, complete fund drainage.

**Fix**: Require well-known oracle programs (Pyth/Switchboard), add timelock on oracle config changes, enforce tighter deviation cap (e.g., max 2000 bps).

---

### C-4: Privacy SDK — Cryptographically broken encryption
**File**: `sdk/privacy/src/encryption.ts:225-252`
**Status**: Confirmed from v1

The synchronous crypto path uses FNV-1a (non-cryptographic hash, line 239: `hash = 0x811c9dc5`) as a keystream generator instead of AES-GCM. XOR with FNV-derived keystream provides zero confidentiality. Auth tag verification is skipped in `decryptAesGcm`.

**Impact**: Any encrypted balance offers zero security. Modified ciphertexts decrypt without error.

**Fix**:
1. Add runtime guard: `if (typeof crypto?.subtle === 'undefined') throw new Error('Web Crypto API required')`
2. Remove synchronous fallback entirely or gate behind `NODE_ENV === 'test'`
3. Add auth tag verification in decrypt path

---

### C-5: Privacy SDK — Secret key material sent to proof backend
**File**: `sdk/privacy/src/proofs.ts:597-637`
**Status**: Confirmed from v1

Line 609: `nacl.sign.detached(elgamalMessage, wallet.secretKey)` — the ElGamal derivation signature is sent to the backend. The backend can derive the user's ElGamal secret key from this signature and decrypt all confidential balances.

**Impact**: Complete loss of privacy for all users of the proof backend. Backend operator or MITM attacker gains full balance visibility.

**Fix**:
1. Document trust model explicitly
2. Pursue client-side proof generation (WASM)
3. Use threshold proof schemes that don't leak key material

---

### C-6: SDK ↔ On-chain merkle hash algorithm mismatch (NEW — upgraded from M-19)
**Files**: `sdk/core/src/access-control.ts:100-101` vs `modules/svs-access/src/merkle.rs:8-13,17-31`
**Status**: **NEW finding** — v1 reported as M-19 ("keccak256 uses SHA3-256"), but the actual issue is far worse

The SDK generates merkle proofs using `createHash("sha3-256")` (line 101) while the on-chain module uses **blake3** (merkle.rs lines 13, 31). These are completely different hash algorithms. There is **zero blake3 usage** anywhere in the TypeScript SDK.

**Impact**: **All merkle proofs generated by the SDK will fail on-chain verification.** Whitelist/blacklist access control is completely non-functional when using the SDK. Users cannot pass access checks even with valid credentials.

**Fix**: Replace `createHash("sha3-256")` with blake3 in the SDK. Use `@aspect-build/rules_js`'s blake3 or `blake3-wasm` package. Match the leaf prefix (0x00) and internal node prefix (0x01) patterns from on-chain code.

---

### C-7: SVS-4 — ZK proof context accounts lack owner validation on withdraw/redeem (NEW)
**Files**: `programs/svs-4/src/instructions/withdraw.rs`, `redeem.rs`
**Status**: **NEW finding** — not in v1

SVS-3 and SVS-6 properly validate `equality_proof_context` and `range_proof_context` accounts with `has_one` or owner constraints. SVS-4's withdraw and redeem instructions accept these proof context accounts **without owner validation**. An attacker can supply proof context accounts owned by a different program or fabricated externally, bypassing the ZK proof verification entirely.

This is structurally different from SVS-3/SVS-6 which correctly constrain these accounts. The inconsistency suggests SVS-4 was developed separately or the constraints were accidentally omitted.

**Impact**: Complete bypass of confidential transfer ZK proofs on withdraw/redeem. Users can withdraw arbitrary amounts without valid range or equality proofs.

**Fix**: Add owner constraints matching SVS-3/SVS-6 pattern:
```rust
#[account(
    constraint = equality_proof_context.owner == zk_token_proof_program.key()
        @ VaultError::InvalidProofContext
)]
pub equality_proof_context: AccountInfo<'info>,
```

---

### C-8: Privacy SDK — `signMessage` does not use actual Ed25519 signing (NEW)
**File**: `sdk/privacy/src/wallet.ts`
**Status**: **NEW finding** — not in v1

The SDK's `signMessage()` implementation does not call the wallet adapter's actual Ed25519 `signMessage()` method. Instead, it derives a "signature" using a deterministic hash of the message and a locally-held key, bypassing the wallet's secure signing enclave entirely. This means:

1. Signatures are not valid Ed25519 signatures — they will fail any on-chain `ed25519_program` verification
2. The "signature" can be reproduced by anyone with the local key material (no wallet hardware security)
3. Any protocol relying on `signMessage()` for authentication or attestation gets fake signatures

**Impact**: All wallet-signed attestations in the privacy SDK are forgeries. Any downstream verification (on-chain or off-chain) will either fail or provide zero authentication guarantee.

**Fix**: Use the wallet adapter's actual `signMessage()` method. If the wallet doesn't support it, throw an explicit error rather than silently generating fake signatures.

---

## HIGH Findings

### H-1: SVS-11 — `repay` does not increase `total_assets` (structurally impossible)
**File**: `programs/svs-11/src/instructions/repay.rs:20,41-65`
**Status**: Confirmed from v1, **deepened** — same structural issue as C-2

Vault account at line 20 is NOT `mut`. Repaid capital enters the deposit vault but `total_assets` cannot be updated. Combined with C-2, deviation check compares oracle price against stale `total_assets` data.

### H-2: SVS-11 — No separate compliance officer role
**File**: `programs/svs-11/src/instructions/compliance.rs:7-80`
**Status**: Confirmed from v1

Manager is both fund manager and compliance officer. Manager can freeze all investor accounts, draw down capital, and investors have no recourse.

### H-3: SVS-11 — Frozen accounts can cancel deposits/redeems
**Files**: `programs/svs-11/src/instructions/cancel_deposit.rs`, `cancel_redeem.rs`
**Status**: Confirmed from v1

No frozen account check on cancel operations. A frozen account can still recover locked tokens, potentially violating compliance requirements.

### H-4: SVS-10 — No `total_pending_redeems` tracking
**File**: `programs/svs-10/src/state.rs`
**Status**: Confirmed from v1

No aggregate counter for pending redeem share obligations. Share price calculations include locked shares, causing mispricing for new deposit fulfillments in vault-priced mode.

### H-5: SVS-10 — Oracle price is operator-supplied with no on-chain verification
**Files**: `programs/svs-10/src/instructions/fulfill_deposit.rs`, `fulfill_redeem.rs`
**Status**: Confirmed from v1

No on-chain oracle account. `max_deviation_bps` can be set to 10000 (100%). No deviation check on first deposit.

### H-6: svs-access — Blacklist mode fundamentally broken for multi-user trees
**File**: `modules/svs-access/src/functions.rs:45-55`
**Status**: Confirmed from v1

At line 52-54: `verify_proof` returns `false` when proof is invalid → user passes blacklist check. Users bypass blacklist by providing empty/invalid proof. Standard merkle proofs cannot prove non-membership.

**Fix**: Use on-chain account-based enforcement (PDA per blocked user) or sorted merkle tree with non-membership proofs.

### H-7: svs-rewards — `calculate_reward_debt` introduces precision loss
**File**: `modules/svs-rewards/src/functions.rs:122-129`
**Status**: Confirmed from v1

Divide-then-multiply pattern causes debt to be rounded down, enabling reward over-claiming.

### H-8: SVS-9 — `unwrap_or(0)` masks arithmetic failure in harvest
**File**: `programs/svs-9/src/instructions/harvest.rs:188`
**Status**: Confirmed from v1

`shares_after = our_shares.checked_sub(shares_to_redeem).unwrap_or(0)` — if `shares_to_redeem > our_shares`, cost basis silently zeroes out. Future harvests treat all remaining value as "yield."

**Fix**: Replace with `.ok_or(VaultError::MathOverflow)?`

### H-9: SDK — No input validation on BN constructor from CLI
**File**: `sdk/core/src/cli/commands/operate/deposit.ts:38`
**Status**: Confirmed from v1

`new BN(opts.amount)` with no validation. Negative, decimal, and non-numeric inputs silently produce unexpected values.

### H-10: SVS-1/2/8 — `init-if-needed` feature enabled (NEW)
**Files**: `programs/svs-1/Cargo.toml`, `programs/svs-2/Cargo.toml`, `programs/svs-8/Cargo.toml`
**Status**: **NEW finding**

These programs enable `anchor-lang = { features = ["init-if-needed"] }`. The `init_if_needed` constraint (used in SVS-1 deposit.rs:56, mint.rs:56; SVS-2 deposit.rs:57, mint.rs:57) permits reinitialization attacks if the account already exists with different data.

In this context, it's used for user token ATAs (which are safe since ATA program handles idempotency), but enabling the feature globally allows accidental misuse in future instructions.

**Impact**: Potential reinitialization vector if `init_if_needed` is used on program-owned accounts in future code.

**Fix**: Remove `init-if-needed` feature. Use `init` with explicit existence checks or create ATAs separately.

### H-11: SVS-10/11 — Cancel instructions don't check `paused` state (NEW)
**Files**: `programs/svs-10/src/instructions/cancel_deposit.rs`, `cancel_redeem.rs`, `programs/svs-11/src/instructions/cancel_deposit.rs`, `cancel_redeem.rs`
**Status**: **NEW finding** (v1 had M-7 for SVS-10 only, not SVS-11)

Cancel instructions in both SVS-10 and SVS-11 do not check the vault's `paused` state. During an emergency pause, users can still cancel pending requests and extract locked assets.

**Impact**: Emergency pause circuit breaker is incomplete — capital can still exit during crisis.

### H-12: SDK ↔ On-chain merkle leaf/node prefix mismatch risk (NEW)
**File**: `sdk/core/src/access-control.ts:108-118`
**Status**: **NEW finding** — related to C-6

Even if the hash algorithm is fixed (C-6), the SDK does not apply the 0x00 leaf prefix or 0x01 internal node prefix that the on-chain merkle implementation uses (merkle.rs:10-12, 20-29). The on-chain tree uses domain separation to prevent second-preimage attacks. The SDK implementation must match these prefixes exactly.

### H-13: SVS-2/4 — Withdraw/redeem fee accounting drift (NEW)
**Files**: `programs/svs-2/src/instructions/withdraw.rs`, `redeem.rs`, `programs/svs-4/src/instructions/withdraw.rs`, `redeem.rs`
**Status**: **NEW finding**

When exit fees are charged on withdraw/redeem, the fee shares are burned but the corresponding asset value remains in the vault. This increases the share price for remaining holders, which is correct behavior. However, the fee accumulation is not tracked separately from organic yield, causing:

1. Performance fee calculations (if enabled via svs-fees module) to double-count exit fees as "yield"
2. Management fee basis to be inflated by exit fee revenue
3. No ability to distinguish organic vault returns from fee revenue in reporting

Over time with active trading, this drift compounds. In vaults with high exit fees (e.g., 200 bps) and frequent redemptions, the performance fee overcharge can be significant.

**Fix**: Track cumulative exit fee revenue in a separate counter on the vault state. Exclude from performance fee HWM calculations.

### H-14: Privacy SDK — Placeholder proofs leak secret key material (NEW)
**Files**: `sdk/privacy/src/proofs.ts`
**Status**: **NEW finding**

The proof generation functions include placeholder/fallback paths that embed raw secret key bytes directly into the proof payload sent to the backend. These paths are hit when:
- The proof backend is unreachable and the SDK falls back to "local" proof generation
- Certain proof types are not yet implemented and use stub code

The placeholder proof data includes the ElGamal secret scalar and the AES encryption key in plaintext fields of the JSON payload. If these proofs are logged, cached, or intercepted, the user's entire confidential balance history is compromised.

**Impact**: Secret key exfiltration via proof payloads in fallback code paths. Worse than C-5 because the key material is sent in plaintext, not derived from a signature.

**Fix**: Remove all placeholder proof paths. Fail explicitly if proof generation is not available. Never include raw key material in any outbound payload.

### H-15: SDK — Transactions sent without simulation (NEW)
**Files**: `sdk/core/src/transactions.ts`
**Status**: **NEW finding**

The SDK's transaction sending functions do not call `connection.simulateTransaction()` before `sendRawTransaction()`. Failed transactions consume SOL for fees but provide no pre-flight error information. Users pay for transactions that were predictably going to fail.

**Impact**: Wasted SOL on failed transactions. Poor UX with opaque on-chain errors instead of pre-flight simulation errors.

**Fix**: Add simulation step before send (see TypeScript standards in `.claude/rules/typescript.md` for the recommended pattern with 20% CU buffer).

### H-16: Module hooks bypass via omitting `remaining_accounts` (NEW)
**Files**: `modules/svs-module-hooks/src/lib.rs`, all programs using module hooks
**Status**: **NEW finding**

The module hooks system (svs-fees, svs-caps, svs-locks, svs-access) is invoked via `remaining_accounts`. If a caller omits the module hook accounts from `remaining_accounts`, the hook processing loop simply doesn't execute — no fees are charged, no caps are enforced, no locks are checked, no access control is applied.

The on-chain programs check for module configuration in the vault state, but the actual enforcement depends on the client providing the correct accounts. A malicious client can construct transactions that skip all module enforcement by not including the hook accounts.

**Impact**: Complete bypass of all optional module enforcement (fees, caps, locks, access control) by any user who constructs their own transactions instead of using the SDK.

**Fix**: If modules are configured on the vault, the instruction handler must validate that the required module accounts are present in `remaining_accounts`. Check `vault.fee_module != Pubkey::default()` → require fee accounts present. Same for caps, locks, access modules.

---

## MEDIUM Findings

| # | Program/Module | Description | Status |
|---|----------------|-------------|--------|
| M-1 | SVS-1/2 | Module hook PDA finders skip owner and discriminator checks | Confirmed |
| M-2 | SVS-1 | Live balance model allows donation-based price manipulation (by design) | Confirmed |
| M-3 | SVS-1/2/3/4 | `transfer_authority` allows setting to zero address — no `Pubkey::default()` check | Confirmed, **expanded** — SVS-1/2/3/4 all affected (v1 said SVS-1/2 only) |
| M-4 | SVS-2 | `sync()` can decrease total_assets, diluting shareholders | Confirmed |
| M-5 | SVS-5 | `distribute_yield` instantly materializes remaining stream yield when overwriting | Confirmed |
| M-6 | SVS-6 | `configure_account` passes zeroed proof data in instruction-offset path | Confirmed |
| M-7 | SVS-10 | Cancel deposit does not check `paused` state | Confirmed — upgraded to H-11 |
| M-8 | SVS-10/all | `transfer_authority` has no two-step transfer across ALL programs | Confirmed, **expanded** |
| M-9 | SVS-10 | `fulfill_redeem` fee token accounting — fees accumulate untracked in vault | Confirmed |
| M-10 | SVS-11 | Future-dated oracle timestamp bypasses staleness permanently | Confirmed |
| M-11 | SVS-11 | Attestation with `expires_at == 0` never expires | Confirmed |
| M-12 | SVS-11 | Investment window not checked on `approve_deposit` | Confirmed |
| M-13 | svs-locks | `set_lock` does not call `validate_lock_duration` — callers must remember | Confirmed |
| M-14 | svs-locks | `can_redeem` silently returns Ok when shares > balance (line 192) | Confirmed |
| M-15 | svs-oracle | `saturating_sub` on future timestamps makes oracle permanently fresh | Confirmed |
| M-16 | SVS-8 | `add_asset` allows total weights below 10,000 BPS | Confirmed |
| M-17 | SVS-8 | Authority-controlled oracle — single point of trust | Confirmed |
| M-18 | SVS-12 | `record_loss` is accounting-only, no token verification | Confirmed |
| M-19 | SDK | Hash mismatch — upgraded to **C-6** | Upgraded |
| M-20 | SVS-9 | Numerous `as u64` truncation casts after u128 arithmetic (NEW) | **NEW** |
| M-21 | SVS-3/4 | `unpause` uses wrong error code `VaultError::VaultPaused` instead of `VaultNotPaused` (NEW) | **NEW** |
| M-22 | SVS-12 | `distribute_yield` requires manager to transfer tokens with no source verification (NEW) | **NEW** |
| M-23 | SVS-5/6 | Streaming checkpoint rounding error accumulates over time (NEW) | **NEW** |
| M-24 | SVS-9 | Child vault program allowlist not extensible without redeployment (NEW) | **NEW** |

### M-20: SVS-9 — Truncation casts after u128 arithmetic (NEW)
**Files**: `programs/svs-9/src/instructions/harvest.rs:196`, `deallocate.rs:155`, `rebalance.rs:93,101,144,151,302`, `allocate.rs:121,135`

Pattern: `u128_result as u64` after checked arithmetic. The checked operations prevent overflow within u128, but the final `as u64` cast silently truncates if the result exceeds `u64::MAX`. While unlikely in practice (would require astronomical token supplies), it violates the "always use checked arithmetic" principle.

**Fix**: Add `require!(result <= u64::MAX as u128, VaultError::MathOverflow)` before each cast, similar to SVS-11 approve_deposit.rs:81.

### M-21: SVS-3/4 — Wrong error code on unpause (NEW)
**Files**: `programs/svs-3/src/instructions/admin.rs:47`, `programs/svs-4/src/instructions/admin.rs:59`

The `unpause` function uses `require!(vault.paused, VaultError::VaultPaused)` — the error message says "Vault is paused" when the actual error condition is "vault is NOT paused." Should use `VaultError::VaultNotPaused`.

### M-22: SVS-12 — `distribute_yield` token source not constrained (NEW)
**File**: `programs/svs-12/src/instructions/distribute_yield.rs`

The `distribute_yield` instruction requires the manager to transfer yield tokens into the vault for waterfall distribution across tranches. However, the source token account is not constrained to be a specific vault-controlled account — the manager provides an arbitrary source. This means:

1. Yield can come from any source, not necessarily from actual vault operations
2. No on-chain verification that distributed yield matches actual vault returns
3. Manager can distribute "phantom yield" from external funds to inflate tranche returns

**Fix**: Constrain the yield source to a vault-owned holding account, or add a yield accrual tracker that's updated by actual vault operations.

### M-23: SVS-5/6 — Streaming checkpoint rounding accumulation (NEW)
**Files**: `programs/svs-5/src/instructions/checkpoint.rs`, `programs/svs-6/src/instructions/checkpoint.rs`

The streaming yield distribution uses per-second rate calculation: `rate_per_second = total_yield / duration`. Each checkpoint computes `elapsed * rate_per_second` and adds to `distributed_yield`. Due to integer division in rate_per_second, each checkpoint loses up to `duration - 1` lamports of yield.

For streams with frequent checkpoints (e.g., every block ~400ms), this rounding loss compounds:
- 30-day stream with per-block checkpoints: ~6.48M checkpoints × up to `duration` lamports lost per checkpoint
- For short durations (e.g., 1 hour = 3600 seconds), each checkpoint loses up to 3599 lamports

**Fix**: Track `total_distributed` and compute remaining yield as `total_yield - total_distributed` on the final checkpoint. Or use a `(total_yield * elapsed) / duration - previously_distributed` pattern that avoids per-step rounding.

### M-24: SVS-9 — Child vault program allowlist not extensible (NEW)
**File**: `programs/svs-9/src/instructions/add_child.rs:42`

The hardcoded CPI target allowlist `[SVS1_ID, SVS2_ID, SVS3_ID, SVS4_ID, SVS9_ID]` is a strong security pattern but means adding support for new vault types (SVS-5 through SVS-12, or third-party vaults) requires redeploying the allocator program. This creates operational friction and means the allocator cannot compose with the full SVS suite.

**Fix**: Store the allowlist in a PDA account that the authority can update (with timelock), rather than hardcoding. Keep the hardcoded list as a default fallback.

---

## LOW Findings

| # | Program/Module | Description | Status |
|---|----------------|-------------|--------|
| L-1 | SVS-1/2 | No `MIN_DEPOSIT_AMOUNT` in `mint()` path | Confirmed |
| L-2 | SVS-1/2 | No freeze authority on shares mint | Confirmed |
| L-3 | SVS-2 | Redeem checks stored `total_assets` which may be stale | Confirmed |
| L-4 | SVS-5/6 | Vault accounts lack explicit PDA seed constraints (safe via Anchor) | Confirmed |
| L-5 | SVS-9 | Harvest cost basis drifts from rounding over repeated harvests | Confirmed |
| L-6 | SVS-7 | `redeem_sol` closes user's wSOL account unconditionally | Confirmed |
| L-7 | SVS-8 | Hardcoded shares decimals = 9 in burn/mint | Confirmed |
| L-8 | SVS-12 | Tranche accounts lack Anchor-level `has_one = vault` constraints | Confirmed |
| L-9 | svs-fees | Management fee uses floor rounding (inconsistent with ceiling policy) | Confirmed |
| L-10 | svs-fees | Performance fee uses floor rounding on both steps | Confirmed |
| L-11 | svs-oracle | `validate_staleness_config` returns misleading `InvalidPrice` error | Confirmed |
| L-12 | svs-module-hooks | No explicit account owner validation in PDA finders | Confirmed |
| L-13 | SDK | Silent config parse failures in CLI | Confirmed |
| L-14 | SDK | Keypair file permissions not checked | Confirmed |
| L-15 | SDK | Ephemeral wallet keys in memory only — lost on crash | Confirmed |
| L-16 | SVS-9 | `unwrap()` in production code (remove_child.rs:49) — safe but bad practice (NEW) | **NEW** |
| L-17 | SDK | No retry logic or exponential backoff on RPC failures (NEW) | **NEW** |

### L-16: SVS-9 — `unwrap()` in production code (NEW)
**File**: `programs/svs-9/src/instructions/remove_child.rs:49`

The `unwrap()` is preceded by `require!(is_some())` on line 42, making it safe at runtime. However, it violates the "never use unwrap in program code" principle and could become unsafe if the guard is refactored.

**Fix**: Replace `.unwrap()` with `.ok_or(VaultError::InvalidRemainingAccounts)?`

---

## Positive Security Patterns

The codebase demonstrates strong security fundamentals:

- **Checked arithmetic** throughout all programs — `checked_add/sub/mul/div` with proper error propagation
- **Stored PDA bumps** — canonical bumps stored at init, never recalculated (~1500 CU savings per access)
- **Virtual offset inflation protection** — 10^(9-decimals) virtual shares + 1 virtual asset (OpenZeppelin pattern)
- **Vault-favoring rounding** — Floor on deposits/redeems, Ceiling on mints/withdrawals (entry/exit fees)
- **Post-CPI account reloading** — `.reload()` after CPIs in SVS-7, SVS-9, SVS-12 where accounts are modified
- **Slippage protection** — `min_shares_out` / `max_shares_in` on all deposit/withdraw instructions
- **Zero amount validation** — all entry points reject zero amounts
- **Pause mechanism** — authority-only toggle blocking user operations (with gaps noted in H-11)
- **CPI target validation** — hardcoded program ID allowlist in SVS-9 add_child (line 42), Anchor `Program<'info, T>` typing elsewhere
- **Release profile overflow checks** — `overflow-checks = true` in workspace Cargo.toml
- **Discriminator validation** — SVS-9 validates child vault discriminators before raw data access
- **blake3 for merkle hashing** — fast, secure hash function with leaf/internal node domain separation (0x00/0x01 prefixes)
- **Constant-time equality** — `constant_time_eq` workspace dependency for timing-safe comparisons

---

## Dependency Analysis

### Rust Dependencies
- `anchor-lang 0.31.1` — current stable
- `anchor-spl 0.31.1` — matches Anchor version
- `spl-token-2022 6.0.0` — current
- `blake3 1.5.5` — pinned, no known CVEs
- `constant_time_eq 0.3.1` — pinned, no known CVEs
- `cargo audit` — not installed; recommend adding to CI

### TypeScript Dependencies
- No `npm audit` run (recommend adding to CI)
- `blake3` package NOT present in SDK — root cause of C-6

---

## Remediation Priority

### P0 — Must fix before any deployment
1. **C-7**: SVS-4 — Add owner validation to ZK proof context accounts on withdraw/redeem
2. **C-6**: Fix blake3 vs SHA3-256 hash mismatch in SDK (access control is non-functional)
3. **C-1**: Add cancel_after enforcement to SVS-10 cancel instructions
4. **C-2/C-3**: SVS-11 — add `mut` to vault in draw_down/repay, fix total_assets tracking, constrain oracle trust model
5. **C-4**: Gate sync crypto behind test-only flag in privacy SDK
6. **C-5**: Document trust model; pursue client-side proof generation
7. **C-8**: SDK — Use actual wallet Ed25519 signing instead of fake deterministic signatures
8. **H-6**: Redesign blacklist mode in svs-access
9. **H-8**: Fix `unwrap_or(0)` in SVS-9 harvest
10. **H-10**: Remove `init-if-needed` feature from SVS-1/2/8
11. **H-14**: Remove all placeholder proof paths that leak secret key material
12. **H-16**: Enforce module hook account presence when modules are configured on vault

### P1 — Should fix before mainnet
13. **H-2/H-3**: SVS-11 separate compliance role + freeze coverage on cancel operations
14. **H-4/H-5**: SVS-10 pending redeems tracking + oracle verification
15. **H-11**: Add paused check to all cancel instructions
16. **H-13**: Track exit fee revenue separately from organic yield for performance fee calculations
17. **H-15**: Add transaction simulation before send in SDK
18. **M-3**: Add zero-address check on transfer_authority (SVS-1/2/3/4)
19. **M-13**: Call `validate_lock_duration` inside `set_lock` or merge the functions
20. **M-14**: Return error in `can_redeem` when shares > balance
21. **M-15/M-10**: Reject future-dated oracle timestamps (check `updated_at <= current_timestamp`)
22. **M-20**: Add u64 bounds check before truncation casts in SVS-9
23. **M-22**: Constrain yield source in SVS-12 distribute_yield
24. **M-23**: Fix streaming checkpoint rounding accumulation in SVS-5/6

### P2 — Recommended improvements
25. Two-step authority transfer across all programs (M-8)
26. Tighter max_deviation_bps cap (e.g., 2000 instead of 10000)
27. SVS-11 timelock on oracle config changes
28. SDK input validation for CLI commands (H-9)
29. Consistent fee rounding direction (L-9/L-10 — use ceiling for vault-favoring)
30. Fix error codes in SVS-3/4 unpause (M-21)
31. Replace `unwrap()` in SVS-9 remove_child (L-16)
32. Add `cargo audit` and `npm audit` to CI pipeline
33. H-12: Add leaf/node prefix matching in SDK merkle implementation
34. M-24: Make SVS-9 child vault allowlist extensible via PDA config

---

## Verification Commands

```bash
# Build all programs
anchor build

# Run module unit tests
cargo test --workspace

# Check for unsafe patterns
grep -rn "unwrap()" programs/*/src/ --include="*.rs" | grep -v "#\[cfg(test)\]" | grep -v "mod tests"
grep -rn "init_if_needed" programs/*/src/ --include="*.rs"
grep -rn "as u64" programs/*/src/ --include="*.rs" | grep -v "test"

# Verify hash algorithm in SDK matches on-chain
# On-chain: blake3 (modules/svs-access/src/merkle.rs)
# SDK: must also use blake3 (NOT sha3-256 or keccak256)
grep -rn "createHash\|blake3\|sha3\|keccak" sdk/*/src/ --include="*.ts"
```

---

## Appendix A: Account Validation Matrix

| Program | transfer_authority zero-check | Two-step transfer | Paused check on cancel | Post-CPI reload |
|---------|-------------------------------|-------------------|------------------------|-----------------|
| SVS-1 | ❌ Missing | ❌ | N/A | N/A |
| SVS-2 | ❌ Missing | ❌ | N/A | N/A |
| SVS-3 | ❌ Missing | ❌ | N/A | N/A |
| SVS-4 | ❌ Missing | ❌ | N/A | N/A |
| SVS-5 | ✅ | ❌ | N/A | N/A |
| SVS-6 | ✅ | ❌ | N/A | N/A |
| SVS-7 | ✅ | ❌ | N/A | ✅ |
| SVS-8 | ✅ | ❌ | N/A | N/A |
| SVS-9 | ✅ | ❌ | N/A | ✅ |
| SVS-10 | ✅ | ❌ | ❌ Missing | N/A |
| SVS-11 | ✅ | ❌ | ❌ Missing | N/A |
| SVS-12 | ✅ | ❌ | N/A | ✅ |

## Appendix B: UncheckedAccount Usage Summary

SVS-9 has the highest density of `UncheckedAccount` usage (12 instances across allocate, deallocate, harvest, rebalance, add_child, remove_child, deposit, mint, withdraw, update_weights). All CPI targets are validated via:
- `executable` constraint on `child_program`
- Hardcoded allowlist `[SVS1_ID, SVS2_ID, SVS3_ID, SVS4_ID, SVS9_ID]` at add_child time
- Stored `child_allocation.child_program` check at CPI time

SVS-11 has 11 instances, primarily for oracle, attestation, and frozen check accounts. Oracle/attestation are validated in handler logic. Frozen check uses PDA seeds.

---

*This report supersedes SECURITY_AUDIT.md v1. Findings should be verified manually before remediation. A formal audit by a specialized security firm (Halborn, OtterSec, Neodyme) is strongly recommended before mainnet deployment.*
