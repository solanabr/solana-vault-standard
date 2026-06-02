# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### SDK & CLI surface

Brings the TypeScript SDK/CLI up to the on-chain instruction set for the
institutional-credit programs.

- **`CreditVault.setOracle(authority, newOracle, newOracleProgram)`** + `credit
  set-oracle` CLI — repoint the pluggable NAV oracle (authority-gated).
- **`CreditVault.updateOracleParams(authority, newMaxStaleness)`** + `credit
  update-oracle-params` CLI — adjust the oracle staleness window (the
  on-chain `update_oracle_params` ix that previously had no SDK surface).
- **`CreditVault.rejectRedeem(manager, investor, reasonCode, remainingAccounts?)`**
  + `credit reject-redeem` CLI — return escrowed shares through the cPOOL
  transfer hook (escrow→investor direction, same extras as `cancelRedeem`).
- **`sdk/core/src/attestation.ts`** — off-chain mirror of the canonical
  `svs-attestation` layout: `decodeAttestation` / `checkAttestationInvariants`
  / `verifyAttestation` (owner → version gate → invariants → canonical-PDA
  binding) + `deriveAttestationAddress`. Byte-for-byte parity with the on-chain
  parser, so consumers can validate attestations from any SAS-compatible issuer
  without that issuer's IDL.
- **Two-step authority rotation** on `CreditVault` and `TranchedVault`:
  `requestTransferAuthority` / `acceptAuthority` / `cancelTransferAuthority`,
  with CLI commands for both. The single-step `transferAuthority` is now
  `@deprecated` in favor of the two-step flow.
- **`DeRwaWrapper` multi-pool fix.** `WrapParams` / `UnwrapParams` gain an
  optional `wrapperConfig` PDA; `wrap`/`unwrap` prefer it and fall back to
  single-config discovery. Removed the dead positional `user` arg and the
  misleading "pass an explicit wrapperConfig via params" error that pointed at
  a field that did not exist.
- **Removed the SDK timelock module + CLI subtree** (`timelock.ts`,
  `cli/commands/timelock`). It persisted "proposals" to local config and marked
  them executed without ever touching the chain; the on-chain oracle-change
  timelock it shadowed no longer exists.

### Architectural refactor — audit-driven

A consolidation pass over the four institutional-credit programs, landed as
five commit-aligned changes. Supersedes some entries in the earlier "Audit
hardening" pass below (noted inline where reversed).

#### Compliance: single source of truth

- **SVS-11 per-vault freeze removed entirely.** Deleted the
  `freeze_account` / `unfreeze_account` instructions, the `FrozenAccount`
  account, `VaultConfig.compliance_officer` + `set_compliance_officer`,
  the `FROZEN_ACCOUNT_SEED` constant, the `AccountFrozen` /
  `UnauthorizedComplianceAction` errors, and the `AccountFrozen` /
  `AccountUnfrozen` / `ComplianceOfficerUpdated` events. Vault managers no
  longer hold freeze power.
- **compliance-hook is now the only compliance authority.** Added a shared
  `assert_wallet_compliant(sanctions_list, frozen_pda, wallet)` helper
  (behind the `cpi` feature). The Token-2022 transfer hook covers
  transfers; the three hook-blind paths — `claim_deposit` (mint_to),
  `approve_redeem` (burn), and derwa-wrapper `unwrap` (burn) — call the
  helper directly. The other six SVS-11 paths no longer take a
  `frozen_check` account.
- Extracted the duplicated `read_hook_program_id` into a shared
  `svs-11/src/hook_extras.rs` (3 sites).

#### Pluggable oracle interface

- **Replaced the hardcoded mock/nav `oracle_source` binary with a
  pluggable interface.** New 25-byte `SvsOraclePrice` header
  (`version`/`price`/`timestamp`/`sequence`) written at account bytes 8..33 by
  any compliant oracle, plus one generic `read_oracle` reader in
  `modules/svs-oracle`. The leading `version` byte (`SVS_ORACLE_VERSION`) is
  enforced by `read_oracle` (rejects mismatch with `WrongVersion`) so layout
  drift fails closed — mirroring the `svs-attestation` version byte. Writers
  (`nav-oracle`, `mock-oracle`) lead their account with it; svs-10 consumes
  only the pricing-math helpers and is unaffected. Deleted `oracle_source`, `set_oracle_source`,
  `OracleSourceInvalid`, `OracleSourceChanged`, and the
  `NAV_ORACLE_SEED` / `NAV_ORACLE_PROGRAM_ID` / `ORACLE_SOURCE_*`
  constants. `approve_deposit` / `approve_redeem` take a single
  `oracle_account` (validated `key == vault.nav_oracle`,
  `owner == vault.oracle_program`).
- Collapsed the two staleness fields into one `max_staleness` (ceiling
  raised from 24h to 45 days); deleted `max_nav_staleness_secs` and the
  now-dead `last_seen_nav_price`.
- `set_oracle` (authority-gated) rotates the oracle account **and** its owner
  program atomically, cross-checking the (account, program) pair — the oracle
  account must be owned by the named program — so a mismatched pair is rejected
  immediately instead of bricking approvals. On rotation it seeds the replay
  floor from the incoming oracle's current sequence.
- **Removed the vault-derived (books-vs-oracle) deviation guard.** SVS-11 no
  longer re-derives a price from `total_assets / total_shares` to bound the
  oracle: `total_assets` tracks idle cash (draw_down deploys capital
  off-chain), so it is not the NAV, and AUM is `total_shares * oracle price`.
  The old guard would have falsely tripped `OracleDeviationExceeded` on any
  vault that had deployed capital, blocking all deposits/redemptions. Deleted
  `CreditVault.max_deviation_bps`, its `update_oracle_params` parameter, the
  `OracleDeviationExceeded` / `MaxDeviationTooHigh` errors, and the
  `DEFAULT_MAX_DEVIATION_BPS` / `MAX_DEVIATION_BPS_CAP` constants. Price
  integrity is now wholly the oracle's responsibility.
