# SVS-2: Stored Balance Vault

## Overview

SVS-2 extends SVS-1 with a stored balance model where `total_assets` is cached in vault state and updated via explicit `sync()` calls or arithmetically during deposits/withdrawals. This enables vaults to deploy assets externally (to yield protocols, bridges, other chains) while maintaining accurate share accounting. The authority controls when external yield is recognized.

## Balance Model

| Aspect | SVS-1 (Live Balance) | SVS-2 (Stored Balance) |
|--------|---------------------|------------------------|
| **total_assets source** | `asset_vault.amount` (live read) | `vault.total_assets` (cached) |
| **Update mechanism** | Automatic (token program updates) | Manual `sync()` + deposit/withdraw arithmetic |
| **External yield** | Not supported (breaks accounting) | Supported via `sync()` |
| **Trust model** | Trustless (permissionless deposits) | Authority controls yield recognition |
| **Use case** | Simple vaults, asset_vault holds all funds | Strategy vaults, deployed capital, managed funds |

**Key difference**: SVS-1 reads `asset_vault.amount` every time. SVS-2 reads `vault.total_assets` (a stored u64) which must be manually synchronized with `asset_vault.amount` via `sync()`.

## sync() Mechanics

### Purpose
Synchronize `vault.total_assets` with actual `asset_vault.amount` to recognize:
- External yield accrued from deployed strategies
- Direct token transfers to the vault ATA
- Returns from bridged/off-chain operations

### Operation
```rust
// Pseudocode
pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let asset_vault = &ctx.accounts.asset_vault;

    // Read current balance from token account
    let current_amount = asset_vault.amount;

    // Update stored total_assets
    vault.total_assets = current_amount;

    emit!(SyncEvent {
        vault: vault.key(),
        old_total_assets: vault.total_assets,
        new_total_assets: current_amount,
    });

    Ok(())
}
```

### Access Control
- **Authority-only**: Only `vault.authority` can call `sync()`
- **Paused state**: Can be called even when vault is paused (emergency recovery)

### When to Call
- After yield is returned to `asset_vault` from external protocols
- Before major operations (large deposits/withdrawals) to ensure accurate pricing
- Periodically to recognize accrued yield
- After receiving direct token transfers (donations, airdrops)

### Deposit/Withdraw Arithmetic
Unlike SVS-1, SVS-2 updates `vault.total_assets` arithmetically:

```rust
// deposit: add assets to total_assets
vault.total_assets = vault.total_assets.checked_add(assets_in).unwrap();

// withdraw: subtract assets from total_assets
vault.total_assets = vault.total_assets.checked_sub(assets_out).unwrap();
```

No `sync()` needed after deposit/withdraw — arithmetic update is sufficient.

## Account Structure

### PDAs

| Account | Seeds | Purpose |
|---------|-------|---------|
| **Vault** | `["vault", asset_mint, vault_id.to_le_bytes()]` | Vault state (same as SVS-1) |
| **Shares Mint** | `["shares", vault_pubkey]` | Token-2022 mint for shares |
| **Asset Vault** | ATA of (asset_mint, vault PDA) | Holds locked assets |

### State: `Vault` Account (211 bytes)

```rust
#[account]
pub struct Vault {
    pub authority: Pubkey,        // 32 bytes
    pub asset_mint: Pubkey,        // 32 bytes
    pub shares_mint: Pubkey,       // 32 bytes
    pub asset_vault: Pubkey,       // 32 bytes
    pub total_assets: u64,         // 8 bytes — ACTIVE (cached balance)
    pub decimals_offset: u8,       // 1 byte
    pub bump: u8,                  // 1 byte
    pub paused: bool,              // 1 byte
    pub vault_id: u64,             // 8 bytes
    pub _reserved: [u8; 64],       // 64 bytes
}
// Total: 211 bytes
```

**Key difference from SVS-1**: `total_assets` field is **actively used** (not always 0). SVS-1 ignores this field and reads `asset_vault.amount` directly.

## Instructions

