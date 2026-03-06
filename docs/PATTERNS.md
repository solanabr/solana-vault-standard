# SVS Implementation Patterns

This document describes the implementation patterns used across all SVS vault variants. Follow these patterns when contributing new instructions, variants, or modules.

---

## 1. Instruction Handler Pattern

Every SVS instruction follows a consistent 7-step structure:

```rust
pub fn handler(ctx: Context<InstructionName>, arg1: u64, arg2: u64) -> Result<()> {
    // 1. VALIDATION - Check preconditions
    require!(arg1 > 0, VaultError::ZeroAmount);
    require!(!ctx.accounts.vault.paused, VaultError::VaultPaused);

    // 2. READ STATE - Get values needed for calculation
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = ctx.accounts.asset_vault.amount;  // SVS-1/3: live balance
    // let total_assets = ctx.accounts.vault.total_assets;  // SVS-2/4: stored balance

    // 3. COMPUTE - Use math functions with checked operations
    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,  // Direction depends on operation
    )?;

    // 4. SLIPPAGE CHECK - Protect user from unexpected results
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    // 5. EXECUTE CPIs - Transfer tokens, mint/burn shares
    transfer_checked(...)?;
    token_2022::mint_to(...)?;

    // 6. UPDATE STATE - Only for stored balance model (SVS-2/4)
    // vault.total_assets = vault.total_assets.checked_add(assets)
    //     .ok_or(VaultError::MathOverflow)?;

    // 7. EMIT EVENT - For indexers and UX
    emit!(DepositEvent {
        vault: ctx.accounts.vault.key(),
        caller: ctx.accounts.user.key(),
        owner: ctx.accounts.user.key(),
        assets,
        shares,
    });

    Ok(())
}
```

### Real Example: Deposit Handler

From `programs/svs-1/src/instructions/deposit.rs:67-141`:

```rust
pub fn handler(ctx: Context<Deposit>, assets: u64, min_shares_out: u64) -> Result<()> {
    // 1. VALIDATION
    require!(assets > 0, VaultError::ZeroAmount);
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);

    // 2. READ STATE
    let vault = &ctx.accounts.vault;
    let total_shares = ctx.accounts.shares_mint.supply;
    let total_assets = ctx.accounts.asset_vault.amount;  // Live balance

    // 3. COMPUTE
    let shares = convert_to_shares(
        assets,
        total_assets,
        total_shares,
        vault.decimals_offset,
        Rounding::Floor,  // User gets fewer shares (favors vault)
    )?;

    // 4. SLIPPAGE CHECK
    require!(shares >= min_shares_out, VaultError::SlippageExceeded);

    // 5. CPIs
    transfer_checked(..., assets, ...)?;  // Assets from user to vault
    token_2022::mint_to(..., shares)?;     // Shares to user

    // 6. STATE UPDATE - None for SVS-1 (live balance)

    // 7. EMIT EVENT
    emit!(DepositEvent { vault, caller, owner, assets, shares });

    Ok(())
}
```

---

## 2. Account Context Pattern

Account contexts define what accounts an instruction requires and how to validate them.

### Full Deposit Context Example

From `programs/svs-1/src/instructions/deposit.rs:18-65`:

```rust
#[derive(Accounts)]
pub struct Deposit<'info> {
    /// User initiating the deposit (pays fees, signs tx)
    #[account(mut)]
    pub user: Signer<'info>,

    /// Vault state - validate not paused
    #[account(
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, Vault>,

    /// Asset mint - validate matches vault config
    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// User's asset token account - validate mint and ownership
    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint,
        constraint = user_asset_account.owner == user.key(),
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    /// Vault's asset token account - validate matches vault config
    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    /// Shares mint - validate matches vault config
    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    /// User's shares token account - create if needed
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = shares_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// SPL Token or Token-2022 (auto-detected for asset)
    pub asset_token_program: Interface<'info, TokenInterface>,
    /// Token-2022 for shares (always)
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
```

### Key Constraint Patterns