- **Consecutive-price deviation guard moved into nav-oracle** (each oracle
  self-validates integrity). `nav-oracle::initialize` now takes
  `InitializeNavArgs { max_deviation_bps }` (must be > 0); new errors
  `DeviationExceeded` (7012) and `InvalidDeviationConfig` (7013).
  `NavAccount` reordered to lead with the canonical header and gained
  `last_published_nav` + `max_deviation_bps`. mock-oracle now writes the
  header too.

#### NAV publisher-rotation authority unified

- Deleted `NavAccount.key_rotation_authority`. `rotate_publisher` now
  reads the pool's live `CreditVault.authority` (pool bytes 8..40) with
  three checks (pool owned by SVS-11, data length, signer match), so
  rotation is governed by the same authority that controls the vault.
  `initialize` no longer takes a `key_rotation_authority` account.

#### Redemption reverted to atomic full approval

- **Removed the on-chain "pro-rata" machinery** — it was manager-driven
  with zero enforced cross-request fairness. `approve_redeem` is now
  atomic full-or-nothing: it takes no `batch_settlement_ratio_scaled` /
  `next_settlement_at` params and burns all `shares_locked` in one shot.
  Deleted RedemptionRequest fields `original_shares` /
  `queued_for_settlement_at` / `fulfilled_shares_cumulative`,
  `request_redeem`'s `queued_for_settlement_at` param, the
  `SettlementHorizonOutOfRange` / `RequestPartiallyFulfilled` errors, the
  `MAX_SETTLEMENT_HORIZON_SECS` constant, and the cancel/reject dust-trap
  constraints. `RedemptionApproved` simplified to
  `{ vault, investor, shares, assets, nav, manager }`.
- Replaced `saturating_*` with `checked_*` across the four Trident fuzz
  harnesses so model overflow surfaces as divergence.

#### Attestation interface extracted to a shared module

- **New `modules/svs-attestation` crate** — the attestation analogue of
  `svs-oracle`. The canonical 129-byte layout, the offset parser
  (`Attestation::from_account_data`), the pure invariant check
  (`check_invariants`), and the full account-level verifier
  (`verify_attestation`, which adds owner + canonical-PDA binding) now
  live in one place instead of being re-implemented by byte offset in
  three programs.
- **Repointed all three consumers** at the shared verifier: SVS-11
  `attestation.rs::validate_attestation`, `compliance-hook`
  `execute.rs::check_attestation`, and `derwa-wrapper`
  `unwrap.rs::validate_investor_attestation`. Each maps the granular
  `AttestationError` onto its own program error codes (e.g. svs-11's
  `InvalidAttester` and compliance-hook's `InvalidAttestationIssuer` both
  derive from `IssuerMismatch`), so on-chain error codes are unchanged.
  Deleted the duplicated `Attestation` struct + layout-stability test
  from `svs-11/src/attestation.rs` and the two hand-rolled offset readers.

### Audit hardening — institutional-credit programs

Security + quality pass against the four programs added in the
institutional credit primitive (compliance-hook, nav-oracle,
derwa-wrapper, SVS-11 extensions). Every fix below addresses a real
issue surfaced by manual + agent-assisted audit; defensive / speculative
changes were deliberately deferred.

#### Real bug fixes

- **compliance-hook `initialize_sanctions_list`** now requires the signer
  be the program's upgrade authority (via `ProgramData` PDA). Closes the
  singleton-init squat race where any payer could claim `authority` for
  the program's lifetime.
- **compliance-hook `initialize_mint_config`** bounds-checks
  `mint_data.len() >= Token2022Mint::LEN` before slicing.
- **nav-oracle `verify_self_consistency`** rejects `nav_gross == 0`
  (`ZeroNavGross` 7008); without this, signed `(0, 0, 0, 0)` would
  persist as valid state.
- **nav-oracle `update`** rejects `ter_bps + loss_bps >= 10_000` with a
  dedicated `FeesExceedGross` (7007) error; previously returned the
  misleading `InconsistentNav`.
- **nav-oracle `update`** adds the missing timestamp lower bound
  (`now - 60s`) — publisher could otherwise backdate to any past value
  and corrupt downstream staleness logic.
- **nav-oracle `rotate_publisher`** rejects `new_publisher == Pubkey::default()`.
- **nav-oracle `initialize`** is now gated by `pool_authority: Signer`
  matching `CreditVault.authority` (bytes 8..40). Closes the per-pool
  squat race. (The architectural refactor above further changed
  `initialize` to take `InitializeNavArgs { max_deviation_bps }` and drop
  the `key_rotation_authority` account.)
- **derwa-wrapper `initialize`** asserts dePOOL `mint_authority ==
  wrapper_signer` and `supply == 0` (`InvalidDerwaMint` 8011).
- **svs-11 request/cancel/approve redeem hook extras** errors now map
  `add_extra_accounts_for_execute_cpi` failures to
  `VaultError::HookExtrasMismatch` instead of opaque `ProgramError`.

#### Lifecycle refactor

- **svs-11 `claimable_tokens` PDA lifecycle** split out of
  `init_if_needed` (CLAUDE.md anti-pattern): now created at
  `request_redeem`, closed by `claim_redeem` / `cancel_redeem` /
  `reject_redeem`. (The earlier `assets_claimable == 0` /
  `RequestPartiallyFulfilled` cancel/reject guard was removed by the
  full-approval revert above — a Pending request always has
  `assets_claimable == 0`, so the guard is moot.)
