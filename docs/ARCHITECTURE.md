# SVS-1 Architecture

Technical deep-dive into the Solana Vault Standard implementation.

## System Overview

```
                                 ┌─────────────────────────────────────┐
                                 │           SVS-1 Program             │
                                 │  ┌─────────────────────────────┐   │
                                 │  │         lib.rs              │   │
                                 │  │   (instruction routing)     │   │
                                 │  └──────────────┬──────────────┘   │
                                 │                 │                   │
          ┌────────────────────┬─┴─────────────────┼───────────────────┴────┬──────────────────┐
          │                    │                   │                        │                  │
          ▼                    ▼                   ▼                        ▼                  ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│   initialize    │  │     deposit     │  │      mint       │  │    withdraw     │  │     redeem      │
│                 │  │                 │  │                 │  │                 │  │                 │
│ Create vault,   │  │ Assets → Shares │  │ Pay → Shares    │  │ Assets ← Burn   │  │ Shares → Assets │
│ shares mint,    │  │ (Floor round)   │  │ (Ceil round)    │  │ (Ceil round)    │  │ (Floor round)   │
│ asset vault     │  │                 │  │                 │  │                 │  │                 │
└─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────────┐
                    │        Supporting           │
                    │  ┌───────┐ ┌───────┐       │
                    │  │ admin │ │ view  │       │
                    │  └───────┘ └───────┘       │
                    │  pause/unpause  previews   │
                    │  sync/transfer  max/total  │
                    └─────────────────────────────┘
```

## File Structure

```
programs/svs-1/src/
├── lib.rs              # Program entry point, instruction routing
├── state.rs            # Vault account structure
├── error.rs            # Custom error codes
├── events.rs           # Event definitions
├── math.rs             # Core mathematical operations
├── constants.rs        # Seeds, limits, constants
└── instructions/
    ├── mod.rs          # Module exports
    ├── initialize.rs   # Vault creation
    ├── deposit.rs      # Deposit assets for shares
    ├── mint.rs         # Mint shares for assets
    ├── withdraw.rs     # Withdraw assets, burn shares
    ├── redeem.rs       # Redeem shares for assets
    ├── admin.rs        # pause/unpause/sync/transfer
    └── view.rs         # Preview and conversion functions
```

## Core Components

### 1. Vault State (`state.rs`)

The Vault account stores all vault configuration and state.

```rust
#[account]
pub struct Vault {
    pub authority: Pubkey,       // 32 bytes - Admin
    pub asset_mint: Pubkey,      // 32 bytes - Underlying token
    pub shares_mint: Pubkey,     // 32 bytes - LP token
    pub asset_vault: Pubkey,     // 32 bytes - Token account
    pub total_assets: u64,       // 8 bytes  - Cached balance
    pub decimals_offset: u8,     // 1 byte   - Inflation protection
    pub bump: u8,                // 1 byte   - PDA bump
    pub paused: bool,            // 1 byte   - Emergency flag
    pub vault_id: u64,           // 8 bytes  - Unique ID
    pub _reserved: [u8; 64],     // 64 bytes - Future upgrades
}
// Total: 8 (discriminator) + 211 = 219 bytes
```

**Design Decisions:**

| Field | Rationale |
|-------|-----------|
| `total_assets` | Cached for gas efficiency; can be synced |
| `decimals_offset` | Pre-computed `9 - asset_decimals` |
| `bump` | Stored to avoid recalculation |
| `vault_id` | Allows multiple vaults per asset |
| `_reserved` | Backward-compatible state extension |

### 2. Mathematical Core (`math.rs`)

All share/asset conversions use the virtual offset pattern.

```rust
pub fn convert_to_shares(
    assets: u64,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64> {
    // Virtual offset = 10^decimals_offset
    let offset = 10u64.checked_pow(decimals_offset as u32)?;

    // Add virtual components
    let virtual_shares = total_shares.checked_add(offset)?;
    let virtual_assets = total_assets.checked_add(1)?;

    // shares = assets × virtual_shares / virtual_assets
    mul_div(assets, virtual_shares, virtual_assets, rounding)
}
```

**Rounding Strategy:**

```
Operation      | Rounding | Why
───────────────┼──────────┼────────────────────────────────
deposit()      | Floor    | User receives fewer shares
mint()         | Ceiling  | User pays more assets
withdraw()     | Ceiling  | User burns more shares
redeem()       | Floor    | User receives fewer assets
```

All rounding favors the vault, preventing value extraction.

### 3. PDA Architecture

```
                        Program ID
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
    ┌───────┐          ┌─────────┐         ┌─────────┐
    │ Vault │          │ Shares  │         │ Asset   │
    │  PDA  │──────────│  Mint   │         │ Vault   │
    │       │          │  PDA    │         │  ATA    │
    └───────┘          └─────────┘         └─────────┘

Seeds:                 Seeds:              Owner:
["vault",              ["shares",          Vault PDA
 asset_mint,            vault_pubkey]
 vault_id]
```