| Instruction | Accounts | Args | Access Control | Notes |
|-------------|----------|------|----------------|-------|
| **initialize** | vault, authority, asset_mint, shares_mint, asset_vault, token_program, system_program | decimals_offset, vault_id | Anyone | Creates vault, shares mint (9 decimals), sets total_assets = 0 |
| **deposit** | vault, shares_mint, asset_vault, user_asset, user_shares, depositor, token_program | assets | Anyone (when not paused) | Mints shares, transfers assets, **increments vault.total_assets** |
| **mint** | vault, shares_mint, asset_vault, user_asset, user_shares, depositor, token_program | shares | Anyone (when not paused) | Mints exact shares, transfers required assets, **increments vault.total_assets** |
| **withdraw** | vault, shares_mint, asset_vault, user_asset, user_shares, owner, token_program | assets | Token account owner | Burns shares, transfers assets, **decrements vault.total_assets** |
| **redeem** | vault, shares_mint, asset_vault, user_asset, user_shares, owner, token_program | shares | Token account owner | Burns exact shares, transfers assets, **decrements vault.total_assets** |
| **pause** | vault, authority | - | Authority only | Sets paused = true |
| **unpause** | vault, authority | - | Authority only | Sets paused = false |
| **sync** | vault, asset_vault, authority | - | **Authority only** | **Sets vault.total_assets = asset_vault.amount** |

### View Instructions (Read-only)

Same as SVS-1 but `total_assets` reads from `vault.total_assets` instead of `asset_vault.amount`:

| View | Accounts | Returns | Note |
|------|----------|---------|------|
| **total_assets** | vault | u64 | **Reads vault.total_assets (cached)** — no asset_vault account needed |
| **total_supply** | shares_mint | u64 | Reads shares_mint.supply |
| **preview_deposit** | vault, shares_mint | shares: u64 | Uses cached total_assets |
| **preview_mint** | vault, shares_mint | assets: u64 | Uses cached total_assets |
| **preview_withdraw** | vault, shares_mint | shares: u64 | Uses cached total_assets |
| **preview_redeem** | vault, shares_mint | assets: u64 | Uses cached total_assets |
| **convert_to_shares** | vault, shares_mint | shares: u64 | Uses cached total_assets |
| **convert_to_assets** | vault, shares_mint | assets: u64 | Uses cached total_assets |

**Key difference**: SVS-2 view instructions don't require `asset_vault` account for `total_assets()` — they read the cached `vault.total_assets` field.

## Math

Identical formulas to SVS-1, but `total_assets` is read from `vault.total_assets` instead of `asset_vault.amount`:

### Virtual Offset
```rust
offset = 10^decimals_offset
decimals_offset = 9 - asset_decimals  // Ensures 9-decimal precision
```

### Conversion (with virtual shares/assets)
```rust
// Assets → Shares (floor)
shares = (assets * (total_supply + offset)) / (total_assets + 1)

// Shares → Assets (floor)
assets = (shares * (total_assets + 1)) / (total_supply + offset)
```

### Rounding

| Operation | Formula | Rounding | Rationale |
|-----------|---------|----------|-----------|
| **deposit** | `shares = convertToShares(assets)` | Floor | Favors vault |
| **mint** | `assets = convertToAssets(shares) + 1` | Ceiling | Protects depositor |
| **withdraw** | `shares = convertToShares(assets) + 1` | Ceiling | Favors vault |
| **redeem** | `assets = convertToAssets(shares)` | Floor | Favors vault |

Same rounding rules as SVS-1.

## SDK Usage

### Class: `ManagedVault`

Extends `SolanaVault` from `@stbr/solana-vault` with SVS-2-specific methods:

```typescript
import { ManagedVault } from '@stbr/solana-vault';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com');
const authority = Keypair.fromSecretKey(/* ... */);

// Load existing vault
const vaultPubkey = new PublicKey('3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD');
const vault = await ManagedVault.load(connection, vaultPubkey);

// Check stored vs actual balance
const storedBalance = await vault.storedTotalAssets();  // Reads vault.total_assets
const actualBalance = await vault.actualTotalAssets();  // Reads asset_vault.amount

console.log(`Stored: ${storedBalance}, Actual: ${actualBalance}`);

// Sync after yield accrual
if (actualBalance > storedBalance) {
  const tx = await vault.sync(authority.publicKey);
  await connection.sendTransaction(tx, [authority]);
  console.log('Synced: recognized yield');
}

// Deposit (same as SVS-1, but updates vault.total_assets arithmetically)
const depositTx = await vault.deposit(
  user.publicKey,
  BigInt(1_000_000_000),  // 1.0 asset tokens (9 decimals)
);
await connection.sendTransaction(depositTx, [user]);

// Preview functions (use cached total_assets)
const shares = await vault.previewDeposit(BigInt(1_000_000_000));
console.log(`Expected shares: ${shares}`);
```

### Key Methods