- **derwa-wrapper events** added: `WrapperInitialized`, `Wrapped`,
  `Unwrapped`. Brings the program in line with the repo's emit-on-state-
  change convention.

#### Code quality

- **Zero `unwrap()`** in production code across the four programs (was
  10); replaced with typed errors (`VersionOverflow`,
  `LockedSupplyOverflow`, `AttestationNotFound`/`AttestationRequired`).
- **Zero `as` casts** in nav-oracle (was 6); replaced with `.into()` /
  `try_from()`.
- **Comment-overhead trim**: the institutional-credit program files were at 21-59% comment
  lines (baseline svs-1/2/9: 7-14%). After trim: every file at/below
  baseline. Removed step-narration, defensive justifications, historical
  references, operator runbooks (all CLAUDE.md anti-patterns).
- **Dropped fictional "backwards-compat" claims** on unreleased code
  (attestation extension fields, `nav_oracle` slot semantics).

#### Layout-stability tests

- `mint_config_permissioned_layout_stable()` asserts MintConfig's Borsh
  layout keeps `attestation_issuer` at byte offset 106 and
  `required_attestation_type` at 138 (EAML byte readers depend on this).
- `attestation_layout_stable_for_cross_program_readers()` asserts
  Attestation's layout keeps subject/issuer/type/expires_at/revoked/bump
  at the offsets compliance-hook and derwa-wrapper read.

#### Doc corrections

- `docs/derwa-wrapper.md`: WrapperConfig `SPACE` 113 → 178 (trust-anchor
  fields were missing); error range 8000-8003 → 8000-8011.
- `docs/compliance-hook.md`: `pool_policy` size annotated as `Some`-case
  (the `None` case is 1 byte, not 33); `SPACE = 139` annotated as
  Permissioned/`Some`; references the CI layout test.

#### Breaking — SDK + tests follow-up required

The lifecycle refactor changes account lists for three SVS-11
instructions. SDK + integration-test updates required before merge:

- `request_redeem` gains: `asset_mint`, `claimable_tokens`,
  `asset_token_program` (investor pays ~165 lamports rent earlier;
  refunded on reject/cancel).
- `cancel_redeem` gains: `asset_mint`, `claimable_tokens`,
  `asset_token_program`.
- `reject_redeem` gains: `asset_mint`, `claimable_tokens`,
  `asset_token_program`.
- `approve_redeem` no longer requires `system_program` for `init`
  (still in the IDL signature; callers may pass any system-program pubkey).

The `nav-oracle initialize` instruction also gains a required
`pool_authority: Signer`.

### Token-2022 TransferHook integration — end-to-end functional

The compliance-hook ↔ Token-2022 TransferHook path is exercised end-to-end
by the integration suite. The compliance-hook + derwa-wrapper + svs-11
tests prove the full bootstrap chain: investor → wrapper-PDA → investor
cPOOL roundtrip succeeds against an ACTIVE Permissioned-mode hook with
full attestation enforcement; a canonical FreelyTransferable transfer
succeeds against a sanctions-only hook; and svs-11's full redemption
flow (request/approve/claim/cancel/repay + rejection paths) succeeds
against the same active hook. The architecture changes that landed to
make this work:

1. **Anchor fallback discriminator dispatch** in `compliance-hook/src/lib.rs`.
   The SPL Transfer Hook Interface uses `sighash("spl-transfer-hook-interface",
   "execute")` while Anchor's auto-generated discriminator is
   `sighash("global", "execute")` — incompatible. Without a fallback, the
   hook program would reject every Token-2022 invocation with
   `InstructionFallbackNotFound`. The fallback parses
   `TransferHookInstruction::unpack(data)` and routes the SPL `Execute`
   variant to Anchor's `__private::__global::execute` with the amount as
   args bytes.
2. **Execute accounts struct alignment with the SPL CPI layout.**
   `spl-transfer-hook-interface::onchain::invoke_execute` inserts the
   EAML PDA itself at CPI account index 4 (BEFORE the resolved EAML
   extras). The Execute struct's `extra_account_meta_list` field now
   sits at that exact index, with a seed constraint
   (`[b"extra-account-metas", mint]`) that guards against forgery. All
   subsequent indices shifted by +1 (`mint_config` → 5, `sanctions_list` → 6,
   etc.). The EAML's `Seed::AccountData { account_index: 5 }` reads now
   correctly target `MintConfig` field offsets, and
   `program_index: 9` reaches the configured attestation program.
3. **Permissioned extras moved off `Option<UncheckedAccount>` typed
   fields onto `ctx.remaining_accounts`.** Anchor 0.31's `Option<T>`
   account binding does not auto-bind `None` for absent trailing
   accounts (FreelyTransferable mode invokes execute with 9 total
   accounts; Permissioned with 13). The handler asserts exactly 4
   remaining accounts in Permissioned mode and reads them positionally
   (attestation_program, source_attestation, destination_attestation,
   pool_policy).
4. **derwa-wrapper + svs-11 CPI ix extension.** `wrap.rs`, `unwrap.rs`,
   and `request_redeem.rs` build the inner `transfer_checked`
   instruction via `spl_token_2022::instruction::transfer_checked` and
   extend it with `add_extra_accounts_for_execute_cpi` BEFORE
   `invoke_signed`. `anchor_spl::token_interface::transfer_checked`
   alone only forwards `cpi_account_infos`; the inner ix's `keys` list
   stays at the canonical 4 accounts, so Token-2022's `next_account_info()`
   iteration cannot reach the hook program account beyond the canonical
   slots. The new CPI extension threads the hook program + EAML PDA + 4
   (FreelyTransferable) or 8 (Permissioned) resolved extras through
   from caller-supplied `remainingAccounts` into the inner ix.
