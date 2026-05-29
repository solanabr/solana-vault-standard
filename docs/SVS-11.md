# SVS-11: Credit Markets Vault

## Overview

SVS-11 is a manager-approved tokenized vault for credit markets and illiquid assets. Unlike SVS-1 through SVS-4 which use permissionless deposit/withdraw, SVS-11 implements a request-approval-claim flow where every deposit and redemption requires manager approval with oracle-based NAV pricing. Mandatory KYC attestation plus protocol-level compliance (sanctions + freeze enforced by the separate `compliance-hook` program) and investment windows make it suitable for regulated credit products, private debt, and institutional fund structures. The attestation model is provider-agnostic — compatible with SAS, Civic Pass, or any program that writes accounts in the spec's `Attestation` format.

## Balance Model

**Stored Balance**: `total_assets` is tracked on the vault account, updated on approvals, repayments, and draw-downs.

- No live balance reads -- total_assets is the source of truth
- Manager-controlled via `repay` (increase) and `draw_down` (decrease)
- No `sync()` instruction -- external donations are not reflected
- Oracle determines share price independently of vault balance

## Account Structure

### PDA Derivation

| Account | Seeds | Authority |
|---------|-------|-----------|
| **CreditVault** | `["credit_vault", asset_mint, vault_id.to_le_bytes()]` | `authority` on initialize |
| **Shares Mint** | `["shares", vault]` | Vault PDA |
| **Deposit Vault** | ATA of `asset_mint` for Vault PDA | Vault PDA |
| **Redemption Escrow** | `["redemption_escrow", vault]` | Vault PDA |
| **InvestmentRequest** | `["investment_request", vault, investor]` | Vault PDA |
| **RedemptionRequest** | `["redemption_request", vault, investor]` | Vault PDA |
| **ClaimableTokens** | `["claimable_tokens", vault, investor]` | Vault PDA |
| **VaultConfig** | `["vault_config", vault]` | Authority |
| **Attestation** | `["attestation", subject, issuer, attestation_type]` | Attestation program |
| **FeeConfig** | `["svs_fee_config", vault]` | Vault authority |
| **CapConfig** | `["svs_cap_config", vault]` | Vault authority |
| **LockConfig** | `["svs_lock_config", vault]` | Vault authority |
| **AccessConfig** | `["svs_access_config", vault]` | Vault authority |

### State Structs

```rust
#[account]
pub struct CreditVault {
    pub authority: Pubkey,              // 32 bytes
    pub manager: Pubkey,                // 32 bytes
    pub asset_mint: Pubkey,             // 32 bytes
    pub shares_mint: Pubkey,            // 32 bytes
    pub deposit_vault: Pubkey,          // 32 bytes
    pub redemption_escrow: Pubkey,      // 32 bytes
    pub nav_oracle: Pubkey,             // 32 bytes — configured oracle account
    pub oracle_program: Pubkey,         // 32 bytes — its owner program
    pub max_staleness: i64,             // 8 bytes  — 60..=45d (NAV publishes monthly)
    pub attester: Pubkey,               // 32 bytes
    pub attestation_program: Pubkey,    // 32 bytes
    pub vault_id: u64,                  // 8 bytes
    pub total_assets: u64,              // 8 bytes  — idle cash; AUM = total_shares * NAV
    pub total_shares: u64,              // 8 bytes  — cached share supply
    pub total_pending_deposits: u64,    // 8 bytes
    pub minimum_investment: u64,        // 8 bytes
    pub investment_window_open: bool,   // 1 byte
    pub bump: u8,                       // 1 byte
    pub redemption_escrow_bump: u8,     // 1 byte
    pub paused: bool,                   // 1 byte
    pub total_approved_deposits: u64,   // 8 bytes
    pub pending_authority: Pubkey,      // 32 bytes — two-step authority transfer
    pub total_pending_redeems: u64,     // 8 bytes
    pub required_attestation_type: u8,  // 1 byte  — must match attestation.attestation_type
    pub _reserved: [u8; 23],            // 23 bytes
    // ---- pluggable oracle interface (D4) ----
    pub last_seen_nav_sequence: u64,    // 8 bytes  — replay baseline (reset on oracle swap)
    pub _padding_oracle: [u8; 24],      // 24 bytes
}
// Total: 484 bytes (8-byte discriminator + 476-byte payload)
```

