# Solana Tokenized Vault Standard

Native port of ERC-4626 to Solana. Standardized interface for tokenized vaults with shares representing proportional ownership of underlying SPL tokens.

**Stack**: Anchor 0.31+, Rust 1.82+, Token-2022, TypeScript
**Reference**: `eth/` contains original Solidity spec, `solana-tokenized-vault-4626/` for patterns

## Skills & Commands

Run `/quick-commit`, `/build-program`, `/test-rust`, `/test-ts`, `/deploy`, `/audit-solana` for workflows.
Agents: `solana-architect`, `anchor-engineer`, `solana-qa-engineer`, `tech-docs-writer`, `solana-guide`, `solana-researcher`
Details in `.claude/commands/`, `.claude/agents/`, `.claude/skills/`

## Standards

- Branch before work: `git checkout -b <type>/<scope>-<description>`
- Build → Format → Lint → Test before commit
- Devnet first, mainnet only with explicit confirmation
- Round in favor of the vault (protect existing shareholders)

## Anti-Patterns (Growing List)

**Security - NEVER:**
- `unwrap()` in program code
- Unchecked arithmetic - use `checked_add`, `checked_sub`
- Recalculate PDA bumps - store canonical bumps
- Skip account validation (owner, signer, PDA derivation)
- Deploy mainnet without explicit user confirmation
- Trust CPI return data without validating target program ID

**Code Quality - NEVER:**
- Comments stating the obvious (`// increment counter` before `counter += 1`)
- Defensive try/catch blocks abnormal for the codebase
- Verbose error messages where simple ones suffice
- Import unused dependencies
- Create abstractions for one-time operations
- Add features beyond what was asked

**AI Slop - ALWAYS REMOVE:**
- Excessive inline comments on self-explanatory code
- Redundant validation of already-validated data
- Style inconsistent with surrounding code
- Empty error handling blocks
- `// TODO: implement` without actual implementation plan

**Vault-Specific - NEVER:**
- Allow share price manipulation via direct token transfers
- Skip virtual shares/assets offset (inflation attack vector)
- Round in favor of user over vault on entry/exit

## Lessons Learned

<!-- Add entries as issues arise -->

**2026-03: Confidential Transfer context state accounts**
- Range proof data exceeds single tx size - split into 2 txs
- Context state account must be created before CT withdraw instruction

**2026-02: Token-2022 transfer hooks**
- Extra accounts must be resolved before CPI, not during
- Use `get_extra_account_metas_address` for hook state PDA

## Review Checklist

Before merge, run `git diff main...HEAD` and verify:
- No AI slop introduced
- Error handling matches existing patterns
- No unnecessary abstractions added
- Security checks present where needed
