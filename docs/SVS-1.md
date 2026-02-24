# SVS-1: Live Balance Vault

## Overview

SVS-1 is the simplest ERC-4626 compatible tokenized vault variant on Solana. It reads `asset_vault.amount` directly on every instruction without requiring synchronization, making external donations immediately visible in share price calculations. This zero-trust, minimal-complexity variant is ideal for lending pools, liquid staking, and yield aggregators where all assets remain in the vault's associated token account.

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
    pub total_assets: u64,           // 8 bytes (UNUSED — always 0)
    pub decimals_offset: u8,         // 1 byte
    pub bump: u8,                    // 1 byte
    pub paused: bool,                // 1 byte
    pub vault_id: u64,               // 8 bytes
    pub _reserved: [u8; 64],         // 64 bytes
}
// Total: 211 bytes
```

**Note**: `total_assets` field exists for struct compatibility but is always `0`. Live balance reads from `asset_vault.amount`.

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

| Feature | SVS-1 (Live) | SVS-2 (Cached) | SVS-3 (Rebasing) |
|---------|--------------|----------------|------------------|
| **Balance Source** | `asset_vault.amount` | `vault.total_assets` | `asset_vault.amount` |
| **Sync Needed** | ❌ No | ✅ Yes (`sync()`) | ❌ No (auto-rebase) |
| **External Donations** | Immediate | After `sync()` | Immediate |
| **State Staleness** | Never | Possible | Never |
| **Compute Cost** | +1 account read | Baseline | +1 account read |
| **Complexity** | Lowest | Medium | Highest |

---

**Specification Version**: 1.0.0
**Last Updated**: 2026-02-23
**Program Version**: 0.1.0
