# SVS-1: Solana Vault Standard

ERC-4626 equivalent for Solana - a standardized tokenized vault interface for SPL tokens.

## Overview

SVS-1 provides a secure, standardized way to build tokenized vaults on Solana. Deposit assets, receive proportional shares (LP tokens), and redeem shares back for assets. The standard includes built-in inflation attack protection and a predictable rounding strategy that favors vault solvency.

**Program ID:** `SVS1VauLt1111111111111111111111111111111111`

## Features

| Feature | Description |
|---------|-------------|
| **ERC-4626 Compatible** | Standard interface matching Ethereum's vault standard |
| **Inflation Attack Protection** | Virtual offset mechanism prevents donation attacks |
| **Vault-Favoring Rounding** | All operations round to protect vault solvency |
| **Slippage Protection** | Min/max parameters prevent sandwich attacks |
| **Multi-Vault Support** | Multiple vaults per asset via `vault_id` |
| **Emergency Controls** | Pause/unpause and authority transfer |
| **CPI-Composable Views** | Preview functions callable from other programs |
| **SPL Token Assets** | Works with any SPL token (up to 9 decimals) |
| **Token-2022 Shares** | LP tokens use Token-2022 with on-chain metadata |

## Token Programs

| Component | Program | Reason |
|-----------|---------|--------|
| Asset Mint | SPL Token | Existing tokens (USDC, SOL, etc.) |
| Asset Vault | SPL Token | Holds deposited assets |
| Shares Mint | **Token-2022** | Metadata extension for name/symbol/uri |
| User Shares | **Token-2022** | Must match shares mint |

## Installation

```bash
# Anchor
anchor add svs_1

# npm
npm install @svs-1/sdk

# yarn
yarn add @svs-1/sdk
```

## Quick Start

### Initialize a Vault

```typescript
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SVS1 } from "@svs-1/sdk";

const program = new Program(idl, provider);
const vaultId = new BN(1);

// Derive vault PDA
const [vaultPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("vault"),
    assetMint.toBuffer(),
    vaultId.toArrayLike(Buffer, "le", 8)
  ],
  program.programId
);

// Derive shares mint PDA
const [sharesMint] = PublicKey.findProgramAddressSync(
  [Buffer.from("shares"), vaultPda.toBuffer()],
  program.programId
);

await program.methods
  .initialize(
    vaultId,
    "Vault USDC",
    "vUSDC",
    "https://metadata.uri"
  )
  .accounts({
    vault: vaultPda,
    authority: wallet.publicKey,
    assetMint: usdcMint,
    sharesMint,
    assetVault: assetVaultAta,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  })
  .rpc();
```

### Deposit Assets

```typescript
const assets = new BN(1_000_000); // 1 USDC (6 decimals)
const minSharesOut = new BN(900_000); // Allow 10% slippage

await program.methods
  .deposit(assets, minSharesOut)
  .accounts({
    vault: vaultPda,
    sharesMint,
    assetVault,
    depositorAssets: userUsdcAta,
    depositorShares: userSharesAta,
    depositor: wallet.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

### Redeem Shares

```typescript
const shares = new BN(500_000); // Redeem 0.5 shares
const minAssetsOut = new BN(450_000); // Slippage protection

