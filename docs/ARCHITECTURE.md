# SVS Architecture

Technical deep-dive into the Solana Vault Standard implementations (SVS-1 and SVS-2).

---

# Part 1: SVS-1 (Public Vault)

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

---

# Part 2: SVS-2 (Confidential Vault)

SVS-2 extends SVS-1 with Token-2022 Confidential Transfers for encrypted share balances.

## System Overview

```
                                 ┌─────────────────────────────────────┐
                                 │           SVS-2 Program             │
                                 │  ┌─────────────────────────────┐   │
                                 │  │         lib.rs              │   │
                                 │  │   (instruction routing)     │   │
                                 │  └──────────────┬──────────────┘   │
                                 │                 │                   │
    ┌────────────────────┬───────┴─────────────────┼───────────────────┴────┬──────────────────┐
    │                    │                         │                        │                  │
    ▼                    ▼                         ▼                        ▼                  ▼
┌─────────────┐  ┌───────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ initialize  │  │  configure    │  │ deposit / mint  │  │  apply_pending  │  │withdraw / redeem│
│             │  │   _account    │  │                 │  │                 │  │                 │
│ CT Mint Ext │  │ ElGamal setup │  │ Mint + CT Dep   │  │ Pending → Avail │  │ ZK Proofs + Burn│
│ + Auditor   │  │ ZK PubkeyPrf  │  │ (encrypted)     │  │ (homomorphic)   │  │ + Transfer      │
└─────────────┘  └───────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘
                         │                                                              │
                         │                                                              │
                         ▼                                                              ▼
                 ┌───────────────────┐                                  ┌───────────────────────┐
                 │  ZK ElGamal Proof │                                  │  Proof Backend (Rust) │
                 │  Native Program   │◀─────────────────────────────────│  solana-zk-sdk        │
                 └───────────────────┘                                  └───────────────────────┘
```

## File Structure

```
programs/svs-2/src/
├── lib.rs                # Program entry point, instruction routing
├── state.rs              # ConfidentialVault account structure
├── error.rs              # Custom error codes (extended)
├── events.rs             # Event definitions
├── math.rs               # Core mathematical operations (shared with SVS-1)
├── constants.rs          # Seeds, limits, constants
└── instructions/
    ├── mod.rs            # Module exports
    ├── initialize.rs     # Vault creation + ConfidentialTransferMint
    ├── configure_account.rs  # User ElGamal setup + PubkeyValidityProof
    ├── deposit.rs        # Deposit + confidential transfer to pending
    ├── mint.rs           # Mint exact shares + confidential deposit
    ├── apply_pending.rs  # Move pending → available (homomorphic)
    ├── withdraw.rs       # ZK proofs + confidential withdraw + burn
    ├── redeem.rs         # ZK proofs + confidential withdraw + burn
    ├── admin.rs          # pause/unpause/sync/transfer
    └── view.rs           # Preview and conversion functions
```

## Core Components

### 1. ConfidentialVault State (`state.rs`)

Extended vault state with privacy features:

```rust
#[account]
pub struct ConfidentialVault {
    pub authority: Pubkey,              // 32 bytes - Admin
    pub asset_mint: Pubkey,             // 32 bytes - Underlying token
    pub shares_mint: Pubkey,            // 32 bytes - LP token (Token-2022 + CT)
    pub asset_vault: Pubkey,            // 32 bytes - Token account
    pub total_assets: u64,              // 8 bytes  - Cached balance
    pub decimals_offset: u8,            // 1 byte   - Inflation protection
    pub bump: u8,                       // 1 byte   - PDA bump
    pub paused: bool,                   // 1 byte   - Emergency flag
    pub vault_id: u64,                  // 8 bytes  - Unique ID
    pub auditor_elgamal_pubkey: Option<[u8; 32]>,  // 1 + 32 bytes - Compliance
    pub confidential_authority: Pubkey, // 32 bytes - CT authority
    pub _reserved: [u8; 32],            // 32 bytes - Future upgrades
}
// Total: 8 (discriminator) + 244 = 252 bytes
```

**Additional Fields vs SVS-1:**

| Field | Purpose |
|-------|---------|
| `auditor_elgamal_pubkey` | Optional compliance key that can decrypt all balances |
| `confidential_authority` | Authority for confidential transfer operations (= vault PDA) |

### 2. Token-2022 Confidential Transfers

The shares mint uses `ConfidentialTransferMint` extension:

```rust
// Initialize in initialize.rs
let extensions = [ExtensionType::ConfidentialTransferMint];
let mint_size = ExtensionType::try_calculate_account_len::<Mint>(&extensions)?;

// Initialize ConfidentialTransferMint extension
let init_ct_ix = initialize_confidential_mint(
    &token_2022_program.key(),
    &shares_mint.key(),
    Some(vault_key),        // CT authority = vault PDA
    true,                   // auto_approve_new_accounts
    auditor_pubkey,         // Optional auditor ElGamal pubkey
)?;
```

**Extension Configuration:**

| Setting | Value | Rationale |
|---------|-------|-----------|
| `authority` | Vault PDA | Vault controls all confidential operations |
| `auto_approve_new_accounts` | `true` | Users can self-configure accounts |
| `auditor_elgamal_pubkey` | Optional | Compliance-friendly audit capability |

### 3. User Account Configuration

Users must configure their shares account before receiving confidential shares:

```
┌─────────────────────────────────────────────────────────────────┐
│ configure_account(decryptable_zero_balance, proof_offset)       │
├─────────────────────────────────────────────────────────────────┤
│ 1. Reallocate account for ConfidentialTransferAccount extension │
│ 2. Validate PubkeyValidityProof (via ZK ElGamal program)        │
│    - Proof in same tx (offset -1) OR                            │
│    - Pre-verified context state account                         │
│ 3. Configure account with:                                      │
│    - ElGamal public key (32 bytes)                              │
│    - Decryptable zero balance (36 bytes AES ciphertext)         │
│    - Maximum pending balance credit counter                     │
│ 4. Account now ready for confidential transfers                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4. Encryption Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Dual Encryption Model                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ElGamal (Twisted)                    AES-128-GCM                        │
│  ─────────────────                    ────────────                       │
│  • Homomorphic encryption             • Authenticated encryption         │
│  • On-chain balance updates           • Owner-only decryption            │
│  • ZK proof compatible                • Efficient balance lookup         │
│                                                                          │
│  Ciphertext = (C, D)                  Ciphertext = nonce ‖ ct ‖ tag      │
│  C = v·H + r·G                        12 + 8 + 16 = 36 bytes             │
│  D = r·P                                                                 │
│  64 bytes total                                                          │
│                                                                          │
│  Used for:                            Used for:                          │
│  • pending_balance                    • decryptable_available_balance    │
│  • available_balance                  • decryptable_pending_balance      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5. Key Derivation

Keys are derived deterministically from wallet signatures:

```typescript
// ElGamal keypair derivation
const elgamalMessage = Buffer.concat([
  Buffer.from("ElGamalSecretKey"),
  tokenAccount.toBuffer()
]);
const elgamalSignature = wallet.signMessage(elgamalMessage);
const elgamalKeypair = deriveElGamalKeypair(elgamalSignature);

// AES key derivation
const aesMessage = Buffer.concat([
  Buffer.from("AeKey"),
  tokenAccount.toBuffer()
]);
const aesSignature = wallet.signMessage(aesMessage);
const aesKey = deriveAesKey(aesSignature);
```

## Instruction Flows

### Initialize Flow (SVS-2)

```
┌─────────────────────────────────────────────────────────────────┐
│ initialize(vault_id, name, symbol, uri, auditor_elgamal_pubkey) │
├─────────────────────────────────────────────────────────────────┤
│ 1. Validate asset_decimals <= 9                                 │
│ 2. Create Vault PDA                                             │
│ 3. Calculate mint space with ConfidentialTransferMint extension │
│ 4. Create Shares Mint account (invoke_signed)                   │
│ 5. Initialize ConfidentialTransferMint extension                │
│    - authority = vault PDA                                      │
│    - auto_approve = true                                        │
│    - auditor = optional auditor pubkey                          │
│ 6. Initialize mint (Token-2022)                                 │
│ 7. Create Asset Vault ATA                                       │
│ 8. Initialize ConfidentialVault state                           │
│ 9. Emit VaultInitialized event                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Deposit Flow (SVS-2)

```
┌─────────────────────────────────────────────────────────────────┐
│ deposit(assets, min_shares_out)                                 │
├─────────────────────────────────────────────────────────────────┤
│ 1. Check !paused                                                │
│ 2. Check assets >= MIN_DEPOSIT_AMOUNT                           │
│ 3. Calculate shares = convert_to_shares(assets, Floor)          │
│ 4. Check shares >= min_shares_out (slippage)                    │
│ 5. CPI: transfer_checked (user assets → vault)                  │
│ 6. CPI: mint_to (shares → user NON-CONFIDENTIAL balance)        │
│ 7. CPI: confidential_deposit (non-conf → PENDING balance)       │
│    - Shares now encrypted in pending_balance                    │
│ 8. Update vault.total_assets += assets                          │
│ 9. Emit Deposit event                                           │
│                                                                 │
│ NOTE: User must call apply_pending to use shares!               │
└─────────────────────────────────────────────────────────────────┘

Balance Flow:
┌──────────────┐    mint_to    ┌──────────────┐  conf_deposit  ┌──────────────┐
│    Shares    │──────────────▶│ Non-Confid.  │───────────────▶│   Pending    │
│     Mint     │               │   Balance    │                │   Balance    │
└──────────────┘               └──────────────┘                └──────────────┘
                                    (u64)                      (ElGamal ct)
```

