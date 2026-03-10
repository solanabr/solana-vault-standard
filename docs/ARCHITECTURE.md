# SVS Architecture

## Overview

The Solana Vault Standard (SVS) provides tokenized vault programs for Solana. Four program variants cover the matrix of public/private and live/stored balance models.

## SVS Variants Matrix

```
                    PUBLIC                    PRIVATE
                    (Token-2022, no ext)      (Token-2022 + CT)
                +-----------------+-----------------+
    LIVE        |                 |                 |
    BALANCE     |     SVS-1       |     SVS-3       |
    (No sync)   |                 |                 |
                +-----------------+-----------------+
    STORED      |                 |                 |
    BALANCE     |     SVS-2       |     SVS-4       |
    (With sync) |                 |                 |
                +-----------------+-----------------+
```

## Account Structure

### PDA Derivation

| Account | Seeds | Owner |
|---------|-------|-------|
| Vault | `["vault", asset_mint, vault_id.to_le_bytes()]` | Program |
| Shares Mint | `["shares", vault_pubkey]` | Token-2022 |
| Asset Vault | `ATA(asset_mint, vault)` | Vault PDA |

The vault PDA is the authority for both the shares mint (can mint/burn) and the asset vault token account (can transfer out).

### State Structs

**Vault (SVS-1, SVS-2) — 211 bytes:**
```rust
pub struct Vault {
    pub authority: Pubkey,       // 32 — admin (pause/unpause/transfer)
    pub asset_mint: Pubkey,      // 32 — underlying token
    pub shares_mint: Pubkey,     // 32 — LP share token (Token-2022)
    pub asset_vault: Pubkey,     // 32 — ATA holding assets
    pub total_assets: u64,       // 8  — SVS-1: unused, SVS-2: cached balance
    pub decimals_offset: u8,     // 1  — 9 - asset_decimals
    pub bump: u8,                // 1  — stored PDA bump
    pub paused: bool,            // 1
    pub vault_id: u64,           // 8  — allows multiple vaults per asset
    pub _reserved: [u8; 64],     // 64
}
```

**ConfidentialVault (SVS-3, SVS-4) — 254 bytes:**
```rust
pub struct ConfidentialVault {
    // ... same base fields as Vault, plus:
    pub auditor_elgamal_pubkey: Option<[u8; 32]>, // 33 — optional compliance auditor
    pub confidential_authority: Pubkey,            // 32 — CT authority
    pub _reserved: [u8; 32],                       // 32
}
```

The different struct names mean the Anchor IDL generates different account discriminators. The core SDK (`SolanaVault`) fetches `program.account["vault"]` and will not work with SVS-3/4 programs which expose `program.account["confidentialVault"]`.

## Balance Models

### Live Balance (SVS-1, SVS-3)

All calculations use `asset_vault.amount` directly — the actual token account balance.

```
total_assets = asset_vault.amount  (read every instruction)
```

- External donations immediately reflected in share price
- No sync timing attack vulnerability
- `vault.total_assets` field exists but is unused (always 0)
- Simpler trust model: no authority action needed to recognize yield

### Stored Balance (SVS-2, SVS-4)

Calculations use `vault.total_assets` — a cached value in the vault account.

```
total_assets = vault.total_assets  (updated via sync() or deposit/withdraw)
```

- Requires `sync()` call to recognize external deposits
- Authority controls when yield is recognized
- `sync()` sets `vault.total_assets = asset_vault.amount`
- Deposit/withdraw update `vault.total_assets` arithmetically

**When to use which**: If 100% of assets live in the vault ATA, use SVS-1. If assets leave the ATA (deployed to other protocols, bridged, managed off-chain), use SVS-2.

## Math

### Virtual Offset (Inflation Attack Protection)

```
offset = 10^(9 - asset_decimals)

shares = assets * (total_shares + offset) / (total_assets + 1)
assets = shares * (total_assets + 1) / (total_shares + offset)
```

All intermediate calculations use u128 to prevent overflow. The `+1` and `+offset` create "virtual" assets and shares that make the first-depositor inflation attack economically unviable.

Examples:
- USDC (6 decimals): offset = 1,000
- SOL (9 decimals): offset = 1
- 0-decimal token: offset = 1,000,000,000

### Rounding Direction

All operations round in favor of the vault to prevent value extraction:

| Operation | Function | Rounding | Effect |
|-----------|----------|----------|--------|
| deposit | `convert_to_shares` | Floor | User gets fewer shares |
| mint | `convert_to_assets` | Ceiling | User pays more assets |
| withdraw | `convert_to_shares` | Ceiling | User burns more shares |
| redeem | `convert_to_assets` | Floor | User receives fewer assets |

