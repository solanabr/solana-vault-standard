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