```rust
#[account]
pub struct VaultConfig {
    pub vault: Pubkey,                  // 32 bytes
    pub pending_oracle: Pubkey,         // 32 bytes — proposed new oracle account (timelock)
    pub pending_oracle_program: Pubkey, // 32 bytes — proposed new oracle owner program (timelock)
    pub oracle_change_at: i64,          // 8 bytes  — when the change can be applied
    pub bump: u8,                       // 1 byte
    pub _reserved: [u8; 31],            // 31 bytes
}
// Total: 136 bytes
// Seeds: ["vault_config", vault]
// Required for oracle timelock changes (rotates both the oracle account and its owner program atomically).
// Must be initialized via `initialize_vault_config` after vault creation.
```

```rust
#[account]
pub struct InvestmentRequest {
    pub investor: Pubkey,               // 32 bytes
    pub vault: Pubkey,                  // 32 bytes
    pub amount_locked: u64,             // 8 bytes
    pub shares_claimable: u64,          // 8 bytes
    pub status: RequestStatus,          // 1 byte
    pub requested_at: i64,              // 8 bytes
    pub fulfilled_at: i64,              // 8 bytes
    pub bump: u8,                       // 1 byte
}
// Total: 98 bytes
```

```rust
#[account]
pub struct RedemptionRequest {
    pub investor: Pubkey,               // 32 bytes
    pub vault: Pubkey,                  // 32 bytes
    pub shares_locked: u64,             // 8 bytes
    pub assets_claimable: u64,          // 8 bytes
    pub status: RequestStatus,          // 1 byte
    pub requested_at: i64,              // 8 bytes
    pub fulfilled_at: i64,              // 8 bytes
    pub bump: u8,                       // 1 byte
}
// Total: 98 bytes
```

```rust
pub enum RequestStatus {
    Pending,
    Approved,
}

pub enum AccessMode {
    Open,       // default
    Whitelist,
    Blacklist,
}
```

## Instructions

