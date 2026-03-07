# SVS-4: Confidential Stored Balance Vault

## Overview

SVS-4 combines the stored balance model from SVS-2 with the confidential transfer privacy features from SVS-3, creating the most feature-rich variant in the Solana Vault Standard. It maintains an authority-controlled `total_assets` field that is updated via `sync()`, while simultaneously encrypting share balances using Token-2022's Confidential Transfer extension. This enables private strategy vaults where the vault operator can adjust tracked assets while shareholders maintain encrypted positions.

## Relationship to Other Variants

| Feature | SVS-1 | SVS-2 | SVS-3 | SVS-4 |
|---------|-------|-------|-------|-------|
| **Balance Model** | Derived (vault ATA) | Stored (sync) | Derived (vault ATA) | **Stored (sync)** |
| **Privacy** | None | None | Confidential Transfers | **Confidential Transfers** |
| **total_assets field** | Unused | Active | Unused | **Active** |
| **sync() instruction** | ❌ | ✅ | ❌ | **✅** |
| **ZK Proofs** | ❌ | ❌ | ✅ | **✅** |
| **Trust Model** | Trustless | Authority (sync) | Trustless (encryption) | **Authority + Encryption** |

**SVS-4 = SVS-2 (stored balance) + SVS-3 (privacy)**

## Account Structure

Uses the same `ConfidentialVault` struct as SVS-3, but with **active** `total_assets` field:

```rust
#[account]
pub struct ConfidentialVault {
    pub authority: Pubkey,           // 32 bytes
    pub asset_mint: Pubkey,          // 32 bytes
    pub shares_mint: Pubkey,         // 32 bytes
    pub asset_vault: Pubkey,         // 32 bytes
    pub total_assets: u64,           // 8 bytes - ACTIVE (unlike SVS-3)
    pub decimals_offset: u8,         // 1 byte
    pub bump: u8,                    // 1 byte
    pub paused: bool,                // 1 byte
    pub vault_id: u64,               // 8 bytes
    pub auditor_elgamal_pubkey: Option<[u8; 32]>, // 33 bytes
    pub confidential_authority: Pubkey, // 32 bytes
    pub _reserved: [u8; 32],         // 32 bytes
}
// Total: 254 bytes
```

**Key Difference from SVS-3**: The `total_assets` field is **actively used** for share/asset conversions instead of deriving from `asset_vault.amount`.

**PDA Structure** (same as all variants):
- Vault: `["vault", asset_mint, vault_id.to_le_bytes()]`
- Shares Mint: `["shares", vault_pubkey]`
- Asset Vault: ATA of `asset_mint` for vault PDA

## Instructions

SVS-4 implements a **superset** of SVS-2 and SVS-3 instructions:

| Instruction | Source | Requires Proof | Authority-Only |
|-------------|--------|----------------|----------------|
| `initialize` | All variants | ❌ | ✅ |
| `deposit` | All variants | ✅ (CT proofs) | ❌ |
| `mint` | All variants | ✅ (CT proofs) | ❌ |
| `withdraw` | All variants | ✅ (CT proofs) | ❌ |
| `redeem` | All variants | ✅ (CT proofs) | ❌ |
| `configure_account` | SVS-3/SVS-4 | ❌ | ❌ |
| `apply_pending` | SVS-3/SVS-4 | ❌ | ❌ |
| `sync` | **SVS-2/SVS-4** | ❌ | **✅** |
| `pause` | All variants | ❌ | ✅ |
| `unpause` | All variants | ❌ | ✅ |
| `transfer_authority` | All variants | ❌ | ✅ |

**Proof Contexts Required** (same as SVS-3):
- `deposit`/`mint`: TransferProofContext (sender balance encryption)
- `withdraw`/`redeem`: WithdrawProofContext (owner balance decryption)

## sync() + Privacy Interaction

The `sync()` instruction updates `vault.total_assets` while encrypted share balances remain unchanged:

```rust
pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let asset_vault = &ctx.accounts.asset_vault;

    // Update stored total_assets from actual vault ATA balance
    vault.total_assets = asset_vault.amount;
    Ok(())
}
```