### Apply Pending Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ apply_pending(new_decryptable_balance, expected_credits)        │
├─────────────────────────────────────────────────────────────────┤
│ 1. Read current pending balance (encrypted)                     │
│ 2. Homomorphically add to available balance                     │
│    - available' = available + pending                           │
│ 3. User provides new_decryptable_balance (AES ciphertext)       │
│    - Client computes: decrypt(current) + pending = new          │
│    - Re-encrypts with AES for storage                           │
│ 4. Zero out pending balance                                     │
│ 5. Shares now usable for withdraw/redeem                        │
└─────────────────────────────────────────────────────────────────┘

Balance Flow:
┌──────────────┐    homomorphic    ┌──────────────┐
│   Pending    │────────add───────▶│  Available   │
│   Balance    │                   │   Balance    │
└──────────────┘                   └──────────────┘
  (zeroed out)                     (updated)
```

### Withdraw/Redeem Flow (SVS-2)

```
┌─────────────────────────────────────────────────────────────────┐
│ withdraw(assets, max_shares, new_decryptable_balance)           │
│ redeem(shares, min_assets, new_decryptable_balance)             │
├─────────────────────────────────────────────────────────────────┤
│ PREREQUISITES:                                                  │
│ • User has pre-verified EqualityProof context account           │
│ • User has pre-verified RangeProof context account              │
│                                                                 │
│ 1. Check !paused                                                │
│ 2. Calculate shares/assets (with proper rounding)               │
│ 3. Check slippage bounds                                        │
│ 4. CPI: inner_withdraw (confidential → non-confidential)        │
│    - Requires EqualityProof (proves amount ownership)           │
│    - Requires RangeProof (proves non-negative remainder)        │
│    - Updates decryptable_available_balance                      │
│ 5. CPI: burn (non-confidential shares)                          │
│ 6. CPI: transfer_checked (vault assets → user)                  │
│ 7. Update vault.total_assets -= assets                          │
│ 8. Emit Withdraw event                                          │
└─────────────────────────────────────────────────────────────────┘
```

## ZK Proof Requirements

### Proof Types

| Proof | Size | Required For | What It Proves |
|-------|------|--------------|----------------|
| `PubkeyValidityProof` | 64 bytes | `configure_account` | Ownership of ElGamal secret key |
| `CiphertextCommitmentEqualityProof` | 192 bytes | `withdraw`, `redeem` | Ciphertext encrypts claimed amount |
| `BatchedRangeProofU64` | 672+ bytes | `withdraw`, `redeem` | Values in range [0, 2^64) |

### Proof Submission Methods

```
Method 1: Instruction Offset
────────────────────────────
┌─────────────────────────────────────────────┐
│ Transaction                                  │
├─────────────────────────────────────────────┤
│ ix[0]: VerifyPubkeyValidity (ZK program)    │
│ ix[1]: configure_account (SVS-2)            │◀── proof_offset = -1
└─────────────────────────────────────────────┘