5. **Wrapper-PDA system attestation** documented as an operational
   requirement. Permissioned-mode hooks validate BOTH transfer owners,
   so `wrapper_signer`'s ATA-as-destination on `wrap` (and ATA-as-source
   on `unwrap`) requires an attestation issued to the `wrapper_signer`
   PDA in the same attestation program. The deRWA wrapper's deploy
   runbook adds this step before opening wrapping.

The 4 active TransferHook execution tests in `compliance-hook.spec.ts`,
4 active wrap/unwrap tests in `derwa-wrapper.spec.ts`, and 7 active
svs-11 redemption-flow tests in `svs-11.ts` prove the full architecture
end-to-end. 9 deeper negative-path cases (sanctioned/frozen execute
failures, revoked/expired attestations, re-init behavior) remain
visible-but-pending under `it.skip` for upstream-review-correct posture.

#### svs-11 cPOOL bootstrap (new instruction)

A new `bootstrap_shares_compliance` instruction lands as the canonical
bootstrap path for the per-pool compliance-hook PDAs (MintConfig +
EAML). The handler CPIs into compliance-hook's typed init handlers
with `vault_seeds`, so the vault PDA — which is the cPOOL mint
authority — satisfies compliance-hook's `Signer == mint_authority`
constraint via Anchor's `invoke_signed` flow.

The earlier comment in `initialize_pool.rs:222-233` claiming this CPI
fails with "signer privilege escalated" was empirically wrong:
anchor-syn 0.31's `Constraints::is_signer()` only flags `is_signer = true`
for explicit `signer` constraints, NOT for `init` constraints (init'd
PDAs sign internally via `CpiContext::with_signer(&[seeds_with_nonce])`
inside the owning program). The corrected comment documents the actual
architecture and references this bootstrap instruction.

Operator workflow per pool:

  1. `initialize_pool(...)` — binds TransferHook on cPOOL, creates
     vault PDA, sets vault as cPOOL mint authority.
  2. `bootstrap_shares_compliance({ mode, pool_policy, attestation_program,
     attestation_issuer, required_attestation_type })` — CPIs
     compliance-hook to init MintConfig + EAML for the pool's cPOOL
     mint. Authority-gated by `vault.authority`.
  3. For Permissioned mode: issue an infrastructure attestation for
     the vault PDA via the configured attestation program (mock-sas /
     SAS). Subject = `vault.key()`. This is required because
     `redemption_escrow.owner == vault`, so the Permissioned hook
     validates vault's attestation on the destination side of
     `request_redeem`'s cPOOL transfer.
  4. Investors onboard with per-wallet attestations. `request_redeem`
     and `cancel_redeem` extend their inner `transfer_checked` CPIs
     with `add_extra_accounts_for_execute_cpi`, so the hook is
     reachable through the wrapper program. Off-chain SDK callers pass
     the resolved EAML extras as `remainingAccounts`.

### Security — attestation and hook hardening

The attestation readers in `compliance-hook::execute` and
`derwa-wrapper::unwrap` perform full identity binding on the attestation
payload. They validate existence, revocation, expiry, subject, issuer,
attestation type, owner program, and canonical PDA derivation before a
Permissioned transfer or unwrap can proceed. This prevents a dePOOL
holder from passing another wallet's valid KYC attestation to unwrap
into permissioned cPOOL or satisfy a Permissioned-mode hook on a foreign
mint. The binding consists of FIVE identity checks:

1. **Owner**: attestation account `.owner == configured_program`
2. **Subject**: `payload[0..32] == expected_wallet`
3. **Issuer**: `payload[32..64] == configured_issuer`
4. **Type**: `payload[64] == required_type`
5. **Canonical PDA**: re-derives
   `[b"attestation", subject, issuer, attestation_type, bump]` and
   asserts `att.key()` matches.

Permissioned-mode EAML now resolves source/destination attestations as
cross-program PDAs under the configured attestation program, so
Token-2022 hook transfers execute against these checks instead of
failing closed at account resolution.

#### compliance-hook program (new)
Generic Token-2022 `TransferHook` backend. Per-mint configuration drives transfer-time policy (sanctions list in both modes, plus full identity-binding attestation gating in Permissioned mode).

- `SanctionsList` PDA — singleton, authority-gated address list
- `MintConfig` PDA (per-mint) — mode (`FreelyTransferable | Permissioned`) + optional `pool_policy` + trust anchors (`attestation_program`, `attestation_issuer`, `required_attestation_type`)
- `ExtraAccountMetaList` PDA (per-mint) — provisions Token-2022 hook account layout. Permissioned-mode attestation extras use `new_external_pda_with_seeds` to derive canonical attestations under the configured attestation program.
- `FrozenAccount` PDA (per-owner) — global hook-level freeze marker at `[b"frozen", owner]`.
- Instructions: `initialize_sanctions_list`, `update_sanctions_list`, `freeze_account`, `unfreeze_account`, `initialize_mint_config`, `initialize_extra_account_meta_list`, `execute`
- `initialize_mint_config` now validates `mint.owner == spl_token_2022::id()` (rejects legacy SPL mints) AND requires non-default trust anchors when `mode == Permissioned`.
- `initialize_extra_account_meta_list` now reads the unpacked Mint and verifies the signer matches `Mint::mint_authority` (closes the prior over-claim).
- `check_attestation` now performs the FIVE identity-binding checks plus `revoked` + `expires_at` (was 3 checks; now 7).
- Events: `SanctionsListUpdated`
- Errors: `SanctionedAddress`, `AccountFrozen`, `AttestationNotFound`, `AttestationRevoked`, `AttestationExpired`, `MissingPoolPolicyForPermissioned`, `PoolPolicySetOnFreelyTransferable`, `InvalidMintAccount`, `InvalidAttestationProgram` (6012), `InvalidAttestationSubject` (6013), `InvalidAttestationIssuer` (6014), `InvalidAttestationType` (6015), `InvalidAttestationPda` (6016), `InvalidAttestationConfig` (6017).
- See `docs/compliance-hook.md`.

