# SVS-11: Credit Markets Vault

## Overview

SVS-11 is a manager-approved tokenized vault for credit markets and illiquid assets. Unlike SVS-1 through SVS-4 which use permissionless deposit/withdraw, SVS-11 implements a request-approval-claim flow where every deposit and redemption requires manager approval with oracle-based NAV pricing. Mandatory KYC via Solana Attestation Service (SAS) and compliance features (account freezing, investment windows) make it suitable for regulated credit products, private debt, and institutional fund structures.

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
| **FrozenAccount** | `["frozen_account", vault, investor]` | Vault PDA |
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
    pub nav_oracle: Pubkey,             // 32 bytes
    pub oracle_program: Pubkey,         // 32 bytes
    pub max_staleness: i64,             // 8 bytes
    pub sas_credential: Pubkey,         // 32 bytes
    pub sas_schema: Pubkey,             // 32 bytes
    pub vault_id: u64,                  // 8 bytes
    pub total_assets: u64,              // 8 bytes
    pub total_shares: u64,              // 8 bytes
    pub total_pending_deposits: u64,    // 8 bytes
    pub minimum_investment: u64,        // 8 bytes
    pub investment_window_open: bool,   // 1 byte
    pub decimals_offset: u8,            // 1 byte
    pub bump: u8,                       // 1 byte
    pub redemption_escrow_bump: u8,     // 1 byte
    pub paused: bool,                   // 1 byte
    pub _reserved: [u8; 64],            // 64 bytes
}
// Total: 345 bytes
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
#[account]
pub struct FrozenAccount {
    pub investor: Pubkey,               // 32 bytes
    pub vault: Pubkey,                  // 32 bytes
    pub frozen_by: Pubkey,              // 32 bytes
    pub frozen_at: i64,                 // 8 bytes
    pub bump: u8,                       // 1 byte
}
// Total: 105 bytes
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

### Deposit Flow (Request-Approve-Claim)

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `request_deposit` | `investor` | Lock assets, create `InvestmentRequest` (requires SAS attestation, open window) |
| `approve_deposit` | `manager` | Convert assets to shares via oracle price, mark request approved |
| `claim_deposit` | `investor` | Mint approved shares to investor's token account |
| `reject_deposit` | `manager` | Return locked assets, close request (emits `reason_code`) |
| `cancel_deposit` | `investor` | Cancel own pending request, reclaim locked assets |

### Redemption Flow (Request-Approve-Claim)

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `request_redeem` | `investor` | Lock shares in redemption escrow (requires SAS attestation, open window) |
| `approve_redeem` | `manager` | Burn shares, transfer assets to claimable account via oracle price |
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

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `freeze_account` | `manager` | Create `FrozenAccount` PDA, blocking investor from deposits and redemptions |
| `unfreeze_account` | `manager` | Close `FrozenAccount` PDA |

### Admin

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `pause` | `authority` | Pause vault (blocks approve_deposit, approve_redeem, draw_down, repay) |
| `unpause` | `authority` | Unpause vault |
| `transfer_authority` | `authority` | Transfer vault authority to new pubkey |
| `set_manager` | `authority` | Set new manager |
| `update_sas_config` | `authority` | Update SAS credential and schema |

### Initialize Parameters

```rust
pub fn initialize_pool(
    ctx: Context<InitializePool>,
    vault_id: u64,
    name: String,           // shares token name
    symbol: String,         // shares token symbol
    uri: String,            // shares token metadata URI
    minimum_investment: u64,
    max_staleness: i64,
) -> Result<()>
```

**Token Programs**:
- Shares mint: Token-2022
- Asset mint: Auto-detected (SPL Token or Token-2022)

## Oracle Integration

NAV pricing uses an external oracle account. The vault reads price data directly from the oracle's account data (no CPI).

```rust
pub struct NavOracleData {
    pub price_per_share: u64,   // price in PRICE_SCALE (1e9)
    pub updated_at: i64,        // unix timestamp
}
```

**Validation**:
1. `oracle_account.key == vault.nav_oracle`
2. `oracle_account.owner == vault.oracle_program`
3. `price_per_share > 0`
4. `clock.unix_timestamp - updated_at <= vault.max_staleness`

**Conversion** (via `svs_oracle` crate):
```rust
shares = assets * PRICE_SCALE / price_per_share
assets = shares * price_per_share / PRICE_SCALE
```

Where `PRICE_SCALE = 1_000_000_000` (1e9).

