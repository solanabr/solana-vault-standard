# compliance-hook

## Overview

`compliance-hook` is a Token-2022 TransferHook program that enforces sanctions screening, account-freeze checks, and per-mint compliance modes on every transfer of mints that bind it. The program is invoked indirectly: a Token-2022 mint that carries the `TransferHook` extension pointing at this program triggers `execute` on every `transfer` / `transfer_checked`, and the runtime supplies the canonical 4 accounts plus the resolved `ExtraAccountMetaList` extras.

The hook implements a per-mint mode dispatch — `FreelyTransferable` (sanctions + frozen-account check only, used for dePOOL-style open mints) versus `Permissioned` (sanctions + frozen-account check + valid SVS-11 attestation on both wallets, used for cPOOL-style closed institutional shares). A global `SanctionsList` PDA is shared across every mint that uses the hook; per-mint state lives in `MintConfig` and `ExtraAccountMetaList` PDAs.

## Architecture

```
                 Token-2022 Mint
            (TransferHook ext = compliance-hook)
                        │
                        │ transfer / transfer_checked
                        ▼
            ┌────────────────────────────┐
            │   Token-2022 runtime       │
            │   reads ExtraAccountMeta-  │
            │   List PDA, resolves       │
            │   extras, invokes execute  │
            └─────────────┬──────────────┘
                          │
                          ▼
                ┌──────────────────────┐
                │  compliance-hook     │
                │       execute        │
                └──────────┬───────────┘
                           │
              ┌────────────┼─────────────────┐
              │            │                 │
              ▼            ▼                 ▼
       SanctionsList   Frozen PDA      MintConfig.mode
       (singleton)      check                │
              │            │       ┌─────────┴─────────┐
              │            │       │                   │
              │            │       ▼                   ▼
              │            │  FreelyTransfer      Permissioned
              │            │       │                   │
              │            │      Ok            check src + dst
              │            │                    Attestation PDAs
              │            │                    (SVS-11)
              ▼            ▼                          │
       SanctionedAddress  AccountFrozen           Ok / 6002-6004

PDA Layout
  [b"sanctions_list"]                       → SanctionsList     (singleton)
  [b"mint_config", mint]                    → MintConfig        (per-mint)
  [b"extra-account-metas", mint]            → ExtraAccountMeta… (per-mint)
  [b"frozen", owner]                        → FrozenAccount     (per-wallet, optional)
  [b"attestation", owner] (svs-11)          → Attestation       (per-wallet, Permissioned)
```

## Account Structures

### SanctionsList (singleton PDA)

Seeds: `[b"sanctions_list"]`

| Field | Type | Size (bytes) | Description |
|-------|------|--------------|-------------|
| (discriminator) | — | 8 | Anchor account discriminator |
| `authority` | `Pubkey` | 32 | Authority that controls updates (typically a governance or multisig authority) |
| `version` | `u64` | 8 | Bumped on every successful update |
| `updated_at` | `i64` | 8 | Unix timestamp of last update |
| `addresses` | `Vec<Pubkey>` | 4 + 32 × `MAX_ADDRESSES` | Sanctioned wallets (length-prefixed) |

`MAX_ADDRESSES = 256`. Total `SPACE = 8 + 32 + 8 + 8 + 4 + (32 × 256) = 8252` bytes — under Solana's 10240-byte CPI realloc cap (`MAX_PERMITTED_DATA_INCREASE`), so `init` succeeds in one CPI.

### MintConfig (per-mint PDA)

Seeds: `[b"mint_config", mint]`

| Field | Type | Size (bytes) | Description |
|-------|------|--------------|-------------|
| (discriminator) | — | 8 | Anchor account discriminator |
| `mint` | `Pubkey` | 32 | The Token-2022 mint this config binds to |
| `mode` | `ComplianceMode` | 1 | `0` = FreelyTransferable, `1` = Permissioned |
| `pool_policy` | `Option<Pubkey>` | 1 + 32 | Pool-policy PDA (Permissioned only); 1-byte tag + 32-byte pubkey reserved fixed-size |

Total `SPACE = 139` bytes: discriminator (8), mint (32), mode (1), max-case `Option<Pubkey>` for `pool_policy` (33), attestation program (32), attestation issuer (32), and required attestation type (1). The EAML builder reads `pool_policy` from typed `MintConfig` state and stores it as a fixed-pubkey extra; it reads `attestation_issuer` at byte offset `106` and `required_attestation_type` at byte offset `138` to derive source/destination attestation PDAs.

### ExtraAccountMetaList (per-mint PDA)

Seeds: `[b"extra-account-metas", mint]` (the seed literal MUST be hyphen-separated — Token-2022 looks up exactly this byte string; an underscore variant breaks the lookup).

