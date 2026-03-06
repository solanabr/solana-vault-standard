# SVS-7: Native SOL Vault

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06
## Base: ERC-7535 adapted — Native asset vault for Solana

---

## 1. Overview

SVS-7 accepts and returns native SOL instead of SPL tokens. It handles SOL ↔ wSOL wrapping internally so users interact with native lamports while the vault's internal accounting uses a wSOL token account. Shares are still Token-2022 SPL tokens.

This vault type targets liquid staking, SOL yield strategies, and any product where requiring users to pre-wrap SOL creates unnecessary friction.

---

## 2. How It Differs from SVS-1

| Aspect | SVS-1 | SVS-7 |
|--------|-------|-------|
| Asset token | Any SPL / Token-2022 mint | Native SOL (lamports) |
| User interaction | Transfer SPL tokens | Transfer native SOL via system_program |
| Internal accounting | SPL token account balance | wSOL token account balance |
| Wrap/unwrap | User's responsibility | Vault handles internally |
| Asset mint | Configurable | Always `So11111111111111111111111111111111` (native mint) |

---

## 3. State

```rust
#[account]
pub struct SolVault {
    pub authority: Pubkey,
    pub shares_mint: Pubkey,         // Token-2022 share token
    pub wsol_vault: Pubkey,          // PDA-owned wSOL token account
    pub total_assets: u64,           // tracked in lamports
    pub decimals_offset: u8,         // 0 (SOL has 9 decimals, 9-9=0, offset=1)
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub balance_model: BalanceModel, // Live or Stored (like SVS-1 vs SVS-2)
    pub _reserved: [u8; 64],
}
// seeds: ["sol_vault", vault_id.to_le_bytes()]

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum BalanceModel {
    Live,    // reads wsol_vault.amount directly
    Stored,  // uses vault.total_assets, requires sync()
}
```

---

## 4. Instruction Set

| # | Instruction | Signer | Description |
|---|------------|--------|-------------|
| 1 | `initialize` | Authority | Creates SolVault PDA, share mint, wSOL vault account |
| 2 | `deposit_sol` | User | Transfers native SOL → wraps to wSOL → mints shares |
| 3 | `deposit_wsol` | User | Transfers existing wSOL → mints shares (no wrap needed) |
| 4 | `mint_sol` | User | Mints exact shares, pays native SOL |
| 5 | `withdraw_sol` | User | Burns shares → unwraps wSOL → transfers native SOL to user |
| 6 | `withdraw_wsol` | User | Burns shares → transfers wSOL to user (no unwrap) |
| 7 | `redeem_sol` | User | Redeems shares for native SOL |
| 8 | `redeem_wsol` | User | Redeems shares for wSOL |
| 9 | `sync` | Authority | Updates total_assets (Stored model only) |
| 10 | `pause` / `unpause` | Authority | Emergency controls |
| 11 | `transfer_authority` | Authority | Transfer admin |

### 4.1 `deposit_sol` Flow

```
deposit_sol(lamports: u64, min_shares_out: u64):
  ✓ lamports > 0
  ✓ vault not paused
  → system_program::transfer(user → vault PDA, lamports)
  → Create temporary wSOL account OR sync_native on vault's wSOL account
  → Compute shares = convert_to_shares(lamports, total_shares, total_assets, offset)
  → require!(shares >= min_shares_out)
  → Mint shares to user
  → Update total_assets (if Stored model)
  → emit Deposit { vault, caller, owner, assets: lamports, shares }
```

### 4.2 `withdraw_sol` Flow

```
withdraw_sol(lamports: u64, max_shares_in: u64):
  ✓ lamports > 0
  ✓ vault not paused
  → Compute shares = convert_to_shares_for_withdraw(lamports) // ceiling
  → require!(shares <= max_shares_in)
  → Burn shares from user
  → Close wSOL to vault PDA (unwraps to native SOL)
    OR transfer wSOL then close_account to unwrap
  → system_program::transfer(vault PDA → user, lamports)
  → Update total_assets (if Stored model)
  → emit Withdraw { vault, caller, receiver, owner, assets: lamports, shares }
```

---

## 5. SOL Wrapping Mechanics

Solana's native mint (`So11111111111111111111111111111111`) requires special handling:

**Depositing SOL:**
1. User transfers native lamports to vault PDA via `system_program::transfer`
2. Vault calls `sync_native` on its wSOL token account to update the token balance to match lamport balance
3. Internal accounting uses the wSOL token account balance

**Withdrawing SOL:**
1. Vault transfers wSOL from vault account to a temporary wSOL account owned by vault PDA
2. Vault calls `close_account` on the temporary account, which unwraps wSOL to native lamports sent to the user

**Alternative approach:** The vault PDA holds native SOL directly (no wSOL account). `total_assets` = vault PDA lamport balance minus rent. This is simpler but makes CPI to external DeFi protocols harder since most expect SPL token accounts. The wSOL approach is preferred for composability.

---

## 6. Rent Handling

The vault PDA must maintain rent-exempt minimum balance. This must be excluded from `total_assets`:

```rust
pub fn total_assets_excluding_rent(vault_lamports: u64) -> u64 {
    let rent_exempt = Rent::get()?.minimum_balance(SolVault::LEN);
    vault_lamports.saturating_sub(rent_exempt)
}
```

If using the wSOL approach, rent is on the wSOL token account and is handled by the SPL Token program. The vault PDA itself doesn't hold assets.

---

## 7. Decimals

SOL has 9 decimals. The virtual offset exponent is `9 - 9 = 0`, so `offset = 10^0 = 1`. This provides minimal inflation attack protection. Consider using a higher fixed offset (e.g., `offset = 1_000`) for SOL vaults, or requiring a minimum initial deposit.

---

## 8. Dual Interface

SVS-7 exposes both `_sol` and `_wsol` variants for each operation. This allows:
- End users to interact with native SOL (better UX)
- Protocols and smart contracts to interact with wSOL (better composability)
- The vault's internal state is identical regardless of which interface is used

---

## 9. Module Compatibility

All modules from `specs-modules.md` are compatible:

- **svs-fees:** Fees computed on lamport amounts. Fee assets sent as native SOL to fee_recipient.
- **svs-caps:** Caps denominated in lamports.
- **svs-locks:** Works identically (share-based, not asset-based).
- **svs-rewards:** Reward tokens are separate mints, unaffected by SOL handling.
- **svs-access:** Identity-based checks, fully compatible.

---

## 10. Use Cases

- **Liquid staking vaults:** Accept SOL, stake across validators, issue liquid staking shares. Yield distributed via Stored model + `sync()`.
- **SOL savings vaults:** Accept SOL, deploy to lending protocols (Kamino, MarginFi), auto-compound. Live model reads returns directly.
- **SOL DCA vaults:** Accept SOL, shares represent a position that executes periodic swaps. Streaming model (SVS-5 style) could be layered on.
