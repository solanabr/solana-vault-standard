# SVS-6: Confidential Streaming Yield Vault

## Overview

SVS-6 is the confidential variant of SVS-5. It combines time-interpolated streaming yield with Token-2022 Confidential Transfers, encrypting individual share balances using ElGamal encryption. Zero-knowledge proofs validate withdrawal and redemption operations without revealing amounts on-chain. The streaming yield math operates on public aggregate state stored in plaintext on the vault PDA, while per-user positions remain private.

This vault type is suited for privacy-sensitive payroll vaults, confidential vesting schedules, and institutional yield products where smooth, MEV-resistant share price appreciation must coexist with encrypted user positions.

## Relationship to Other Variants

```
                    Public          Confidential
                    ──────          ────────────
Live Balance        SVS-1           SVS-4
Stored (Sync)       SVS-2           SVS-3
Streaming           SVS-5           SVS-6  ←
```

SVS-6 = SVS-5 streaming math + SVS-3 confidential transfer mechanics. Understanding SVS-5 and SVS-3 in isolation before reading this document is strongly recommended.

## Privacy Model

**What is hidden:**
- Individual share balances (ElGamal-encrypted on each user's shares token account)
- Deposit and mint amounts moving into pending balance
- Withdraw and redeem amounts (validated only through ZK proofs)

**What is public:**
- Total vault assets (`asset_vault.amount` — a standard SPL token account)
- `shares_mint.supply` (plaintext aggregate, not individual positions)
- Share price, calculable from `effective_total_assets(now)` and `shares_mint.supply`
- Streaming state: `base_assets`, `stream_amount`, `stream_start`, `stream_end`
- Transaction existence (not amounts)

**Why shares supply is public**: Token-2022 CT encrypts individual account balances, not the mint's total supply. `shares_mint.supply` is always accurate and readable on-chain, same as SVS-5.

**Encryption**: ElGamal encryption on each user's shares token account. The user derives their ElGamal keypair from their wallet keypair and the token account address. An optional auditor ElGamal public key can be configured at initialization for regulatory compliance; if set, the auditor can decrypt all user balances.

## Balance Model

| Aspect | SVS-1 (Live) | SVS-2 (Stored) | SVS-3 (CT Live) | SVS-5 (Streaming) | SVS-6 (CT Streaming) |
|--------|-------------|----------------|-----------------|-------------------|----------------------|
| **total_assets source** | `asset_vault.amount` | `vault.total_assets` | `asset_vault.amount` | `effective_total_assets(now)` | `effective_total_assets(now)` |
| **Share balances** | Plaintext | Plaintext | Encrypted (ElGamal) | Plaintext | Encrypted (ElGamal) |
| **total_shares source** | Mint supply | Mint supply | Mint supply | Mint supply | Mint supply |
| **Yield distribution** | Instant | Discrete (`sync()`) | Instant | Continuous (linear) | Continuous (linear) |
| **MEV risk** | None | Front-run `sync()` window | None | None | None |
| **Withdraw requires ZK proof** | No | No | Yes | No | Yes |
| **Use case** | Simple vaults | Strategy vaults | Privacy vaults | Payroll, vesting | Confidential payroll, institutional |

## Account Structure

### PDAs

| Account | Seeds | Purpose |
|---------|-------|---------|
| **ConfidentialStreamVault** | `["confidential_stream_vault", asset_mint, vault_id.to_le_bytes()]` | Vault state (318 bytes) |
| **Shares Mint** | `["shares", vault_pubkey]` | Token-2022 mint with `ConfidentialTransferMint` extension |
| **Asset Vault** | ATA of (asset_mint, ConfidentialStreamVault PDA) | Holds locked assets + unstreamed yield |

The vault PDA is also set as `confidential_authority` on the shares mint during initialization, enabling it to sign CT operations via CPI.

### State: `ConfidentialStreamVault` Account (318 bytes)

```rust
#[account]
pub struct ConfidentialStreamVault {
    // ── Core vault fields ──
    pub authority: Pubkey,                         // 32 bytes — vault admin
    pub asset_mint: Pubkey,                        // 32 bytes — underlying asset
    pub shares_mint: Pubkey,                       // 32 bytes — LP token mint (CT-enabled)
    pub asset_vault: Pubkey,                       // 32 bytes — asset token account
    pub decimals_offset: u8,                       // 1 byte   — virtual offset exponent
    pub bump: u8,                                  // 1 byte   — PDA bump seed
    pub paused: bool,                              // 1 byte   — emergency pause flag
    pub vault_id: u64,                             // 8 bytes  — unique vault identifier

    // ── Streaming fields (from SVS-5) ──
    pub base_assets: u64,                          // 8 bytes  — assets at last checkpoint
    pub stream_amount: u64,                        // 8 bytes  — yield in current stream period
    pub stream_start: i64,                         // 8 bytes  — unix timestamp: stream begin
    pub stream_end: i64,                           // 8 bytes  — unix timestamp: stream end
    pub last_checkpoint: i64,                      // 8 bytes  — unix timestamp: last checkpoint

    // ── Confidential fields (from SVS-3) ──
    pub auditor_elgamal_pubkey: Option<[u8; 32]>,  // 33 bytes — optional compliance auditor
    pub confidential_authority: Pubkey,             // 32 bytes — CT authority (vault PDA)

    pub _reserved: [u8; 64],                        // 64 bytes — future upgrades
}
// Seeds: ["confidential_stream_vault", asset_mint, vault_id.to_le_bytes()]
// Total: 318 bytes (318 data + 8-byte Anchor discriminator)
```

**Key differences from SVS-5 `StreamVault`:**
- Reads `shares_mint.supply` directly (same as SVS-5, CT does not hide mint supply)
- `auditor_elgamal_pubkey` — optional compliance auditor who can decrypt all share balances
- `confidential_authority` — set to the vault PDA; authorizes CT inner operations
- `_reserved` kept at 64 bytes (matching SVS-5) for upgrade headroom

**Size comparison:**

| Variant | Account Size | Key Addition |
|---------|--------------|--------------|
| SVS-1 `Vault` | 219 bytes | Base |
| SVS-3 `ConfidentialVault` | 246 bytes | +CT fields |
| SVS-5 `StreamVault` | 251 bytes | +streaming fields |
| SVS-6 `ConfidentialStreamVault` | 318 bytes | +CT + streaming |

## Instructions

### Core Instructions

| # | Instruction | Signer | Description |
|---|-------------|--------|-------------|
| 1 | `initialize` | `authority` | Create `ConfidentialStreamVault`, CT-enabled shares mint, and asset vault ATA |
| 2 | `configure_account` | `user` | One-time CT setup on user's shares token account; requires `PubkeyValidityProof` in preceding instruction |
| 3 | `deposit` | `user` | Transfer assets, mint shares to pending CT balance at `effective_total_assets(now)` |
| 4 | `mint` | `user` | Mint exact shares, transfer required assets, shares land in pending CT balance |
| 5 | `apply_pending` | `user` | Promote shares from pending to available CT balance |
| 6 | `withdraw` | `user` | Withdraw exact assets; CT inner_withdraw + burn shares; requires equality + range proof contexts |
| 7 | `redeem` | `user` | Redeem exact shares for assets; CT inner_withdraw + burn; requires equality + range proof contexts |
| 8 | `distribute_yield` | `authority` | Transfer yield tokens, start new stream; auto-checkpoints any active stream |
| 9 | `checkpoint` | permissionless | Materialize accrued yield into `base_assets` |
| 10 | `pause` | `authority` | Set `paused = true`; blocks all financial instructions |
| 11 | `unpause` | `authority` | Set `paused = false` |
| 12 | `transfer_authority` | `authority` | Transfer vault admin rights to a new pubkey |

### View Instructions (Read-only)

| View | Returns | Note |
|------|---------|------|
| `total_assets` | `u64` | Returns `effective_total_assets(now)` |
| `convert_to_shares` | `u64` | Uses `effective_total_assets(now)` and `shares_mint.supply` |
| `convert_to_assets` | `u64` | Uses `effective_total_assets(now)` and `shares_mint.supply` |
| `preview_deposit` | `u64` | Shares for given assets at current stream state |
| `preview_mint` | `u64` | Assets required for given shares at current stream state |
| `preview_withdraw` | `u64` | Shares burned for given assets at current stream state |
| `preview_redeem` | `u64` | Assets returned for given shares at current stream state |
| `max_deposit` | `u64::MAX` | No per-user limit enforceable on-chain |
| `max_mint` | `u64::MAX` | No per-user limit enforceable on-chain |
| `max_withdraw` | `0` | Encrypted balance unreadable on-chain; SDK handles preview client-side |
| `max_redeem` | `0` | Encrypted balance unreadable on-chain; SDK handles preview client-side |
| `get_stream_info` | `StreamInfo` | `base_assets`, `stream_amount`, `stream_start`, `stream_end`, `effective_total`, `last_checkpoint` |

### Modified Instruction Signatures

`withdraw` and `redeem` carry additional parameters versus SVS-5:

```rust
// SVS-5
pub fn withdraw(ctx: Context<Withdraw>, assets: u64, max_shares_in: u64) -> Result<()>

// SVS-6
pub fn withdraw(
    ctx: Context<Withdraw>,
    assets: u64,
    max_shares_in: u64,
    new_decryptable_available_balance: [u8; 36],  // AES-encrypted updated balance
) -> Result<()>
// Context includes: equality_proof_context, range_proof_context
```

`configure_account` matches SVS-3:

```rust
pub fn configure_account(
    ctx: Context<ConfigureAccount>,
    decryptable_zero_balance: [u8; 36],  // AES-encrypted zero
    proof_instruction_offset: i8,         // -1 = preceding instruction in same tx
) -> Result<()>
```

## Streaming Yield + Confidential Transfer Interaction

The streaming model and CT operate on different layers and do not interfere:

**Streaming math uses public aggregates.** `base_assets`, `stream_amount`, `stream_start`, and `stream_end` are stored in plaintext on the vault PDA. `effective_total_assets(now)` is computed from these fields at transaction time, exactly as in SVS-5.

**Individual balances are encrypted.** The vault reads `shares_mint.supply` for the aggregate but cannot read any individual user's share count on-chain.

**Share conversion is computed in plaintext, applied as CT.** When a user deposits, the program computes `shares = convertToShares(assets, effective_total_assets(now))` using plaintext arithmetic, then mints that integer quantity to the user's CT pending balance. The CT layer encrypts the balance at rest; the conversion math itself is not confidential.

```
effective_total_assets(now) = base_assets + accrued_stream_yield(now)

accrued_stream_yield(now) = stream_amount * elapsed / duration   (floor)

where elapsed = min(now - stream_start, duration)
```

This matches SVS-5 exactly. No CT involvement in the yield calculation.

**Total shares.** SVS-6 reads `shares_mint.supply` directly, same as SVS-5. Token-2022 CT encrypts individual account balances but does not hide the mint's total supply.

**`max_withdraw` and `max_redeem` return 0.** The on-chain program cannot decrypt a user's ElGamal-encrypted balance to compute their maximum withdrawal. The SDK resolves this client-side by decrypting the user's available balance using their AES key, then computing the equivalent asset amount using `convertToAssets`.

## Deposit Flow

```
1. configure_account (one-time setup per user)
   ├─ Derive ElGamal keypair from wallet + token account address
   ├─ Create PubkeyValidityProof (64 bytes)
   ├─ Submit proof as preceding instruction in same tx
   └─ Call configure_account with decryptable_zero_balance = AES(0)

2. deposit
   ├─ Compute shares = convertToShares(assets, effective_total_assets(now))
   ├─ Transfer assets from user to asset_vault
   ├─ Mint shares to user's shares account
   ├─ Shares land in PENDING balance (not yet spendable)
   ├─ vault.base_assets += assets
   └─ shares_mint.supply updated by mint CPI

3. apply_pending
   ├─ Compute new_decryptable_available_balance client-side
   ├─ Call apply_pending with expected_pending_balance_credit_counter
   └─ Shares move from pending to AVAILABLE balance
```

## Two-Transaction Withdraw Pattern

ZK proof data for withdrawal exceeds the 1232-byte Solana transaction size limit. Confidential withdrawals require two separate transactions.

### Transaction 1: Create Proof Context State Accounts

```typescript
import { createContextStateAccount } from '@stbr/svs-privacy-sdk';

// Generate proofs via the Rust proof backend
const { equalityProof, rangeProof } = await generateWithdrawProofs(
  elgamalKeypair,
  currentEncryptedBalance,
  withdrawAmount,
);

// Equality proof context
const [equalityContextPda] = await createContextStateAccount(
  connection,
  equalityProof,
  'ciphertext_commitment_equality',
  payer,
);

// Range proof context
const [rangeContextPda] = await createContextStateAccount(
  connection,
  rangeProof,
  'batched_range_proof_u64',
  payer,
);
```

### Transaction 2: Execute Withdraw with Proof Contexts

```typescript
// checkpoint() immediately before withdraw: finalizes yield accrued to this block
const withdrawTx = new Transaction()
  .add(await vault.checkpoint())
  .add(await vault.confidentialWithdraw({
    assets: withdrawAmount,
    maxSharesIn: expectedShares.mul(new BN(105)).div(new BN(100)),
    newDecryptableAvailableBalance: computeNewBalance(aesKey, currentBalance - withdrawAmount),
    equalityProofContext: equalityContextPda,
    rangeProofContext: rangeContextPda,
  }));

await sendTransaction(withdrawTx, [owner]);
```

### Transaction 3 (Optional): Recover Rent

```typescript
// Close proof context state accounts to reclaim rent
const closeTx = new Transaction()
  .add(closeContextStateAccount(equalityContextPda, payer))
  .add(closeContextStateAccount(rangeContextPda, payer));

await sendTransaction(closeTx, [payer]);
```

### Why `checkpoint()` Immediately Before `withdraw`

The streaming share price changes every second. If you generate ZK proofs at timestamp T1 encoding a specific share amount, but the withdraw instruction executes at T2, `effective_total_assets` has changed and the share-to-asset ratio no longer matches the proofs. Calling `checkpoint()` as the first instruction in the withdraw transaction:

1. Finalizes accrued yield up to the current block timestamp
2. Resets `stream_start` to now and reduces `stream_amount` by the accrued portion
3. Ensures the withdraw instruction computes shares against the post-checkpoint `base_assets`
4. Eliminates any drift between proof generation time and execution time when the checkpoint and withdraw are batched in the same transaction

This is the recommended pattern for all withdraw and redeem operations in SVS-6.

### Withdraw Logic (On-Chain)

The withdraw instruction performs three steps in sequence:

```
1. Auto-checkpoint (accrue streaming yield)
2. CT inner_withdraw: move `shares` from encrypted → non-confidential balance
   (validated by equality_proof_context and range_proof_context)
3. Burn shares from non-confidential balance
4. Transfer assets from asset_vault to user
5. vault.base_assets -= net_assets
   shares_mint.supply updated by burn CPI
```

The program validates that both proof context accounts are owned by `zk_elgamal_proof_program`:

```rust
constraint = equality_proof_context.owner == &solana_zk_sdk::zk_elgamal_proof_program::id()
    @ VaultError::InvalidProof
constraint = range_proof_context.owner == &solana_zk_sdk::zk_elgamal_proof_program::id()
    @ VaultError::InvalidProof
```

## Proof System

### Proof Types

| Proof | Size | Purpose | When Used |
|-------|------|---------|-----------|
| **PubkeyValidityProof** | 64 bytes | Proves ElGamal pubkey is a valid curve point | `configure_account` (one-time) |
| **CiphertextCommitmentEqualityProof** | 192 bytes | Proves encrypted share amount matches Pedersen commitment | `withdraw`, `redeem` |
| **BatchedRangeProofU64** | 672+ bytes | Proves amount is within valid u64 range | `withdraw`, `redeem` |
| **Total per withdraw/redeem** | ~928+ bytes | — | Per operation |

Range proof size scales with batch size. Single-value range proof = 672 bytes. Multi-value batches increase proportionally up to 8 amounts.

### Proof Generation

**Option 1: Rust Backend** (production-ready)

```
proofs-backend/
├── POST /api/proofs/pubkey-validity   → 64 bytes
├── POST /api/proofs/equality          → 192 bytes
├── POST /api/proofs/range             → 672+ bytes
├── POST /api/proofs/withdraw          → equality + range with shared Pedersen opening
└── GET  /health
```

Auth: API key header + Ed25519 wallet signature, 5-minute replay window.

```typescript
import { configureProofBackend } from '@stbr/svs-privacy-sdk';

configureProofBackend({ url: 'http://localhost:3001', apiKey: 'your-key' });
const { equalityProof, rangeProof } = await generateWithdrawProofsViaBackend(
  elgamalKeypair,
  walletKeypair,
  currentEncryptedBalance,
  withdrawAmount,
);
```

**Option 2: WASM Bindings** (expected mid-2026)

```typescript
import { initWasm, generateWithdrawProofsWasm } from '@stbr/svs-privacy-sdk';
await initWasm();
const { equalityProof, rangeProof } = generateWithdrawProofsWasm(
  elgamalKeypair,
  currentEncryptedBalance,
  withdrawAmount,
);
```

Deposit and mint do not require ZK proofs. Minting encrypted tokens requires only the recipient's ElGamal public key, which is stored on the configured token account.

## SDK Usage

`@stbr/solana-vault` (core SDK) is not compatible with SVS-6. Use `@stbr/svs-privacy-sdk`.

**Why incompatible:**
1. Different account struct: `ConfidentialStreamVault` vs `Vault` or `StreamVault` (different Anchor discriminators)
2. `withdraw`/`redeem` require `new_decryptable_available_balance` and proof context accounts
3. View context: `VaultView` only — no `VaultViewWithOwner` (encrypted balances unreadable on-chain)
4. `shares_mint.supply` read directly (same as SVS-5)

```typescript
import { ConfidentialStreamVault } from '@stbr/svs-privacy-sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

const connection = new Connection('https://api.devnet.solana.com');
const wallet = new Wallet(Keypair.fromSecretKey(/* ... */));
const idl = JSON.parse(fs.readFileSync('target/idl/svs_6.json', 'utf-8'));

const vault = new ConfidentialStreamVault(connection, wallet, idl);

// Derive vault PDA
const assetMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC
const vaultId = BigInt(1);
const [vaultPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from('confidential_stream_vault'),
    assetMint.toBuffer(),
    Buffer.from(new Uint8Array(new BigUint64Array([vaultId]).buffer)),
  ],
  new PublicKey('2w7aL5ZrD2i9RpzQBGSPAg7s61wVc8Qs8gtuQUTojEDE'),
);

// One-time: configure CT on user shares account
const { elgamalKeypair, aesKey } = await vault.configureAccount({ vault: vaultPda });

// Deposit
await vault.deposit({ vault: vaultPda, assets: new BN(1_000_000), minSharesOut: new BN(0) });

// Apply pending balance
await vault.applyPending({
  vault: vaultPda,
  newDecryptableAvailableBalance: computeNewBalance(aesKey, pendingAmount),
  expectedPendingBalanceCreditCounter: 1,
});

// Read streaming state (public)
const info = await vault.getStreamInfo(vaultPda);
console.log(`effective total: ${info.effectiveTotal}`);
console.log(`stream ends:     ${new Date(Number(info.streamEnd) * 1000).toISOString()}`);

// Preview withdraw using decrypted balance
const encryptedBalance = await vault.getEncryptedBalance(vaultPda, wallet.publicKey);
const decryptedShares = vault.decryptBalance(encryptedBalance, aesKey);
const maxAssets = await vault.previewRedeem(vaultPda, decryptedShares);
```

## Math

### Virtual Offset

```rust
offset = 10^decimals_offset
decimals_offset = 9 - asset_decimals  // Ensures 9-decimal precision
```

### Conversion

Identical to SVS-5:

```rust
// Assets → Shares (floor)
shares = (assets * (shares_mint.supply + offset)) / (effective_total_assets(now) + 1)

// Shares → Assets (floor)
assets = (shares * (effective_total_assets(now) + 1)) / (shares_mint.supply + offset)
```

### Rounding

| Operation | Rounding | Rationale |
|-----------|----------|-----------|
| **deposit** | Floor shares | Favors vault |
| **mint** | Ceiling assets (`+1`) | Favors vault |
| **withdraw** | Ceiling shares (`+1`) | Favors vault |
| **redeem** | Floor assets | Favors vault |

`accrued_stream_yield` is always floored, protecting existing shareholders from rounding-based dilution.

## Compute Unit Budget

| Instruction | Approximate CU | Notes |
|-------------|---------------|-------|
| `initialize` | ~30,000 | Create vault + CT-enabled shares mint + asset vault |
| `configure_account` | ~80,000 | `PubkeyValidityProof` verification (~25k CU) |
| `deposit` | ~50,000 | Streaming math (~200 CU) + CT mint to pending |
| `mint` | ~50,000 | Streaming math + CT mint to pending |
| `apply_pending` | ~40,000 | CT balance finalization |
| `withdraw` | ~185,000 | Auto-checkpoint + equality proof (~50k CU) + range proof (~80k CU) + burn + transfer |
| `redeem` | ~185,000 | Same breakdown as withdraw |
| `distribute_yield` | ~25,000 | +~8,000 if auto-checkpoint fires on an active stream |
| `checkpoint` | ~8,000 | State update only |
| `pause` / `unpause` | ~5,000 | Single field write |
| `transfer_authority` | ~5,000 | Single field write |

Withdraw and redeem approach the 200,000 CU default limit. When modules are enabled, set a higher budget explicitly:

```typescript
.preInstructions([
  ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
])
```

## Module Compatibility

Build with `anchor build -- --features modules`. Same caveats as SVS-3: module admin instructions are available; handler hook integration into the CT instruction path requires additional ZK proof complexity and is not fully implemented.

| Module | SVS-6 Behavior |
|--------|----------------|
| **svs-fees** | Entry/exit fees computed on plaintext asset amounts before CT application; fee shares minted to fee_recipient's CT or non-CT balance depending on configuration |
| **svs-caps** | Global cap checked against `shares_mint.supply * share_price` (plaintext). Per-user cap requires user to provide a decrypted balance proof or a plaintext `UserDeposit` tracking PDA |
| **svs-locks** | `ShareLock` PDA stores plaintext lock timestamps; CT does not affect lockup checks |
| **svs-rewards** | Reward claims are in a separate token; no CT interaction |
| **svs-access** | Identity-based checks; fully compatible without modification |

Available module admin instructions (with `--features modules`):
- `initialize_fee_config`, `update_fee_config`
- `initialize_cap_config`, `update_cap_config`
- `initialize_lock_config`, `update_lock_config`
- `initialize_access_config`, `update_access_config`

See [specs-modules.md](specs-modules.md) for full specification.

## Security Considerations

### Proof Context Injection

Program validates that both proof context accounts are owned by the ZK ElGamal proof program before any CT inner_withdraw. Passing an arbitrary account as a "verified" proof causes the instruction to fail with `InvalidProof`:

```rust
require!(
    proof_context.owner == &solana_zk_sdk::zk_elgamal_proof_program::id(),
    VaultError::InvalidProof
);
```

### Share Supply

SVS-6 reads `shares_mint.supply` directly from the Token-2022 mint account, same as SVS-5. CT does not hide the mint's total supply — only individual account balances are encrypted.

### Partial Privacy

Asset amounts in deposit and withdraw are public — SPL token transfers on the asset side are fully visible on-chain. Only share balances are confidential. An observer can determine:
- That a user deposited or withdrew a specific asset amount
- The vault's total assets and total shares at any point
- The current share price

They cannot determine an individual user's share position without the user's AES key.

### Auditor Key is Immutable

`auditor_elgamal_pubkey` is set at initialization and cannot be changed. Choosing whether to configure an auditor is a one-time, irreversible decision. If `Some`, the auditor can decrypt all user balances on the shares mint. If `None`, full privacy applies to all positions.

### Clock Manipulation

Same exposure as SVS-5. `Clock::unix_timestamp` can drift ±1–2 seconds at the validator level. For streams measured in hours or days this is sub-0.01% error. The minimum stream duration of 60 seconds ensures clock jitter stays below 3% of the stream period in the worst case.

### Encrypted Balance Limitations

The following cannot be enforced on-chain and require client-side handling or alternative mechanisms:
- Per-user deposit/withdrawal limits (balance encrypted)
- `max_withdraw` and `max_redeem` — always return 0 from on-chain view functions

### Inflation Attack Protection

Same virtual offset mechanism as SVS-1 through SVS-5. Share price manipulation via donation attack (direct token transfer to `asset_vault`) is prevented by the virtual offset:

```
offset = 10^(9 - asset_decimals)
```

## Deployment

### Devnet

| Item | Value |
|------|-------|
| **Program ID** | `2w7aL5ZrD2i9RpzQBGSPAg7s61wVc8Qs8gtuQUTojEDE` |
| **Network** | Devnet |
| **SDK Package** | `@stbr/svs-privacy-sdk` |
| **Class** | `ConfidentialStreamVault` |

### Verification

```bash
# Verify program deployment
solana program show 2w7aL5ZrD2i9RpzQBGSPAg7s61wVc8Qs8gtuQUTojEDE --url devnet

# Anchor verify (if verifiable build available)
anchor verify 2w7aL5ZrD2i9RpzQBGSPAg7s61wVc8Qs8gtuQUTojEDE --provider.cluster devnet
```

## Error Codes

In addition to [core errors](ERRORS.md):

| Code | Name | Message | When Thrown |
|------|------|---------|-------------|
| 6011 | `StreamTooShort` | Stream duration must be at least 60 seconds | `distribute_yield` with `duration < 60` |
| 6012 | `AccountNotConfigured` | Account not configured for confidential transfers | CT operation before `configure_account` |
| 6013 | `PendingBalanceNotApplied` | Pending balance not applied — call apply_pending first | Operation requires applied balance |
| 6014 | `InvalidProof` | Invalid proof data | Proof context account not owned by `zk_elgamal_proof_program` |
| 6015 | `ConfidentialTransferNotInitialized` | Confidential transfer extension not initialized | CT extension missing on shares account |
| 6016 | `InvalidCiphertext` | Invalid ciphertext format | `new_decryptable_available_balance` cannot be deserialized |

## Implementation Files

| File | Purpose |
|------|---------|
| `programs/svs-6/src/lib.rs` | Program entry, instruction dispatch |
| `programs/svs-6/src/state.rs` | `ConfidentialStreamVault` struct, `effective_total_assets`, `checkpoint` method |
| `programs/svs-6/src/math.rs` | `mul_div`, `convert_to_shares`, `convert_to_assets` |
| `programs/svs-6/src/instructions/initialize.rs` | Create vault + CT-enabled shares mint |
| `programs/svs-6/src/instructions/configure_account.rs` | CT account setup |
| `programs/svs-6/src/instructions/deposit.rs` | Deposit handler |
| `programs/svs-6/src/instructions/mint.rs` | Mint handler |
| `programs/svs-6/src/instructions/apply_pending.rs` | Pending → available CT balance |
| `programs/svs-6/src/instructions/withdraw.rs` | CT inner_withdraw + burn + asset transfer |
| `programs/svs-6/src/instructions/redeem.rs` | CT inner_withdraw + burn + asset transfer |
| `programs/svs-6/src/instructions/distribute_yield.rs` | Start yield stream |
| `programs/svs-6/src/instructions/checkpoint.rs` | Materialize accrued yield |
| `programs/svs-6/src/instructions/admin.rs` | `pause`, `unpause`, `transfer_authority` |
| `programs/svs-6/src/instructions/view.rs` | Read-only views; `max_withdraw`/`max_redeem` return 0 |
| `programs/svs-6/src/instructions/module_admin.rs` | Module config (with `modules` feature) |
| `programs/svs-6/src/error.rs` | `VaultError` enum |
| `programs/svs-6/src/events.rs` | `VaultInitialized`, `Withdraw`, `YieldStreamStarted`, `Checkpoint` |
| `svs-module-hooks/` (shared crate) | Module integration hooks |
| `proofs-backend/src/` | ZK proof generation server |

---

**See Also:**
- [SVS-5.md](./SVS-5.md) — Base streaming yield vault
- [SVS-3.md](./SVS-3.md) — Confidential transfer implementation (live balance)
- [PRIVACY.md](./PRIVACY.md) — Privacy model details
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
- [PATTERNS.md](./PATTERNS.md) — Implementation patterns
- [ERRORS.md](./ERRORS.md) — Full error code reference