This is Token-2022's standard `ExtraAccountMetaList` account (defined by `spl-tlv-account-resolution`). The program writes the layout the runtime uses to resolve the extras `execute` consumes beyond the canonical 4 (`source_ata`, `mint`, `destination_ata`, `source_owner`).

Capacity is sized for the max case (`Permissioned` mode, 8 extras) regardless of mode at init time, so a future mode flip does not require realloc. `FreelyTransferable` mode writes 4 entries and leaves the remainder unused. Space is computed via `ExtraAccountMetaList::size_of(8)`.

## Compliance Modes

### FreelyTransferable

Behavior: `execute` validates that neither the source-ATA owner nor the destination-ATA owner is on the `SanctionsList`, that no `FrozenAccount` PDA exists for either, then returns `Ok`. No attestation lookup. Suitable for dePOOL-style open mints where holders are free to transfer to any wallet.

EAML extras: 4 entries (`MintConfig`, `SanctionsList`, source-frozen-check, destination-frozen-check).

### Permissioned

Behavior: same sanctions + frozen-account checks as `FreelyTransferable`, plus a verification that BOTH the source-ATA owner and destination-ATA owner hold non-revoked, non-expired SVS-11 `Attestation` PDAs. Suitable for cPOOL-style closed institutional shares where every holder must be KYC'd.

EAML extras: 8 entries (the 4 `FreelyTransferable` extras plus attestation-program, source-attestation, destination-attestation, pool-policy). Source/destination attestations are resolved as cross-program PDAs under the configured attestation program.

`pool_policy` is wired through the EAML for forward compatibility: the current `execute` handler does not enforce jurisdiction / investor-class / KYC-tier thresholds against it. The slot is reserved for an optional policy-enforcement layer, and surfacing it in the EAML now means that layer can be enabled without re-initializing EAML accounts.

## Instructions

| Instruction | Signer | Purpose |
|-------------|--------|---------|
| `initialize_sanctions_list` | `payer` | Create the singleton `SanctionsList` PDA; record the future-update authority |
| `initialize_mint_config` | `payer`, `mint_authority` | Create the per-mint `MintConfig` PDA binding mode + optional pool policy |
| `initialize_extra_account_meta_list` | `payer`, `mint_authority` | Create the per-mint `ExtraAccountMetaList` PDA at the Token-2022 canonical seed |
| `update_sanctions_list` | `authority` | Apply additions/removals to the sanctions list, bump version, emit event |
| `freeze_account` | `SanctionsList.authority` | Create `[b"frozen", owner]`, blocking owner as source or destination |
| `unfreeze_account` | `SanctionsList.authority` | Close `[b"frozen", owner]`, allowing transfers again |
| `execute` | (Token-2022 program) | TransferHook entry point; invoked indirectly on every transfer of a bound mint |

`execute` is never called by users directly. The Token-2022 program builds the inner instruction during `transfer` / `transfer_checked` processing and invokes the hook with the canonical 4 accounts followed by the EAML-resolved extras.

## Initialize Parameters

### `initialize_sanctions_list`

No parameters. The signer's `authority` account (an `UncheckedAccount`) is stored as the gate for future `update_sanctions_list` calls.

### `initialize_mint_config`

```rust
pub struct InitializeMintConfigArgs {
    pub mode: ComplianceMode,           // FreelyTransferable | Permissioned
    pub pool_policy: Option<Pubkey>,    // None for FreelyTransferable; Some for Permissioned
    pub attestation_program: Pubkey,    // Required for Permissioned
    pub attestation_issuer: Pubkey,     // Required for Permissioned
    pub required_attestation_type: u8,
}
```

Consistency invariants enforced in the handler:

- `mode = Permissioned` AND `pool_policy = None` → `MissingPoolPolicyForPermissioned`
- `mode = FreelyTransferable` AND `pool_policy = Some(_)` → `PoolPolicySetOnFreelyTransferable`

The handler requires `mint.owner == spl_token_2022::id()`, unpacks the bound mint's `mint_authority`, and verifies the `mint_authority` signer matches. Permissioned mode also rejects default `attestation_program` / `attestation_issuer` trust anchors.

### `initialize_extra_account_meta_list`

No parameters. The handler reads `mint_config.mode` (typed `Account<MintConfig>` constrained to canonical seeds) and writes 4 or 8 `ExtraAccountMeta` entries depending on the mode.

### `update_sanctions_list`

```rust
fn update_sanctions_list(
    additions: Vec<Pubkey>,
    removals: Vec<Pubkey>,
) -> Result<()>
```

Removals apply first, then additions (already-present entries are skipped). The version counter is bumped and `SanctionsListUpdated` is emitted.

## Errors

