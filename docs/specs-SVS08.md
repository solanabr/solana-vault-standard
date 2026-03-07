# SVS-8: Multi-Asset Vault

## Status: Draft
## Authors: Superteam Brasil
## Date: 2026-03-06
## Base: ERC-7575 adapted — Multi-token basket vault

---

## 1. Overview

SVS-8 holds a basket of multiple underlying SPL tokens. A single share mint represents proportional ownership of the entire portfolio. Deposits and redemptions can be made in any of the accepted assets (or all at once in proportion).

This vault type targets index funds, treasury management, diversified yield strategies, and any product where a single tokenized position represents exposure to multiple assets.

---

## 2. How It Differs from SVS-1

| Aspect | SVS-1 | SVS-8 |
|--------|-------|-------|
| Underlying assets | Single SPL token | N SPL tokens (configurable basket) |
| Asset vaults | One PDA-owned token account | N PDA-owned token accounts |
| `total_assets` | Single u64 | Weighted sum across all assets (denominated in base unit) |
| Deposit | Transfer one token | Transfer one or more basket tokens |
| Redeem | Receive one token | Receive proportional basket or single token |
| Share price | `total_assets / total_shares` | `weighted_total_value / total_shares` |

---

## 3. State

```rust
#[account]
pub struct MultiAssetVault {
    pub authority: Pubkey,
    pub shares_mint: Pubkey,
    pub total_shares: u64,
    pub decimals_offset: u8,
    pub bump: u8,
    pub paused: bool,
    pub vault_id: u64,
    pub num_assets: u8,              // number of assets in basket (max 8)
    pub base_decimals: u8,           // decimal precision for weighted value (e.g., 6 for USD)
    pub _reserved: [u8; 64],
}
// seeds: ["multi_vault", vault_id.to_le_bytes()]

#[account]
pub struct AssetEntry {
    pub vault: Pubkey,
    pub asset_mint: Pubkey,
    pub asset_vault: Pubkey,         // PDA-owned token account
    pub oracle: Pubkey,              // price oracle for this asset (Pyth, Switchboard, or svs-oracle)
    pub target_weight_bps: u16,      // target allocation (10000 = 100%)
    pub asset_decimals: u8,
    pub index: u8,                   // position in basket (0-indexed)
    pub bump: u8,
}
// seeds: ["asset_entry", vault_pda, asset_mint]
```

---

## 4. Pricing Model

Each asset's value is converted to a common base unit (e.g., USD with 6 decimals) using its oracle price:

```rust
/// Total portfolio value in base units
pub fn total_portfolio_value(
    assets: &[AssetEntry],
    balances: &[u64],
    prices: &[u64],         // price per token in base units (e.g., USDC price = 1_000_000)
) -> Result<u64> {
    let mut total: u128 = 0;
    for i in 0..assets.len() {
        // value = balance * price / 10^asset_decimals
        let value = (balances[i] as u128)
            .checked_mul(prices[i] as u128)?
            .checked_div(10u128.pow(assets[i].asset_decimals as u32))?;
        total = total.checked_add(value)?;
    }
    u64::try_from(total).map_err(|_| error!(VaultError::MathOverflow))
}

/// Share conversion uses total_portfolio_value as the denominator
pub fn convert_to_shares(
    deposit_value: u64,      // value of deposited assets in base units
    total_shares: u64,
    total_value: u64,        // total_portfolio_value
    offset: u64,
) -> Result<u64> {
    mul_div(deposit_value, total_shares + offset, total_value + 1, Rounding::Floor)
}
```

---

## 5. Instruction Set

| # | Instruction | Signer | Description |
|---|------------|--------|-------------|
| 1 | `initialize` | Authority | Creates MultiAssetVault PDA and share mint |
| 2 | `add_asset` | Authority | Adds an AssetEntry to the basket |
| 3 | `remove_asset` | Authority | Removes an asset (must have zero balance) |
| 4 | `update_weights` | Authority | Rebalances target weights (must sum to 10000) |
| 5 | `deposit_single` | User | Deposits one asset, mints shares based on its value |
| 6 | `deposit_proportional` | User | Deposits all assets in target weight proportions |
| 7 | `redeem_single` | User | Redeems shares for one asset |
| 8 | `redeem_proportional` | User | Redeems shares for proportional basket |
| 9 | `rebalance` | Authority | Swaps between asset vaults to match target weights |
| 10 | `pause` / `unpause` | Authority | Emergency controls |
| 11 | `transfer_authority` | Authority | Transfer admin |

### 5.1 `deposit_single`

