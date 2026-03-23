# SVS-3: Confidential Live Balance Vault

## Overview

SVS-3 extends SVS-1's live balance model with Token-2022 Confidential Transfers, encrypting share balances using ElGamal encryption. Zero-knowledge proofs validate operations without revealing amounts. Shares move through pending→available balance states, requiring explicit proof submission for withdrawals/redemptions.

## Privacy Model

**What's Hidden:**
- Individual share balances (encrypted with ElGamal)
- Deposit/mint amounts (pending balances)
- Withdraw/redeem amounts (with ZK proofs)

**What's Public:**
- Total vault assets (`asset_vault.amount`)
- Share price (calculable from asset_vault.amount / total_shares)
- Transaction existence (not amounts)
- Shares mint total supply

**Encryption:**
- ElGamal encryption on user's shares account
- User holds ElGamal secret key (derived from wallet keypair + token account)
- Optional auditor ElGamal pubkey for compliance
- Only secret key holder can decrypt balances

## Account Structure

### PDAs

| Account | Seeds | Purpose |
|---------|-------|---------|
| `ConfidentialVault` | `["vault", asset_mint, vault_id.to_le_bytes()]` | Vault state (246 bytes) |
| Shares Mint | `["shares", vault_pubkey]` | Token-2022 mint with ConfidentialTransfer extension |
| Asset Vault | `ATA(asset_mint, vault)` | Holds locked assets |

### ConfidentialVault Struct (246 bytes)

```rust
#[account]
pub struct ConfidentialVault {
    pub authority: Pubkey,                           // 32
    pub asset_mint: Pubkey,                          // 32
    pub shares_mint: Pubkey,                         // 32
    pub asset_vault: Pubkey,                         // 32
    pub decimals_offset: u8,                         // 1
    pub bump: u8,                                    // 1
    pub paused: bool,                                // 1
    pub vault_id: u64,                               // 8
    pub auditor_elgamal_pubkey: Option<[u8; 32]>,    // 33 (1 discriminator + 32 pubkey)
    pub confidential_authority: Pubkey,              // 32
    pub _reserved: [u8; 32],                         // 32
}
// Total: 246 bytes (+ 8-byte Anchor discriminator)
```

**Differences from SVS-1 `Vault`:**
- Different Anchor discriminator (`ConfidentialVault` vs `Vault` — not binary compatible)
- +33 bytes: `auditor_elgamal_pubkey` (optional compliance auditor)
- +32 bytes: `confidential_authority` (CT authority)
- Smaller `_reserved` (32 vs 64 bytes)

## Instructions

| Instruction | Signer | Description |
|-------------|--------|-------------|
| `initialize` | `authority` | Create ConfidentialVault + shares mint with CT extension |
| `deposit` | `user` | Deposit assets, shares go to **pending balance** |
| `mint` | `user` | Mint exact shares, shares go to **pending balance** |
| `withdraw` | `user` | Withdraw exact assets, requires equality + range proof contexts |
| `redeem` | `user` | Redeem shares for assets, requires equality + range proof contexts |
| `configure_account` | `user` | One-time setup: enable CT on user's shares account |
| `apply_pending` | `user` | Move shares from pending to available balance |
| `pause` | `authority` | Emergency pause |
| `unpause` | `authority` | Resume operations |
| `transfer_authority` | `authority` | Transfer vault authority |

### Modified Instruction Signatures

**withdraw/redeem** differ from SVS-1:

```rust
// SVS-1
pub fn withdraw(ctx: Context<Withdraw>, assets: u64, max_shares_in: u64) -> Result<()>

// SVS-3
pub fn withdraw(
    ctx: Context<ConfidentialWithdraw>,
    assets: u64,
    max_shares_in: u64,
    new_decryptable_available_balance: [u8; 36],  // AES-encrypted new balance
) -> Result<()>
// Context includes: equality_proof_context, range_proof_context
```

**configure_account**:

```rust
pub fn configure_account(
    ctx: Context<ConfigureAccount>,
    decryptable_zero_balance: [u8; 36],  // AES-encrypted zero
    proof_instruction_offset: i8,         // -1 = preceding instruction
) -> Result<()>
```

## Deposit Flow

```
1. configure_account (one-time setup)
   ├─ Generate ElGamal keypair from wallet + token account
   ├─ Create PubkeyValidityProof (64 bytes)
   ├─ Submit proof as preceding instruction
   └─ Call configure_account with decryptable_zero_balance

2. deposit
   ├─ Transfer assets from user to asset_vault
   ├─ Mint shares to user's shares account
   └─ Shares land in PENDING balance (not yet spendable)

3. apply_pending
   ├─ Calculate new_decryptable_available_balance client-side
   ├─ Call apply_pending with expected_pending_balance_credit_counter
   └─ Shares move to AVAILABLE balance
```

**Step-by-step:**

```typescript
import { ConfidentialSolanaVault } from '@stbr/svs-privacy-sdk';

// 1. Configure (one-time)
const { elgamalKeypair, aesKey } = await vault.configureAccount({ vault: vaultPda });

// 2. Deposit
await vault.deposit({ vault: vaultPda, assets: new BN(1_000_000), minSharesOut: new BN(0) });

// 3. Apply pending
await vault.applyPending({
  vault: vaultPda,
  newDecryptableAvailableBalance: computeNewBalance(aesKey, pendingAmount),
  expectedPendingBalanceCreditCounter: 1,
});
```

## Withdraw/Redeem Flow

```
1. Create ZK proofs (via backend or WASM)
   ├─ CiphertextCommitmentEqualityProof (192 bytes)
   └─ BatchedRangeProofU64 (672+ bytes)

2. Create proof context accounts
   ├─ Submit proofs to zk_elgamal_proof_program
   └─ Get context account pubkeys

3. Call withdraw/redeem
   ├─ Pass equality_proof_context + range_proof_context
   ├─ Program validates proof ownership (account.owner == zk_elgamal_proof_program)
   ├─ Burn shares, transfer assets
   └─ Update encrypted balance with new_decryptable_available_balance
```

**Step-by-step:**

```typescript
// 1-2. Create proof contexts
const { equalityProofContext, rangeProofContext } = await vault.createWithdrawProofContexts(
  elgamalKeypair, withdrawAmount, currentEncryptedBalance,
);

// 3. Withdraw
await vault.withdraw({
  vault: vaultPda,
  assets: withdrawAmount,
  maxSharesIn: expectedShares.mul(new BN(105)).div(new BN(100)),
  newDecryptableBalance: computeNewBalance(aesKey, currentBalance - withdrawAmount),
  equalityProofContext,
  rangeProofContext,
});
```

## View Functions

| Function | SVS-1 | SVS-3 | Reason |
|----------|-------|-------|--------|
| `total_assets` | `asset_vault.amount` | Same | Public data |
| `convert_to_shares` | Standard | Same | Share price is public |
| `convert_to_assets` | Standard | Same | Share price is public |
| `preview_deposit` | Standard | Same | Share price is public |
| `preview_mint` | Standard | Same | Share price is public |
| `preview_withdraw` | Standard | Same | Share price is public |
| `preview_redeem` | Standard | Same | Share price is public |
| `max_deposit` | `u64::MAX` | Same | No per-user limit |
| `max_mint` | `u64::MAX` | Same | No per-user limit |
| `max_withdraw` | **User's shares → assets** | **Vault's total assets** | Can't read encrypted balance |
| `max_redeem` | **User's share balance** | **`u64::MAX`** | Can't read encrypted balance |

**Context Difference:**
- SVS-1: `VaultView` + `VaultViewWithOwner` (includes `owner_shares_account`)
- SVS-3: `VaultView` only (no `VaultViewWithOwner` — encrypted balances unreadable on-chain)

## Proof System

### Proof Types