### Pool Setup (one-shot per pool)

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize_pool` | `authority` (operator) | Create the vault PDA + shares mint (cPOOL) with TransferHook ext bound to compliance-hook + redemption escrow |
| `bootstrap_shares_compliance` | `authority` (operator) | Initialize compliance-hook's per-mint `MintConfig` + `ExtraAccountMetaList` PDAs for the cPOOL via CPI signed by vault PDA. Pass `mode` (`FreelyTransferable` or `Permissioned`) and the trust anchors (`attestation_program`, `attestation_issuer`, `required_attestation_type`, `pool_policy`). For `Permissioned` mode, the operator must ALSO issue a system attestation for the vault PDA via the configured attestation program (subject = `vault.key()`) so the hook's destination-side check on cPOOL transfers — destination owner = vault PDA via `redemption_escrow.owner` — passes. |

### Deposit Flow (Request-Approve-Claim)

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `request_deposit` | `investor` | Lock assets, create `InvestmentRequest` (requires KYC attestation, open window) |
| `approve_deposit` | `manager` | Convert assets to shares via oracle price, mark request approved |
| `claim_deposit` | `investor` | Mint approved shares to investor's token account |
| `reject_deposit` | `manager` | Return locked assets, close request (emits `reason_code`) |
| `cancel_deposit` | `investor` | Cancel own pending request, reclaim locked assets |

### Redemption Flow (Request-Approve-Claim)

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `request_redeem` | `investor` | Lock shares in redemption escrow (requires KYC attestation; intentionally does not require an open investment window) |
| `approve_redeem` | `manager` | Atomic full approval — burn ALL `shares_locked` and transfer their full asset value (via oracle price) to the claimable account in one shot |
| `claim_redeem` | `investor` | Withdraw claimable assets to own token account |
| `cancel_redeem` | `investor` | Cancel own pending request, reclaim locked shares |

### Credit Operations

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `draw_down` | `manager` | Withdraw assets from vault to external destination (decrements `total_assets`) |
| `repay` | `manager` | Return assets to vault (increments `total_assets`) |

### Investment Window

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `open_investment_window` | `manager` | Enable deposit/redeem requests |
| `close_investment_window` | `manager` | Disable new deposit/redeem requests |

### Compliance

SVS-11 has no per-vault freeze instructions. Compliance (sanctions + freeze) is enforced at the protocol level by the separate `compliance-hook` program (see the Compliance section below). Every Token-2022 cPOOL transfer routes through the hook; the three hook-blind paths (`claim_deposit`, `approve_redeem`, `unwrap`) additionally call the hook's shared `assert_wallet_compliant` helper.

### Admin

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `pause` | `authority` | Pause vault (blocks approve_deposit, approve_redeem, draw_down, repay) |
| `unpause` | `authority` | Unpause vault |
| `transfer_authority` | `authority` | Transfer vault authority to new pubkey |
| `set_manager` | `authority` | Set new manager |
| `update_attester` | `authority` | Update attester and attestation program |

### Initialize Parameters

```rust
pub fn initialize_pool(
    ctx: Context<InitializePool>,
    vault_id: u64,
    minimum_investment: u64,  // minimum deposit amount (in asset decimals)
    max_staleness: i64,       // max oracle age in seconds (60..=DEFAULT_MAX_NAV_STALENESS_SECS = 45 days)
) -> Result<()>
```

**Token Programs**:
- Shares mint: Token-2022
- Asset mint: Auto-detected (SPL Token or Token-2022)

## Oracle Integration

NAV pricing uses a pluggable external oracle account. SVS-11 has no hardcoded
mock/nav selector — the vault reads ANY compliant oracle through a generic
24-byte `SvsOraclePrice` header via the shared `read_oracle` reader in
`modules/svs-oracle` (no CPI; price data is read directly from account data).
Any program can plug in its own oracle as long as it writes this header; oracle
integrity stays the responsibility of each oracle program. The Credit Markets
`nav-oracle` is the reference implementation, `mock-oracle` is an example.

```rust
// SvsOraclePrice header — 24 bytes of payload (after the 8-byte Anchor discriminator)
pub struct SvsOraclePrice {
    pub price: u64,       // payload 0..8   (on-disk bytes 8..16)  — price in PRICE_SCALE (1e9)
    pub timestamp: i64,   // payload 8..16  (on-disk bytes 16..24) — unix timestamp
    pub sequence: u64,    // payload 16..24 (on-disk bytes 24..32) — monotonic replay guard
}
```

**Validation**:
1. `oracle_account.key == vault.nav_oracle`
2. `oracle_account.owner == vault.oracle_program`
3. `price > 0`
4. `clock.unix_timestamp - timestamp <= vault.max_staleness`
5. Sequence monotonicity vs `vault.last_seen_nav_sequence` (a `sequence == 0` value is the "unused" sentinel that skips the monotonicity check)

`approve_deposit` and `approve_redeem` each take a SINGLE `oracle_account`
(replacing the old `nav_oracle` + `nav_account` pair).

**Conversion** (via `svs_oracle` crate):
```rust
shares = assets * PRICE_SCALE / price
assets = shares * price / PRICE_SCALE
```

Where `PRICE_SCALE = 1_000_000_000` (1e9).

## Oracle Timelock And Rotation

Oracle changes go through a timelock (`request_oracle_change` /
`apply_oracle_change`) recorded in `VaultConfig`. A rotation swaps BOTH the
oracle account AND its owner program atomically: `request_oracle_change` takes a
`new_oracle` account and a `new_oracle_program` arg, staging them into
`pending_oracle` / `pending_oracle_program`; `apply_oracle_change` commits both
to `vault.nav_oracle` / `vault.oracle_program` once the timelock elapses.
`request_oracle_change` cross-checks the pair at stage time (the new oracle
account must be owned by the new program), so a mismatched pair fails fast
instead of bricking approvals after the timelock. This
lets a deployment migrate from one oracle implementation (e.g. `mock-oracle`) to
another (e.g. the Credit Markets `nav-oracle`) without changing the core
deposit/redeem state machine.

Credit Markets deployments use the `nav-oracle` reference implementation because
private-credit NAV needs signed publisher payloads, gross/net NAV, TER,
loss-provision basis points, sequence monotonicity, stale-NAV checks, and
loan-tape Merkle commitments — all of which the oracle program enforces behind
the generic `SvsOraclePrice` header.

## KYC Attestation

Every `request_deposit`, `request_redeem`, `approve_deposit`, and `approve_redeem` validates the investor's attestation account. The model is provider-agnostic — any program that writes accounts matching the canonical `Attestation` layout is supported. The layout and verification live in the shared `svs_attestation` crate (`modules/svs-attestation`, the attestation analogue of `svs-oracle`); `attestation.rs::validate_attestation` calls `svs_attestation::verify_attestation` and maps the result onto `VaultError`. `compliance-hook` and `derwa-wrapper` consume the same module.

**Attestation Account Layout** (129 bytes on-disk: 8-byte discriminator + 121-byte payload):
```rust
pub struct Attestation {
    pub subject: Pubkey,          // 32 — investor being attested
    pub issuer: Pubkey,           // 32 — attester identity
    pub attestation_type: u8,     //  1 — KYC(0), Accredited(1), etc.
    pub country_code: [u8; 2],    //  2 — ISO 3166-1 alpha-2
    pub issued_at: i64,           //  8 — unix timestamp
    pub expires_at: i64,          //  8 — must be strictly in the future
    pub revoked: bool,            //  1
    pub bump: u8,                 //  1
    pub _reserved: [u8; 32],      // 32
    // additive-only metadata (default-zero = no policy enforcement):
    pub jurisdiction: [u8; 2],    //  2 — ISO 3166-1 alpha-2, [0,0] = unset
    pub investor_class: u8,       //  1 — 0=infra, 1=retail, 2=accredited, 3=qualified
    pub kyc_risk_tier: u8,        //  1 — 0=unset, 1=low, 2=medium, 3=high
}
```

**Validation** (`svs_attestation::verify_attestation`):
1. `att.owner == vault.attestation_program`
2. `att.subject == investor`
3. `att.issuer == vault.attester`
4. `att.attestation_type == vault.required_attestation_type`
5. `att.revoked == false`
6. `att.expires_at > clock.unix_timestamp` (a non-positive expiry is treated as expired)
7. Canonical PDA: `att.key() == [b"attestation", subject, issuer, &[type], &[bump]]` under `vault.attestation_program` — atomically binds steps 2–4 to the physical account.

**Configuration**: The vault stores `attester` (issuer pubkey) and `attestation_program` (program that owns attestation accounts). These can be updated via `update_attester`.

## Security

### Access Control

| Role | Permissions |
|------|-------------|
| **Authority** | pause, unpause, transfer_authority, set_manager, update_attester, module admin |
| **Manager** | approve/reject deposits, approve redemptions, draw_down, repay, open/close window |
| **Investor** | request/cancel deposits, request/cancel redemptions, claim |

### Compliance Features

- **Protocol-Level Compliance (sanctions + freeze)**: Enforced by the separate `compliance-hook` program, not per-vault. The hook owns a singleton SanctionsList PDA `["sanctions_list"]` and a per-wallet FrozenAccount PDA `["frozen", wallet]`, and exposes `freeze_account` / `unfreeze_account`. Every Token-2022 cPOOL transfer routes through the hook automatically. The three hook-blind paths — `claim_deposit` (mint_to), `approve_redeem` (burn), and the derwa-wrapper `unwrap` — additionally call the hook's shared `assert_wallet_compliant` helper, which rejects sanctioned or frozen wallets. The other six core instructions (`request_deposit`, `cancel_deposit`, `approve_deposit`, `request_redeem`, `cancel_redeem`, `claim_redeem`) take no compliance-check account.
- **Investment Windows**: Deposits and redemptions only accepted when `investment_window_open == true`.
- **Pause**: Halts approve_deposit, approve_redeem, draw_down, repay. Requests and claims still work.

### Rounding

All share/asset conversions use oracle price via `svs_oracle` which rounds in favor of the vault:
- Deposits: investor receives fewer shares (floor division)
- Redemptions: investor receives fewer assets (floor division)

### Inflation Attack Protection

Same virtual offset mechanism as SVS-1:
```rust
decimals_offset = 9 - asset_decimals
```

### Liquidity Check

`approve_redeem` verifies sufficient available liquidity:
```rust
available = deposit_vault.amount - vault.total_pending_deposits
require!(available >= gross_assets)
```

This ensures pending deposit assets are not used to fund redemptions.

## Events

| Event | Fields | Emitted By |
|-------|--------|------------|
| `VaultInitialized` | vault, authority, manager, asset_mint, shares_mint, vault_id | `initialize_pool` |
| `InvestmentRequested` | vault, investor, amount | `request_deposit` |
| `InvestmentApproved` | vault, investor, amount, shares, nav | `approve_deposit` |
| `InvestmentClaimed` | vault, investor, shares | `claim_deposit` |
| `InvestmentRejected` | vault, investor, amount, reason_code | `reject_deposit` |
| `InvestmentCancelled` | vault, investor, amount | `cancel_deposit` |
| `RedemptionRequested` | vault, investor, shares | `request_redeem` |
| `RedemptionApproved` | vault, investor, shares, assets, nav, manager | `approve_redeem` |
| `RedemptionClaimed` | vault, investor, assets | `claim_redeem` |
| `RedemptionCancelled` | vault, investor, shares | `cancel_redeem` |
| `Repayment` | vault, amount, new_total_assets | `repay` |
| `DrawDown` | vault, amount, destination | `draw_down` |
| `VaultStatusChanged` | vault, paused | `pause` / `unpause` |
| `AuthorityTransferred` | vault, old_authority, new_authority | `transfer_authority` |
| `ManagerChanged` | vault, old_manager, new_manager | `set_manager` |
| `WindowOpened` | vault | `open_investment_window` |
| `WindowClosed` | vault | `close_investment_window` |
| `AttesterUpdated` | vault, old/new attester, old/new attestation_program | `update_attester` |

See [EVENTS.md](EVENTS.md) for parsing examples.

## Error Codes

| Code | Name | Message |
|------|------|---------|
| 6000 | `ZeroAmount` | Amount must be greater than zero |
| 6001 | `VaultPaused` | Vault is paused |
| 6002 | `VaultNotPaused` | Vault is not paused |
| 6003 | `InvalidAssetDecimals` | Asset decimals must be <= 9 |
| 6004 | `MathOverflow` | Arithmetic overflow |
| 6005 | `DivisionByZero` | Division by zero |
| 6006 | `Unauthorized` | Unauthorized |
| 6007 | `DepositTooSmall` | Deposit amount below minimum investment |
| 6008 | `RequestNotPending` | Request is not in pending status |
| 6009 | `RequestNotApproved` | Request is not in approved status |
| 6010 | `InsufficientLiquidity` | Insufficient liquidity in vault |
| 6011 | `InvestmentWindowClosed` | Investment window is closed |
| 6012 | `InvalidAddress` | Invalid address: cannot be the zero address |
| 6014 | `InvalidAttestationProgram` | Attestation account not owned by attestation program |
| 6015 | `InvalidAttestation` | Invalid attestation account |
| 6016 | `InvalidAttester` | Attestation issuer does not match vault attester |
| 6017 | `AttestationRevoked` | Attestation has been revoked |
| 6018 | `AttestationExpired` | Attestation has expired |
| 6019 | `OracleStale` | Oracle price data is stale |
| 6020 | `OracleInvalidPrice` | Oracle price is invalid |
| 6021 | `OracleInvalidProgram` | Oracle account owner does not match vault.oracle_program |
| 6022 | `GlobalCapExceeded` | Deposit would exceed global vault cap |
| 6023 | `EntryFeeExceedsMax` | Entry fee exceeds maximum |
| 6024 | `LockDurationExceedsMax` | Lock duration exceeds maximum |

See [ERRORS.md](ERRORS.md) for complete error documentation.

## Constants

```rust
pub const VAULT_SEED: &[u8] = b"credit_vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const REDEMPTION_ESCROW_SEED: &[u8] = b"redemption_escrow";
pub const INVESTMENT_REQUEST_SEED: &[u8] = b"investment_request";
pub const REDEMPTION_REQUEST_SEED: &[u8] = b"redemption_request";
pub const CLAIMABLE_TOKENS_SEED: &[u8] = b"claimable_tokens";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const DEFAULT_MAX_STALENESS: i64 = 3600;                       // 1 hour
pub const DEFAULT_MAX_NAV_STALENESS_SECS: i64 = 45 * 24 * 60 * 60; // 45 days (max_staleness ceiling)