**Derivation Code:**

```rust
// Vault PDA
let (vault, vault_bump) = Pubkey::find_program_address(
    &[
        b"vault",
        asset_mint.as_ref(),
        &vault_id.to_le_bytes(),
    ],
    program_id,
);

// Shares Mint PDA
let (shares_mint, _) = Pubkey::find_program_address(
    &[b"shares", vault.as_ref()],
    program_id,
);

// Asset Vault (ATA owned by Vault PDA)
let asset_vault = get_associated_token_address(&vault, &asset_mint);
```

### 4. Token Programs

SVS-1 uses different token programs for different purposes:

| Token | Program | Reason |
|-------|---------|--------|
| Asset Mint | Token or Token-2022 | Existing tokens (USDC, etc.) |
| Shares Mint | Token-2022 | Metadata extension for name/symbol |
| Asset Vault | Same as Asset | Must match asset program |

```rust
// Initialize shares mint with Token-2022 metadata
let extension_types = vec![ExtensionType::MetadataPointer];
let space = ExtensionType::try_calculate_account_len::<Mint>(&extension_types)?;

// Mint uses Token-2022
#[account(
    init,
    payer = authority,
    mint::decimals = SHARES_DECIMALS,
    mint::authority = vault,
    seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
    bump,
    token::token_program = token_2022_program,
)]
pub shares_mint: InterfaceAccount<'info, Mint>,
```

## Instruction Flow

### Initialize Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ initialize(vault_id, name, symbol, uri)                         │
├─────────────────────────────────────────────────────────────────┤
│ 1. Validate asset_decimals <= 9                                 │
│ 2. Create Vault PDA                                             │
│ 3. Create Shares Mint PDA (Token-2022 + metadata)               │
│ 4. Create Asset Vault ATA (owned by Vault PDA)                  │
│ 5. Initialize Vault state:                                      │
│    - authority = signer                                         │
│    - total_assets = 0                                           │
│    - decimals_offset = 9 - asset_decimals                       │
│    - paused = false                                             │
│ 6. Emit VaultInitialized event                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Deposit Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ deposit(assets, min_shares_out)                                 │
├─────────────────────────────────────────────────────────────────┤
│ 1. Check !paused                                                │
│ 2. Check assets >= MIN_DEPOSIT_AMOUNT                           │
│ 3. Calculate shares = convert_to_shares(assets, Floor)          │
│ 4. Check shares >= min_shares_out (slippage)                    │
│ 5. CPI: transfer_checked (user → asset_vault)                   │
│ 6. CPI: mint_to (shares_mint → user)                            │
│ 7. Update vault.total_assets += assets                          │
│ 8. Emit Deposit event                                           │
└─────────────────────────────────────────────────────────────────┘

CPI Order (Critical for Security):
    transfer_checked → mint_to
    (Assets received before shares minted)
```

### Redeem Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ redeem(shares, min_assets_out)                                  │
├─────────────────────────────────────────────────────────────────┤
│ 1. Check !paused                                                │
│ 2. Calculate assets = convert_to_assets(shares, Floor)          │
│ 3. Check assets >= min_assets_out (slippage)                    │
│ 4. Check vault.total_assets >= assets                           │
│ 5. CPI: burn (user shares)                                      │
│ 6. CPI: transfer_checked (asset_vault → user)                   │
│ 7. Update vault.total_assets -= assets                          │
│ 8. Emit Withdraw event                                          │
└─────────────────────────────────────────────────────────────────┘

CPI Order (Critical for Security):
    burn → transfer_checked
    (Shares burned before assets sent)
```

## Virtual Offset Mechanism

The virtual offset prevents inflation/donation attacks by ensuring the share price can never be manipulated to extreme values.

### Without Protection (Vulnerable)

```
State: total_assets=0, total_shares=0

Attack:
1. Attacker sends 1,000,000 USDC directly to vault
2. Attacker deposits 1 USDC
3. shares = 1 × 0 / 0 = undefined (or 1 with naive impl)
4. Attacker owns all shares, worth 1,000,001 USDC
```

### With Protection (SVS-1)

```
State: total_assets=0, total_shares=0, offset=3

Protection (6-decimal asset like USDC):
1. Attacker sends 1,000,000 USDC directly to vault
2. Attacker deposits 1 USDC
3. virtual_shares = 0 + 10^3 = 1,000
4. virtual_assets = 1,000,000 + 1 = 1,000,001
5. shares = 1 × 1,000 / 1,000,001 = 0 (floor)
6. Attack yields nothing!
```

### Offset Calculation

```
decimals_offset = 9 - asset_decimals

Purpose: Normalize to 9 decimal precision for shares

Asset Type    │ Decimals │ Offset │ Virtual Shares
──────────────┼──────────┼────────┼────────────────
USDC/USDT     │    6     │   3    │ 1,000
SOL           │    9     │   0    │ 1
Custom        │    4     │   5    │ 100,000
Custom        │    0     │   9    │ 1,000,000,000
```

