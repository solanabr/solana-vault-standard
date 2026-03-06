# ERC-4626 Reference for SVS

The Solana Vault Standard (SVS) is a native Solana port of ERC-4626. This document maps SVS concepts to their EVM counterparts for developers familiar with Ethereum.

---

## Core Standard Mapping

| SVS Variant | EVM Standard | Description | Reference |
|-------------|--------------|-------------|-----------|
| SVS-1, SVS-2, SVS-3, SVS-4 | ERC-4626 | Tokenized vault standard | [EIP-4626](https://eips.ethereum.org/EIPS/eip-4626) |
| SVS-10 (Async) | ERC-7540 | Asynchronous tokenized vault | [EIP-7540](https://eips.ethereum.org/EIPS/eip-7540) |
| SVS-9 (Allocator) | MetaMorpho | Vault-of-vaults allocator | [Morpho Labs](https://github.com/morpho-org/metamorpho) |
| SVS-12 (Tranched) | Centrifuge Tinlake | Structured finance tranches | [Centrifuge](https://github.com/centrifuge/tinlake) |

---

## Function Mapping

### Core Operations

| ERC-4626 Function | SVS Instruction | Signature Difference |
|-------------------|-----------------|---------------------|
| `deposit(assets, receiver)` | `deposit(assets, min_shares_out)` | Added slippage protection |
| `mint(shares, receiver)` | `mint(shares, max_assets_in)` | Added slippage protection |
| `withdraw(assets, receiver, owner)` | `withdraw(assets, max_shares_in)` | Added slippage protection |
| `redeem(shares, receiver, owner)` | `redeem(shares, min_assets_out)` | Added slippage protection |

### View Functions

| ERC-4626 Function | SVS View | Notes |
|-------------------|----------|-------|
| `totalAssets()` | `total_assets()` | Returns via `set_return_data` |
| `totalSupply()` | Read `shares_mint.supply` | Token account read |
| `convertToShares(assets)` | `convert_to_shares(assets)` | Same math |
| `convertToAssets(shares)` | `convert_to_assets(shares)` | Same math |
| `previewDeposit(assets)` | `preview_deposit(assets)` | Returns shares out |
| `previewMint(shares)` | `preview_mint(shares)` | Returns assets in |
| `previewWithdraw(assets)` | `preview_withdraw(assets)` | Returns shares to burn |
| `previewRedeem(shares)` | `preview_redeem(shares)` | Returns assets out |
| `maxDeposit(receiver)` | `max_deposit()` | Returns `u64::MAX` or 0 if paused |
| `maxMint(receiver)` | `max_mint()` | Returns `u64::MAX` or 0 if paused |
| `maxWithdraw(owner)` | `max_withdraw(owner)` | Based on owner's shares |
| `maxRedeem(owner)` | `max_redeem(owner)` | Owner's share balance |

### Events

| ERC-4626 Event | SVS Event | Fields |
|----------------|-----------|--------|
| `Deposit(caller, owner, assets, shares)` | `Deposit` | vault, caller, owner, assets, shares |
| `Withdraw(caller, receiver, owner, assets, shares)` | `Withdraw` | vault, caller, receiver, owner, assets, shares |

---

## Key Differences from ERC-4626

### 1. Balance Model

**ERC-4626**: Single storage-based model with `totalAssets()` stored or calculated.

**SVS**: Two balance models:
- **Live Balance (SVS-1, SVS-3)**: `total_assets = asset_vault.amount` - reads token account directly
- **Stored Balance (SVS-2, SVS-4)**: `total_assets = vault.total_assets` - cached in state, requires `sync()`

```solidity
// ERC-4626 (typical)
function totalAssets() public view returns (uint256) {
    return IERC20(asset).balanceOf(address(this));
}

// SVS-1 equivalent (live)
let total_assets = ctx.accounts.asset_vault.amount;

// SVS-2 equivalent (stored)
let total_assets = ctx.accounts.vault.total_assets;
```

### 2. Slippage Protection

**ERC-4626**: No standard slippage protection. Users must preview + compare off-chain.

**SVS**: Built-in slippage parameters on all operations:

```solidity
// ERC-4626: No protection
function deposit(uint256 assets, address receiver) external returns (uint256 shares);

// SVS: min/max parameters
pub fn deposit(ctx, assets: u64, min_shares_out: u64) -> Result<()>;
pub fn mint(ctx, shares: u64, max_assets_in: u64) -> Result<()>;
pub fn withdraw(ctx, assets: u64, max_shares_in: u64) -> Result<()>;
pub fn redeem(ctx, shares: u64, min_assets_out: u64) -> Result<()>;
```

### 3. Virtual Offset (Inflation Attack Protection)

**ERC-4626**: Implementation detail, varies by implementation. OpenZeppelin uses similar approach.

**SVS**: Core to specification with fixed formula:

```rust
// SVS formula (always applied)
offset = 10^(9 - asset_decimals)
shares = assets * (total_shares + offset) / (total_assets + 1)
assets = shares * (total_assets + 1) / (total_shares + offset)
```

```solidity
// OpenZeppelin ERC4626 (similar approach)
function _decimalsOffset() internal view virtual returns (uint8) {
    return 0;  // Can be overridden
}

function _convertToShares(uint256 assets, Math.Rounding rounding) internal view returns (uint256) {
    return assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), totalAssets() + 1, rounding);
}
```

### 4. Share Decimals

**ERC-4626**: Inherits from underlying ERC-20, typically matches asset decimals.

**SVS**: Fixed at 9 decimals for all shares (Token-2022 with 9 decimals).

### 5. Privacy

**ERC-4626**: No privacy features in standard.

**SVS**: Optional confidential transfers (SVS-3, SVS-4) via Token-2022 Confidential Transfer extension.

### 6. Token Standard

| Aspect | ERC-4626 | SVS |
|--------|----------|-----|
| Share Token | ERC-20 | Token-2022 (SPL) |
| Asset Token | ERC-20 | SPL Token or Token-2022 |
| Decimals | Variable (inherits) | Fixed 9 (shares) |

---

## Reference Implementations

### OpenZeppelin ERC4626

The canonical EVM implementation with similar protections:

**Repository**: [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/extensions/ERC4626.sol)

Key similarities with SVS:
- Virtual offset for inflation attack protection
- Rounding direction favors vault
- Uses `mulDiv` for safe math

```solidity
// OpenZeppelin rounding (same as SVS)
function _convertToShares(uint256 assets, Math.Rounding rounding) internal view virtual returns (uint256) {
    return assets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), totalAssets() + 1, rounding);
}

function deposit(uint256 assets, address receiver) public virtual returns (uint256) {
    uint256 shares = previewDeposit(assets);  // Uses Math.Rounding.Floor
    _deposit(_msgSender(), receiver, assets, shares);
    return shares;
}
```

### Yearn V3 Vaults

Production ERC-4626 implementation with strategy system:

**Repository**: [Yearn V3](https://github.com/yearn/yearn-vaults-v3)

Key concepts mapped to SVS:
- Strategy deployment → SVS-9 Allocator child vaults
- Performance fees → `svs-fees` module
- Role management → `svs-access` module

### Morpho Blue & MetaMorpho

Lending protocol with vault-of-vaults pattern:

**Repository**: [Morpho Blue](https://github.com/morpho-org/morpho-blue) | [MetaMorpho](https://github.com/morpho-org/metamorpho)

Key concepts mapped to SVS:
- MetaMorpho → SVS-9 Allocator Vault
- Curator role → SVS-9 curator authority
- Market allocation → child vault allocation

```solidity
// MetaMorpho allocation (similar to SVS-9)
function reallocate(MarketAllocation[] calldata allocations) external onlyAllocatorRole {
    // Rebalance across underlying markets
}
```

### Centrifuge Tinlake

Structured finance with tranches:

**Repository**: [Centrifuge Tinlake](https://github.com/centrifuge/tinlake)

Key concepts mapped to SVS:
- Senior/Junior tranches → SVS-12 priority ordering
- Waterfall distribution → SVS-12 yield distribution
- Subordination → SVS-12 subordination_bps

---

## ERC-7540: Async Vaults

SVS-10 implements the ERC-7540 asynchronous vault pattern.

**EIP**: [EIP-7540](https://eips.ethereum.org/EIPS/eip-7540)

### Operation Mapping

| ERC-7540 | SVS-10 |
|----------|--------|
| `requestDeposit(assets, receiver, owner)` | `request_deposit(assets)` |
| `requestRedeem(shares, receiver, owner)` | `request_redeem(shares)` |
| `pendingDepositRequest(requestId, owner)` | Read `DepositRequest` PDA |
| `pendingRedeemRequest(requestId, owner)` | Read `RedeemRequest` PDA |
| `claimDeposit(receiver)` | `claim_deposit()` |
| `claimRedeem(receiver)` | `claim_redeem()` |

### Flow Comparison

```
ERC-7540 Flow:
1. requestDeposit(assets) → emits RequestDeposit
2. [operator fulfills off-chain]
3. claimDeposit() → receive shares

SVS-10 Flow:
1. request_deposit(assets) → creates DepositRequest PDA
2. fulfill_deposit() → operator sets conversion rate
3. claim_deposit() → receive shares, close PDA
```

---

## Solana-Specific Concepts

### Account Model vs Storage

**EVM**: State stored in contract storage slots.

**Solana**: State stored in separate accounts (PDAs).

```solidity
// ERC-4626: Storage in contract
contract Vault is ERC4626 {
    uint256 public totalAssets;
    mapping(address => uint256) public balances;
}
```

```rust
// SVS: Separate account PDAs
#[account]
pub struct Vault {
    pub total_assets: u64,
    // ...
}
// User balances in separate token accounts
```

### CPI vs Internal Calls

**EVM**: Contracts call other contracts directly.

**Solana**: Cross-Program Invocations (CPIs) with explicit account passing.

```solidity
// ERC-4626: Internal call
IERC20(asset).transferFrom(msg.sender, address(this), assets);
```

```rust
// SVS: CPI with accounts
transfer_checked(
    CpiContext::new(
        ctx.accounts.asset_token_program.to_account_info(),
        TransferChecked { from, to, mint, authority },
    ),
    assets,
    decimals,
)?;
```

### PDA Authority vs msg.sender

**EVM**: `msg.sender` is the caller, contracts have their own address.

**Solana**: PDAs are derived addresses that can sign via program seeds.

```solidity
// ERC-4626: Contract is authority by being owner
IERC20(asset).transfer(receiver, assets);  // Contract calls directly
```

```rust
// SVS: PDA signs via seeds
let signer_seeds = &[VAULT_SEED, asset_mint, vault_id, &[bump]];
transfer_checked(
    CpiContext::new_with_signer(..., signer_seeds),
    assets,
    decimals,
)?;
```

---

## Migration Guide: EVM to Solana

### For Vault Deployers

| EVM Task | Solana SVS Equivalent |
|----------|----------------------|
| Deploy ERC4626 contract | `initialize` instruction creates vault PDA |
| Set vault parameters | Parameters in `initialize` call |
| Upgrade contract | Program upgrade via Anchor (if upgradeable) |

### For Integrators

| EVM Pattern | Solana Pattern |
|-------------|----------------|
| `approve` + `deposit` | Single `deposit` instruction |
| Read `balanceOf(user)` | Read user's shares token account |
| Read `totalAssets()` | Read `asset_vault.amount` or `vault.total_assets` |
| Listen to `Deposit` events | Subscribe to program logs, parse Anchor events |

### For Frontend Developers

| EVM (ethers.js) | Solana (Anchor) |
|-----------------|-----------------|
| `vault.deposit(assets)` | `program.methods.deposit(assets, minShares).accounts({...}).rpc()` |
| `vault.previewDeposit(assets)` | `program.methods.previewDeposit(assets).accounts({...}).view()` |
| `vault.totalAssets()` | `(await program.account.vault.fetch(vaultPda)).totalAssets` or read token account |

---

## Further Reading

### EVM Standards
- [EIP-4626: Tokenized Vault Standard](https://eips.ethereum.org/EIPS/eip-4626)
- [EIP-7540: Asynchronous ERC-4626 Tokenized Vaults](https://eips.ethereum.org/EIPS/eip-7540)
- [EIP-7575: Multi-Asset ERC-4626 Vaults](https://eips.ethereum.org/EIPS/eip-7575)

### Reference Implementations
- [OpenZeppelin ERC4626](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/extensions/ERC4626.sol)
- [Yearn V3 Vaults](https://github.com/yearn/yearn-vaults-v3)
- [Morpho Blue](https://github.com/morpho-org/morpho-blue)
- [MetaMorpho](https://github.com/morpho-org/metamorpho)
- [Centrifuge Tinlake](https://github.com/centrifuge/tinlake)

### Solana Concepts
- [Anchor Framework](https://www.anchor-lang.com/)
- [SPL Token-2022](https://spl.solana.com/token-2022)
- [Program Derived Addresses](https://solana.com/docs/core/pda)