// No hardcoded attestation program ID — configured per-vault via `attester` and `attestation_program`
```

See [CONSTANTS.md](CONSTANTS.md) for complete reference.

## Module Integration

SVS-11 supports optional on-chain modules via the `modules` feature flag.

**Build:** `anchor build -- --features modules`

### Available Modules

| Module | Purpose | Admin Instructions |
|--------|---------|-------------------|
| svs-fees | Entry/exit/management/performance fees | `initialize_fee_config`, `update_fee_config` |
| svs-caps | Global/per-user investment caps | `initialize_cap_config`, `update_cap_config` |
| svs-locks | Lock duration on shares | `initialize_lock_config`, `update_lock_config` |
| svs-access | Whitelist/blacklist via merkle root | `initialize_access_config`, `update_access_config` |

### Integration Design

Unlike SVS-1 through SVS-4, module configs in SVS-11 are **not enforced at runtime** in core instructions. The manager-approved flow handles these concerns at the approval step:

- **Fees**: Manager applies fees off-chain when calculating approval amounts
- **Caps**: Manager checks caps before approving deposits
- **Locks**: Manager considers lock status before approving redemptions
- **Access**: Manager verifies access before approving

Module config accounts serve as on-chain reference data that the manager (or off-chain systems) reads when making approve/reject decisions.

## SDK Usage

```typescript
import { CreditVault } from '@stbr/solana-vault';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';

