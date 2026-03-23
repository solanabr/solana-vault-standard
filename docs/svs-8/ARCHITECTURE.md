# SVS-8 Architecture

## State Layouts

### MultiAssetVault (149 bytes)

```
Offset  Size  Field
──────  ────  ─────
0       8     Anchor discriminator
8       32    authority: Pubkey
40      32    shares_mint: Pubkey
72      1     decimals_offset: u8
73      1     bump: u8
74      1     paused: bool
75      8     vault_id: u64
83      1     num_assets: u8
84      1     base_decimals: u8
85      64    _reserved: [u8; 64]
```

**PDA seeds**: `["multi_vault", vault_id.to_le_bytes()]`

### AssetEntry (142 bytes)

```
Offset  Size  Field
──────  ────  ─────
0       8     Anchor discriminator
8       32    vault: Pubkey
40      32    asset_mint: Pubkey
72      32    asset_vault: Pubkey
104     32    oracle: Pubkey
136     1     oracle_type: u8
137     2     target_weight_bps: u16 (LE)
139     1     asset_decimals: u8
140     1     index: u8
141     1     bump: u8
```

**PDA seeds**: `["asset_entry", vault_pubkey, asset_mint]`

### Asset Vault

Standard Associated Token Account (ATA) owned by the vault PDA:
```
ATA(asset_mint, MultiAssetVault PDA, asset_token_program)
```

### Shares Mint

Token-2022 mint, PDA seeds: `["shares", vault_pubkey]`. Authority is the vault PDA. 9 decimals.

## Remaining Accounts Layout

Instructions that operate across all assets use `remaining_accounts` with per-asset groupings:

| Instruction | Per-Asset Group | Accounts/Asset | Writable |
|---|---|---|---|
| `deposit_single` | `[entry, vault, oracle]` | 3 | vault: no |
| `deposit_proportional` | `[entry, vault, oracle, mint, user_ata, token_program]` | 6 | vault: yes, user_ata: yes |
| `redeem_proportional` | `[entry, vault, mint, user_ata, token_program]` | 5 | vault: yes, user_ata: yes |
| `update_weights` | `[entry]` | 1 | entry: yes |
| `add_asset` | `[existing_entries...]` | 1 | no |
| View functions | `[entry, vault, oracle]` | 3 | no |

**Validation**: Each instruction requires `remaining_accounts.len() == num_assets * group_size`. Entries are validated via PDA re-derivation against `vault_key` and `asset_mint`.

### ParsedAssetEntry (Raw Byte Parsing)

`remaining_accounts` cannot use Anchor's `Account::try_from` due to lifetime constraints. Instead, `ParsedAssetEntry` reads fields directly from raw account bytes:

```rust
impl ParsedAssetEntry {
    pub fn from_account_data(data: &[u8]) -> Result<Self>
    pub fn validate_pda(&self, key: &Pubkey, vault_key: &Pubkey, program_id: &Pubkey) -> Result<()>
}
```

Token balances are read via `read_token_balance()` which extracts the u64 amount at offset 64 from SPL Token account data.

## Oracle Integration

### Mock Oracle Format

```
[price: u64 LE (8 bytes), updated_at: i64 LE (8 bytes)]
```

Oracle accounts are owned by the SVS-8 program (created via `SystemProgram.createAccount` with `programId = svs_8`).

### Price Reading

`read_mock_oracle_price()` in `deposit_single.rs`:
1. Validates data length >= 16
2. Parses price (u64 LE) and updated_at (i64 LE)
3. Requires `price > 0`
4. Validates freshness via `svs_oracle::validate_freshness(updated_at, current_timestamp, MAX_ORACLE_STALENESS)`

`MAX_ORACLE_STALENESS = 300` seconds (5 minutes).

### svs-oracle Module

The `svs-oracle` module provides:
- **`OracleType`** enum: `Pyth(0)`, `Switchboard(1)`, `Custom(2)`
- **`read_oracle_price(data, oracle_type, max_staleness, current_timestamp)`**: Feature-gated provider dispatch
- **`NormalizedPrice`**: Unified output `{ price, confidence, updated_at }`
- **Validation**: `validate_freshness`, `validate_price`, `validate_deviation`
- **Feature flags**: `custom`, `pyth`, `switchboard` — each enables the corresponding provider

SVS-8 currently uses the inline `read_mock_oracle_price()`. Migration to `svs_oracle::read_oracle_price()` is planned for a future PR.

### Test Utilities

The `set_oracle_data` instruction (behind `#[cfg(feature = "test-utils")]`) allows tests to write price data to mock oracle accounts. This avoids the need for bankrun or validator fixtures.

## Portfolio Math

All math in `math.rs` uses `u128` intermediates via `svs_math::mul_div` with configurable rounding.