Method 2: Context State Account
────────────────────────────────
┌─────────────────────────────────────────────┐
│ Transaction 1: Create & Verify Proof        │
├─────────────────────────────────────────────┤
│ ix[0]: Create context account               │
│ ix[1]: VerifyEqualityProof → context        │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ Transaction 2: Use Proof                    │
├─────────────────────────────────────────────┤
│ ix[0]: withdraw (references context acct)   │
└─────────────────────────────────────────────┘
```

### ZK ElGamal Proof Program

Native program ID: `ZkE1Gama1Proof11111111111111111111111111111`

| Discriminator | Instruction |
|---------------|-------------|
| 0 | CloseContextState |
| 1 | VerifyZeroCiphertext |
| 2 | VerifyCiphertextCiphertextEquality |
| 3 | VerifyCiphertextCommitmentEquality |
| 4 | VerifyPubkeyValidity |
| 5 | VerifyPercentageWithCap |
| 6 | VerifyBatchedRangeProofU64 |
| 7 | VerifyBatchedRangeProofU128 |
| 8 | VerifyBatchedRangeProofU256 |

## Proof Backend Architecture

Since `solana-zk-sdk` lacks WASM bindings, proof generation requires a Rust backend:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Proof Backend (Axum)                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────┐    ┌─────────────────┐    ┌─────────────────────────┐  │
│  │   Routes    │    │    Services     │    │    solana-zk-sdk        │  │
│  │             │    │                 │    │                         │  │
│  │ /health     │───▶│ ProofGenerator  │───▶│ ElGamalKeypair          │  │
│  │ /api/proofs │    │                 │    │ PubkeyValidityProofData │  │
│  │  /pubkey    │    │ • derive_keypair│    │ EqualityProofData       │  │
│  │  /equality  │    │ • gen_pubkey_prf│    │ RangeProofData          │  │
│  │  /range     │    │ • gen_equality  │    │                         │  │
│  │             │    │ • gen_range     │    │                         │  │
│  └─────────────┘    └─────────────────┘    └─────────────────────────┘  │
│         │                    │                                           │
│         ▼                    ▼                                           │
│  ┌─────────────┐    ┌─────────────────┐                                 │
│  │ Middleware  │    │   Validation    │                                 │
│  │             │    │                 │                                 │
│  │ • API Key   │    │ • Signature     │                                 │
│  │ • CORS      │    │ • Timestamp     │                                 │
│  │ • Tracing   │    │ • Request size  │                                 │
│  └─────────────┘    └─────────────────┘                                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## PDA Architecture (SVS-2)

Same PDA structure as SVS-1, but shares mint has additional extension:

```
                        Program ID (SVS-2)
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
    ┌───────┐          ┌─────────┐         ┌─────────┐
    │ Vault │          │ Shares  │         │ Asset   │
    │  PDA  │──────────│  Mint   │         │ Vault   │
    │       │          │  PDA    │         │  ATA    │
    │       │          │ + CT Ext│         │         │
    └───────┘          └─────────┘         └─────────┘
                            │
                            ▼
                    ┌─────────────┐
                    │ User Shares │
                    │   Account   │
                    │ + CT Acct   │
                    │   Extension │
                    └─────────────┘
```

## Compute Budget (SVS-2)

Higher CU due to confidential transfer operations:

| Instruction | CU (approx) | Notes |
|-------------|-------------|-------|
| initialize | 80,000 | CT mint extension setup |
| configure_account | 45,000 | Account reallocation + CT setup |
| deposit | 65,000 | Mint + confidential deposit |
| mint | 65,000 | Mint + confidential deposit |
| apply_pending | 35,000 | Homomorphic balance update |
| withdraw | 75,000 | CT withdraw + burn + transfer |
| redeem | 75,000 | CT withdraw + burn + transfer |

## Security Invariants (SVS-2)

All SVS-1 invariants plus:

6. **Encryption Integrity**: ElGamal ciphertexts are well-formed
7. **Proof Validity**: All ZK proofs verified by native program before use
8. **Balance Consistency**: `decryptable_balance` matches `available_balance` when decrypted
9. **Pending Isolation**: Pending balance cannot be spent until applied
10. **Auditor Read-Only**: Auditor key can only decrypt, never modify

## Comparison: SVS-1 vs SVS-2

| Aspect | SVS-1 | SVS-2 |
|--------|-------|-------|
| Share balances | Public u64 | Encrypted ElGamal |
| Shares mint | Token-2022 + Metadata | Token-2022 + CT + Metadata |
| User account setup | None required | `configure_account` + proof |
| Deposit complexity | Simple CPI | Mint + confidential deposit |
| Withdraw complexity | Simple burn | ZK proofs + CT withdraw + burn |
| Backend required | No | Yes (for proofs) |
| Privacy level | None | Amount privacy |
| Compute cost | ~35K CU | ~65-75K CU |

## References

- [ERC-4626 Specification](https://eips.ethereum.org/EIPS/eip-4626)
- [OpenZeppelin Implementation](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/extensions/ERC4626.sol)
- [Anchor Framework](https://www.anchor-lang.com/)
- [Token-2022 Extensions](https://spl.solana.com/token-2022)
- [Token-2022 Confidential Transfers](https://solana.com/docs/tokens/extensions/confidential-transfer)
- [ZK ElGamal Proof Program](https://docs.anza.xyz/runtime/zk-elgamal-proof)
- [Twisted ElGamal Paper](https://iacr.org/archive/asiacrypt2004/33290377/33290377.pdf)
