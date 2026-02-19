# SVS Security Model

## Audit Status

**⚠️ NOT AUDITED** - This software has not undergone a professional security audit. Use at your own risk.

## Attack Vectors & Mitigations

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

## Best Practices

1. Always use slippage protection
2. Preview before executing
3. Monitor vault state
4. Use SVS-1 for trustless scenarios
5. Verify program ID
6. Handle errors gracefully

## Reporting Vulnerabilities

Please report security vulnerabilities to: security@superteam.com.br