### mul_div Implementation

```rust
fn mul_div(a: u64, b: u64, c: u64, rounding: Rounding) -> Result<u64> {
    let numerator = (a as u128).checked_mul(b as u128)?;
    let result = match rounding {
        Rounding::Floor => numerator / (c as u128),
        Rounding::Ceiling => (numerator + (c as u128) - 1) / (c as u128),
    };
    Ok(result as u64)
}
```

## Token Programs

| Component | Token Program | Why |
|-----------|--------------|-----|
| Shares Mint | Token-2022 | Required for CT extension in SVS-3/4, used consistently across all variants |
| Asset Mint | SPL Token or Token-2022 | Auto-detected by SDK; supports both |
| Asset Vault | Matches asset mint | ATA uses same program as the mint |

## View Functions

All view functions use `set_return_data()` for CPI composability — other programs can call them and read the result.

### SVS-1/SVS-2 vs SVS-3/SVS-4

| Function | SVS-1/SVS-2 | SVS-3/SVS-4 |
|----------|-------------|-------------|
| `max_withdraw` | User's shares converted to assets (requires `owner_shares_account`) | Vault's total assets (can't read encrypted balances) |
| `max_redeem` | User's share balance (requires `owner_shares_account`) | `u64::MAX` (can't read encrypted balances) |
| All others | Identical | Identical |

SVS-1/SVS-2 define a `VaultViewWithOwner` context struct for `max_withdraw`/`max_redeem` that includes the user's shares token account. SVS-3/SVS-4 use the base `VaultView` context since on-chain code can't decrypt confidential balances.

## Security Considerations

### Inflation/Donation Attack Protection

The virtual offset mechanism prevents the classic "first depositor" attack by ensuring share price starts at approximately 1:1. An attacker would need to donate `offset` tokens to move the price by 1 unit.

### Sync Timing Attack (SVS-2, SVS-4)

Since `sync()` is authority-controlled, a malicious authority could front-run large deposits by syncing yield just before. Mitigations:
- Use SVS-1/SVS-3 for trustless scenarios
- Add timelocks on sync (SDK module, not on-chain)
- Use multisig authority

### Proof Context Injection (SVS-3, SVS-4)

SVS-3/SVS-4 validate proof context accounts by checking `account.owner == zk_elgamal_proof_program::id()`. This prevents passing arbitrary accounts as "verified" proofs.

### Account Reloading

After CPIs that modify token accounts (transfer, mint, burn), account data must be current. Anchor's account deserialization happens at instruction entry, so operations that need post-CPI state read `asset_vault.amount` before any CPIs and calculate the expected result arithmetically rather than re-reading.

---

## CPI Signer Seeds Pattern

When the vault PDA needs to sign CPIs (mint shares, transfer assets), construct signer seeds from stored values.

### Critical: Always Use Stored Bump

```rust
// WRONG - Wastes ~1500 CU per access, potential security issue
let (_, bump) = Pubkey::find_program_address(&seeds, &program_id);

// CORRECT - Use stored bump from vault state
let bump = ctx.accounts.vault.bump;
```

### Complete Signer Seeds Construction

```rust
let asset_mint_key = ctx.accounts.vault.asset_mint;
let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
let bump = ctx.accounts.vault.bump;  // STORED bump

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
        signer_seeds,
    ),
    amount,
    decimals,
)?;
```