| Proof | Size | Purpose | When Used |
|-------|------|---------|-----------|
| **PubkeyValidityProof** | 64 bytes | Proves ElGamal pubkey is valid curve point | `configure_account` (one-time) |
| **CiphertextCommitmentEqualityProof** | 192 bytes | Proves encrypted amount matches Pedersen commitment | `withdraw`, `redeem` |
| **BatchedRangeProofU64** | 672+ bytes | Proves amount is within valid u64 range | `withdraw`, `redeem` |

### Proof Context Accounts

Created via `zk_elgamal_proof_program`, validated on-chain:

```rust
// Program validates proof ownership
require!(
    equality_proof_context.owner == &zk_elgamal_proof_program::id(),
    ErrorCode::InvalidProofContext
);
require!(
    range_proof_context.owner == &zk_elgamal_proof_program::id(),
    ErrorCode::InvalidProofContext
);
```

### Proof Generation Methods

**Option 1: Rust Backend** (production-ready)

```
proofs-backend/
├── POST /api/proofs/pubkey-validity   → 64 bytes
├── POST /api/proofs/equality          → 192 bytes
├── POST /api/proofs/range             → 672+ bytes
├── POST /api/proofs/withdraw          → 320 + 936 bytes (equality + range, shared Pedersen opening)
└── GET  /health
```

Auth: API key header + Ed25519 wallet signature, 5-min replay window.

```typescript
import { configureProofBackend, createPubkeyValidityProofViaBackend } from '@stbr/svs-privacy-sdk';

configureProofBackend({ url: 'http://localhost:3001', apiKey: 'your-key' });
const proof = await createPubkeyValidityProofViaBackend(elgamalKeypair, walletKeypair);
```

**Option 2: WASM Bindings** (expected mid-2026)

```typescript
import { initWasm, createPubkeyValidityProofWasm } from '@stbr/svs-privacy-sdk';
await initWasm();
const proof = createPubkeyValidityProofWasm(elgamalKeypair);
```

### Proof Instruction Offset

```rust
proof_instruction_offset: i8  // -1 = preceding instruction in same tx
```

For `configure_account`, the PubkeyValidityProof verification instruction must precede the configure instruction in the same transaction.

## SDK Usage

**Core SDK (`@stbr/solana-vault`) is INCOMPATIBLE with SVS-3.** Use `@stbr/svs-privacy-sdk`.

**Why Incompatible:**
1. Different account struct: `ConfidentialVault` vs `Vault` (different Anchor discriminator)
2. Different instruction signatures: withdraw/redeem require `new_decryptable_available_balance` + proof context accounts
3. Different view contexts: `VaultView` only (no `VaultViewWithOwner`)

```typescript
import { ConfidentialSolanaVault } from '@stbr/svs-privacy-sdk';
import { Connection, Keypair } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com');
const wallet = new Wallet(Keypair.fromSecretKey(/* ... */));
const idl = JSON.parse(fs.readFileSync('target/idl/svs_3.json', 'utf-8'));

const vault = new ConfidentialSolanaVault(connection, wallet, idl);

// Fetch vault state
const state = await vault.getVault(vaultPda);

// Preview operations (same math as SVS-1)
const shares = await vault.previewDeposit(vaultPda, new BN(1_000_000));
const assets = await vault.convertToAssets(vaultPda, shares);
```

## Security

### Proof Context Injection Prevention

Program validates that proof context accounts are owned by the ZK ElGamal proof program. Passing arbitrary accounts as "verified" proofs fails:

```rust
require!(
    proof_context.owner == &zk_elgamal_proof_program::id(),
    ErrorCode::InvalidProofContext
);
```

### Encrypted Balance Limitations

**Cannot enforce on-chain:**
- Per-user deposit/withdrawal limits (balance encrypted)
- Per-user max withdraw/redeem (returns vault-level bounds or `u64::MAX`)

**Client-side enforcement required** for user-specific limits.

### Auditor Key

```rust
pub auditor_elgamal_pubkey: Option<[u8; 32]>,
```

