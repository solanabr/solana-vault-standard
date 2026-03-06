# SVS Security Model

## Audit Status

**NOT AUDITED** - This software has not undergone a professional security audit. Use at your own risk.

## SVS-Specific Attack Vectors

### 1. Inflation/Donation Attack
**Mitigation:** Virtual offset mechanism creates "phantom" shares and assets.

### 2. Rounding Attacks
**Mitigation:** Vault-favoring rounding on all operations.

### 3. Sync Timing Attack (SVS-2, SVS-4 only)
**Mitigation:** Use SVS-1/SVS-3 for trustless scenarios (live balance).

### 4. Slippage/Sandwich Attacks
**Mitigation:** Slippage parameters on all operations.

### 5. Arithmetic Overflow
**Mitigation:** All arithmetic uses checked operations with u128 intermediate calculations.

### 6. Fake Proof Context Injection (SVS-3, SVS-4)
**Mitigation:** Proof context accounts validated via owner check (`account.owner == zk_elgamal_proof_program::id()`). Prevents passing arbitrary accounts as "verified" proofs.

---

## Solana Security Checklist

### Core Principle

Assume the attacker controls:
- Every account passed into an instruction
- Every instruction argument
- Transaction ordering (within reason)
- CPI call graphs (via composability)

---

### 1. Missing Owner Checks

**Risk**: Attacker creates fake accounts with identical data structure and correct discriminator.

**Anchor Prevention**:
```rust
// Use typed accounts (automatic)
pub account: Account<'info, ProgramAccount>,

// Or explicit constraint
#[account(owner = program_id)]
pub account: UncheckedAccount<'info>,
```

---

### 2. Missing Signer Checks

**Risk**: Any account can perform operations that should be restricted to specific authorities.

**Anchor Prevention**:
```rust
// Use Signer type
pub authority: Signer<'info>,

// Or explicit constraint
#[account(signer)]
pub authority: UncheckedAccount<'info>,
```

---

### 3. Arbitrary CPI Attacks

**Risk**: Program blindly calls whatever program is passed as parameter.

**Anchor Prevention**:
```rust
// Use typed Program accounts
pub token_program: Program<'info, Token>,

// Or explicit validation
if ctx.accounts.token_program.key() != &spl_token::ID {
    return Err(ProgramError::IncorrectProgramId);
}
```

---

### 4. Reinitialization Attacks

**Risk**: Calling initialization functions on already-initialized accounts overwrites existing data.

**Anchor Prevention**:
```rust
// Use init constraint (automatic protection)
#[account(init, payer = payer, space = 8 + Data::LEN)]
pub account: Account<'info, Data>,
```

**Critical**: Avoid `init_if_needed` - it permits reinitialization.

---

### 5. PDA Sharing Vulnerabilities

**Risk**: Same PDA used across multiple users enables unauthorized access.

**Vulnerable Pattern**:
```rust
// BAD: Only mint in seeds
seeds = [b"pool", pool.mint.as_ref()]
```

**Secure Pattern**:
```rust
// GOOD: Include user-specific identifiers
seeds = [b"pool", vault.key().as_ref(), owner.key().as_ref()]
```

---

### 6. Type Cosplay Attacks

**Risk**: Accounts with identical data structures but different purposes can be substituted.

**Prevention**: Use discriminators to distinguish account types. Anchor provides automatic 8-byte discriminator with `#[account]` macro.

---

### 7. Duplicate Mutable Accounts

**Risk**: Passing same account twice causes program to overwrite its own changes.

**Prevention**:
```rust
if ctx.accounts.account_1.key() == ctx.accounts.account_2.key() {
    return Err(ProgramError::InvalidArgument);
}
```

---

### 8. Revival Attacks

**Risk**: Closed accounts can be restored within same transaction by refunding lamports.

**Anchor Prevention**:
```rust
#[account(mut, close = destination)]
pub account: Account<'info, Data>,
```

---

### 9. Data Matching Vulnerabilities

**Risk**: Correct type/ownership validation but incorrect assumptions about data relationships.

**Anchor Prevention**:
```rust
#[account(has_one = authority)]
pub account: Account<'info, Data>,
```