const connection = new Connection('https://api.devnet.solana.com');
const provider = new AnchorProvider(connection, wallet, {});
const vaultPubkey = new PublicKey('YOUR_VAULT_ADDRESS');

const vault = new CreditVault(provider, vaultPubkey);

// Investor: request deposit (requires KYC attestation)
const attestation = vault.getAttestationPda(investor);
const tx = await vault.requestDeposit(
  1_000_000_000,   // 1000 USDC
  attestation,
);

// Manager: approve deposit
const approveTx = await vault.approveDeposit(investor);

// Investor: claim shares
const claimTx = await vault.claimDeposit();

// Manager: draw down for credit operations
const drawTx = await vault.drawDown(500_000_000, destination);

// Manager: repay
const repayTx = await vault.repay(500_000_000);
```

## Differences from Other SVS Variants

| Feature | SVS-1 (Live) | SVS-2 (Stored) | SVS-10 (Async) | SVS-11 (Credit) |
|---------|--------------|----------------|-----------------|-----------------|
| **Balance Source** | `asset_vault.amount` | `vault.total_assets` | `vault.total_assets` | `vault.total_assets` |
| **Deposit Flow** | Permissionless | Permissionless | Request-Fulfill-Claim | Request-Approve-Claim |
| **Pricing** | On-chain math | On-chain math | On-chain math | Oracle NAV |
| **KYC** | None | None | None | Generic Attestation |
| **Manager Role** | None | None | Operator (delegated) | Manager (fixed) |
| **Account Freezing** | No | No | No | Protocol-level (compliance-hook) |
| **Investment Windows** | Always open | Always open | Always open | Manager-controlled |
| **Credit Ops** | N/A | N/A | N/A | draw_down / repay |

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/svs-11/src/lib.rs` | Program entry point, instruction dispatch |
| `programs/svs-11/src/state.rs` | Account structs (CreditVault, requests) |
| `programs/svs-11/src/constants.rs` | PDA seeds, limits |
| `programs/svs-11/src/error.rs` | Error codes |
| `programs/svs-11/src/events.rs` | Event definitions |
| `programs/svs-11/src/math.rs` | Share/asset conversion via oracle |
| `programs/svs-11/src/hook_extras.rs` | Shared Token-2022 TransferHook helper (`read_hook_program_id`) |
| `programs/svs-11/src/attestation.rs` | Generic KYC attestation validation |
| `modules/svs-oracle/src/price.rs` | Generic `SvsOraclePrice` header + `read_oracle` (oracle reading/validation) |
| `programs/svs-11/src/instructions/` | Instruction handlers |
| `programs/svs-11/src/instructions/module_admin.rs` | Module admin (with `modules` feature) |
| `sdk/core/src/credit-vault.ts` | TypeScript SDK |
| `tests/svs-11.ts` | Anchor test suite |
| `scripts/svs-11/` | Modular devnet E2E scripts |

## See Also

- [SVS-10.md](./SVS-10.md) — Base async vault
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
- [MODULES.md](./MODULES.md) — Module integration