| Code | Name | Description |
|------|------|-------------|
| 6000 | `SanctionedAddress` | Source or destination address is on the sanctions list |
| 6001 | `AccountFrozen` | Source or destination account is frozen |
| 6002 | `AttestationNotFound` | Destination wallet does not have a valid attestation |
| 6003 | `AttestationRevoked` | Destination attestation is revoked |
| 6004 | `AttestationExpired` | Destination attestation has expired |
| 6005 | `SanctionsListFull` | Sanctions list update would exceed max capacity (256) |
| 6006 | `UnauthorizedAuthority` | Update authority does not match `SanctionsList.authority` (or `mint_authority` mismatch on mint binding) |
| 6007 | `InvestorClassTooLow` | Pool policy requires higher investor class than attestation provides (reserved for optional policy enforcement) |
| 6008 | `JurisdictionNotPermitted` | Pool policy does not permit this jurisdiction (reserved for optional policy enforcement) |
| 6009 | `InvalidMintAccount` | Mint account does not deserialize as a valid Token-2022 mint |
| 6010 | `MissingPoolPolicyForPermissioned` | `Permissioned` mode requires a `pool_policy` |
| 6011 | `PoolPolicySetOnFreelyTransferable` | `FreelyTransferable` mode rejects a `pool_policy` (must be `None`) |
| 6012 | `InvalidAttestationProgram` | Attestation account owner does not match the configured attestation program |
| 6013 | `InvalidAttestationSubject` | Attestation subject does not match the source/destination ATA owner |
| 6014 | `InvalidAttestationIssuer` | Attestation issuer does not match the configured issuer |
| 6015 | `InvalidAttestationType` | Attestation type does not match the configured required type |
| 6016 | `InvalidAttestationPda` | Attestation address does not match canonical PDA derivation |
| 6017 | `InvalidAttestationConfig` | Permissioned trust anchors are missing/default |

See [ERRORS.md](ERRORS.md) for cross-program error code allocation.

## Events

| Event | Emitted By | Fields |
|-------|-----------|--------|
| `SanctionsListUpdated` | `update_sanctions_list` | `version: u64`, `added: Vec<Pubkey>`, `removed: Vec<Pubkey>`, `authority: Pubkey`, `updated_at: i64` |

`execute` does not emit events of its own — the parent Token-2022 transfer that triggered the hook emits the standard SPL Token transfer log. `initialize_sanctions_list`, `initialize_mint_config`, and `initialize_extra_account_meta_list` log via `msg!` for runbook visibility but do not emit Anchor events.

## Security

### Authority Gating

