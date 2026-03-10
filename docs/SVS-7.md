# SVS-7: Native SOL Vault

## Overview

SVS-7 is a vault standard for native SOL with automatic wSOL wrapping. Users deposit raw SOL and receive vault shares. Internally, the program wraps SOL to wSOL for accounting via SPL Token's native mint. On exit, wSOL is transferred to a temporary user account and closed — converting back to native SOL seamlessly. No user-side wrapping is required.

SVS-7 is a Solana-native adaptation of [ERC-7535](https://eips.ethereum.org/EIPS/eip-7535) (Native Asset ERC-4626 Vault).

## Relationship to Other Variants

| Feature | SVS-1 | SVS-2 | SVS-7 |
|---------|-------|-------|-------|
| **Asset** | SPL Token | SPL Token | **Native SOL (wSOL internally)** |
| **Balance Model** | Live | Stored | **Live or Stored** |
| **Privacy** | None | None | None |
| **sync()** | ❌ | ✅ | ✅ (Stored model only) |
| **User wraps wSOL?** | N/A | N/A | **No — automatic** |
| **Shares Token Program** | Token-2022 | Token-2022 | **Token-2022** |
| **wSOL Token Program** | N/A | N/A | **SPL Token** |

## Account Structure

```rust
#[account]
pub struct SolVault {
    pub authority: Pubkey,        // 32 bytes — vault admin
    pub shares_mint: Pubkey,      // 32 bytes — Token-2022 shares mint
    pub wsol_vault: Pubkey,       // 32 bytes — SPL Token wSOL account (holds SOL)
    pub total_assets: u64,        // 8 bytes  — active in Stored model
    pub decimals_offset: u8,      // 1 byte   — always 0 (SOL = 9 decimals)
    pub bump: u8,                 // 1 byte   — vault PDA bump
    pub paused: bool,             // 1 byte
    pub vault_id: u64,            // 8 bytes  — allows multiple vaults
    pub balance_model: u8,        // 1 byte   — 0 = Live, 1 = Stored
    pub _reserved: [u8; 64],      // 64 bytes — future use
}
// Total: 8 (discriminator) + 181 = 189 bytes
```

**PDA Structure:**
- **Vault:** `["sol_vault", vault_id.to_le_bytes()]`
- **Shares Mint:** `["shares", vault_pubkey]`
- **wSOL Vault:** ATA of `NATIVE_MINT` for vault PDA (SPL Token program)

> **Key difference from SVS-1/2**: The vault PDA seed uses `"sol_vault"` (not `"vault"`) and does **not** include the asset mint (native mint is implicit). The wSOL vault is an ATA, so its address is deterministic: `getAssociatedTokenAddressSync(NATIVE_MINT, vault, true, TOKEN_PROGRAM_ID)`.

## Balance Model

SVS-7 supports two balance models set at initialization:

| Model | `balance_model` | `totalAssets` source | `sync()` |
|-------|----------------|----------------------|----------|
| Live | `0` | `wsol_vault.amount` read each instruction | Not available |
| Stored | `1` | `vault.total_assets` cached on-chain | Required to recognize SOL donations |

## Instructions

### Core Operations

| Instruction | Description | Signer |
|-------------|-------------|--------|
| `initialize` | Create vault PDA, shares mint, wSOL vault ATA | authority |
| `deposit_sol` | Transfer SOL → sync wSOL → mint shares | depositor |
| `deposit_wsol` | Transfer pre-wrapped wSOL → mint shares | depositor |
| `mint_sol` | Pay SOL for exact shares | depositor |
| `withdraw_sol` | Burn shares → receive exact native SOL | user |
| `withdraw_wsol` | Burn shares → receive exact wSOL | user |
| `redeem_sol` | Burn exact shares → receive native SOL | user |
| `redeem_wsol` | Burn exact shares → receive wSOL | user |

### Admin Operations

| Instruction | Description | Authority-only |
|-------------|-------------|----------------|
| `pause` | Emergency pause | ✅ |
| `unpause` | Resume vault | ✅ |
| `transfer_authority` | Change vault admin | ✅ |
| `sync` | Sync `total_assets` from wSOL vault (Stored model only) | ❌ permissionless |

### View Functions (11 total)

All view functions use `set_return_data` and are callable via CPI simulation.

| Instruction | Description |
|-------------|-------------|
| `preview_deposit` | Shares received for SOL deposit |
| `preview_mint` | SOL required to mint exact shares |
| `preview_withdraw` | Shares burned for exact SOL out |
| `preview_redeem` | SOL received for exact shares burned |
| `convert_to_shares` | SOL amount → shares |
| `convert_to_assets` | Shares → SOL amount |
| `total_assets` | Current vault SOL balance |
| `max_deposit` | `u64::MAX` (unpaused) or `0` (paused) |
| `max_mint` | `u64::MAX` (unpaused) or `0` (paused) |
| `max_withdraw` | User's redeemable assets |
| `max_redeem` | User's share balance |

## Deposit/Withdraw Flow

### Deposit (native SOL)
```
1. system_program::transfer(user → wsol_vault, lamports)
   — moves SOL before sync so the balance is reflected
2. spl_token::sync_native(wsol_vault)
   — updates wsol_vault.amount to match its lamport balance
3. convert_to_shares(lamports, total_assets_before, total_shares)
4. token_2022::mint_to(shares_mint → user_shares_account)
```

### Redeem/Withdraw (receive native SOL)
```
1. token_2022::burn(user_shares_account, shares)
2. spl_token::transfer(wsol_vault → user_wsol_account, lamports)
   — SPL Token moves both token amount AND lamports for NATIVE_MINT
3. spl_token::close_account(user_wsol_account → user)
   — closes the wSOL ATA, sending all lamports as native SOL to user
```

> **Why close_account?** SPL Token's `transfer` for native mint accounts moves lamports to the destination account's token balance. `close_account` then converts those lamports back to native by closing the ATA and sending its lamport balance to the destination.

## PDA Derivation (TypeScript)

```typescript
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";

const vaultId = new BN(1);

// Vault PDA
const [vault] = PublicKey.findProgramAddressSync(
  [Buffer.from("sol_vault"), vaultId.toArrayLike(Buffer, "le", 8)],
  SVS7_PROGRAM_ID
);

// Shares Mint (Token-2022)
const [sharesMint] = PublicKey.findProgramAddressSync(
  [Buffer.from("shares"), vault.toBuffer()],
  SVS7_PROGRAM_ID
);

// wSOL Vault (ATA of NATIVE_MINT for vault PDA, owned by SPL Token program)
const wsolVault = getAssociatedTokenAddressSync(
  NATIVE_MINT,
  vault,
  true, // allowOwnerOffCurve — vault is a PDA
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
);

// User's temp wSOL ATA (used during redeem/withdraw, then closed)
const userWsolAccount = getAssociatedTokenAddressSync(
  NATIVE_MINT,
  userPublicKey,
  false,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
);

// User's shares ATA (Token-2022)
const userSharesAccount = getAssociatedTokenAddressSync(
  sharesMint,
  userPublicKey,
  false,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
);
```

## Initialize Accounts

```typescript
await program.methods
  .initialize(vaultId, 0, "SOL Vault", "svSOL", "https://...")
  .accountsStrict({
    authority: payer.publicKey,
    vault,
    nativeMint: NATIVE_MINT,
    sharesMint,
    wsolVault,
    wsolTokenProgram: TOKEN_PROGRAM_ID,       // SPL Token (for wSOL)
    token2022Program: TOKEN_2022_PROGRAM_ID,  // Token-2022 (for shares)
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  })
  .rpc();
```

## Redeem SOL Accounts

```typescript
await program.methods
  .redeemSol(shares, minLamportsOut)
  .accountsStrict({
    user: payer.publicKey,
    vault,
    wsolVault,
    sharesMint,
    userSharesAccount,
    nativeMint: NATIVE_MINT,
    userWsolAccount,  // created if needed (init_if_needed), closed at end
    wsolTokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | `ZeroAmount` | Amount must be > 0 |
| 6001 | `SlippageExceeded` | Slippage tolerance exceeded |
| 6002 | `VaultPaused` | Vault is paused |
| 6003 | `InvalidAssetDecimals` | Asset decimals > 9 |
| 6004 | `MathOverflow` | Arithmetic overflow |
| 6005 | `DivisionByZero` | Division by zero |
| 6006 | `InsufficientShares` | Not enough shares to burn |
| 6007 | `InsufficientAssets` | Insufficient vault SOL |
| 6008 | `Unauthorized` | Not vault authority |
| 6009 | `DepositTooSmall` | Below 1000 lamport minimum |
| 6010 | `InvalidNativeMint` | Must be NATIVE_MINT |
| 6011 | `VaultNotPaused` | Vault is not paused |
| 6012 | `InvalidBalanceModel` | Unknown balance model byte |
| 6013 | `SyncNotAvailableLiveModel` | sync() only valid on Stored model |

## Events

| Event | Fields |
|-------|--------|
| `SolVaultInitialized` | vault, authority, shares_mint, wsol_vault, vault_id, balance_model |
| `Deposit` | vault, caller, owner, assets (lamports), shares, is_native |
| `Withdraw` | vault, caller, receiver, owner, assets (lamports), shares, is_native |
| `VaultSynced` | vault, previous_total_assets, new_total_assets |
| `VaultStatusChanged` | vault, paused |
| `AuthorityTransferred` | vault, previous_authority, new_authority |

## Compute Units (approximate)

| Instruction | CU |
|-------------|-----|
| `initialize` | ~60,000 |
| `deposit_sol` | ~35,000 |
| `redeem_sol` | ~30,000 |
| `withdraw_sol` | ~30,000 |
| `sync` | ~8,000 |
| View functions | ~5,000 |

## Security Considerations

### Inflation Attack Protection
- `decimals_offset = 9 - 9 = 0`, so virtual offset = `10^0 = 1`
- SOL already has 9 decimals — no additional virtual shares needed
- First depositor sets the initial exchange rate

### Live vs Stored Balance
- **Live model**: `wsol_vault.amount` is the source of truth. External SOL donations instantly reflected. No sync timing attack.
- **Stored model**: `vault.total_assets` is used. External donations require `sync()`. Authority controls when yield is distributed.

### Native SOL Transfer Safety
- Direct `try_borrow_mut_lamports` manipulation on SPL Token-owned accounts is **illegal** — only the owning program can debit
- SVS-7 uses `spl_token::transfer` + `spl_token::close_account` instead, which are the sanctioned CPI paths for native mint accounts

### Rounding
- `deposit` / `redeem`: Floor rounding (user gets fewer shares/assets)
- `mint` / `withdraw`: Ceiling rounding (user pays more SOL/burns more shares)

## Module Integration

SVS-7 has module hook call-sites wired in all core instruction handlers via `#[cfg(feature = "modules")]`. Build with:

```bash
anchor build -p svs-7 -- --features modules
```

Module compatibility:

| Module | SVS-7 | Notes |
|--------|-------|-------|
| svs-fees | ✅ | Entry/exit fees on SOL amounts |
| svs-caps | ✅ | Global/per-user SOL deposit caps |
| svs-locks | ✅ | Time-locked share redemption |
| svs-access | ✅ | Whitelist/blacklist access |
| svs-rewards | Scaffolding | Future integration |
| svs-oracle | — | SOL price needs no oracle (SOL is base asset) |

## Deployment Status

| Network | Program ID | Status |
|---------|------------|--------|
| Localnet | `SVSxBmEB9ZAaHMJ4PJPsLDu56bGjoXKNsSp1bWKyMYC` | ✅ Active |
| Devnet | `SVSxBmEB9ZAaHMJ4PJPsLDu56bGjoXKNsSp1bWKyMYC` | ✅ Deployed |
| Mainnet | Not deployed | ⏳ Pending audit |

**Test Coverage:** 11 integration tests covering: initialize (Live balance model), deposit_sol (×2), redeem_sol, withdraw_sol, pause/unpause, sync rejection on Live model, view functions (×4).

**SDK:** `SolVaultSDK` class in `sdk/core/src/svs-7.ts` (exported from `@stbr/solana-vault`).

---

**See Also:**
- [SVS-1.md](./SVS-1.md) — Public vault live balance (base pattern)
- [SVS-2.md](./SVS-2.md) — Public vault stored balance + sync()
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Feature matrix across all variants
- [PATTERNS.md](./PATTERNS.md) — Implementation patterns
- [ERRORS.md](./ERRORS.md) — Error code reference