```
deposit_single(asset_mint: Pubkey, amount: u64, min_shares_out: u64):
  ✓ asset_mint is in the basket (AssetEntry exists)
  ✓ amount > 0, vault not paused
  → Read oracle price for deposited asset
  → deposit_value = amount * price / 10^asset_decimals
  → Read all oracle prices, compute total_portfolio_value
  → shares = convert_to_shares(deposit_value, total_shares, total_value, offset)
  → require!(shares >= min_shares_out)
  → Transfer asset from user to asset_vault
  → Mint shares
  → emit Deposit { vault, asset_mint, amount, shares, value: deposit_value }
```

### 5.2 `deposit_proportional`

```
deposit_proportional(base_amount: u64, min_shares_out: u64):
  ✓ vault not paused
  → For each asset in basket:
      asset_amount = base_amount * asset.target_weight_bps / 10000
      Transfer asset_amount from user to asset_vault
  → total_deposit_value = sum of all asset values
  → shares = convert_to_shares(total_deposit_value, ...)
  → require!(shares >= min_shares_out)
  → Mint shares
  → emit ProportionalDeposit { vault, amounts: [...], shares }
```

### 5.3 `redeem_proportional`

```
redeem_proportional(shares: u64, min_values_out: [u64; N]):
  ✓ vault not paused, user has enough shares
  → total_value = total_portfolio_value()
  → redeem_value = convert_to_assets(shares, total_shares, total_value, offset)
  → For each asset:
      asset_share = asset_vault.amount * shares / total_shares
      require!(asset_share >= min_values_out[i])
      Transfer asset_share from asset_vault to user
  → Burn shares
  → emit ProportionalRedeem { vault, shares, amounts: [...] }
```

### 5.4 `rebalance`

Authority-initiated rebalancing to match target weights. Uses remaining accounts pattern to pass swap program (Jupiter) and route accounts.

```
rebalance(from_asset: Pubkey, to_asset: Pubkey, amount: u64, min_out: u64):
  ✓ signer == vault.authority
  → CPI to swap program (Jupiter aggregator)
  → Transfer `amount` of from_asset, receive >= min_out of to_asset
  → emit Rebalance { from_asset, to_asset, amount_in, amount_out }
```

---

## 6. Oracle Requirements

Each `AssetEntry` references a price oracle. The vault reads prices at deposit/redeem time. Supported oracle types:

- **Pyth:** Read `PriceUpdateV2` account, extract `price` and `expo`, check `publish_time` freshness.
- **Switchboard:** Read `AggregatorAccountData`, extract `latest_confirmed_round.result`.
- **svs-oracle:** Read `OraclePrice` account from the module interface (for custom/internal prices).

The vault validates freshness: `require!(oracle.updated_at > clock.unix_timestamp - MAX_STALENESS)`. Stale prices block all financial operations for that asset.

---

## 7. Remaining Accounts Pattern

With up to 8 assets, each having an asset_vault, AssetEntry PDA, and oracle account, a single instruction can require 24+ accounts. Solana's transaction account limit is 64, which is sufficient, but the instruction definition should use remaining accounts for the per-asset data:

```rust
#[derive(Accounts)]
pub struct DepositSingle<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub vault: Account<'info, MultiAssetVault>,
    pub shares_mint: Account<'info, Mint>,
    // ... standard accounts ...

    // Per-asset data passed as remaining_accounts:
    // [AssetEntry, asset_vault, oracle] × num_assets
}
```

---

## 8. Weight Invariant

`sum(target_weight_bps for all AssetEntry) == 10_000`

This invariant is checked on `add_asset`, `remove_asset`, and `update_weights`. The vault cannot enter a state where weights don't sum to 100%.

---

## 9. Single-Asset Deposit Imbalance

When a user deposits a single asset into a multi-asset vault, the portfolio drifts from target weights. This is acceptable — the authority can `rebalance` periodically. The vault does NOT auto-rebalance on deposit (that would require CPI to a swap program on every deposit, adding cost and complexity).

For vaults that want to enforce balanced deposits, `deposit_proportional` is the only enabled deposit method. The authority can disable `deposit_single` by setting a flag on the vault (future enhancement, not MVP).

---

## 10. Module Compatibility

**Implementation:** Build with `--features modules`. Module config PDAs passed via `remaining_accounts`.

- **svs-fees:** Fees computed on the base-unit value of the deposit/redemption.
- **svs-caps:** Global cap on total_portfolio_value. Per-user cap on cumulative deposited value.
- **svs-locks:** Works identically (share-based).
- **svs-rewards:** Compatible. Rewards distributed per-share regardless of underlying basket composition.
- **svs-access:** Compatible. Identity-based checks.

---