`SanctionsList.authority` is set at `initialize_sanctions_list` and is the only signer accepted by `update_sanctions_list` (enforced by Anchor's `has_one = authority @ UnauthorizedAuthority` constraint). Production deployments rotate this pubkey to their configured governance authority (e.g. a multisig vault).

### Mint-Authority Validation

`initialize_mint_config` and `initialize_extra_account_meta_list` both require the `mint_authority` signer to match the bound mint's `Mint::mint_authority` field (read via `spl_token_2022::state::Mint::unpack`). Fixed-supply mints (where `mint_authority = COption::None`) are rejected with `UnauthorizedAuthority` since no entity can authorize the binding.

### Mode Invariants

The two-way consistency check between `mode` and `pool_policy` (see `MissingPoolPolicyForPermissioned` / `PoolPolicySetOnFreelyTransferable`) prevents a `Permissioned` mint from being silently downgraded: if `pool_policy = None`, the EAML would not resolve a `pool_policy` extra at all, and the entire policy enforcement path would be unreachable.

### TransferHook Invocation Path

`execute` is invoked by the Token-2022 program, never by users. The runtime supplies the canonical 4 accounts and uses the EAML to resolve the extras — meaning a malicious caller cannot pass arbitrary `MintConfig` / `SanctionsList` / `Attestation` accounts. Anchor's typed account constraints (`seeds = [...]`, `bump`) revalidate the PDAs even after the runtime has resolved them, so a misconfigured EAML surfaces as a constraint failure rather than a silent bypass.

### EAML Capacity Sizing

`MAX_EXTRA_METAS = 8` is the `Permissioned` count. Sizing for the max case avoids realloc CPIs on a `FreelyTransferable` → `Permissioned` mode flip; the per-PDA waste in `FreelyTransferable` mode is roughly 4 × `ExtraAccountMeta` ≈ 140 bytes, which is acceptable.

### Frozen-Account Check Semantics

The `source_frozen_check` and `destination_frozen_check` extras are PDAs at `[b"frozen", owner]` derived against this program. The runtime always passes the derived address; existence is signaled by `lamports() > 0 && data_len() > 0`. An absent PDA (account never created) shows up with `lamports = 0` and `data_len = 0`, so the check correctly returns "not frozen" without an explicit existence query.

## Integration with Token-2022

The choreography for binding compliance-hook to a Token-2022 mint:

1. Create the Token-2022 mint account sized for `Mint` + `TransferHook` extension (use `ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook])`).
2. Call `spl_token_2022::extension::transfer_hook::instruction::initialize` to bind the hook authority + program ID. This MUST happen BEFORE `initialize_mint2` — Token-2022 requires extensions to be initialized between `create_account` and base mint init.
3. Initialize the base mint (`initialize_mint2`).
4. Call `compliance_hook::initialize_mint_config` (sets mode + optional pool policy).
5. Call `compliance_hook::initialize_extra_account_meta_list` (provisions the EAML PDA the runtime reads).

After all five steps, every `transfer` / `transfer_checked` on the mint routes through `compliance-hook::execute`. Steps 4–5 must be a separate transaction from the mint creation: the dependent PDAs are owned by `compliance-hook`, not by Token-2022 or by the mint-creating program, so they cannot be initialized inline via CPI from a different program (PDA-derivation-program-mismatch and signer-privilege-escalation issues — see [ARCHITECTURE.md](ARCHITECTURE.md)).

## Integration with SVS-11

SVS-11's `initialize_pool` creates the cPOOL shares mint with the `TransferHook` extension bound to `COMPLIANCE_HOOK_PROGRAM_ID` at the pool admin's authority. The pool initialization deliberately does NOT call `initialize_mint_config` or `initialize_extra_account_meta_list` inline — deployment performs those calls in a separate transaction directly against compliance-hook so that:

- Anchor's `init` constraint on cross-program PDAs does not require svs-11 to forge signer privilege for an account it does not own.
- `invoke_signed` seeds derive against the correct (compliance-hook) program ID.

For cPOOL mints, the runbook calls `initialize_mint_config` with `mode = Permissioned` and `pool_policy = Some(<policy_pda>)`. For deRWA mints (the open-transfer wrapper), `mode = FreelyTransferable` and `pool_policy = None`.

The redemption escrow account that SVS-11 creates is sized for the `TransferHookAccount` extension because its mint (cPOOL) carries `TransferHook` — Token-2022 requires every account holding tokens of a TransferHook-bearing mint to be sized for the companion account-level extension. See [SVS-11.md](SVS-11.md) for the full pool init sequence.

## Constants

| Name | Value | Description |
|------|-------|-------------|
| `SanctionsList::SEED_PREFIX` | `b"sanctions_list"` | PDA seed literal for the singleton list |
| `SanctionsList::MAX_ADDRESSES` | `256` | Capacity bound for the addresses Vec |
| `SanctionsList::SPACE` | `8252` | Account allocation size |
| `MintConfig::SEED_PREFIX` | `b"mint_config"` | PDA seed literal prefix (suffix: mint pubkey) |
| `MintConfig::SPACE` | `139` | Account allocation size (post-attestation-fields extension) |
| `EXTRA_ACCOUNT_METAS_SEED` | `b"extra-account-metas"` | Token-2022 canonical seed for the EAML PDA — hyphen, NOT underscore |
| `MAX_EXTRA_METAS` | `8` | Capacity sizing for the EAML (Permissioned mode count) |

The program declares `declare_id!("6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P")`. See [CONSTANTS.md](CONSTANTS.md) for the full program-ID registry.

## Implementation Files

- `programs/compliance-hook/src/lib.rs` — `#[program]` entry points
- `programs/compliance-hook/src/state.rs` — `SanctionsList`, `ComplianceMode`, `MintConfig`
- `programs/compliance-hook/src/error.rs` — `ComplianceHookError` (codes 6000–6017)
- `programs/compliance-hook/src/instructions/initialize_sanctions_list.rs`
- `programs/compliance-hook/src/instructions/initialize_mint_config.rs`
- `programs/compliance-hook/src/instructions/initialize_extra_account_meta_list.rs`
- `programs/compliance-hook/src/instructions/update_sanctions_list.rs`
- `programs/compliance-hook/src/instructions/freeze_account.rs`
- `programs/compliance-hook/src/instructions/unfreeze_account.rs`
- `programs/compliance-hook/src/instructions/execute.rs`

## See Also

- [SVS-11.md](SVS-11.md) — Credit pool that binds compliance-hook on its cPOOL mint
- [ARCHITECTURE.md](ARCHITECTURE.md) — Cross-program design and CPI constraints
- [ERRORS.md](ERRORS.md) — Cross-program error code allocation
- [MODULES.md](MODULES.md) — In-binary modules (compliance-hook is a separate program, not a module)