See [PATTERNS.md](PATTERNS.md#3-pda-signer-seeds-pattern) for complete examples.

---

## Compute Unit Estimates

Approximate CU costs per instruction type:

| Instruction | SVS-1 | SVS-2 | SVS-3 | SVS-4 | Notes |
|-------------|-------|-------|-------|-------|-------|
| `initialize` | ~50k | ~50k | ~65k | ~65k | Mint creation overhead |
| `deposit` | ~25k | ~27k | ~150k | ~155k | CT adds ~120k for proofs |
| `mint` | ~25k | ~27k | ~150k | ~155k | Same as deposit |
| `withdraw` | ~30k | ~32k | ~180k | ~185k | CT withdraw more expensive |
| `redeem` | ~30k | ~32k | ~180k | ~185k | Same as withdraw |
| `sync` | N/A | ~8k | N/A | ~8k | Simple state update |
| `pause/unpause` | ~5k | ~5k | ~5k | ~5k | State flag only |
| `configure_account` | N/A | N/A | ~80k | ~80k | Account reallocation |
| `apply_pending` | N/A | N/A | ~40k | ~40k | CT state update |

**Notes**:
- SVS-1/2 are significantly cheaper than SVS-3/4
- Proof verification is the main cost in confidential variants
- `init_if_needed` on shares account adds ~5k on first deposit

---

## Account Sizes

| Account Type | Size (bytes) | Variants |
|--------------|-------------|----------|
| Vault | 219 | SVS-1, SVS-2 |
| ConfidentialVault | 252 | SVS-3, SVS-4 |
| TokenAccount (SPL) | 165 | Asset accounts |
| TokenAccount (Token-2022) | 165+ | Shares, +CT extension |
| Mint (SPL) | 82 | Asset mints |
| Mint (Token-2022) | 82+ | Shares mint, +extensions |

### Module Config PDAs

| Account Type | Size (bytes) | Module |
|--------------|-------------|--------|
| FeeConfig | 97 | svs-fees |
| CapConfig | 57 | svs-caps |
| UserDeposit | 81 | svs-caps |
| LockConfig | 49 | svs-locks |
| ShareLock | 81 | svs-locks |
| AccessConfig | 74 | svs-access |
| FrozenAccount | 113 | svs-access |
| RewardConfig | 161 | svs-rewards |
| UserReward | 129 | svs-rewards |

---

## Module Integration Points

Modules hook into core vault instructions at specific points:

```
┌─────────────────────────────────────────────────────────────┐
│                     DEPOSIT INSTRUCTION                      │
├─────────────────────────────────────────────────────────────┤
│  1. Validation                                               │
│     └── svs-access: verify_access(), check_not_frozen()     │
│     └── svs-caps: check_global_cap(), check_user_cap()      │
│                                                              │
│  2. Compute shares                                           │
│                                                              │
│  3. Apply fees                                               │
│     └── svs-fees: apply_entry_fee()                         │
│                                                              │
│  4. Execute transfer + mint                                  │
│                                                              │
│  5. Update locks                                             │
│     └── svs-locks: set_lock()                               │
│                                                              │
│  6. Update rewards                                           │
│     └── svs-rewards: update_reward_debt()                   │
│                                                              │
│  7. Emit event                                               │
└─────────────────────────────────────────────────────────────┘
```

### Module Config PDAs

Each module stores configuration in a PDA derived from the vault:

```rust
// Module config derivation pattern
seeds = [MODULE_SEED, vault.key().as_ref()]

// Per-user tracking PDAs add user pubkey
seeds = [USER_SEED, vault.key().as_ref(), user.key().as_ref()]
```

See [specs-modules.md](specs-modules.md) for complete module specifications.

---

## Extended Variants (SVS-5 through SVS-12)

Beyond the core 4 variants, SVS defines additional specialized vaults:

| Variant | Purpose | Key Difference |
|---------|---------|----------------|
| SVS-5 | Streaming Yield | Time-interpolated yield distribution |
| SVS-6 | Streaming + Confidential | SVS-5 with encrypted balances |
| SVS-7 | Native SOL | Direct SOL deposits (wraps internally) |
| SVS-8 | Multi-Asset | Portfolio of multiple tokens |
| SVS-9 | Allocator | Vault-of-vaults (MetaMorpho pattern) |
| SVS-10 | Async | Request → Fulfill → Claim flow |
| SVS-11 | Credit Markets | Async + KYC + Oracle NAV |
| SVS-12 | Tranched | Multiple share classes with waterfall |

See individual spec files (`specs-SVS{N}.md`) for details.

---

## EVM Reference

SVS is a native Solana port of ERC-4626. Key mappings:

| SVS | EVM Standard |
|-----|--------------|
| SVS-1/2/3/4 | [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626) |
| SVS-10 | [ERC-7540](https://eips.ethereum.org/EIPS/eip-7540) (Async) |
| SVS-9 | [MetaMorpho](https://github.com/morpho-org/metamorpho) |
| SVS-12 | [Centrifuge Tinlake](https://github.com/centrifuge/tinlake) |

See [ERC-4626-REFERENCE.md](ERC-4626-REFERENCE.md) for complete EVM mapping.

---

## Related Documentation

- [PATTERNS.md](PATTERNS.md) - Implementation patterns for contributors
- [SECURITY.md](SECURITY.md) - Security model and attack vectors
- [ERRORS.md](ERRORS.md) - Error code reference
- [CONSTANTS.md](CONSTANTS.md) - PDA seeds and numeric constants
- [EVENTS.md](EVENTS.md) - Event definitions and parsing
