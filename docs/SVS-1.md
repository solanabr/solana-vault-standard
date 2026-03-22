# SVS-1: Live Balance Vault

## Overview

SVS-1 is the simplest tokenized vault variant in the Solana Vault Standard. It reads `asset_vault.amount` directly on every instruction without requiring synchronization, making external donations immediately visible in share price calculations. This zero-trust, minimal-complexity variant is ideal for lending pools, liquid staking, and yield aggregators where all assets remain in the vault's associated token account.

## Balance Model

**Live Balance**: `total_assets = asset_vault.amount`

- No cached balance — reads token account on every call
- No `sync()` instruction needed
- External deposits automatically reflected in share price
- Highest transparency, zero state staleness
- Slightly higher compute (1 account deserialization per call)

```rust
pub fn get_total_assets(asset_vault: &Account<TokenAccount>) -> u64 {
    asset_vault.amount
}
```

## Account Structure

### PDA Derivation

| Account | Seeds | Authority |
|---------|-------|-----------|
| **Vault** | `["vault", asset_mint, vault_id.to_le_bytes()]` | User-specified on `initialize` |
| **Shares Mint** | `["shares", vault_pubkey]` | Vault PDA |
| **Asset Vault** | ATA of `asset_mint` for Vault PDA | Vault PDA |

### State Struct

```rust
#[account]
pub struct Vault {
    pub authority: Pubkey,          // 32 bytes
    pub asset_mint: Pubkey,          // 32 bytes
    pub shares_mint: Pubkey,         // 32 bytes
    pub asset_vault: Pubkey,         // 32 bytes
    pub decimals_offset: u8,         // 1 byte
    pub bump: u8,                    // 1 byte
    pub paused: bool,                // 1 byte
    pub vault_id: u64,               // 8 bytes
    pub _reserved: [u8; 64],         // 64 bytes
}
// Total: 203 bytes
```

## Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize` | `payer` | Create vault, shares mint (Token-2022), and asset vault ATA |
| `deposit` | `owner` | Deposit assets, receive shares (rounds down) |
| `mint` | `receiver` | Mint exact shares, pay required assets (rounds up) |
| `withdraw` | `owner` | Withdraw exact assets, burn shares (rounds up) |
| `redeem` | `owner` | Redeem shares, receive assets (rounds down) |
| `pause` | `authority` | Set `paused = true`, disables deposit/mint/withdraw/redeem |
| `unpause` | `authority` | Set `paused = false` |
| `transfer_authority` | `authority` | Transfer vault authority to new pubkey |

### Initialize Parameters

```rust
pub struct InitializeParams {
    pub vault_id: u64,               // Unique ID for multi-vault deployments
    pub asset_decimals: u8,          // Used to calculate decimals_offset
}
```

**Token Programs**:
- Shares mint: Token-2022 (no extensions)
- Asset mint: Auto-detected (SPL Token or Token-2022)

## View Functions

All view functions use `set_return_data()` for CPI composability. Return values are little-endian `u64`.

| Function | Context | Returns | SVS-1 Specifics |
|----------|---------|---------|-----------------|
| `total_assets` | `VaultView` | Current total assets | Reads `asset_vault.amount` |
| `convert_to_shares` | `VaultView` | Shares for N assets | Uses live balance |
| `convert_to_assets` | `VaultView` | Assets for N shares | Uses live balance |
| `max_deposit` | `VaultView` | Max depositable assets | `u64::MAX` (no limit) |
| `max_mint` | `VaultView` | Max mintable shares | `u64::MAX` (no limit) |
| `max_withdraw` | `VaultViewWithOwner` | Max withdrawable assets | Based on owner's shares |
| `max_redeem` | `VaultViewWithOwner` | Max redeemable shares | Owner's share balance |

**Contexts**:
- `VaultView`: vault, asset_vault, shares_mint
- `VaultViewWithOwner`: VaultView + owner, owner_shares

## Math

### Virtual Offset

```rust
decimals_offset = 9 - asset_decimals
offset = 10^decimals_offset
```

**Example**: USDC (6 decimals) → offset = 10³ = 1000 virtual shares

### Conversion Formulas

```rust
// Convert assets to shares
shares = assets * (total_shares + offset) / (total_assets + 1)

// Convert shares to assets
assets = shares * (total_assets + 1) / (total_shares + offset)
```

**Where**:
- `total_assets = asset_vault.amount`
- `total_shares = shares_mint.supply`
- `offset = 10^decimals_offset`

### Rounding Strategy

| Operation | Formula | Rounding | Favors |
|-----------|---------|----------|--------|
| `deposit` | `shares = assets * (S + offset) / (A + 1)` | Floor | Vault |
| `mint` | `assets = shares * (A + 1) / (S + offset)` | Ceiling | Vault |
| `withdraw` | `shares = assets * (S + offset) / (A + 1)` | Ceiling | Vault |
| `redeem` | `assets = shares * (A + 1) / (S + offset)` | Floor | Vault |

