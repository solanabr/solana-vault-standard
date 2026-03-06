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