**Privacy Implications**:
- Share balances remain encrypted via ElGamal
- Total asset changes are **public** (visible in `vault.total_assets`)
- Individual shareholder positions stay private
- Share price changes are observable but not attributable

**Use Case**: Vault operator rebalances strategy positions off-chain, then calls `sync()` to update vault accounting while preserving shareholder privacy.

## Deposit/Withdraw Flow

### Deposit Flow
```
1. User configures confidential transfer on shares token account
2. User creates deposit ZK proof context (TransferProofContext)
3. deposit(assets) instruction:
   - Transfer assets to vault ATA (public)
   - Calculate shares = (assets * total_shares) / vault.total_assets
   - Mint shares with encrypted amount (ElGamal)
   - Update vault.total_assets += assets (stored balance)
4. User calls apply_pending to finalize encrypted balance
```

### Withdraw Flow
```
1. User creates withdraw ZK proof context (WithdrawProofContext)
2. withdraw(assets) instruction:
   - Calculate shares = (assets * total_shares) / vault.total_assets
   - Burn encrypted shares (with proof)
   - Transfer assets from vault ATA
   - Update vault.total_assets -= assets (stored balance)
3. Encrypted balance updated automatically
```

**Math Source**: Uses `vault.total_assets` (stored) instead of `asset_vault.amount` (derived).

## View Functions

Same as SVS-3, but reads from stored `total_assets`:

```typescript
interface VaultView {
  totalAssets: bigint;      // vault.total_assets (stored)
  totalShares: bigint;      // shares_mint.supply
  convertToShares(assets: bigint): bigint;
  convertToAssets(shares: bigint): bigint;
  previewDeposit(assets: bigint): bigint;
  previewMint(shares: bigint): bigint;
  previewWithdraw(assets: bigint): bigint;
  previewRedeem(shares: bigint): bigint;
  maxDeposit(): bigint;     // vault.total_assets
  maxMint(): bigint;        // u64::MAX
  maxWithdraw(): bigint;    // vault.total_assets
  maxRedeem(): bigint;      // u64::MAX
}
```

**No per-user max functions** due to encrypted balances (same limitation as SVS-3).

## Trust Model

SVS-4 requires trust in **two** dimensions:

### 1. Sync Authority (from SVS-2)
- Authority can call `sync()` to update `total_assets`
- Can manipulate share price by setting arbitrary values
- Shareholders must trust authority to sync accurately

### 2. Encryption Privacy (from SVS-3)
- Share balances encrypted with ElGamal
- Privacy depends on ElGamal key security
- Optional auditor can decrypt with auditor key

**Combined Risk**:
- Authority manipulation invisible to individual shareholders (encrypted balances)
- Shareholders cannot easily verify sync accuracy without decrypting positions
- Most suitable for institutional/permissioned use cases with trusted operators

## SDK Status

**Current**: SDK wrapper for SVS-4 **not yet implemented**.

**Planned Architecture**:
```typescript
class ConfidentialStoredBalanceVault extends ConfidentialSolanaVault {
  // Inherits all SVS-3 confidential transfer methods

  // Additional method from SVS-2:
  async sync(): Promise<TransactionSignature> {
    // Authority-only sync call
  }

  // Override totalAssets to read from stored field
  async totalAssets(): Promise<bigint> {
    return this.vault.totalAssets; // stored, not derived
  }
}
```

**Workaround**: Use SVS-3 SDK with manual `sync()` instruction building.

## Security Considerations

### Sync Timing Attacks
- Authority can delay sync to manipulate share price
- Depositors/withdrawers exposed to stale `total_assets`
- **Mitigation**: Require regular sync schedule, monitor vault state changes

### Proof Injection (same as SVS-3)
- Malicious proof contexts can break accounting
- **Mitigation**: Same as SVS-3 — validate proof account ownership, use recent context accounts

### Combined Attack Vectors
1. **Silent Rug**: Authority syncs to zero, drains vault, shareholders unaware (encrypted)
2. **Price Manipulation**: Sync to inflate/deflate share price before large deposits/withdrawals
3. **Selective Processing**: Authority delays sync for specific users based on observable proof timing

**Defense**: Only use SVS-4 with trusted authorities in permissioned environments.