## SAS Attestation (KYC)

Every `request_deposit` and `request_redeem` validates the investor's SAS attestation.

**Validation**:
1. `attestation.owner == SAS_PROGRAM_ID`
2. PDA matches: `find_program_address([credential, schema, investor], SAS_PROGRAM_ID)`
3. `attestation.credential == vault.sas_credential`
4. `attestation.schema == vault.sas_schema`
5. `attestation.expiry == 0` (no expiry) OR `attestation.expiry > clock.unix_timestamp`

**Revocation**: SAS revokes attestations by closing the account. The PDA check (step 2) implicitly rejects revoked attestations since the account no longer exists.

## Security

### Access Control

| Role | Permissions |
|------|-------------|
| **Authority** | pause, unpause, transfer_authority, set_manager, update_sas_config, module admin |
| **Manager** | approve/reject deposits, approve redemptions, draw_down, repay, freeze/unfreeze, open/close window |
| **Investor** | request/cancel deposits, request/cancel redemptions, claim |

### Compliance Features

- **Account Freezing**: Manager creates `FrozenAccount` PDA to block an investor. Checked via `Option<Account<'info, FrozenAccount>>` -- if the account exists, the investor is frozen.
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
| `RedemptionApproved` | vault, investor, shares, assets, nav | `approve_redeem` |
| `RedemptionClaimed` | vault, investor, assets | `claim_redeem` |
| `RedemptionCancelled` | vault, investor, shares | `cancel_redeem` |
| `Repayment` | vault, amount, new_total_assets | `repay` |
| `DrawDown` | vault, amount, destination | `draw_down` |
| `AccountFrozen` | vault, investor, frozen_by | `freeze_account` |
| `AccountUnfrozen` | vault, investor | `unfreeze_account` |
| `VaultStatusChanged` | vault, paused | `pause` / `unpause` |
| `AuthorityTransferred` | vault, old_authority, new_authority | `transfer_authority` |
| `ManagerChanged` | vault, old_manager, new_manager | `set_manager` |
| `WindowOpened` | vault | `open_investment_window` |
| `WindowClosed` | vault | `close_investment_window` |
| `SasConfigUpdated` | vault, old/new credential, old/new schema | `update_sas_config` |

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
| 6013 | `AccountFrozen` | Account is frozen |
| 6014 | `InvalidAttestationProgram` | Attestation account not owned by SAS program |
| 6015 | `InvalidAttestation` | Attestation PDA address mismatch |
| 6016 | `InvalidCredential` | Attestation credential does not match vault |
| 6017 | `InvalidSchema` | Attestation schema does not match vault |
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
pub const FROZEN_ACCOUNT_SEED: &[u8] = b"frozen_account";

pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const DEFAULT_MAX_STALENESS: i64 = 3600;  // 1 hour

pub const SAS_PROGRAM_ID: Pubkey = pubkey!("22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG");
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

// Investor: request deposit (requires SAS attestation)
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
| **KYC** | None | None | None | SAS Attestation |
| **Manager Role** | None | None | Operator (delegated) | Manager (fixed) |
| **Account Freezing** | No | No | No | Yes |
| **Investment Windows** | Always open | Always open | Always open | Manager-controlled |
| **Credit Ops** | N/A | N/A | N/A | draw_down / repay |

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/svs-11/src/lib.rs` | Program entry point, instruction dispatch |
| `programs/svs-11/src/state.rs` | Account structs (CreditVault, requests, frozen) |
| `programs/svs-11/src/constants.rs` | PDA seeds, limits, SAS program ID |
| `programs/svs-11/src/error.rs` | Error codes |
| `programs/svs-11/src/events.rs` | Event definitions |
| `programs/svs-11/src/math.rs` | Share/asset conversion via oracle |
| `programs/svs-11/src/oracle.rs` | Oracle reading and validation |
| `programs/svs-11/src/attestation.rs` | SAS KYC attestation validation |
| `programs/svs-11/src/instructions/` | Instruction handlers |
| `programs/svs-11/src/instructions/module_admin.rs` | Module admin (with `modules` feature) |
| `sdk/core/src/credit-vault.ts` | TypeScript SDK |
| `tests/svs-11.ts` | Anchor test suite |
| `scripts/e2e-svs11-devnet.ts` | Devnet E2E test script |

---

**Specification**: [specs-SVS11.md](specs-SVS11.md)
**Last Updated**: 2026-03-11
**Program Version**: 0.1.0
