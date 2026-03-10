# Extend the Solana Vault Standard Programs & SDK

**Source:** https://superteam.fun/earn/listing/extend-the-solana-vault-standard-programs-and-sdk
**Fetched:** 2026-03-10

## Overview

Superteam Brazil invites developers to build SVS-5 through SVS-12 — eight new vault standard implementations extending Solana's open-source infrastructure to cover DeFi and RWA use cases.

## Prize Structure

| Place | Prize |
|-------|-------|
| 1st | $1,500 USDG |
| 2nd | $1,200 USDG |
| 3rd | $800 USDG |
| 4th | $300 USDG |
| 5th | $200 USDG |
| **Total** | **$4,000 USDG** |

Rankings determined by total contribution value across all submitted PRs.

## Standards Available (Pick Up to 3)

| Standard | Focus |
|----------|-------|
| SVS-5 | Streaming Yield – continuous token distribution |
| SVS-6 | Streaming + Confidential – privacy transfers |
| SVS-7 | Native SOL – direct SOL vault handling |
| SVS-8 | Multi-Asset Basket – multiple underlying assets |
| SVS-9 | Allocator/Vault-of-Vaults – meta-vault allocation |
| SVS-10 | Async/ERC-7540 – request-fulfill redemptions |
| SVS-11 | Credit Vault – lending with borrower management |
| SVS-12 | Tranched/Structured – senior/junior tranches |

## Required Deliverables Per Standard

### 1. On-Chain Program (Anchor)

- Complete instruction implementation per spec
- Account structures matching PDA layouts
- Events for all state-changing operations
- Descriptive error codes
- Clean CPI interfaces
- In-code documentation

### 2. Module Compatibility

Integrate existing modules (svs-fees, svs-caps, svs-locks, svs-rewards, svs-access, svs-oracle) where applicable. Document incompatibilities clearly.

### 3. TypeScript SDK

- Extend existing SDK following established patterns
- Full typings (no `any` types)
- Usage examples included

### 4. CLI

- Standard-specific commands
- Follow CLI.md structure
- All operations accessible via command line

### 5. Testing

- Unit tests for every instruction (Anchor bankrun)
- SDK integration tests
- End-to-end lifecycle tests
- Trident fuzz testing – heavily encouraged

### 6. Documentation

- Standard-specific markdown file
- Update docs/README.md
- Update main README.md if needed
- Cross-reference updates

### 7. Devnet Deployment

- Deploy to Devnet
- Include Program ID and example transactions in PR

## Evaluation Criteria (100 Total)

| Criterion | Weight |
|-----------|--------|
| Spec Compliance & Correctness | 40% |
| Module Compatibility | 15% |
| Code Quality | 15% |
| Testing | 15% |
| SDK, CLI & Documentation | 15% |

**Bonus Factors:**

- Trident fuzz tests
- Multiple high-quality standards
- Novel optimizations beyond spec
- Clean git history

## Submission Requirements

1. **PR Links** – Maximum 3 PRs to github.com/solanabr/solana-vault-standard
2. **Devnet Proof** – Program IDs and example transactions
3. **Twitter Post** – Tag @SuperteamBR
4. **Brief Summary** – 3-5 sentences per PR on approach and design decisions

**Submission Bonuses:**

- Deep dive article/writeup
- Video walkthrough
- Video proof of end-to-end tests
- Release post with animations/examples

## Timeline

- **Submission Deadline:** March 31, 2026
- **Review Period:** 10 days after deadline
- **Winner Announcement:** Within 14 days after deadline
- **Payment:** Within 15 days after announcement

## Rules

**Allowed:**

- AI-assisted development (if reviewed, tested, production-quality)
- Building on repo patterns
- Up to 3 PRs per person/team
- Teams under single account

**Not Allowed:**

- More than 3 PRs per person/team
- Breaking SVS-1 through SVS-4 tests
- Modifying core module interfaces without approval
- Incomplete standards

## Key Resources

- **Repository:** github.com/solanabr/solana-vault-standard
- **Critical Docs:** CONTRIBUTING.md, ARCHITECTURE.md, PATTERNS.md, TESTING.md, SDK.md, CLI.md
- **Contact:** GitHub @kauenet / Discord discord.gg/superteambrasil / Twitter @SuperteamBR @kauenet

## Eligibility

Residents of Brazil. Skills: Rust, Anchor, TypeScript, Token-2022, DeFi Architecture.