await program.methods
  .redeem(shares, minAssetsOut)
  .accounts({
    vault: vaultPda,
    sharesMint,
    assetVault,
    redeemerShares: userSharesAta,
    redeemerAssets: userUsdcAta,
    redeemer: wallet.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

### Preview Operations

```typescript
// Preview shares from deposit (off-chain)
const previewTx = await program.methods
  .previewDeposit(new BN(1_000_000))
  .accounts({ vault: vaultPda })
  .simulate();

// Check return data for shares amount
const returnData = previewTx.returnData;
```

## PDA Derivation

### Vault PDA
**Seeds:** `["vault", asset_mint, vault_id (u64 LE)]`

```typescript
const [vault, bump] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("vault"),
    assetMint.toBuffer(),
    vaultId.toArrayLike(Buffer, "le", 8)
  ],
  programId
);
```

### Shares Mint PDA
**Seeds:** `["shares", vault_pubkey]`

```typescript
const [sharesMint, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("shares"), vault.toBuffer()],
  programId
);
```

## Architecture

```
┌─────────────────────────────────────────┐
│           Solana Vault (SVS-1)          │
├─────────────────────────────────────────┤
│  Vault Account (PDA)                    │
│  - authority                            │
│  - asset_mint                           │
│  - shares_mint (PDA)                    │
│  - asset_vault (ATA)                    │
│  - total_assets (cached)                │
│  - decimals_offset (inflation protect)  │
│  - paused flag                          │
└─────────────────────────────────────────┘
         │                    │
         ▼                    ▼
   ┌──────────┐        ┌──────────┐
   │  Assets  │        │  Shares  │
   │ (USDC)   │        │ (vUSDC)  │
   └──────────┘        └──────────┘
```

### Core Operations

| Operation | User Action | Rounding | Favors |
|-----------|-------------|----------|--------|
| **deposit** | Pay exact assets → receive shares | Floor | Vault |
| **mint** | Receive exact shares → pay assets | Ceiling | Vault |
| **withdraw** | Receive exact assets → burn shares | Ceiling | Vault |
| **redeem** | Burn exact shares → receive assets | Floor | Vault |

All rounding favors the vault to prevent share dilution attacks.

## Instructions

### Core Operations

#### `initialize`
Creates a new vault for an asset.

**Accounts:**
- `vault` (mut, init): Vault PDA
- `authority` (signer): Vault admin
- `asset_mint`: SPL token to accept (max 9 decimals)
- `shares_mint` (mut, init): LP token mint (PDA)
- `asset_vault` (mut, init): Token account holding assets
- `token_program`: SPL Token Program
- `system_program`: System Program

**Arguments:**
- `vault_id`: Unique identifier (allows multiple vaults per asset)
- `name`: Shares token name
- `symbol`: Shares token symbol
- `uri`: Metadata URI

**Security:**
- Asset decimals must be ≤ 9
- Shares mint always uses 9 decimals
- Decimals offset calculated as `9 - asset_decimals`

#### `deposit`
Deposit assets, receive shares (floor rounding).

**Arguments:**
- `assets`: Amount to deposit
- `min_shares_out`: Minimum shares to receive (slippage protection)

**Errors:**
- `ZeroAmount`: assets = 0
- `SlippageExceeded`: Shares received < min_shares_out
- `VaultPaused`: Vault is paused
- `DepositTooSmall`: assets < MIN_DEPOSIT_AMOUNT (1000)

#### `mint`
Mint exact shares by paying assets (ceiling rounding).

**Arguments:**
- `shares`: Exact shares to mint
- `max_assets_in`: Maximum assets willing to pay

**Errors:**
- `ZeroAmount`: shares = 0
- `SlippageExceeded`: Assets required > max_assets_in
- `VaultPaused`: Vault is paused

#### `withdraw`
Withdraw exact assets by burning shares (ceiling rounding).

**Arguments:**
- `assets`: Exact assets to withdraw
- `max_shares_in`: Maximum shares willing to burn

**Errors:**
- `ZeroAmount`: assets = 0
- `SlippageExceeded`: Shares required > max_shares_in
- `InsufficientShares`: User lacks required shares
- `InsufficientAssets`: Vault lacks assets

#### `redeem`
Redeem shares for assets (floor rounding).

**Arguments:**
- `shares`: Amount to redeem
- `min_assets_out`: Minimum assets to receive

**Errors:**
- `ZeroAmount`: shares = 0
- `SlippageExceeded`: Assets received < min_assets_out
- `InsufficientShares`: User lacks shares

### Admin Operations

#### `pause`
Emergency pause all vault operations (deposit, mint, withdraw, redeem all blocked).

**Accounts:**
- `vault` (mut): Vault PDA
- `authority` (signer): Current vault authority

**Errors:**
- `Unauthorized`: Caller is not authority

#### `unpause`
Resume normal vault operations.

#### `transfer_authority`
Transfer vault authority to new address.

**Arguments:**
- `new_authority`: New authority pubkey

#### `sync`
Sync `total_assets` with actual vault balance (useful after direct transfers).

### View Functions

All view functions return data via Solana return data (CPI-composable).

#### `preview_deposit(assets: u64)`
Calculate shares for deposit (floor).

#### `preview_mint(shares: u64)`
Calculate assets required for mint (ceiling).

#### `preview_withdraw(assets: u64)`
Calculate shares to burn for withdraw (ceiling).

#### `preview_redeem(shares: u64)`
Calculate assets received for redeem (floor).

#### `convert_to_shares(assets: u64)`
Convert assets to shares (floor).

#### `convert_to_assets(shares: u64)`
Convert shares to assets (floor).

#### `total_assets()`
Get total assets in vault.

#### `max_deposit()`
Maximum depositable assets (u64::MAX or 0 if paused).

#### `max_mint()`
Maximum mintable shares (u64::MAX or 0 if paused).

#### `max_withdraw(owner: Pubkey)`
Maximum assets owner can withdraw (based on share balance).

#### `max_redeem(owner: Pubkey)`
Maximum shares owner can redeem (their share balance).

## Events

All state changes emit events for indexing and monitoring:

| Event | Fields |
|-------|--------|
| `VaultInitialized` | vault, authority, assetMint, sharesMint, vaultId |
| `Deposit` | vault, caller, owner, assets, shares |
| `Withdraw` | vault, caller, receiver, owner, assets, shares |
| `VaultSynced` | vault, previousTotal, newTotal |
| `VaultStatusChanged` | vault, paused |
| `AuthorityTransferred` | vault, previousAuthority, newAuthority |

## Error Codes

| Code | Name | Description |
|------|------|-------------|
| 6000 | ZeroAmount | Amount must be > 0 |
| 6001 | SlippageExceeded | Slippage tolerance exceeded |
| 6002 | VaultPaused | Vault is paused |
| 6003 | InvalidAssetDecimals | Asset decimals > 9 |
| 6004 | MathOverflow | Arithmetic overflow |
| 6005 | DivisionByZero | Division by zero |
| 6006 | InsufficientShares | Not enough shares |
| 6007 | InsufficientAssets | Not enough assets |
| 6008 | Unauthorized | Not vault authority |
| 6009 | DepositTooSmall | Below minimum deposit (1000) |

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for detailed security information.

**Key Features:**
- Virtual offset inflation attack protection
- Vault-favoring rounding strategy
- Slippage protection on all operations
- Emergency pause mechanism
- Checked arithmetic throughout
- No `unwrap()` in program code
- PDA bumps stored (not recalculated)

**Audit Status:** Not audited. Use at your own risk.

## Testing

```bash
# Build program
anchor build

# Run tests
anchor test

# Run fuzz tests
cd trident-tests
cargo test-sbf
```

## Development

### Project Structure

```
tokenized-vault-standard/
├── programs/svs-1/          # Anchor program
│   └── src/
│       ├── lib.rs           # Program entrypoint
│       ├── state.rs         # Vault state
│       ├── math.rs          # Share calculations
│       ├── constants.rs     # Seeds and limits
│       ├── error.rs         # Error codes
│       └── instructions/    # Instruction handlers
├── sdk/                     # TypeScript SDK
├── tests/                   # Integration tests
└── trident-tests/           # Fuzz tests
```

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `VAULT_SEED` | `"vault"` | Vault PDA seed prefix |
| `SHARES_MINT_SEED` | `"shares"` | Shares mint PDA seed |
| `MAX_DECIMALS` | 9 | Maximum asset decimals |
| `SHARES_DECIMALS` | 9 | Fixed shares decimals |
| `MIN_DEPOSIT_AMOUNT` | 1000 | Minimum deposit (prevents dust) |

### Build

```bash
# Standard build
anchor build

# Verifiable build
anchor build --verifiable

# Check program size
ls -lh target/deploy/svs_1.so
```

## License

Apache 2.0

## Contributing

Contributions welcome. Please open an issue before submitting major changes.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - Technical deep-dive
- [Security](docs/SECURITY.md) - Security analysis and audit status
- [SDK Guide](docs/SDK.md) - TypeScript SDK documentation
- [Testing Guide](docs/TESTING.md) - Test coverage and patterns

## Resources

- [ERC-4626 Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [Anchor Documentation](https://www.anchor-lang.com/)
- [Solana Cookbook](https://solanacookbook.com/)

## Disclaimer

This software is provided "as is" without warranty. Use at your own risk. Not audited.