### Total Portfolio Value

```
total_value = Σ (balance[i] * price[i] / 10^decimals[i])
```

Computed in a single pass over all assets. Each term uses `u128` multiplication then division. Final result cast to `u64`.

### Deposit to Shares

```
deposit_value = amount * price / 10^decimals

virtual_shares = total_shares + 10^decimals_offset
virtual_value  = total_value + 1

shares = deposit_value * virtual_shares / virtual_value  (floor)
```

The virtual offset prevents inflation attacks on empty/low-supply vaults.

### Redeem (Single Asset)

```
amount_out = shares * asset_vault.amount / total_shares  (floor)
```

No oracle needed. Direct proportional withdrawal.

### Redeem (Proportional)

Per asset:
```
amount_out[i] = shares * balance[i] / total_shares  (floor)
```

### Asset Value in Base Units

```
value = balance * price / 10^asset_decimals
```

## Module Compatibility

Optional modules are behind `#[cfg(feature = "modules")]`:
- `svs-fees`: Fee calculations
- `svs-caps`: Deposit/withdrawal caps
- `svs-locks`: Time-locked operations
- `svs-access`: Access control lists
- `svs-rewards`: Reward distribution
- `svs-module-hooks`: Pre/post instruction hooks

These are declared as optional dependencies in `Cargo.toml` and activated via the `modules` feature flag. The core program compiles and operates without them.

## Instruction Flow Diagrams

### deposit_single

```
User → deposit_single(amount, min_shares_out)
  │
  ├─ Validate: amount > 0, amount >= MIN_DEPOSIT, !paused
  ├─ Loop remaining_accounts (3 per asset):
  │   ├─ Parse AssetEntry, validate PDA
  │   ├─ Read vault balance
  │   ├─ Read oracle price + validate freshness
  │   └─ Accumulate weight_sum
  ├─ Require weight_sum == 10000
  ├─ Compute total_portfolio_value
  ├─ Compute deposit_value for deposited asset
  ├─ Convert to shares via virtual offset formula
  ├─ Require shares >= min_shares_out
  ├─ CPI: transfer_checked (user → asset_vault)
  ├─ CPI: mint_to (shares → user) [vault PDA signs]
  └─ Emit SingleDeposit event
```

### redeem_single

```
User → redeem_single(shares, min_amount_out)
  │
  ├─ Validate: shares > 0, user has enough shares, !paused
  ├─ Compute amount_out = shares * asset_balance / total_shares
  ├─ Require amount_out >= min_amount_out
  ├─ CPI: burn shares (user signs)
  ├─ CPI: transfer_checked (asset_vault → user) [vault PDA signs]
  └─ Emit SingleRedeem event
```

## Error Codes

| Code | Name | Trigger |
|---|---|---|
| 6000 | `ZeroAmount` | Deposit/redeem with amount = 0 |
| 6001 | `SlippageExceeded` | Output below minimum |
| 6002 | `VaultPaused` | Operation while paused |
| 6003 | `InvalidAssetDecimals` | base_decimals > 9 |
| 6004 | `MathOverflow` | Arithmetic overflow |
| 6005 | `DivisionByZero` | Zero denominator |
| 6006 | `InsufficientShares` | Redeeming more than balance |
| 6007 | `InsufficientAssets` | Vault doesn't have enough |
| 6008 | `Unauthorized` | Non-authority caller |
| 6009 | `DepositTooSmall` | Below MIN_DEPOSIT_AMOUNT (1000) |
| 6010 | `VaultNotPaused` | Unpause when not paused |
| 6011 | `MaxAssetsExceeded` | Adding > 8 assets |
| 6012 | `InvalidWeight` | Weight sum would exceed 10000 |
| 6013 | `WeightsNotFullyAllocated` | Weight sum != 10000 for financial ops |
| 6014 | `OracleStale` | Price older than MAX_ORACLE_STALENESS |
| 6015 | `OracleInvalid` | Price = 0 or data too short |
| 6016 | `OracleUncertain` | Confidence interval too wide |
| 6017 | `AssetNotFound` | Entry doesn't belong to vault |
| 6018 | `AssetVaultNotEmpty` | Remove with non-zero balance |
| 6019 | `InvalidRemainingAccounts` | Wrong remaining_accounts length |
| 6020 | `InvalidAssetEntry` | PDA mismatch |
| 6021 | `InvalidAssetVault` | Vault account mismatch |
| 6022 | `InvalidNewAuthority` | Transfer to Pubkey::default |
| 6023 | `WeightsLengthMismatch` | Wrong number of weights |
| 6024 | `MinAmountsLengthMismatch` | Wrong number of min amounts |
| 6025 | `RebalanceSlippageExceeded` | Swap output below minimum |
