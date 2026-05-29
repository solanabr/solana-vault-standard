# Solana Tokenized Vault Standard

<!-- MAINTAINER: Based on solana-claude template. Project-specific additions below the template sections.
     Language-specific rules live in .claude/rules/ — don't duplicate here.
     HTML comments are stripped before reaching Claude (zero tokens). -->

Native port of ERC-4626 to Solana. 17 programs (SVS-1 through SVS-12, plus compliance-hook, nav-oracle, derwa-wrapper, mock-oracle, and mock-sas) implementing tokenized vaults with shares representing proportional ownership of underlying SPL tokens.

**Stack**: Anchor 0.31+, Rust 1.82+, Token-2022, TypeScript
**AI Tooling**: [solana-claude](https://github.com/solanabr/solana-claude) for skills, rules, agents, and MCP servers

## Communication Style
<!-- These override Claude's default chattiness. High compliance, keep. -->

- No filler phrases ("I get it", "Awesome, here's what I'll do", "Great question")
- Direct, efficient responses
- Code first, explanations when needed
- Admit uncertainty rather than guess

## Branch Workflow
<!-- Matches CLAUDE.md branch convention. /quick-commit automates this. -->

All new work: `git checkout -b <type>/<scope>-<description>-<DD-MM-YYYY>`. Use `/quick-commit` for automation.

## Mandatory Workflow
<!-- Core build loop. Steps 1-4 are enforced by Done Checklist below. -->

Every program change:
1. **Build**: `anchor build` or `cargo build-sbf`
2. **Format**: `cargo fmt`
3. **Lint**: `cargo clippy -- -W clippy::all`
4. **Test**: Unit + integration + fuzz
5. **Deploy**: Devnet first, mainnet with explicit confirmation

## Security Principles
<!-- HIGH VALUE: These rules prevent real security bugs. Do not compress further.
     Detailed per-language rules are in .claude/rules/{rust,anchor,pinocchio}.md -->

**NEVER**:
- Deploy to mainnet without explicit user confirmation
- Use unchecked arithmetic in programs
- Skip account validation
- Use `unwrap()` in program code
- Recalculate PDA bumps on every call
- Trust CPI return data without validating target program ID
- Use `init_if_needed` on PDA data accounts (reinit attack). Exception: ATAs with `associated_token` constraint
- Allow share price manipulation via direct token transfers
- Skip virtual shares/assets offset (inflation attack vector)
- Round in favor of user over vault on entry/exit

**ALWAYS**:
- Validate ALL accounts (owner, signer, PDA)
- Use checked arithmetic (`checked_add`, `checked_sub`)
- Store canonical PDA bumps
- Reload accounts after CPIs if modified
- Validate CPI target program IDs
- Round in favor of the vault (protect existing shareholders)

## MCP Servers
<!-- API keys go in .env (gitignored). Run /setup-mcp to configure. -->

MCP servers are configured in `.mcp.json`. API keys go in `.env` (never in mcp.json). Available servers:
- **Helius** — 60+ tools: RPC, DAS API, webhooks, priority fees, token metadata
- **solana-dev** — Solana Foundation official MCP: docs, guides, API references
- **Context7** — Up-to-date library documentation lookup
- **Playwright** — Browser automation for dApp testing
- **context-mode** — Compresses large RPC responses and build logs to save context
- **memsearch** — Persistent memory across sessions with semantic search

Run `/setup-mcp` to configure API keys and verify connections.

## Agent Teams
<!-- Keep this section minimal — just confirm feature is on + example. -->

Enabled. Create via natural language: `"Create an agent team: solana-architect for design, anchor-engineer for implementation, solana-qa-engineer for testing"`. Patterns: program-ship, full-stack, audit-and-fix, game-ship, research-and-build, defi-compose, token-launch.

## Anti-Patterns (Growing List)

**Code Quality — NEVER:**
- Comments stating the obvious (`// increment counter` before `counter += 1`)
- Defensive try/catch blocks abnormal for the codebase
- Verbose error messages where simple ones suffice
- Import unused dependencies
- Create abstractions for one-time operations
- Add features beyond what was asked

**AI Slop — ALWAYS REMOVE:**
- Excessive inline comments on self-explanatory code
- Redundant validation of already-validated data
- Style inconsistent with surrounding code
- Empty error handling blocks
- `// TODO: implement` without actual implementation plan

## Done Checklist
<!-- This is the gate before completing any branch. Claude checks these items.
     Program-specific items only apply when .rs files are changed. -->

Before completing a branch, verify:
- [ ] Build succeeds
- [ ] Formatted and linted (no warnings)
- [ ] All tests pass
- [ ] AI slop removed — run `/diff-review` (excessive comments, redundant try/catch, verbose errors)
- [ ] Ripple check — update related docs (README, CHANGELOG, config refs, API docs)

If program change:
- [ ] Security audit passed (`/audit-solana`)
- [ ] CU profiled (`/profile-cu`)
- [ ] Verifiable build (`anchor build --verifiable`) if deploying

## Self-Learning
<!-- Two tiers: strict (tracked) and relaxed (private). -->

**Writing to `CLAUDE.md`** (this file, tracked in git):
- Only when user is emphatic about a preference or correction
- When a process or error repeated 2+ times reveals a pattern
- When user explicitly says "remember this" or similar
- Project-specific → write here. Cross-project → write to `~/.claude/CLAUDE.md`.

**Writing to `CLAUDE.local.md`** (private, gitignored):
- Observations, scratch context, debugging notes, session summaries
- Be concise — only what's clearly useful. Not shared with team.

## Lessons Learned

<!-- Add entries as issues arise -->

**2026-03: Confidential Transfer context state accounts**
- Range proof data exceeds single tx size — split into 2 txs
- Context state account must be created before CT withdraw instruction

**2026-02: Token-2022 transfer hooks**
- Extra accounts must be resolved before CPI, not during
- Use `get_extra_account_metas_address` for hook state PDA

## Project Conventions

## Recurring Patterns

---

**Skills**: `.claude/skills/SKILL.md` | **Rules**: `.claude/rules/` | **Commands**: `.claude/commands/` | **Agents**: `.claude/agents/` | **MCP**: `.mcp.json`
