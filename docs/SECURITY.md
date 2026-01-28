# Security

## Overview

SVS-1 (Solana Vault Standard) implements comprehensive security measures to protect against common vault attacks. This document details security features, attack mitigations, known limitations, and responsible disclosure procedures.

## Security Architecture

### Defense-in-Depth Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  - Slippage protection on all operations                    │
│  - Minimum deposit threshold                                │
│  - Authority validation                                      │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    Mathematical Layer                        │
│  - Virtual offset (inflation attack protection)             │
│  - Vault-favoring rounding                                  │
│  - Checked arithmetic (u128 intermediates)                  │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    Account Layer                             │
│  - PDA seed separation                                      │
│  - Owner validation                                         │
│  - Signer constraints                                       │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    Emergency Layer                           │
│  - Full circuit breaker (pause)                             │
│  - Authority transfer                                       │
│  - Balance sync                                             │
└─────────────────────────────────────────────────────────────┘
```

## Security Features

### 1. Inflation Attack Protection

**Threat:** First depositor manipulates share price by donating assets to empty vault before depositing minimal amount.

**Mitigation:** Virtual offset mechanism adds phantom shares and assets to all calculations.

```rust
// Core protection formula
virtual_shares = total_shares + 10^decimals_offset
virtual_assets = total_assets + 1

shares = assets × virtual_shares / virtual_assets
assets = shares × virtual_assets / virtual_shares
```

**Attack Scenario Analysis:**

| Step | Without Protection | With Protection (offset=3) |
|------|-------------------|---------------------------|
| 1. Empty vault | 0 assets, 0 shares | Virtual: 1 asset, 1000 shares |
| 2. Attacker donates 1M USDC | Balance: 1M, shares: 0 | Balance: 1M, virtual: 1M+1 assets |
| 3. Attacker deposits 1 USDC | Gets ~1M shares (disaster!) | Gets 1×1000/1,000,001 = 0 shares |
| 4. Result | Attacker controls vault | Attack fails completely |

**Offset Calculation:**
```
decimals_offset = 9 - asset_decimals

Token          Decimals    Offset    Virtual Shares
─────────────────────────────────────────────────────
USDC           6           3         1,000
USDT           6           3         1,000
SOL            9           0         1
Custom (4)     4           5         100,000
```

### 2. Vault-Favoring Rounding

All operations round to favor the vault, preventing value extraction through rounding exploitation.

| Operation | Action | Rounding | Effect |
|-----------|--------|----------|--------|
| `deposit` | User pays assets → receives shares | **Floor** | User gets fewer shares |
| `mint` | User wants shares → pays assets | **Ceiling** | User pays more assets |
| `withdraw` | User wants assets → burns shares | **Ceiling** | User burns more shares |
| `redeem` | User burns shares → receives assets | **Floor** | User gets fewer assets |

**Mathematical Proof:**
```rust
// Round-trip can never profit attacker
let shares = convert_to_shares(assets, ..., Floor);   // User gets fewer
let back = convert_to_assets(shares, ..., Floor);     // User gets fewer
assert!(back <= assets);  // Always true - no free money
```

**Cumulative Protection:**
After 1 million operations, the vault accumulates dust that benefits all remaining shareholders proportionally.

### 3. Slippage Protection

All user-facing operations require min/max bounds to prevent MEV exploitation.

```typescript
// Deposit: minimum shares to receive
await vault.deposit(assets, minSharesOut);

// Mint: maximum assets to pay
await vault.mint(shares, maxAssetsIn);

// Withdraw: maximum shares to burn
await vault.withdraw(assets, maxSharesIn);

// Redeem: minimum assets to receive
await vault.redeem(shares, minAssetsOut);
```

**Attacks Prevented:**
- Sandwich attacks (frontrunning + backrunning)
- Price manipulation during volatility
- Large deposit/withdrawal exploitation

**Error:** `SlippageExceeded` (6002)

### 4. Checked Arithmetic

All arithmetic uses checked operations with u128 intermediates.

```rust
pub fn mul_div(value: u64, numerator: u64, denominator: u64, rounding: Rounding) -> Result<u64> {
    require!(denominator > 0, VaultError::DivisionByZero);

    // u128 intermediate prevents overflow
    let product = (value as u128)
        .checked_mul(numerator as u128)
        .ok_or(VaultError::MathOverflow)?;

    let result = match rounding {
        Rounding::Floor => product / (denominator as u128),
        Rounding::Ceiling => {
            (product + denominator as u128 - 1) / (denominator as u128)
        }
    };

    require!(result <= u64::MAX as u128, VaultError::MathOverflow);
    Ok(result as u64)
}
```

**Protections:**
- Integer overflow → `MathOverflow` error
- Integer underflow → `checked_sub` returns error
- Division by zero → `DivisionByZero` error
- u128 overflow → Returns error before truncation

### 5. PDA Seed Separation

Distinct seed prefixes prevent account collision attacks.

```rust
// Vault PDA - unique per asset + vault_id combination
seeds = [b"vault", asset_mint.as_ref(), vault_id.to_le_bytes()]