**Implementation**:
- Floor: Direct division (`/`)
- Ceiling: `(numerator + denominator - 1) / denominator`

## SDK Usage

```typescript
import { SolanaVault } from '@stbr/solana-vault';
import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';

const connection = new Connection('https://api.devnet.solana.com');
const provider = new AnchorProvider(connection, wallet, {});
const vaultPubkey = new PublicKey('YOUR_VAULT_ADDRESS');

const vault = await SolanaVault.load(provider, vaultPubkey);

// Deposit 1000 USDC
const depositTx = await vault.deposit(1_000_000_000n); // 1000 * 10^6
await provider.sendAndConfirm(depositTx);

// Preview withdraw
const shares = await vault.getShareBalance(wallet.publicKey);
const previewAssets = await vault.previewRedeem(shares);
console.log(`Redeeming ${shares} shares → ${previewAssets} assets`);

// Redeem all shares
const redeemTx = await vault.redeem(shares);
await provider.sendAndConfirm(redeemTx);

// View functions
const totalAssets = await vault.totalAssets();
const maxDeposit = await vault.maxDeposit(wallet.publicKey);
```

## Security

### Inflation Attack Protection

**Attack Vector**: First depositor deposits 1 wei, directly donates 1M tokens → dilutes subsequent depositors.

**Mitigation**: Virtual offset ensures minimum share cost.

```rust
// First deposit of 1 wei with offset = 1000
shares = 1 * (0 + 1000) / (0 + 1) = 1000 shares

// Attacker donates 1M tokens
// Second deposit of 1 wei
shares = 1 * (1000 + 1000) / (1_000_000 + 1) ≈ 0.002 shares (rounds to 0)
// ❌ Attack fails — depositor receives 0 shares, reverts
```

**Offset Calculation**:
- 18-decimal token (e.g., SOL): offset = 1
- 9-decimal token (e.g., custom SPL): offset = 1
- 6-decimal token (e.g., USDC): offset = 1000

### Rounding Protection

All operations round in favor of the vault:
- Users receive **fewer shares** on deposit/mint
- Users burn **more shares** on withdraw
- Users receive **fewer assets** on redeem

This protects existing shareholders from dilution.

### Account Validation

Every instruction validates:
- PDA bumps (stored in `vault.bump`)
- Token account ownership (vault owns `asset_vault`)
- Mint authorities (`shares_mint` authority = vault PDA)
- Signer authorization (`authority`, `owner`, `receiver`)

### Pause Mechanism

When `vault.paused = true`:
- ❌ `deposit`, `mint`, `withdraw`, `redeem` fail
- ✅ View functions still work
- ✅ `transfer_authority` still works (to unpause)

## Deployment

### Devnet

**Program ID**: `Bv8aVSQ3DJUe3B7TqQZRZgrNvVTh8TjfpwpoeR1ckDMC`

```bash
# Example initialization
anchor run initialize-vault -- \
  --asset-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --vault-id 1 \
  --asset-decimals 6
```

### Mainnet

**Checklist**:
- [ ] Verifiable build (`anchor build --verifiable`)
- [ ] Devnet testing (7+ days)
- [ ] Security audit
- [ ] Fuzz testing (10+ min)
- [ ] Inflation attack scenarios tested
- [ ] User explicit confirmation

### IDL

Published to npm as `@stbr/solana-vault-idl`. SDK auto-imports.

## Differences from Other SVS Variants

| Feature | SVS-1 (Live) | SVS-2 (Stored) | SVS-3 (Confidential Live) |
|---------|--------------|----------------|---------------------------|
| **Balance Source** | `asset_vault.amount` | `vault.total_assets` | `asset_vault.amount` |
| **Sync Needed** | ❌ No | ✅ Yes (`sync()`) | ❌ No |
| **External Donations** | Immediate | After `sync()` | Immediate |
| **State Staleness** | Never | Possible | Never |
| **Privacy** | Public | Public | Encrypted balances |
| **Compute Cost** | ~25k CU | ~27k CU | ~150k CU |

---

## Account Contexts

### Initialize Context

From `programs/svs-1/src/instructions/initialize.rs:21-60`:

```rust
#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Vault::LEN,
        seeds = [VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Initialized via CPI
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
```

### Deposit Context

From `programs/svs-1/src/instructions/deposit.rs:18-65`:

```rust
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(constraint = !vault.paused @ VaultError::VaultPaused)]
    pub vault: Account<'info, Vault>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = asset_vault.key() == vault.asset_vault)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
```

### Withdraw Context

From `programs/svs-1/src/instructions/withdraw.rs:17-60`:

```rust
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(constraint = !vault.paused @ VaultError::VaultPaused)]
    pub vault: Account<'info, Vault>,

    #[account(constraint = asset_mint.key() == vault.asset_mint)]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = asset_vault.key() == vault.asset_vault)]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut, constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}
```

---

## Error Codes