## 11. Limitations

- **Max 8 assets per basket.** Practical limit from account size and compute budget. Can be increased if Solana raises compute limits.
- **Oracle dependency.** Every financial operation requires fresh prices for ALL basket assets. A single stale oracle blocks the entire vault.
- **No atomic rebalancing.** Rebalance swaps are separate transactions. MEV is possible between legs of a multi-step rebalance. Mitigation: use Jupiter's route API for optimal execution in a single tx.
- **Share price tracking.** Divergence between actual portfolio weights and target weights means share price reflects actual holdings, not target allocation.

---

## 12. Jupiter CPI Integration

Rebalancing uses Jupiter aggregator for optimal swap execution:

```rust
/// Rebalance via Jupiter aggregator
pub fn rebalance_jupiter(
    ctx: Context<RebalanceJupiter>,
    route_data: Vec<u8>,  // Jupiter route payload (serialized)
    minimum_out: u64,     // Slippage protection
) -> Result<()> {
    let vault = &ctx.accounts.vault;

    // 1. Validate authority
    require!(ctx.accounts.authority.key() == vault.authority, VaultError::Unauthorized);

    // 2. Validate Jupiter program ID
    let jupiter_program = Pubkey::from_str("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4")
        .map_err(|_| VaultError::InvalidProgram)?;
    require!(
        ctx.accounts.jupiter_program.key() == jupiter_program,
        VaultError::InvalidProgram
    );

    // 3. Deserialize route to get expected amounts
    let route = JupiterRoute::deserialize(&route_data)?;

    // 4. Record balances before swap
    let from_balance_before = ctx.accounts.from_asset_vault.amount;
    let to_balance_before = ctx.accounts.to_asset_vault.amount;

    // 5. Execute swap via Jupiter CPI
    // Note: remaining_accounts contains all Jupiter route accounts
    let vault_seeds = &[
        b"multi_vault",
        &vault.vault_id.to_le_bytes(),
        &[vault.bump],
    ];
    let signer_seeds = &[&vault_seeds[..]];

    invoke_signed(
        &jupiter_instruction(&route_data, &ctx.remaining_accounts),
        &ctx.remaining_accounts.to_vec(),
        signer_seeds,
    )?;

    // 6. Reload and verify output
    ctx.accounts.to_asset_vault.reload()?;
    let received = ctx.accounts.to_asset_vault.amount
        .checked_sub(to_balance_before)
        .ok_or(VaultError::MathOverflow)?;

    require!(received >= minimum_out, VaultError::SlippageExceeded);

    // 7. Validate weight invariant still holds
    // (Portfolio value should be approximately the same, just rebalanced)

    emit!(Rebalance {
        vault: vault.key(),
        from_asset: ctx.accounts.from_asset_mint.key(),
        to_asset: ctx.accounts.to_asset_mint.key(),
        amount_in: from_balance_before - ctx.accounts.from_asset_vault.amount,
        amount_out: received,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RebalanceJupiter<'info> {
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    pub authority: Signer<'info>,

    #[account(mut)]
    pub from_asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub to_asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub from_asset_mint: InterfaceAccount<'info, Mint>,
    pub to_asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Validated against known Jupiter program ID
    pub jupiter_program: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,

    // remaining_accounts: Jupiter route accounts (varies per route)
}
```

---

## 13. Oracle Staleness Validation

```rust
/// Validate oracle price is fresh and confident
pub fn validate_oracle_price(
    oracle: &AccountInfo,
    max_staleness_secs: u64,
    max_confidence_pct: u64,  // e.g., 100 = 1%
) -> Result<OraclePrice> {
    let clock = Clock::get()?;
    let current_time = clock.unix_timestamp as u64;

    // Pyth price feed validation
    let price_feed = load_price_feed_from_account_info(oracle)
        .map_err(|_| VaultError::InvalidOracle)?;

    let price_data = price_feed.get_price_no_older_than(
        current_time as i64,
        max_staleness_secs,
    ).ok_or(VaultError::OracleStale)?;

    // Check confidence interval
    // confidence should be < price * max_confidence_pct / 10000
    let price_abs = price_data.price.abs() as u64;
    let max_confidence = price_abs
        .checked_mul(max_confidence_pct)?
        .checked_div(10000)?;

    require!(
        (price_data.conf as u64) <= max_confidence,
        VaultError::OracleUncertain
    );

    Ok(OraclePrice {
        price: price_data.price,
        expo: price_data.expo,
        confidence: price_data.conf,
        updated_at: price_data.publish_time,
    })
}

/// Read all basket prices, blocking if any are stale
pub fn read_all_prices(
    assets: &[AssetEntry],
    oracles: &[AccountInfo],
    max_staleness: u64,
) -> Result<Vec<u64>> {
    let mut prices = Vec::with_capacity(assets.len());

    for (asset, oracle) in assets.iter().zip(oracles.iter()) {
        let price = validate_oracle_price(oracle, max_staleness, 100)?;  // 1% confidence

        // Normalize to base decimals
        let normalized = normalize_price(price.price, price.expo, asset.asset_decimals)?;
        prices.push(normalized);
    }

    Ok(prices)
}
```