// Shares Mint PDA - unique per vault
seeds = [b"shares", vault.key().as_ref()]
```

**Security Properties:**
- No two vaults can share the same address
- Shares mint is cryptographically bound to vault
- vault_id allows multiple vaults per asset (different strategies)
- Cross-vault attacks impossible due to seed separation

### 6. Authority Validation

Admin operations enforce strict authority checks.

```rust
#[derive(Accounts)]
pub struct Admin<'info> {
    #[account(
        constraint = authority.key() == vault.authority @ VaultError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub vault: Account<'info, Vault>,
}
```

**Protected Operations:**
| Operation | Access | Notes |
|-----------|--------|-------|
| `pause` | Authority only | Emergency stop |
| `unpause` | Authority only | Resume operations |
| `transfer_authority` | Authority only | Handoff to new key |
| `sync` | Authority only | Update cached balance |

### 7. Minimum Deposit Threshold

Prevents dust attacks and protects against rounding edge cases.

```rust
pub const MIN_DEPOSIT_AMOUNT: u64 = 1000;

// In deposit instruction:
require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);
```

**Protections:**
- Gas griefing (many tiny transactions)
- State bloat from dust positions
- Rounding manipulation at small values

### 8. Emergency Pause (Full Circuit Breaker)

Authority can freeze **all** vault operations in emergencies.

```rust
pub fn pause(ctx: Context<Admin>) -> Result<()> {
    require!(!vault.paused, VaultError::VaultPaused);
    vault.paused = true;
    emit!(VaultStatusChanged { vault: vault.key(), paused: true });
    Ok(())
}
```

**When Paused - ALL State-Changing Operations Blocked:**
- `deposit` - Blocked
- `mint` - Blocked
- `withdraw` - Blocked
- `redeem` - Blocked

**View Functions Remain Available:**
- `preview_*` - Continue working
- `convert_to_*` - Continue working
- `max_*` - Returns 0 when paused

**Use Cases:**
- Exploit discovered
- Oracle failure (future)
- Protocol upgrade migration
- Regulatory compliance

### 9. Token Transfer Safety

Vault only accepts assets through proper instruction flow.

```
Correct Flow:
┌──────────┐    deposit()    ┌─────────────┐
│   User   │ ───────────────→│    Vault    │
│  Assets  │    + CPI        │   Assets    │
└──────────┘  transfer_checked└─────────────┘
      │                              │
      │       mint_to shares         │
      └──────────────────────────────┘

Blocked Flow:
┌──────────┐  direct transfer  ┌─────────────┐
│ Attacker │ ─────────────────→│    Vault    │
│  Assets  │    No shares!     │   Balance   │
└──────────┘                   └─────────────┘
```

**Direct Transfer Handling:**
- Assets sent directly to vault don't mint shares
- `sync()` allows authority to recognize balance changes
- Donated assets benefit existing shareholders proportionally

## Attack Surface Analysis

### Fully Mitigated

| Attack | Vector | Mitigation | Status |
|--------|--------|------------|--------|
| Inflation Attack | First depositor manipulation | Virtual offset | ✅ |
| Sandwich Attack | MEV frontrunning | Slippage protection | ✅ |
| Rounding Exploitation | Extract value via precision | Vault-favoring rounding | ✅ |
| Integer Overflow | Large value calculations | Checked math + u128 | ✅ |
| Authority Takeover | Unauthorized admin ops | Signer + constraint checks | ✅ |
| PDA Collision | Account substitution | Unique seed separation | ✅ |
| Reentrancy | Cross-instruction state | Solana single-threaded | ✅ N/A |

### Partially Mitigated

| Risk | Description | Current Mitigation | Residual Risk |
|------|-------------|-------------------|---------------|
| Donation Attack | Attacker donates to inflate share price | `sync()` + proportional distribution | Low - donator loses funds |
| Authority Compromise | Malicious authority | Transfer capability | Medium - requires trust |

### External Integration Risks

| Risk | Description | Recommended Mitigation |
|------|-------------|----------------------|
| Flash Loan Attack | Large temporary position | Use TWAP, not spot price |
| Oracle Manipulation | Price feed attacks | Multiple oracle sources |
| Composability Risk | Bad integrator code | Review all CPIs to vault |

## Known Limitations

### Functional Limitations

| Limitation | Description | Workaround |
|------------|-------------|------------|
| Single Asset | One SPL token per vault | Deploy multiple vaults |
| No Built-in Fees | No protocol fee mechanism | Implement in wrapper |
| No Yield Strategy | Passive vault only | External yield integration |
| Max 9 Decimals | Assets > 9 decimals rejected | Use wrapped token |
| Immutable Program | No upgrade mechanism | Deploy new + migrate |

### Operational Limitations

| Limitation | Impact | Notes |
|------------|--------|-------|
| Authority Trust | Single key controls pause/sync | Consider multisig |
| No Timelocks | Instant authority actions | Add governance layer |
| Rent Exempt Only | No rent reclamation | Standard Solana behavior |

## Testing Coverage

### Unit Tests
- Math operations: rounding, overflow, edge cases
- Conversion functions: shares ↔ assets
- Virtual offset calculations

### Integration Tests
| Category | Tests | Status |
|----------|-------|--------|
| Core Operations | 21 | ✅ |
| Edge Cases | 15 | ✅ |
| Multi-User | 15 | ✅ |
| Decimals | 12 | ✅ |
| Yield/Sync | 12 | ✅ |
| Admin | 10 | ✅ |
| Lifecycle | 8 | ✅ |
| **Total Integration** | **~93** | ✅ |

### SDK Tests
| Category | Tests | Status |
|----------|-------|--------|
| Math | 18 | ✅ |
| PDA | 11 | ✅ |
| Vault Interfaces | 30 | ✅ |
| Error Handling | 25 | ✅ |
| Event Parsing | 29 | ✅ |
| **Total SDK** | **113** | ✅ |

### Fuzz Tests (Trident)
- Deposit invariants
- Redeem invariants
- Conversion round-trip checks
- Share/asset conservation

```bash
# Run all tests
anchor test

