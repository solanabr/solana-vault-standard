# SVS Architecture

## Overview

The Solana Vault Standard (SVS) implements ERC-4626 compatible tokenized vaults on Solana. The architecture supports four variants optimized for different use cases.

## SVS Variants Matrix

```
                    PUBLIC                    PRIVATE
                    (SPL Token)               (Token-2022 + CT)
                ┌─────────────────┬─────────────────┐
    LIVE        │                 │                 │
    BALANCE     │     SVS-1       │     SVS-3       │
    (No sync)   │                 │                 │
                ├─────────────────┼─────────────────┤
    STORED      │                 │                 │
    BALANCE     │     SVS-2       │     SVS-4       │
    (With sync) │                 │                 │
                └─────────────────┴─────────────────┘
```

## Balance Models

### Live Balance (SVS-1, SVS-3)

Uses `asset_vault.amount` directly for all calculations. External donations immediately reflected in share price. No sync timing attack vulnerability.

### Stored Balance (SVS-2, SVS-4)

Uses `vault.total_assets` stored in account. Requires `sync()` call to recognize external donations. Authority controls when yield is recognized.

## Security Considerations

### Inflation/Donation Attack Protection

The virtual offset mechanism prevents the classic "first depositor" attack by ensuring share price starts at approximately 1:1.

### Rounding Direction

All operations round in favor of the vault:
- deposit: Floor shares
- mint: Ceiling assets
- withdraw: Ceiling shares
- redeem: Floor assets

### Sync Timing Attack (SVS-2, SVS-4)

Use SVS-1/SVS-3 for trustless scenarios, or add timelocks/multisig for sync operations.