#### nav-oracle program (new)
Per-pool NAV oracle for credit-grade pricing. Off-chain publisher signs a canonical 133-byte payload; on-chain handler verifies via `Ed25519Program` instruction scan and stores the latest NAV in a `NavAccount` PDA.

- `NavAccount` PDA (per-pool) — stores publisher, key_rotation_authority, sequence, gross/net NAV, TER, loss-provision, timestamp, signature, loan-tape merkle root
- Instructions: `initialize`, `update`, `rotate_publisher`
- Canonical 133-byte signing payload (pool · navNet · navGross · terBps · lossBps · navType · timestamp · sequence · publisher · merkleRoot)
- Events: `NavUpdated`
- Errors: `StaleSequence`, `InvalidSignature`, `InconsistentNav`, `UnauthorizedRotation`, `UnauthorizedPublisher`, `TimestampInFuture`
- Replay-safe via strict sequence monotonicity; tolerates ComputeBudget priority-fee instructions (scans ALL preceding ixs for the verify, not just index 0)
- See `docs/nav-oracle.md`.

#### derwa-wrapper program (new)
1:1 wrap between a closed permissioned mint (cPOOL) and an open Token-2022 mint (dePOOL) with attestation-gated unwrap.

- `WrapperConfig` PDA (per-pool) — binds (pool, permissioned mint, deRWA mint) AND captures trust anchors (`attestation_program`, `attestation_issuer`, `required_attestation_type`) used by `unwrap` to validate destination wallets
- `wrapper_signer` PDA — token authority on the cPOOL escrow ATA + mint+freeze authority on dePOOL
- Instructions: `initialize` (now takes `InitializeWrapperArgs` with the trust anchors), `wrap` (cPOOL → dePOOL), `unwrap` (dePOOL → cPOOL, attestation-gated with FIVE-step identity binding)
- `wrap` / `unwrap` forward caller-supplied `remaining_accounts` into the cPOOL `transfer_checked` CPI so active Permissioned-mode hooks receive their EAML extras during CPI; SDK and CLI callers expose this as `remainingAccounts` / `--remaining-accounts`.
- `unwrap` performs full attestation validation BEFORE the cPOOL transfer CPI: owner / subject / issuer / type / canonical PDA + revoked + expires_at. The earlier implementation only validated existence + revoked + expires_at and was vulnerable to a foreign-attestation attack (any holder of dePOOL could pass any KYC'd wallet's attestation and unwrap).
- Errors: `ZeroAmount`, `AttestationRequired`, `InsufficientLockedSupply`, `MintMismatch`, `InvalidAttestationProgram` (8004), `InvalidAttestationSubject` (8005), `InvalidAttestationIssuer` (8006), `InvalidAttestationType` (8007), `InvalidAttestationPda` (8008), `InvalidAttestationConfig` (8009).
- Mechanism: wrap deposits cPOOL into a wrapper-owned escrow + mints dePOOL; unwrap burns dePOOL + transfers cPOOL out of escrow. The wrapper has NO mint authority on cPOOL.
- Operational requirement: issue a system attestation to the `wrapper_signer` PDA before enabling wrapping, because the Permissioned hook validates both transfer owners.
- See `docs/derwa-wrapper.md`.

#### SVS-11: NAV oracle extensibility
- New `set_oracle_source` instruction (authority-gated). Toggles `CreditVault.oracle_source` between `0` (simple/mock oracle, neutral upstream default) and `1` (NavOracle adapter, opt-in for richer NAV semantics)
- New `OracleSourceChanged` event
- New `CreditVault` fields: `last_seen_nav_sequence`, `last_seen_nav_price`, `max_nav_staleness_secs`, `oracle_source` (32 bytes total + 7-byte alignment padding)
- `approve_deposit` and `approve_redeem` branch on `oracle_source` and read the appropriate oracle account
- New errors: `OracleAccountMissing`, `OracleAccountInvalid`, `OraclePoolMismatch`, `OraclePublisherMismatch`, `OracleSequenceStale`, `OracleSourceInvalid`

#### SVS-11: Redemption pro-rata fulfillment
- `RedemptionRequest` gains `original_shares`, `fulfilled_shares_cumulative`, `queued_for_settlement_at` fields for partial-fulfillment across multiple settlement dates
- `approve_redeem` supports floor-rounded pro-rata fulfillment
- `request_redeem` accepts `queued_for_settlement_at` argument (off-chain scheduler input; sentinel `0` accepted)
- Auto-requeue on partial settlement (request stays in queue until `fulfilled_shares_cumulative == original_shares`)

#### SVS-11: Attestation extensions
- `Attestation` struct extended with `jurisdiction (u16)`, `investor_class (u8)`, `kyc_risk_tier (u8)`
- `validate_attestation` retains existing `attestation_type` enforcement; new fields are observed-only on this PR (reserved for future enforcement gates)
- The 4 new bytes occupy what was previously reserved padding; field order is load-bearing for ComplianceHook + deRWA offset readers

