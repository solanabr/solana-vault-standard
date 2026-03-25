# SVS-9: Allocator Vault

## Overview

SVS-9 is a vault-of-vaults allocator for the Solana Vault Standard. Users deposit a single underlying asset into an idle buffer and receive allocator shares, while a curator deploys idle capital across compatible child SVS vaults through CPI.

The design is intended for meta-vaults, strategy routers, risk-diversified yield products, and managed allocators that need one user-facing share token with multiple underlying strategies.

## Core Model

Allocator accounting is split between:

- `idle_vault`: unallocated liquidity held directly by the allocator PDA.
- `ChildAllocation` PDAs: one record per child vault, including the child program, the allocator's child share ATA, weight bounds, and cost-basis tracking.
- `shares_mint`: the allocator's Token-2022 share mint, derived as a PDA from the allocator vault.

`total_assets` is computed as:

```text
idle balance + sum(current market value of all enabled child positions)
```

That means share pricing depends on both idle liquidity and the live value of child vault positions.

## PDA Layout

| Account | Seeds | Purpose |
|---------|-------|---------|
| `AllocatorVault` | `["allocator_vault", asset_mint, vault_id.to_le_bytes()]` | Top-level vault state |
| `ChildAllocation` | `["child_allocation", allocator_vault, child_vault]` | Per-child allocation state |
| `shares_mint` | `["shares_mint", allocator_vault]` | Allocator share mint |
| `idle_vault` | ATA of `(asset_mint, allocator_vault)` | Unallocated asset buffer |

## State

### `AllocatorVault`

- `authority`: admin with pause and configuration powers
- `curator`: allocation manager
- `asset_mint`: underlying asset for the allocator and all children
- `shares_mint`: Token-2022 mint for allocator shares
- `idle_vault`: ATA that holds liquid funds
- `vault_id`: unique identifier for multi-vault deployments
- `total_shares`: tracked share count
- `idle_buffer_bps`: minimum liquid buffer in basis points
- `num_children`: number of active child allocations
- `decimals_offset`: virtual offset exponent
- `bump`, `paused`, `_reserved`

### `ChildAllocation`

- `allocator_vault`: parent allocator
- `child_vault`: child vault address
- `child_program`: owning SVS program
- `child_shares_account`: allocator ATA that holds child shares
- `target_weight_bps`: target allocation weight
- `max_weight_bps`: hard cap enforced on allocate and rebalance
- `deposited_assets`: cost basis tracked for the child
- `index`: position index
- `enabled`: allocation toggle
- `child_decimals_offset`: inflation-protection offset used by the child
- `bump`, `_reserved`

## Instruction Surface

### User flow

- `initialize`
- `deposit`
- `mint`
- `withdraw`
- `redeem`

### Curator flow

- `allocate`
- `deallocate`
- `harvest`
- `rebalance`

### Admin flow

- `add_child`
- `remove_child`
- `update_weights`
- `pause`
- `unpause`
- `transfer_authority`
- `set_curator`

### View flow

- `preview_deposit`
- `preview_mint`
- `preview_withdraw`
- `preview_redeem`
- `convert_to_shares`
- `convert_to_assets`
- `get_total_assets`
- `max_deposit`
- `max_mint`
- `max_withdraw`
- `max_redeem`
- `get_idle_balance`
- `get_child_allocation_info`

## Important Behavioral Notes

### Idle-buffer liquidity model

User withdrawals and redemptions are paid from the idle buffer only. The allocator does not automatically deallocate from child vaults inside user redeem flows.

That means:

- `max_withdraw` and `max_redeem` are bounded by idle liquidity.
- If the curator allocates too aggressively, user exits are limited until capital is deallocated back to the idle vault.
- This is a managed-liquidity trust model, not an always-liquid vault.

### Child compatibility

The implementation validates child programs against a fixed allowlist of supported SVS variants and checks child vault ownership and discriminator shape before registration.

The current path is designed around atomic child `deposit` and `redeem` CPIs. Variants with non-atomic or asynchronous lifecycle requirements are not suitable child targets.

### Weight enforcement

`max_weight_bps` is enforced using current market value, not only cost basis. This prevents stale cost-basis accounting from underestimating overweight child positions after yield accrual.

## Module Compatibility

When compiled with the `modules` feature, SVS-9 exposes module admin instructions and user-flow hooks for:

- `svs-fees`
- `svs-caps`
- `svs-locks`
- `svs-access`

The current implementation wires deposit and redeem hooks, plus module admin account initialization and updates.

Compatibility notes:

- Fee and cap logic applies at the allocator layer, not inside child vaults.
- Share locks apply to allocator shares.
- Access control applies to allocator entry and exit, not to child vault governance.
- Reward and oracle modules are not yet described as first-class integrated flows in this implementation document and should be documented explicitly before any PR claims full support.

## Events

SVS-9 emits dedicated events for:

- vault initialization
- child add and remove
- user deposit and withdraw
- allocate, deallocate, harvest, and rebalance
- pause and unpause
- authority transfer
- curator transfer
- weight updates

## Errors

Allocator-specific errors include:

- `InsufficientBuffer`
- `InvalidChildProgram`
- `InvalidChildVault`
- `UnsupportedChildVariant`
- `ChildAllocationDisabled`
- `ChildHasAssets`
- `MaxWeightExceeded`
- `InvalidRemainingAccounts`
- `DuplicateChildVault`

## SDK And CLI

Current integration points in this branch:

- `sdk/core/src/svs9.ts`
- `sdk/core/src/cli/commands/svs9/*`
- `scripts/svs-9/*`
- `tests/svs-9.ts`
- `tests/svs-9-e2e.ts`

The SDK exposes allocator PDA helpers, state fetchers, child allocation helpers, and all primary instruction wrappers.

CLI coverage in this branch now includes:

- generic lifecycle commands through the main CLI: `info`, `balance`, `preview`, `deposit`, `mint`, `withdraw`, `redeem`, `pause`, `unpause`, `transfer-authority`, and `permissions`
- allocator-specific commands under `solana-vault svs9`: `init`, `status`, `add-child`, `remove-child`, `update-weights`, `set-curator`, `allocate`, `deallocate`, `harvest`, and `rebalance`

## Testing Status

Validated locally on this machine:

- `corepack yarn workspace @stbr/solana-vault build` (TypeScript SDK + CLI)
- `cargo build-sbf` for `svs-1` and `svs-9` using a local `platform-tools` SDK

Blocked on this machine:

- `solana-test-validator` fails to create the ledger with `Acesso negado (os error 5)` while unpacking genesis.
- As a result, `tests/svs-9.ts`, `tests/svs-9-e2e.ts`, and `scripts/svs-9/*` could not be executed here.

Still required before PR merge:

- local validator run with `svs_1` and `svs_9` preloaded
- lifecycle scripts execution evidence
- devnet deployment evidence and transaction links

## Open Notes

- `SVS-9` must not regress merged variants already present in `main`.
- Shared docs and README entries should only be updated to claim support that is actually implemented and tested.
- Example scripts should prefer real child vault setup over mock placeholders before PR submission.