| Constraint | Purpose | Example |
|------------|---------|---------|
| `constraint = !vault.paused` | State validation | Ensure vault is active |
| `constraint = X.key() == vault.Y` | Relationship validation | Link accounts to vault config |
| `constraint = account.mint == expected` | Token account validation | Verify correct mint |
| `constraint = account.owner == signer.key()` | Ownership validation | Verify user owns account |
| `has_one = authority` | Shorthand relationship | Same as `constraint = vault.authority == authority.key()` |

### Account Type Selection

| Type | When to Use |
|------|-------------|
| `Account<'info, T>` | Program-owned accounts (Vault, custom state) |
| `InterfaceAccount<'info, Mint>` | SPL Token OR Token-2022 mints |
| `InterfaceAccount<'info, TokenAccount>` | SPL Token OR Token-2022 token accounts |
| `Program<'info, Token2022>` | Specifically Token-2022 program |
| `Interface<'info, TokenInterface>` | SPL Token OR Token-2022 (auto-detect) |
| `Signer<'info>` | Transaction signer verification |
| `UncheckedAccount<'info>` | Manual validation (use sparingly) |

---

## 3. PDA Signer Seeds Pattern

When the vault PDA needs to sign CPIs (mint shares, transfer assets), construct signer seeds from stored values.

### Critical Rule: Always Use Stored Bump

```rust
// WRONG - Wastes ~1500 CU per access, potential security issue
let (_, bump) = Pubkey::find_program_address(&seeds, &program_id);

// CORRECT - Use stored bump from vault state
let bump = ctx.accounts.vault.bump;
```

### Complete Signer Seeds Construction

From `programs/svs-1/src/instructions/withdraw.rs:106-114`:

```rust
// Get values from vault state (already validated by Anchor)
let asset_mint_key = ctx.accounts.vault.asset_mint;
let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
let bump = ctx.accounts.vault.bump;  // STORED bump

// Construct signer seeds exactly matching PDA derivation
let signer_seeds: &[&[&[u8]]] = &[&[
    VAULT_SEED,              // b"vault"
    asset_mint_key.as_ref(),
    vault_id_bytes.as_ref(),
    &[bump],
]];

// Use in CPI
transfer_checked(
    CpiContext::new_with_signer(
        ctx.accounts.asset_token_program.to_account_info(),
        TransferChecked { from, to, mint, authority: vault },
        signer_seeds,  // Pass signer seeds
    ),
    assets,
    decimals,
)?;
```

### Storing Bump at Initialization

From `programs/svs-1/src/instructions/initialize.rs:128-137`:

```rust
pub fn handler(ctx: Context<Initialize>, vault_id: u64, ...) -> Result<()> {
    // Get canonical bump from Anchor context
    let vault_bump = ctx.bumps.vault;

    // Store in vault state
    let vault = &mut ctx.accounts.vault;
    vault.bump = vault_bump;  // Store for future use
    // ... rest of initialization
}
```

---

## 4. Token Interface Pattern

SVS supports both SPL Token and Token-2022 for underlying assets, while shares always use Token-2022.

### Dual Token Program Support

```rust
// Account definitions
pub asset_mint: InterfaceAccount<'info, Mint>,           // Either SPL or Token-2022
pub user_asset_account: InterfaceAccount<'info, TokenAccount>,
pub asset_token_program: Interface<'info, TokenInterface>,  // Auto-detect

pub shares_mint: InterfaceAccount<'info, Mint>,          // Always Token-2022
pub token_2022_program: Program<'info, Token2022>,       // Explicit Token-2022
```

### Transfer Pattern

Always use `transfer_checked` for compatibility:

```rust
use anchor_spl::token_interface::{transfer_checked, TransferChecked};

transfer_checked(
    CpiContext::new(
        ctx.accounts.asset_token_program.to_account_info(),  // Correct program
        TransferChecked {
            from: ctx.accounts.user_asset_account.to_account_info(),
            to: ctx.accounts.asset_vault.to_account_info(),
            mint: ctx.accounts.asset_mint.to_account_info(),  // Required for checked
            authority: ctx.accounts.user.to_account_info(),
        },
    ),
    amount,
    ctx.accounts.asset_mint.decimals,  // Required for checked
)?;
```