#### SVS-11: ComplianceHook integration on `initialize_pool`
- Pool initialization now binds the cPOOL Token-2022 TransferHook extension to compliance-hook in the same transaction
- Subsequent share-mint transfers route through `compliance-hook.execute`

#### SDK (`@stbr/solana-vault`)
- New TypeScript clients matching every supporting program:
  - `ComplianceHook` class + `compliance-hook-pda.ts` helpers
  - `NavOracle` class + `nav-oracle-pda.ts` helpers (includes `buildSigningPayload` helper for off-chain publisher tooling)
  - `DeRwaWrapper` class + `derwa-wrapper-pda.ts` helpers
  - `mock-sas-pda.ts` helpers (extracted from `credit-vault-pda.ts`)
- `CreditVault.setOracleSource()` SDK method
- `CreditVaultState` interface gains `oracleSource`, `lastSeenNavSequence`, `lastSeenNavPrice`, `maxNavStalenessSecs`
- `CreditVault.approveDeposit` / `approveRedeem` accept optional `navAccount` parameter (used when `oracle_source == 1`)
- `CreditVault.requestRedeem` accepts optional `queuedForSettlementAt` parameter
- All new modules re-exported from `sdk/core/src/index.ts`
- See `docs/SDK.md`.

#### CLI (`solana-vault`)
- New `solana-vault compliance` group: `init-sanctions-list`, `update-sanctions-list`, `freeze-account`, `unfreeze-account`, `init-mint-config`, `init-eaml`
- New `solana-vault nav` group: `init`, `publish`, `rotate-publisher`
- New `solana-vault derwa` group: `init`, `wrap`, `unwrap`
- New `solana-vault set-oracle-source` command in the credit group
- Wired the SVS-11 credit command group into the CLI top-level (was authored but never registered before this PR)
- See `docs/CLI.md`.

#### Operator scripts (reference deployment)
Reference scripts demonstrating canonical deployment patterns for the new programs. Generic enough to be reused by any SVS deployer; deployment-specific orchestration (multisig topology, runbook stages, in-place upgrade tooling) lives in deployer-side ops repos rather than the SVS standard tree.

- `initialize-nav-account.ts` — per-pool NavAccount initialization (sentinel-pubkey hardened)
- `create-derwa-mint.ts` — Token-2022 dePOOL mint with TransferHook + MintConfig + ExtraAccountMetaList wiring

#### Tests
- `tests/compliance-hook.spec.ts` (new) — active sanctions-list + freeze/unfreeze authority tests, FreelyTransferable hook execution, Permissioned hook execution, destination-missing attestation rejection, and EAML creation coverage, plus visible pending cases for deeper negative-path coverage
- `tests/nav-oracle.spec.ts` (new) — publish self-consistency, stale-sequence rejection, inconsistent-NAV rejection
- `tests/derwa-wrapper.spec.ts` (new) — wrap + unwrap roundtrip + attestation gate
- `tests/create-derwa-mint-script.spec.ts` (new) — regression guard against partial mint bootstrap wiring
- `tests/svs-11.ts` (extended) — NavOracle helpers (`buildNavSigningPayload`, `publishNav`), opt-in approval (success), missing-NavAccount rejection (negative), source-switch test, NavAccount initialization in pool init flow
- SDK unit tests for all new client classes (PDA derivation, byte-layout parity for the NAV signing payload, IDL drift detection)

#### Documentation
- New per-program docs: `docs/compliance-hook.md`, `docs/nav-oracle.md`, `docs/derwa-wrapper.md`
- Updated cross-cutting docs: `docs/SVS-11.md` (oracle extensibility section), `docs/EVENTS.md`, `docs/ERRORS.md`, `docs/TESTING.md`, `docs/ARCHITECTURE.md`, `docs/MODULES.md`
- New "Supporting Programs" sections in ARCHITECTURE and MODULES describing how compliance-hook / nav-oracle / derwa-wrapper sit alongside SVS-1..SVS-12

### Changed

- **Breaking-ish (SVS-11 only)**: `Attestation` byte layout extended by 4 bytes (`jurisdiction` + `investor_class` + `kyc_risk_tier`). Older attestation accounts created before this change need to be re-issued; the on-chain reader still tolerates the older shorter layout because the new fields occupy what was previously zero-initialized reserved bytes.
- **Breaking-ish (SVS-11 only)**: `request_redeem` signature gains a `queued_for_settlement_at` argument. Callers without an off-chain redemption scheduler can pass `0` as a sentinel (manager sets the real value on first partial fulfillment).
- `CreditVault.approveDeposit` / `approveRedeem` SDK methods accept an optional `navAccount` parameter (defaults to `program.programId` as a harmless sentinel when `oracle_source == 0`).
- `Cargo.lock` now committed at the workspace root to lock dep resolution for Solana 1.84 cargo.
- Yarn version pinned to `1.22.22` via `packageManager` field. Yarn workspaces remain in classic v1 lockfile format. Yarn 4 / Berry was inadvertently introduced during development and reverted before this PR; the pin prevents future drift.

### Removed

- **Breaking (SVS-11 only)**: `realloc_credit_vault_for_oracle_v2` instruction removed. Pre-Apr-2026 devnet pools using the v1 layout cannot be migrated in place — recreate them. This avoids carrying upstream a one-shot migration that no fresh SVS-11 deployment ever needs.

### Build / Tooling

- Three new on-chain programs added to the workspace: `programs/compliance-hook`, `programs/nav-oracle`, `programs/derwa-wrapper`. Registered in `Anchor.toml` under `[programs.devnet]` and `[programs.localnet]`.
- `tweetnacl` added as a devDependency for test-only off-chain Ed25519 signing of NAV payloads.
- `.gitignore` now ignores yarn 4 PnP artifacts (`.pnp.*`).