## Event System

All state changes emit events for indexing.

```rust
#[event]
pub struct Deposit {
    pub vault: Pubkey,
    pub caller: Pubkey,   // Transaction signer
    pub owner: Pubkey,    // Share recipient
    pub assets: u64,      // Assets deposited
    pub shares: u64,      // Shares minted
}

#[event]
pub struct Withdraw {
    pub vault: Pubkey,
    pub caller: Pubkey,   // Transaction signer
    pub receiver: Pubkey, // Asset recipient
    pub owner: Pubkey,    // Share owner
    pub assets: u64,      // Assets withdrawn
    pub shares: u64,      // Shares burned
}
```

**Event Discriminators** (first 8 bytes of sha256):

```
VaultInitialized:  [hash of "event:VaultInitialized"]
Deposit:           [hash of "event:Deposit"]
Withdraw:          [hash of "event:Withdraw"]
VaultSynced:       [hash of "event:VaultSynced"]
VaultStatusChanged:[hash of "event:VaultStatusChanged"]
AuthorityTransferred:[hash of "event:AuthorityTransferred"]
```

## View Functions

View functions use `set_return_data` for CPI composability.

```rust
pub fn preview_deposit(ctx: Context<VaultView>, assets: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;

    let shares = convert_to_shares(
        assets,
        vault.total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    )?;

    // Set return data for CPI callers
    anchor_lang::solana_program::program::set_return_data(&shares.to_le_bytes());

    emit!(PreviewDeposit { assets, shares });
    Ok(())
}
```

**CPI Usage:**

```rust
// Other program calling SVS-1 preview
let ix = svs_1::instruction::preview_deposit(assets);
invoke(&ix, &[vault.to_account_info()])?;

// Read return data
let (_, data) = get_return_data().unwrap();
let shares = u64::from_le_bytes(data.try_into().unwrap());
```

## Admin Operations

### Pause/Unpause

```rust
pub fn pause(ctx: Context<Admin>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(!vault.paused, VaultError::VaultPaused);
    vault.paused = true;
    emit!(VaultStatusChanged { vault: vault.key(), paused: true });
    Ok(())
}
```

When paused:
- `deposit`, `mint`, `withdraw`, `redeem` → Error
- `preview_*`, `convert_*` → Continue working
- `max_deposit`, `max_mint` → Return 0

### Sync

Updates cached `total_assets` to match actual balance.

```rust
pub fn sync(ctx: Context<Sync>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let actual = ctx.accounts.asset_vault.amount;

    vault.total_assets = actual;

    emit!(VaultSynced {
        vault: vault.key(),
        previous_total,
        new_total: actual,
    });
    Ok(())
}
```

**Use Cases:**
- Recognize yield sent directly to vault
- Correct after donation/airdrop
- Manual reconciliation

## Compute Budget

Typical CU usage per instruction:

| Instruction | CU (approx) |
|-------------|-------------|
| initialize | 50,000 |
| deposit | 35,000 |
| mint | 35,000 |
| withdraw | 35,000 |
| redeem | 35,000 |
| preview_* | 5,000 |
| sync | 15,000 |
| pause/unpause | 10,000 |

## Composability

### CPI to SVS-1

```rust
// Deposit from another program
let cpi_accounts = svs_1::cpi::accounts::Deposit {
    user: user.to_account_info(),
    vault: vault.to_account_info(),
    // ... other accounts
};
let cpi_ctx = CpiContext::new(svs_1_program.to_account_info(), cpi_accounts);
svs_1::cpi::deposit(cpi_ctx, assets, min_shares)?;
```

### Reading Vault State

```rust
// Load and deserialize vault account
let vault_data = vault_account.try_borrow_data()?;
let vault: Vault = Vault::try_deserialize(&mut &vault_data[..])?;

let total_assets = vault.total_assets;
let share_price = total_assets as f64 / total_shares as f64;
```

## Security Invariants

These invariants must always hold:

1. **Share Conservation**: `shares_mint.supply == Σ user_share_balances`
2. **Asset Backing**: `vault.total_assets <= asset_vault.amount` (equality after sync)
3. **Rounding Direction**: Round-trip never profits user
4. **Authority Check**: Admin ops only by `vault.authority`
5. **Pause Enforcement**: State-changing ops blocked when paused

## Future Extensions

The `_reserved` field allows future state additions:

```rust
pub _reserved: [u8; 64],  // 64 bytes for future use
```

Potential additions:
- Fee configuration (management/performance fees)
- Deposit/withdrawal caps
- Timelock settings
- Whitelist mode flag

## References

- [ERC-4626 Specification](https://eips.ethereum.org/EIPS/eip-4626)
- [OpenZeppelin Implementation](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/extensions/ERC4626.sol)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Token-2022 Extensions](https://spl.solana.com/token-2022)