### Mint/Burn Pattern (Shares)

Shares always use Token-2022:

```rust
use anchor_spl::token_2022::{self, MintTo, Burn};

// Mint shares (vault is authority via PDA)
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

// Burn shares (user is authority)
token_2022::burn(
    CpiContext::new(
        ctx.accounts.token_2022_program.to_account_info(),
        Burn {
            mint: ctx.accounts.shares_mint.to_account_info(),
            from: ctx.accounts.user_shares_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    ),
    shares,
)?;
```

---

## 5. Math Pattern

All SVS math uses checked operations with u128 intermediate values.

### Core Functions

From `programs/svs-1/src/math.rs`:

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rounding {
    Floor,    // Favors vault on deposit/redeem
    Ceiling,  // Favors vault on mint/withdraw
}

/// Convert assets to shares with virtual offset protection
pub fn convert_to_shares(
    assets: u64,
    total_assets: u64,
    total_shares: u64,
    decimals_offset: u8,
    rounding: Rounding,
) -> Result<u64> {
    let offset = 10u64
        .checked_pow(decimals_offset as u32)
        .ok_or(VaultError::MathOverflow)?;

    let virtual_shares = total_shares
        .checked_add(offset)
        .ok_or(VaultError::MathOverflow)?;

    let virtual_assets = total_assets
        .checked_add(1)
        .ok_or(VaultError::MathOverflow)?;

    mul_div(assets, virtual_shares, virtual_assets, rounding)
}

/// Safe multiplication then division with u128 intermediate
pub fn mul_div(value: u64, numerator: u64, denominator: u64, rounding: Rounding) -> Result<u64> {
    require!(denominator > 0, VaultError::DivisionByZero);

    let product = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(VaultError::MathOverflow)?;

    let result = match rounding {
        Rounding::Floor => product / (denominator as u128),
        Rounding::Ceiling => {
            let denom = denominator as u128;
            product
                .checked_add(denom)
                .ok_or(VaultError::MathOverflow)?
                .checked_sub(1)
                .ok_or(VaultError::MathOverflow)?
                / denom
        }
    };

    require!(result <= u64::MAX as u128, VaultError::MathOverflow);
    Ok(result as u64)
}
```

### Rounding Direction by Operation

| Operation | Rounding | Effect | Why |
|-----------|----------|--------|-----|
| `deposit` | Floor | User gets fewer shares | Protects existing shareholders |
| `mint` | Ceiling | User pays more assets | Protects existing shareholders |
| `withdraw` | Ceiling | User burns more shares | Protects vault assets |
| `redeem` | Floor | User receives fewer assets | Protects vault assets |

### Checked Arithmetic Rules

```rust
// ALWAYS use checked operations
let sum = a.checked_add(b).ok_or(VaultError::MathOverflow)?;
let diff = a.checked_sub(b).ok_or(VaultError::InsufficientAssets)?;
let product = a.checked_mul(b).ok_or(VaultError::MathOverflow)?;
let quotient = a.checked_div(b).ok_or(VaultError::DivisionByZero)?;