---

## Program Checklist

### Account Validation
- [ ] Validate account owners match expected program
- [ ] Validate signer requirements explicitly
- [ ] Validate writable requirements explicitly
- [ ] Validate PDAs match expected seeds + bump
- [ ] Validate token mint <-> token account relationships
- [ ] Check for duplicate mutable accounts

### CPI Safety
- [ ] Validate program IDs before CPIs (no arbitrary CPI)
- [ ] Do not pass extra writable or signer privileges to callees
- [ ] Ensure invoke_signed seeds are correct and canonical

### Arithmetic
- [ ] Use checked math (`checked_add`, `checked_sub`, `checked_mul`, `checked_div`)
- [ ] Avoid unchecked casts
- [ ] Re-validate state after CPIs when required

### State Lifecycle
- [ ] Close accounts securely (mark discriminator, drain lamports)
- [ ] Gate upgrades and ownership transfers
- [ ] Prevent reinitialization of existing accounts

---

## Client Checklist

- [ ] Cluster awareness: never hardcode mainnet endpoints in dev flows
- [ ] Simulate transactions for UX where feasible
- [ ] Handle blockhash expiry and retry with fresh blockhash
- [ ] Never assume token program variant; detect Token-2022 vs classic
- [ ] Validate transaction simulation results before signing

---

## Security Review Questions

1. Can an attacker pass a fake account that passes validation?
2. Can an attacker call this instruction without proper authorization?
3. Can an attacker substitute a malicious program for CPI targets?
4. Can an attacker reinitialize an existing account?
5. Can an attacker exploit shared PDAs across users?
6. Can an attacker pass the same account for multiple parameters?
7. Can an attacker revive a closed account in the same transaction?
8. Can an attacker exploit mismatches between stored and provided data?

---

## Best Practices

1. Always use slippage protection
2. Preview before executing
3. Monitor vault state
4. Use SVS-1 for trustless scenarios
5. Verify program ID
6. Handle errors gracefully

## Reporting Vulnerabilities

Please report security vulnerabilities to: security@superteam.com.br

---

## Per-Instruction Security Checklist

Use this checklist when implementing or reviewing instructions:

### Initialize
- [ ] Asset decimals validated (≤ 9)
- [ ] Vault PDA derived correctly
- [ ] Bump stored for future use
- [ ] Shares mint authority is vault PDA
- [ ] Asset vault authority is vault PDA
- [ ] All accounts owned by correct programs

### Deposit / Mint
- [ ] Amount > 0 validated
- [ ] Amount >= MIN_DEPOSIT_AMOUNT validated
- [ ] Vault not paused
- [ ] Slippage check (min_shares_out / max_assets_in)
- [ ] User owns source token account
- [ ] Correct mint for token accounts
- [ ] Shares minted to correct recipient
- [ ] Event emitted with correct values

### Withdraw / Redeem
- [ ] Amount > 0 validated
- [ ] Vault not paused
- [ ] Slippage check (max_shares_in / min_assets_out)
- [ ] User has sufficient shares
- [ ] Vault has sufficient assets
- [ ] Stored bump used for signer seeds
- [ ] Assets transferred to correct recipient
- [ ] Shares burned from correct account
- [ ] Event emitted with correct values

### Admin Operations
- [ ] Caller is authority
- [ ] State transition is valid (pause when unpaused, etc.)
- [ ] New authority is not zero address
- [ ] Event emitted for audit trail

### View Functions
- [ ] No state mutations
- [ ] Return data set correctly
- [ ] Safe to call when paused

---

## Fuzz Testing Requirements

Before mainnet deployment, fuzz testing must:

1. **Run for minimum 10 minutes** with no crashes
2. **Test all state transitions** (init → deposit → yield → sync → withdraw)
3. **Verify invariants** after every operation
4. **Include edge cases**: zero amounts, max values, concurrent operations

### Trident Configuration

```toml
# trident-tests/Trident.toml
[fuzz]
iterations = 100000
exit_on_error = true
corpus_dir = "corpus"

[invariants]
shares_conservation = true
rounding_direction = true
no_value_creation = true
```

### Required Invariants