```typescript
class ManagedVault extends SolanaVault {
  // SVS-2 specific
  async sync(authority: PublicKey): Promise<Transaction>;
  async storedTotalAssets(): Promise<bigint>;  // vault.total_assets
  async actualTotalAssets(): Promise<bigint>;  // asset_vault.amount

  // Inherited from SolanaVault (same as SVS-1)
  async deposit(depositor: PublicKey, assets: bigint): Promise<Transaction>;
  async mint(depositor: PublicKey, shares: bigint): Promise<Transaction>;
  async withdraw(owner: PublicKey, assets: bigint): Promise<Transaction>;
  async redeem(owner: PublicKey, shares: bigint): Promise<Transaction>;
  async previewDeposit(assets: bigint): Promise<bigint>;
  // ... other preview/convert methods
}
```

## Trust Model & Security

### Authority Powers

| Power | Risk | Mitigation |
|-------|------|-----------|
| **Delayed sync** | Authority delays `sync()` to suppress yield, extracting value via deposits at stale (low) share price | Automated sync schedules, transparent on-chain monitoring |
| **Front-running sync** | Authority syncs yield just before their own deposit to capture value | Timelock between sync and authority deposits, multisig governance |
| **Arbitrary total_assets** | If `sync()` allowed arbitrary values, authority could manipulate share price | **Mitigated**: `sync()` only reads `asset_vault.amount` (no arbitrary input) |

### Sync Timing Attack

**Scenario**:
1. Vault has 1000 USDC in `asset_vault`, `total_assets = 1000`, `total_supply = 1000`
2. External strategy accrues 100 USDC yield (returned to `asset_vault`)
3. `asset_vault.amount = 1100`, but `vault.total_assets = 1000` (not synced yet)
4. User deposits 1000 USDC expecting ~909 shares (at true 1.1 asset/share ratio)
5. **Instead**: User receives 1000 shares (at stale 1.0 ratio) — overpaid by ~91 shares
6. Authority calls `sync()`, recognizing 100 USDC yield
7. Authority redeems their shares at new 1.05 ratio, extracting value

**Mitigations**:
- **Automated sync bots**: Trigger `sync()` immediately when `asset_vault.amount > vault.total_assets` detected
- **Timelock**: Require T blocks between `sync()` and authority deposits
- **Multisig authority**: Governance controls sync timing
- **Use SVS-1 for trustless vaults**: If assets never leave the vault ATA, use SVS-1 (live balance)
- **On-chain monitoring**: Alert users when `storedTotalAssets() << actualTotalAssets()` for extended periods

### When to Use SVS-1 vs SVS-2

| Use SVS-1 (Live Balance) | Use SVS-2 (Stored Balance) |
|--------------------------|----------------------------|
| Assets stay in vault ATA | Assets deployed to external protocols |
| Trustless, permissionless deposits desired | Managed fund with active strategy |
| Simple yield (SPL staking, internal fees) | Bridged assets, off-chain management |
| No authority intervention needed | Authority monitors/rebalances positions |

**Security principle**: Use SVS-1 by default. Only use SVS-2 when assets must leave the vault ATA.

## Deployment

### Devnet

| Item | Value |
|------|-------|
| **Program ID** | `3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD` |
| **Network** | Devnet |
| **SDK Package** | `@stbr/solana-vault` |
| **Class** | `ManagedVault` |

### Verification

```bash
# Verify program deployment
solana program show 3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD --url devnet

# Anchor verify (if verifiable build available)
anchor verify 3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD --provider.cluster devnet
```

### Integration Example

```typescript
import { ManagedVault } from '@stbr/solana-vault';
import { Connection, PublicKey } from '@solana/web3.js';

const DEVNET_PROGRAM_ID = new PublicKey('3UrYrxh1HmVgq7WPygZ5x1gNEaWFwqTMs7geNqMnsrtD');
const connection = new Connection('https://api.devnet.solana.com');

// Find vault PDA
const assetMint = new PublicKey('So11111111111111111111111111111111111111112'); // Wrapped SOL
const vaultId = BigInt(1);

const [vaultPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from('vault'),
    assetMint.toBuffer(),
    Buffer.from(new Uint8Array(new BigUint64Array([vaultId]).buffer)),
  ],
  DEVNET_PROGRAM_ID
);

const vault = await ManagedVault.load(connection, vaultPda);

// Check balance sync status
const stored = await vault.storedTotalAssets();
const actual = await vault.actualTotalAssets();

if (actual > stored) {
  console.warn(`Vault needs sync: ${actual - stored} assets unrecognized`);
}
```

---

**Next Steps**:
- Review SVS-1.md for comparison
- Test sync timing attack scenarios
- Implement automated sync monitoring
- Evaluate SVS-3 (Rate-Limited Balance) for additional security