### Oracle Staleness Behavior

| Scenario | Behavior |
|----------|----------|
| All oracles fresh | Operations proceed normally |
| One oracle stale | ALL operations blocked (deposit, redeem, rebalance) |
| Oracle confidence too wide | Treated as stale, operations blocked |
| Oracle account invalid | Transaction fails with `InvalidOracle` |

**Rationale**: A multi-asset vault cannot compute accurate share prices with partial price data. Better to fail fast than allow incorrect valuations.

---

## 14. add_asset Pseudocode

```rust
pub fn add_asset(
    ctx: Context<AddAsset>,
    target_weight_bps: u16,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;

    // 1. Validate authority
    require!(
        ctx.accounts.authority.key() == vault.authority,
        VaultError::Unauthorized
    );

    // 2. Validate max assets not exceeded
    require!(vault.num_assets < 8, VaultError::MaxAssetsExceeded);

    // 3. Calculate current total weight
    let mut current_total_weight: u16 = 0;
    // Note: would need to iterate existing AssetEntry accounts
    // Passed as remaining_accounts for efficiency
    for asset_info in ctx.remaining_accounts.iter() {
        let asset: Account<AssetEntry> = Account::try_from(asset_info)?;
        current_total_weight = current_total_weight
            .checked_add(asset.target_weight_bps)
            .ok_or(VaultError::MathOverflow)?;
    }

    // 4. Validate new weight won't exceed 10000 bps
    require!(
        current_total_weight.checked_add(target_weight_bps).ok_or(VaultError::MathOverflow)? <= 10000,
        VaultError::InvalidWeight
    );

    // 5. Validate oracle is readable
    validate_oracle_price(
        &ctx.accounts.oracle,
        300,  // 5 minute staleness for setup
        500,  // 5% confidence for setup
    )?;

    // 6. Initialize AssetEntry PDA
    let asset_entry = &mut ctx.accounts.asset_entry;
    asset_entry.vault = vault.key();
    asset_entry.asset_mint = ctx.accounts.asset_mint.key();
    asset_entry.asset_vault = ctx.accounts.asset_vault.key();
    asset_entry.oracle = ctx.accounts.oracle.key();
    asset_entry.target_weight_bps = target_weight_bps;
    asset_entry.asset_decimals = ctx.accounts.asset_mint.decimals;
    asset_entry.index = vault.num_assets;
    asset_entry.bump = ctx.bumps.asset_entry;

    // 7. Increment asset count
    vault.num_assets = vault.num_assets.checked_add(1).ok_or(VaultError::MathOverflow)?;

    emit!(AssetAdded {
        vault: vault.key(),
        asset_mint: ctx.accounts.asset_mint.key(),
        oracle: ctx.accounts.oracle.key(),
        target_weight_bps,
        index: asset_entry.index,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct AddAsset<'info> {
    #[account(mut, has_one = authority)]
    pub vault: Account<'info, MultiAssetVault>,

    pub authority: Signer<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Validated via oracle reading
    pub oracle: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + AssetEntry::INIT_SPACE,
        seeds = [b"asset_entry", vault.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub asset_entry: Account<'info, AssetEntry>,

    #[account(
        init,
        payer = authority,
        token::mint = asset_mint,
        token::authority = vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    // remaining_accounts: existing AssetEntry accounts for weight calculation
}
```

---

## 15. Compute Unit Estimates

| Instruction | Approximate CU | Notes |
|-------------|---------------|-------|
| `initialize` | ~25,000 | Create vault + shares mint |
| `add_asset` | ~35,000 | Create AssetEntry + asset_vault |
| `deposit_single` | ~50,000 | Read all oracles + transfer + mint |
| `deposit_proportional` | ~80,000 | N transfers + N oracle reads |
| `redeem_proportional` | ~90,000 | N transfers + burn |
| `rebalance` | ~100,000+ | Jupiter CPI (varies by route) |

---

## See Also

- [SVS-1](./SVS-1.md) — Base single-asset vault
- [specs-modules.md](./specs-modules.md#36-svs-oracle) — Oracle module interface
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Cross-variant design