# Run fuzz tests
cd trident-tests && cargo test
```

## Audit Status

**Status:** ⚠️ **NOT AUDITED**

This program has not undergone professional security audit.

### Pre-Mainnet Checklist

- [ ] Professional security audit (Neodyme, OtterSec, Zellic)
- [ ] Formal verification of math module
- [ ] Economic model review
- [ ] Extended fuzzing (> 10M iterations)
- [ ] Testnet deployment (30+ days)
- [ ] Bug bounty program launch
- [ ] Verifiable build published

## Responsible Disclosure

### Contact

**Email:** [TBD - Add security email]

**PGP Key:** [TBD - Add public key]

### Process

1. **Report:** Email detailed description with reproduction steps
2. **Acknowledge:** We respond within 48 hours
3. **Assess:** Severity classification within 7 days
4. **Fix:** Patch development (timeline depends on severity)
5. **Disclose:** Coordinated disclosure after fix deployed

### Severity Classification

| Severity | Description | Response Time |
|----------|-------------|---------------|
| Critical | Fund loss possible | 24 hours |
| High | Significant impact | 72 hours |
| Medium | Limited impact | 7 days |
| Low | Minimal impact | 30 days |

### Bug Bounty

**Status:** TBD (will be announced before mainnet)

**Scope:**
- SVS-1 program code
- SDK security issues
- Documentation errors leading to insecure usage

**Out of Scope:**
- Third-party integrations
- Social engineering
- Physical attacks

## Security Checklist for Integrators

If building on SVS-1:

### Must Do
- [ ] Never use spot share price as oracle truth
- [ ] Implement TWAP for any price-dependent logic
- [ ] Add your own slippage checks on top
- [ ] Validate vault is not paused before composing
- [ ] Handle all vault errors gracefully
- [ ] Test with various decimal tokens (0, 6, 9)

### Should Do
- [ ] Have emergency pause in your protocol
- [ ] Monitor vault events for anomalies
- [ ] Maintain upgrade path if vault migrates
- [ ] Document your integration's trust assumptions

### Don't Do
- [ ] Don't assume shares == assets 1:1
- [ ] Don't ignore slippage on any operation
- [ ] Don't rely on vault's cached `total_assets` for critical decisions
- [ ] Don't bypass minimum deposit checks in your wrapper

## References

- [ERC-4626 Security Considerations](https://eips.ethereum.org/EIPS/eip-4626#security-considerations)
- [OpenZeppelin ERC-4626](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/ERC20/extensions/ERC4626.sol)
- [Solana Security Best Practices](https://docs.solana.com/developing/on-chain-programs/overview)
- [Anchor Security Guidelines](https://www.anchor-lang.com/docs/security)
- [Inflation Attack Analysis](https://blog.openzeppelin.com/a-novel-defense-against-erc4626-inflation-attacks)

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01 | Initial implementation |

## Disclaimer

This security document is provided for informational purposes only. It does not constitute a guarantee of security. Users and integrators are responsible for conducting their own security review before using this software in production.

**USE AT YOUR OWN RISK.**