```rust
// Must pass after every fuzzed operation
fn invariants_hold(state: &VaultState) -> bool {
    // 1. Shares supply matches sum of balances
    let supply_matches = state.shares_supply ==
        state.user_shares.values().sum();

    // 2. Assets cover all claims
    let assets_sufficient = state.asset_vault_balance >=
        calculate_total_claimable(state);

    // 3. No overflow in any field
    let no_overflow = state.shares_supply <= u64::MAX &&
                      state.total_assets <= u64::MAX;

    supply_matches && assets_sufficient && no_overflow
}
```

---

## Audit Preparation Checklist

Before requesting an audit:

### Code Quality
- [ ] All `unwrap()` removed from program code
- [ ] All arithmetic uses checked operations
- [ ] No `init_if_needed` without careful analysis
- [ ] PDA bumps stored and reused
- [ ] All CPIs use typed Program accounts

### Documentation
- [ ] README current and accurate
- [ ] All instructions documented
- [ ] Error codes documented
- [ ] PDA derivations documented
- [ ] Known limitations documented

### Testing
- [ ] Unit tests for all math functions
- [ ] Integration tests for all instructions
- [ ] Edge case tests (zero, max, boundary)
- [ ] Multi-user scenario tests
- [ ] Fuzz tests run for 10+ minutes

### Security
- [ ] OWASP top 10 considered
- [ ] Reentrancy analyzed
- [ ] Integer overflow/underflow checked
- [ ] Access control reviewed
- [ ] Account validation complete

---

## Attack Scenario Examples

### Inflation Attack (Prevented)

```rust
// Attack attempt:
// 1. Attacker is first depositor
// 2. Deposits 1 wei
// 3. Directly transfers 1M tokens to vault
// 4. New user deposits 1M tokens, gets ~1 share
// 5. Attacker redeems 1 share, gets ~1M tokens

// SVS Prevention (virtual offset):
// With offset = 1000 (USDC):
// Step 2: Attacker gets 1 * (0 + 1000) / (0 + 1) = 1000 shares
// Step 3: Direct transfer makes vault have 1M assets
// Step 4: New user gets 1M * (1000 + 1000) / (1M + 1) ≈ 2000 shares
// Step 5: Attacker redeems 1000 shares, gets 1000 * (1M + 1) / (3000) ≈ 333K
// Attack fails: Attacker paid 1M, got 333K
```

### Sync Timing Attack (SVS-2/4)

```rust
// Attack scenario:
// 1. External yield of 100 tokens accrued
// 2. Authority sees large deposit incoming
// 3. Authority syncs just before deposit
// 4. Depositor gets shares at old price
// 5. Authority benefits from diluted price

// Mitigations:
// - Use SVS-1 for trustless scenarios
// - Timelock between sync and authority actions
// - Multisig authority
// - Automated sync bots
```

### Rounding Extraction (Prevented)

```rust
// Attack attempt:
// Loop: deposit 1 → redeem 1 → extract rounding error

// SVS Prevention:
// All operations round in favor of vault
// deposit(1) → floor(shares) → maybe 0 shares
// redeem(shares) → floor(assets) → maybe 0 assets
// No value extracted, attacker loses fees
```

---

## Confidential Transfer Security (SVS-3/4)

### Proof Validation

```rust
// CRITICAL: Validate proof context ownership
require!(
    ctx.accounts.proof_context.owner == zk_elgamal_proof_program::id(),
    VaultError::InvalidProof
);

// Prevents: Attacker creating fake "verified" proof accounts
```

### Ciphertext Handling

```rust
// Range proofs required for all withdrawals
// Prevents: Negative amounts, overflow attacks

// Ciphertext equality proofs required
// Prevents: Substituting different amounts
```

### Pending Balance Flow

```
1. deposit() → shares go to pending balance
2. apply_pending() → user moves to available
3. Only user can call apply_pending (signed)

// Prevents: Front-running pending balance claims
```

---

## See Also

- [Architecture](./ARCHITECTURE.md) - Technical implementation
- [Patterns](./PATTERNS.md) - Implementation patterns
- [Testing](./TESTING.md) - Testing guide
- [Errors](./ERRORS.md) - Error codes