// NEVER use unchecked
let sum = a + b;  // WRONG - can panic
```

---

## 6. Event Emission Pattern

Events provide an audit trail for indexers and user interfaces.

### Event Definitions

From `programs/svs-1/src/events.rs`:

```rust
#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub authority: Pubkey,
    pub asset_mint: Pubkey,
    pub shares_mint: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct Deposit {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct Withdraw {
    pub vault: Pubkey,
    pub caller: Pubkey,
    pub receiver: Pubkey,
    pub owner: Pubkey,
    pub assets: u64,
    pub shares: u64,
}

#[event]
pub struct VaultStatusChanged {
    pub vault: Pubkey,
    pub paused: bool,
}

#[event]
pub struct AuthorityTransferred {
    pub vault: Pubkey,
    pub previous_authority: Pubkey,
    pub new_authority: Pubkey,
}
```

### Emission Rules

1. **Emit after all state mutations** - Ensures event reflects final state
2. **Include all relevant data** - Caller, owner, receiver, amounts
3. **Use consistent field names** - `vault`, `caller`, `owner`, `assets`, `shares`

```rust
// At end of instruction, after all CPIs
emit!(Deposit {
    vault: ctx.accounts.vault.key(),
    caller: ctx.accounts.user.key(),
    owner: ctx.accounts.user.key(),
    assets,
    shares,
});
```

---

## 7. Error Handling Pattern

### Error Definition

From `programs/svs-1/src/error.rs`:

```rust
#[error_code]
pub enum VaultError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,                    // 6000

    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,              // 6001

    #[msg("Vault is paused")]
    VaultPaused,                   // 6002

    #[msg("Asset decimals must be <= 9")]
    InvalidAssetDecimals,          // 6003

    #[msg("Arithmetic overflow")]
    MathOverflow,                  // 6004

    #[msg("Division by zero")]
    DivisionByZero,                // 6005

    #[msg("Insufficient shares balance")]
    InsufficientShares,            // 6006

    #[msg("Insufficient assets in vault")]
    InsufficientAssets,            // 6007

    #[msg("Unauthorized - caller is not vault authority")]
    Unauthorized,                  // 6008

    #[msg("Deposit amount below minimum threshold")]
    DepositTooSmall,               // 6009

    #[msg("Vault is not paused")]
    VaultNotPaused,                // 6010
}
```

### Error Usage

```rust
// Use require! for condition checks
require!(assets > 0, VaultError::ZeroAmount);
require!(!vault.paused, VaultError::VaultPaused);
require!(shares >= min_shares_out, VaultError::SlippageExceeded);

// Use ok_or for Option -> Result conversion
let value = option_value.ok_or(VaultError::MathOverflow)?;

// Use custom constraint errors
#[account(
    constraint = !vault.paused @ VaultError::VaultPaused,
)]
```

### Error Naming Conventions

- **Input errors**: `ZeroAmount`, `DepositTooSmall`, `InvalidAssetDecimals`
- **State errors**: `VaultPaused`, `VaultNotPaused`, `Unauthorized`
- **Math errors**: `MathOverflow`, `DivisionByZero`
- **Balance errors**: `InsufficientShares`, `InsufficientAssets`
- **Protection errors**: `SlippageExceeded`

---

## 8. File Organization

### Program Structure

```
programs/svs-{N}/
├── Cargo.toml
└── src/
    ├── lib.rs              # Program entry, #[program] macro
    ├── state.rs            # Account struct definitions
    ├── constants.rs        # PDA seeds, numeric limits
    ├── error.rs            # Custom error codes
    ├── events.rs           # Event definitions
    ├── math.rs             # Mathematical functions
    └── instructions/
        ├── mod.rs          # Re-exports
        ├── initialize.rs   # Vault creation
        ├── deposit.rs      # User deposits assets
        ├── mint.rs         # User mints exact shares
        ├── withdraw.rs     # User withdraws exact assets
        ├── redeem.rs       # User redeems exact shares
        ├── view.rs         # Read-only preview functions
        └── admin.rs        # pause, unpause, transfer_authority
```

### Module Re-exports

In `lib.rs`:
```rust
mod constants;
mod error;
mod events;
mod instructions;
mod math;
mod state;

pub use error::*;
pub use events::*;
pub use state::*;

#[program]
pub mod svs_1 {
    use super::*;

    pub fn initialize(...) -> Result<()> {
        instructions::initialize::handler(ctx, ...)
    }

    pub fn deposit(...) -> Result<()> {
        instructions::deposit::handler(ctx, ...)
    }
    // ... etc
}
```

---

## Summary Checklist

When implementing a new instruction:

- [ ] Follow 7-step handler structure
- [ ] Define account context with proper constraints
- [ ] Validate all relationships (mint→token account, vault→accounts)
- [ ] Use stored bump for PDA signing
- [ ] Use `InterfaceAccount` for dual SPL/Token-2022 support
- [ ] Use `transfer_checked` for transfers
- [ ] Use checked arithmetic everywhere
- [ ] Use correct rounding direction
- [ ] Emit event after all state mutations
- [ ] Add error codes with descriptive messages