### Privacy Leakage
- `sync()` events reveal total asset changes (public)
- Correlating sync timing with encrypted transfer events may reveal strategy changes
- **Mitigation**: Batch sync with multiple operations, randomize timing

## Deployment Status

| Network | Program ID | Status |
|---------|------------|--------|
| Localnet | `2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY` | ✅ Active |
| Devnet | `2WP7LXWqrp1W4CwEJuVt2SxWPNY2n6AYmijh6Z4EeidY` | ✅ Deployed |
| Mainnet | Not deployed | ⏳ Pending audit |

**Upgrade Authority:** `5fB4rwQTCd5GEyL17Ao7YR4juS6hDtSTkjrXMa7ZtY5x`

**Test Coverage:** 43 integration tests covering init, admin, views, sync, CT deposit+sync flow (donation → sync → share price increase → second deposit), and CT withdraw/redeem flow with stored balance updates.

**SDK Package**: Not yet published. Use SVS-3 SDK + manual `sync()` calls.

---

---

## Trust Model Analysis

### What Authority Can Do

| Action | Impact | Visibility |
|--------|--------|------------|
| Delay `sync()` | Suppress yield recognition | Observable (balance mismatch) |
| Front-run `sync()` | Capture yield before others | Detectable via tx ordering |
| Sync to wrong value | Not possible (reads actual balance) | N/A |
| Read user balances | Only with auditor key | Depends on configuration |

### What Authority Cannot Do

| Action | Why |
|--------|-----|
| Set arbitrary `total_assets` | `sync()` reads `asset_vault.amount` directly |
| Decrypt user balances | Requires user's ElGamal secret key |
| Transfer user shares | Requires user signature |
| Bypass proof verification | Proofs validated on-chain |

### Recommended Use Cases

| Use Case | Appropriate | Notes |
|----------|-------------|-------|
| Institutional fund | ✅ Yes | Trusted operator, compliance auditor |
| Public DeFi vault | ❌ No | Use SVS-1 or SVS-3 |
| Permissioned strategy | ✅ Yes | KYC'd participants, managed deployment |
| Anonymous deposits | ❌ No | Privacy + sync = trust conflict |

---

## SDK Implementation Status

**Current Status**: Not implemented

**Workaround**:
```typescript
import { ConfidentialSolanaVault } from '@stbr/svs-privacy-sdk';
import { Program } from '@coral-xyz/anchor';

// Use SVS-3 SDK
const vault = new ConfidentialSolanaVault(connection, wallet, idl);

// Manual sync instruction
async function syncVault(program: Program, vaultPda: PublicKey, authority: Keypair) {
  await program.methods
    .sync()
    .accounts({
      vault: vaultPda,
      assetVault: await getAssetVault(vaultPda),
      authority: authority.publicKey,
    })
    .signers([authority])
    .rpc();
}
```

**Planned SDK**: Q2 2026 - Will extend `ConfidentialSolanaVault` with `sync()` method.

---

## Error Codes

Combines [SVS-2 errors](SVS-2.md#error-codes) and [SVS-3 errors](SVS-3.md#error-codes).

---

## Compute Units

| Instruction | Approximate CU |
|-------------|---------------|
| `sync` | ~8,000 |
| `deposit` | ~155,000 |
| `withdraw` | ~185,000 |
| Others | See SVS-3 |

---

## Limitation: Cannot Use in SVS-9 Allocator

SVS-4 vaults **cannot** be used as child vaults in SVS-9 (Allocator) because:
1. Encrypted balances prevent `total_assets` calculation across children
2. Allocator needs to read child vault balances

---

## Module Integration

SVS-4 supports module configuration via admin instructions. Build with `anchor build -- --features modules`.

**Note:** Same as SVS-3 — module admin instructions are available, handler hook integration pending due to confidential transfer complexity.

See [SVS-3.md#module-integration](SVS-3.md#module-integration) for details and [specs-modules.md](specs-modules.md) for full specification.

---

**See Also**:
- [SVS-2.md](./SVS-2.md) — Stored balance model and sync() details
- [SVS-3.md](./SVS-3.md) — Confidential transfer implementation and ZK proof handling
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Feature matrix across all variants
- [PATTERNS.md](./PATTERNS.md) — Implementation patterns
- [ERRORS.md](./ERRORS.md) — Error code reference
