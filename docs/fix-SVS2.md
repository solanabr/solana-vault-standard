# SVS-2 Improvement Notes

Improvements identified during SVS-5 implementation that should be backported to SVS-2.

## 1. Vault balance safety check

SVS-5 adds an explicit check against actual vault token balance in withdraw/redeem:

```rust
require!(net_assets <= ctx.accounts.asset_vault.amount, VaultError::InsufficientAssets);
```

SVS-2 lacks this. If `total_assets` drifts from actual balance (e.g., direct token transfer without `sync()`), withdraw could attempt to transfer more tokens than the vault holds, causing a runtime CPI failure instead of a clean error.

**Fix**: Add the same `net_assets <= asset_vault.amount` check in SVS-2 withdraw and redeem handlers.

## 2. Redundant `total_assets_needed` variable

In SVS-2 `withdraw.rs`, the code creates:

```rust
let total_assets_needed = assets;
```

Then checks against it. This is just an alias with no transformation. Can be simplified to:

```rust
require!(assets <= total_assets, VaultError::InsufficientAssets);
```

**Fix**: Remove the alias and check `assets` directly.

## 3. `check_deposit_access` naming

Kept as `check_deposit_access()` across all variants. A future rename can be done in a dedicated PR to avoid cross-program scope creep.