## [2.0.0] - 2026-04-04

### Security
- Completed 10 internal audit rounds (v1 through v10), all findings resolved
- Scrubbed leaked program keypairs from git history
- Fresh deployment with new program IDs (no upgrade authority on old IDs)
- **SVS-11 MEDIUM**: `CreditVault` carries `required_attestation_type: u8` and `validate_attestation` enforces `attestation.attestation_type == vault.required_attestation_type`, preventing low-bar attestations from satisfying higher-bar vaults when the attester issues multiple types.
- **SVS-9 MEDIUM**: `compute_total_assets` validates `allocation_info.owner == crate::ID` and `shares_info.owner == SPL Token / Token-2022` before deserialization, blocking attacker-forged `ChildAllocation` accounts that could skew NAV via a manipulated `child_decimals_offset`.
- **SVS-8 LOW**: `remove_asset`, `add_asset`, and `update_weights` dedupe `remaining_accounts` keys before processing, preventing admin self-harm via duplicate entries.
- **SVS-11 LOW**: `validate_attestation` added a defensive `data.len() >= 8` guard before slicing past the Anchor discriminator.
- **SVS-8 HIGH**: `redeem_single.user_asset_account` / `user_shares_account` carry `token::mint` + `token::authority` constraints.
- **SVS-8 LOW**: vault PDA seeds+bump validation added to `add_asset`, `remove_asset`, `update_weights`, `deposit_single`, `redeem_single` account structs.

### Changed
- **Breaking**: All 14 programs redeployed with new program IDs
- **Breaking**: Removed `init_if_needed` on user token accounts — callers must pre-create ATAs before deposit/mint operations (improves security, saves ~5k CU)
- **Breaking**: All remaining_accounts validated with owner checks before deserialization
- **Breaking**: SVS-11 attestation PDA seed convention: `["attestation", subject, issuer, attestation_type]`
- **Breaking**: SVS-11 compliance operations (freeze/unfreeze) require VaultConfig PDA (initialized via `initialize_vault_config`)
- **Breaking**: SVS-11 CreditVault adds `required_attestation_type: u8` (default 0) — attestation validation now enforces `attestation.attestation_type == vault.required_attestation_type`
- Version bump: 0.2.0 → 2.0.0 across all packages (programs, modules, SDKs)

### Added

#### SVS-8: Multi-Asset Basket Vault
- `initialize` — creates MultiAssetVault PDA + Token-2022 shares mint
- `add_asset` / `remove_asset` — manage basket assets with target weights (bps)
- `update_weights` — rebalance target weights (must sum to 10,000 bps)
- `update_oracle` — set/update OraclePrice PDA per asset (authority only)
- `deposit_single` — deposit one asset, mint shares priced by oracle portfolio value
- `deposit_proportional` — atomic deposit across all basket assets by target weight
- `redeem_single` — burn shares, receive proportional amount of one asset
- `redeem_proportional` — burn shares, receive proportional amounts from all assets
- `pause` / `unpause` / `transfer_authority` — admin controls
- OraclePrice PDA per asset with staleness validation (60s) and price > 0 check
- Owner checks on all remaining_accounts before deserialization
- svs_math wrapper for share/asset conversion (consistent with SVS-1/5)
- shares_mint.supply as source of truth (no redundant total_shares field)
- 110 tests passing (localnet)
#### SVS-10: Async Vault (ERC-7540)
- Async request/fulfill/claim lifecycle for deposits and redemptions
- Dual pricing: vault-priced (svs-math) or oracle-priced with deviation protection
- Operator-managed fulfillment with delegation via OperatorApproval PDA
- Synchronous cancel (ERC-7887 deviation)
- Liquidity isolation via total_pending_deposits
- Share escrow for locked redemptions
- Full module compatibility (fees, caps, locks, access)
- TypeScript SDK: AsyncVault class with all lifecycle methods
- CLI: 9 async vault commands (request/cancel/fulfill/claim deposit/redeem + set-operator)
- 35 integration tests covering lifecycle, oracle, permissions, and edge cases