| Code | Name | Message |
|------|------|---------|
| 6000 | `ZeroAmount` | Amount must be greater than zero |
| 6001 | `SlippageExceeded` | Slippage tolerance exceeded |
| 6002 | `VaultPaused` | Vault is paused |
| 6003 | `InvalidAssetDecimals` | Asset decimals must be <= 9 |
| 6004 | `MathOverflow` | Arithmetic overflow |
| 6005 | `DivisionByZero` | Division by zero |
| 6006 | `InsufficientShares` | Insufficient shares balance |
| 6007 | `InsufficientAssets` | Insufficient assets in vault |
| 6008 | `Unauthorized` | Unauthorized - caller is not vault authority |
| 6009 | `DepositTooSmall` | Deposit amount below minimum threshold |
| 6010 | `VaultNotPaused` | Vault is not paused |

See [ERRORS.md](ERRORS.md) for complete error documentation.

---

## Events

### VaultInitialized
```rust
#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
}
```

### Deposit
```rust
#[event]
pub struct Deposit {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}
```

### Withdraw
```rust
#[event]
pub struct Withdraw {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub receiver: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}
```

### VaultStatusChanged
```rust
#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,
    pub paused: bool,
}
```

### AuthorityTransferred
```rust
#[event]
pub struct AuthorityTransferred {
    pub vault: Pubkey,
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}
```

See [EVENTS.md](EVENTS.md) for parsing examples.

---

## Constants

```rust
pub const VAULT_SEED: &[u8] = b"vault";
pub const SHARES_MINT_SEED: &[u8] = b"shares";
pub const MAX_DECIMALS: u8 = 9;
pub const SHARES_DECIMALS: u8 = 9;
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;
```

See [CONSTANTS.md](CONSTANTS.md) for complete reference.

---

## CPI Examples

### Mint Shares (Vault as Authority)

```rust
let asset_mint_key = ctx.accounts.vault.asset_mint;
let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
let bump = ctx.accounts.vault.bump;  // STORED bump

let signer_seeds: &[&[&[u8]]] = &[&[
    VAULT_SEED,
    asset_mint_key.as_ref(),
    vault_id_bytes.as_ref(),
    &[bump],
]];

token_2022::mint_to(
    CpiContext::new_with_signer(
        ctx.accounts.token_2022_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.shares_mint.to_account_info(),
            to: ctx.accounts.user_shares_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    ),
    shares,
)?;
```

### Transfer Assets (From Vault)

```rust
transfer_checked(
    CpiContext::new_with_signer(
        ctx.accounts.asset_token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.asset_vault.to_account_info(),
            to: ctx.accounts.user_asset_account.to_account_info(),
            mint: ctx.accounts.asset_mint.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    ),
    assets,
    ctx.accounts.asset_mint.decimals,
)?;
```

See [PATTERNS.md](PATTERNS.md) for complete implementation patterns.

---

## Compute Units

| Instruction | Approximate CU |
|-------------|---------------|
| `initialize` | ~50,000 |
| `deposit` | ~25,000 |
| `mint` | ~25,000 |
| `withdraw` | ~30,000 |
| `redeem` | ~30,000 |
| `pause` | ~5,000 |
| `unpause` | ~5,000 |
| `transfer_authority` | ~5,000 |
| View functions | ~3,000-5,000 |

---

## Module Integration

SVS-1 supports optional on-chain modules via the `modules` feature flag.

**Build:** `anchor build -- --features modules`

### Available Modules

| Module | Purpose | Admin Instruction |
|--------|---------|-------------------|
| svs-fees | Entry/exit fees | `initialize_fee_config` |
| svs-caps | Global/per-user caps | `initialize_cap_config` |
| svs-locks | Time-locked shares | `initialize_lock_config` |
| svs-access | Whitelist/blacklist | `initialize_access_config` |

### Integration Points

Module hooks are called in deposit/mint/withdraw/redeem handlers:

1. **Access check** — `verify_access()`, `check_not_frozen()`
2. **Cap check** — `check_global_cap()`, `check_user_cap()`
3. **Fee application** — `apply_entry_fee()` / `apply_exit_fee()`
4. **Lock enforcement** — `check_lockup()`, `set_lock()`

Module config PDAs are passed via `remaining_accounts`. If not provided, checks are skipped (pure ERC-4626 behavior).

See [specs-modules.md](specs-modules.md) for full specification.

---

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/svs-1/src/lib.rs` | Program entry point |
| `programs/svs-1/src/state.rs` | Vault account struct |
| `programs/svs-1/src/constants.rs` | PDA seeds, limits |
| `programs/svs-1/src/error.rs` | Error codes |
| `programs/svs-1/src/events.rs` | Event definitions |
| `programs/svs-1/src/math.rs` | Share/asset conversion |
| `programs/svs-1/src/instructions/` | Instruction handlers |
| `modules/svs-module-hooks/` | Shared module hooks and state (with `modules` feature) |
| `programs/svs-1/src/instructions/module_admin.rs` | Module admin instructions (with `modules` feature) |

---

**Specification Version**: 1.0.0
**Last Updated**: 2026-03-12
**Program Version**: 0.1.0