- If `Some`: Shares mint CT extension includes auditor, who can decrypt all balances
- If `None`: Full privacy, no compliance auditor
- Set at initialization, cannot be changed

### Inflation Attack Protection

Same virtual offset mechanism as SVS-1. Share price manipulation via donation attack is prevented by `offset = 10^(9 - asset_decimals)`.

## Deployment Status

| Network | Program ID | Status |
|---------|------------|--------|
| Localnet | `EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh` | ✅ Active |
| Devnet | `EcpnYtaCBrZ4p4uq7dDr55D3fL9nsxbCNqpyUREGpPkh` | ✅ Deployed |
| Mainnet | Not deployed | ⏳ Pending audit |

**Upgrade Authority:** `5fB4rwQTCd5GEyL17Ao7YR4juS6hDtSTkjrXMa7ZtY5x`

**Test Coverage:** 42 integration tests covering init, admin, views, CT deposit flow (configure_account → deposit → apply_pending), and CT withdraw/redeem flow (equality + range proofs via context state accounts).

---

---

## Proof Size Reference

| Proof Type | Size (bytes) | When Required |
|------------|--------------|---------------|
| PubkeyValidityProof | 64 | `configure_account` (one-time) |
| CiphertextCommitmentEqualityProof | 192 | `withdraw`, `redeem` |
| BatchedRangeProofU64 | 672+ | `withdraw`, `redeem` |
| **Total for withdraw/redeem** | **~864+** | Per operation |

### Context State Accounts

Range proof data exceeds single transaction size. Use context state accounts:

```typescript
// Transaction 1: Create context state account
const contextStatePda = await createContextStateAccount(proofData);

// Transaction 2: Use context in withdraw
await vault.withdraw({
  assets,
  equalityProofContext: contextStatePda,
  rangeProofContext: contextStatePda,
  // ...
});
```

**Lesson Learned (2026-03)**: Always split proof submission into separate transactions.

---

## Compute Units

| Instruction | Approximate CU |
|-------------|---------------|
| `configure_account` | ~80,000 |
| `apply_pending` | ~40,000 |
| `deposit` | ~150,000 |
| `withdraw` | ~180,000 |
| `redeem` | ~180,000 |

CT proof verification accounts for ~100k CU of withdraw/redeem cost.

---

## Error Codes

In addition to [core errors](ERRORS.md):

| Code | Name | Message |
|------|------|---------|
| 6020 | `InvalidProof` | Invalid zero-knowledge proof |
| 6021 | `ProofContextMismatch` | Proof context account mismatch |
| 6022 | `PendingBalanceNotEmpty` | Pending balance must be empty |
| 6023 | `ConfidentialTransferDisabled` | CT not enabled on account |

---

## Module Integration

SVS-3 supports module configuration via admin instructions. Build with `anchor build -- --features modules`.

**Note:** Module admin instructions (fee/cap/lock/access configuration) are available. Handler hook integration (automatic enforcement in deposit/withdraw) is pending due to confidential transfer proof complexity.

Available admin instructions:
- `initialize_fee_config`, `update_fee_config`
- `initialize_cap_config`, `update_cap_config`
- `initialize_lock_config`, `update_lock_config`
- `initialize_access_config`, `update_access_config`

See [specs-modules.md](specs-modules.md) for full specification.

---

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/svs-3/src/instructions/configure_account.rs` | CT setup |
| `programs/svs-3/src/instructions/apply_pending.rs` | Pending→available |
| `programs/svs-3/src/instructions/module_admin.rs` | Module admin (with `modules` feature) |
| `proofs-backend/src/` | ZK proof generation server |

---

**See Also:**
- [SVS-1.md](./SVS-1.md) — Base live balance model
- [SVS-4.md](./SVS-4.md) — SVS-3 + stored balance (sync)
- [PRIVACY.md](./PRIVACY.md) — Privacy model details
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant architecture
- [PATTERNS.md](./PATTERNS.md) — Implementation patterns