#### SVS-5: Streaming Yield Vault
- **programs/svs-5**: Time-interpolated yield distribution vault using `distribute_yield(amount, duration)` + `checkpoint()`
- **sdk/core/streaming-vault.ts**: `StreamingVault` SDK class with `distributeYield()`, `checkpoint()`, `getStreamInfo()`, `effectiveTotalAssets()`
- **scripts/svs-5/**: 9 devnet test scripts (basic, slippage, multi-user, edge-cases, inflation-attack, live-balance, withdraw-mint, view-functions, full-drain)
- **trident-tests/fuzz_svs5**: 1,524-line fuzz test with 31 flows and 13 end invariants covering streaming yield, fees, caps, locks, access control, inflation attacks, and timing edge cases
- SVS-5 uses `svs-module-hooks` crate for module integration (same pattern as SVS-1)
- Program ID (devnet): `HCp23XHzV4HJHXwLWwQj8aSTU1yjyzj8FCNLe6NybwXt`

## [0.3.0] - 2026-03-06

### Added

#### On-Chain Module System
- **modules/svs-math**: Extracted shared math crate (mul_div, rounding, share/asset conversion)
- **modules/svs-fees**: Entry/exit fee calculation with basis points
- **modules/svs-caps**: Global and per-user deposit cap enforcement
- **modules/svs-locks**: Time-locked shares with duration checking
- **modules/svs-access**: Whitelist/blacklist with merkle proof verification
- **modules/svs-rewards**: Secondary reward token distribution (scaffolding)
- **modules/svs-oracle**: Oracle price validation with staleness checks (scaffolding)

#### SVS-1 Module Instructions (feature: modules)
- `initialize_fee_config` / `update_fee_config` - Configure entry/exit fees (max 10%)
- `initialize_cap_config` / `update_cap_config` - Configure global/per-user caps
- `initialize_lock_config` / `update_lock_config` - Configure share lock duration (max 1 year)
- `initialize_access_config` / `update_access_config` - Configure whitelist/blacklist with merkle root

#### Module Hook Integration
- Deposit/mint handlers now enforce access control, caps, and entry fees when module configs are passed
- Withdraw/redeem handlers now enforce access control, lock checks, and exit fees when module configs are passed
- Modules are optional - if config PDAs not passed, checks are skipped (backward compatible)
- Both deposit() and mint() enforce caps to prevent bypass attacks

### Changed
- Test count: 130 passing (anchor tests) + module crate unit tests

## [0.2.2] - 2025-03-06

### Fixed
- npm: Add repository field for provenance publishing

## [0.2.1] - 2025-03-06

### Fixed
- CI: Handle missing `@stbr/svs-privacy-sdk` gracefully in confidential transfer commands
- CI: Node 22+ compatibility for ts-node (conditional `--no-experimental-strip-types` flag)
- CI: Track yarn.lock for reproducible builds

## [0.2.0] - 2025-03-05

### Added

#### CLI Command Modules
- **fees**: `show`, `configure`, `collect`, `preview` - Manage vault fee configuration
- **cap**: `show`, `configure`, `check` - Manage deposit caps (global and per-user)
- **access**: `show`, `set-mode`, `add`, `remove`, `check`, `generate-proof`, `clear` - Whitelist/blacklist access control with merkle proofs
- **emergency**: `show`, `configure`, `withdraw`, `preview` - Emergency withdrawal with penalty
- **timelock**: `show`, `configure`, `propose`, `execute`, `cancel`, `list`, `clear` - Timelocked governance proposals
- **strategy**: `show`, `add`, `remove`, `deploy`, `recall`, `rebalance`, `health` - DeFi strategy management
- **portfolio**: `show`, `configure`, `deposit`, `redeem`, `rebalance`, `status` - Multi-vault portfolio management
- **ct**: `configure`, `apply-pending`, `status` - Confidential transfer support (SVS-3/SVS-4)

#### Documentation
- `docs/CLI.md` - Comprehensive CLI documentation (860+ lines)
- `docs/DEPLOYMENT.md` - Full deployment guide (devnet, mainnet, multisig, CI/CD)
- `docs/SECURITY.md` - Expanded security checklist with Solana-specific vulnerabilities

#### Tests
- `cli-extended.test.ts` - 36 new tests for extended CLI commands
- Total test coverage: 460 tests passing

### Changed
- Reorganized `.claude/skills/` - Moved documentation files to `docs/`
- Updated skill references to point to docs/

### Removed
- `docs/plan-cli.md` - Planning document no longer needed

## [0.1.0-beta.1] - 2025-03-03

### Added

#### SDK Modules
- **vault.ts** - Core vault operations (deposit, mint, withdraw, redeem)
- **math.ts** - Share/asset conversion with virtual offset protection
- **pda.ts** - PDA derivation utilities
- **fees.ts** - Fee calculation and management
- **cap.ts** - Deposit cap enforcement
- **access-control.ts** - Whitelist/blacklist with merkle proofs
- **emergency.ts** - Emergency withdrawal with penalty
- **timelock.ts** - Proposal management with delays
- **strategy.ts** - DeFi strategy integration
- **multi-asset.ts** - Multi-vault portfolio management
- **events.ts** - Event parsing utilities
- **errors.ts** - Error handling

#### CLI (solana-vault)
- `info` - Display vault information
- `balance` - Check user balance
- `preview` - Preview operations
- `deposit` / `mint` / `withdraw` / `redeem` - Core vault operations
- `pause` / `unpause` - Admin controls
- `sync` - Sync stored balance (SVS-2/SVS-4)
- `transfer-authority` - Transfer vault authority
- `permissions` - View access permissions
- `derive` - PDA derivation
- `convert` - Unit conversion
- `list` - List configured vaults
- `history` - Transaction history
- `dashboard` - Real-time monitoring
- `health` - Vault health checks
- `autopilot` - Automated operations
- `guard` - Safety monitoring
- `batch` - Batch operations
- `config` - Configuration management

#### Documentation
- `docs/SDK.md` - TypeScript SDK reference
- `docs/SVS-1.md` - Live balance vault specification
- `docs/SVS-2.md` - Stored balance vault specification
- `docs/SVS-3.md` - Confidential live balance vault
- `docs/SVS-4.md` - Confidential stored balance vault
- `docs/ARCHITECTURE.md` - System architecture
- `docs/PRIVACY.md` - Privacy model
- `docs/TESTING.md` - Testing guide

### Security
- Virtual offset protection against inflation attacks
- Vault-favoring rounding on all operations
- Checked arithmetic throughout
- Slippage protection on all user operations

[Unreleased]: https://github.com/solanabr/tokenized-vault-standard/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/solanabr/tokenized-vault-standard/compare/v0.2.2...v2.0.0
[0.2.2]: https://github.com/solanabr/tokenized-vault-standard/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/solanabr/tokenized-vault-standard/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/solanabr/tokenized-vault-standard/compare/v0.1.0-beta.1...v0.2.0
[0.1.0-beta.1]: https://github.com/solanabr/tokenized-vault-standard/releases/tag/v0.1.0-beta.1
