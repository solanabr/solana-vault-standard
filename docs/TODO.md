# Tokenized Vault Standard — Upgrade Roadmap

A functionality-focused backlog of improvements to evolve the repo toward Anchor v1, modern Solana tooling, and best-in-class DX. Entries are grouped by theme; no dates or time estimates are attached.

## 1. Anchor v1 Migration (Breaking)

Upgrading the workspace from Anchor 0.31.1 to 1.0.0 unlocks every other item in this document.

- **Bump `anchor-lang` and `anchor-spl` to `1.0.0`** across the workspace `Cargo.toml` and every program `Cargo.toml` (14 programs + mock-oracle + mock-sas). Update `Anchor.toml` `[toolchain]` and `[workspaces]` entries.
- **Upgrade Solana toolchain to 3.x** (minimum `3.1.10`). Update `.github/workflows/test.yml` to pin the installer URL and echo the version for reproducibility. Delete the current "stable" fallback.
- **Replace `@coral-xyz/anchor` with `@anchor-lang/core`** across `sdk/core`, `tests/`, and all `package.json` dependencies. Update every import including legacy `@coral-xyz/anchor/dist/cjs/idl` paths.
- **Audit for `AccountInfo` in `#[derive(Accounts)]`** — Anchor v1 now warns; migrate each to `UncheckedAccount<'info>` with an explicit `/// CHECK:` doc comment. Known hotspots: attestation PDA checks in `svs-11/instructions/*.rs`, frozen-account probes in `svs-11/instructions/request_*.rs`, remaining-account plumbing in module hooks.
- **Consolidate per-program `#[error_code]` blocks** — Anchor v1 rejects multiple blocks per program. Each program must have exactly one `error.rs` enum. Verify svs-11 (which has compliance + vault errors) and any program with split errors.
- **Handle duplicate-mutable-account rejection** — Anchor v1 rejects identical mutable accounts by default. Audit instructions that intentionally receive the same account twice (e.g., self-rebalance, tranche-to-tranche transfers inside svs-12) and annotate with `#[account(mut, dup)]` or refactor to split authority.
- **Remove deprecated constructs** — `#[interface]` attribute, `[registry]` section in `Anchor.toml`, `anchor login` invocations in scripts, `interface-instructions` feature flags. None of these are currently present in the repo but should be part of the audit checklist.
- **Re-validate `.reload()` call sites** — Anchor v1 re-triggers owner checks on reload. Confirm every post-CPI `.reload()?` in `svs-12/instructions/deposit.rs`, `svs-12/instructions/redeem.rs`, `svs-1..7/instructions/*.rs`, and mint CPIs still matches the expected program owner.
- **Switch IDL publishing to Program Metadata Program (PMP)** — Legacy on-chain IDL instructions are gone. Update release scripts and `anchor idl init` / `anchor idl upgrade` invocations; `program-id` argument is now optional.
- **Update Borsh to 1.5.7** across shared crates and SDK to match Anchor v1.

## 2. Anchor v1 Feature Adoption

- **Introduce `Migration<'info, From, To>` for every stateful account** — Add `state_v1.rs` / `state_v2.rs` scaffolding per program so future field additions (e.g., new accounting fields on `CreditVault`, tranche metadata on `TranchedVault`) can land without a wipe. Provide a migration instruction for each vault type that upgrades `VaultV1` → `VaultV2` via `realloc` + `migrate()`. Priority targets: `svs-11` (credit markets — most actively evolving), `svs-12` (tranched — waterfall math likely to gain fields), `svs-1` (canonical reference).
- **Adopt lifecycle hooks in `Anchor.toml`** — Define `pre_build` (format + clippy), `post_build` (verifiable-build artifact copy, checksum generation), `pre_test` (fixture reset), `post_deploy` (IDL upload via PMP, devnet health probe). This replaces the ad-hoc shell scripts in `package.json`.
- **Adopt `declare_program!` for all cross-program references** — Replaces the manual 8-byte discriminator skip in `svs-11/attestation.rs` and `svs-11/oracle.rs`, and the hand-rolled `mock-oracle` / `mock-sas` deserializers in tests. Benefits: typed instruction parsers, composite account resolution, tight coupling of SDK types to program IDLs.
- **Use `dup` constraint explicitly where needed** rather than silently allowing duplicates — currently no documented uses, but establish this as the sanctioned pattern.
- **Leverage broader PDA seed expressions** — Anchor v1 allows richer Rust in `seeds = [...]`. Audit `svs-8`, `svs-10`, `svs-11`, `svs-12` for seed expressions that currently compute helper values in handlers and move them inline.
- **Drop redundant CPI context `program` arguments** — v1 simplifies CPI context construction; refactor every `CpiContext::new_with_signer` call site to the leaner form.
- **Adopt `avm self-update`** in the dev setup docs and `/setup-mcp` / `/scaffold` skills.

## 3. Architecture & Code Quality

- **Consolidate duplicated `math.rs` across svs-1..7** — The same ~64-line module is copy-pasted into seven programs. Move all shared functions (`convert_to_shares`, `convert_to_assets`, `preview_*`) into `modules/svs-math` behind generic `Rounding` and `DecimalsOffset` inputs. Programs should re-export nothing — just call `svs_math::*`.
- **Extract a `svs-vault-core` crate** — Common `Admin` context (`pause`, `unpause`, `transfer_authority`, `accept_authority`), common error variants, common event types, canonical PDA seed constants, and the `decimals_offset` helper. Every program becomes a thin instruction+state layer over it.
- **Extract attestation parsing into a reusable crate** — `svs-11/src/attestation.rs` manually skips 8 bytes and deserializes. Move to a new `modules/svs-attestation` crate so svs-8, svs-10, and future programs can share the code. (The oracle half is DONE: the generic `SvsOraclePrice` header + `read_oracle` now live in `modules/svs-oracle`, consumed by SVS-11.)
- **Introduce `AdminContext` trait + derive macro** — Every program duplicates `pause`, `unpause`, `transfer_authority`, `accept_authority`. A trait with a blanket `#[derive(Admin)]` macro would cut hundreds of lines and enforce the two-step authority transfer invariant project-wide.
- **Formalize the module-hooks ABI** — Today `svs-module-hooks` is a loose collection of `pub fn check_*` signatures. Define a `ModuleHook` trait plus a versioned discriminator so modules can evolve independently of vault programs.
- **Stabilize `svs-rewards` and `svs-oracle`** — both are listed as "scaffolding" in code comments. Either finish them to match the other modules or mark them as work-in-progress in `README.md` and gate behind a `cfg(feature = "experimental")`.
- **Audit every `Box<Account>` wrap** — the v2.0.0 sweep was defensive. Now that local and CI use the same toolchain, re-profile stack frames (via `cargo build-sbf --verbose` frame reports) and un-box the ones that are comfortably under the 4KB limit to reduce heap pressure and save CU.
- **Split `sdk/core/src/svs9.ts`** (42KB, largest SDK file) into logical units — allocator config, child vault routing, reporting helpers. Same split review for other SDK files approaching 20KB.

## 4. Performance & CU Optimization

- **Introduce zero-copy accounts for hot-path state** — Candidates: `TranchedVault` (svs-12 — accessed 4× per instruction for subordination checks), `CreditVault` (svs-11 — heavy field count), `AllocatorConfig` (svs-9 — variable-length child list). Use `#[account(zero_copy)]` + `Ref`/`RefMut`. Keep the regular `#[account]` path for admin-only instructions.
- **Benchmark before/after every refactor** — Introduce a `benches/` tree using Mollusk's `compute_units_consumed` output. Each program gets a baseline CSV checked into `benches/baselines/` and `/benchmark` skill fails the build on regression > 2%.
- **Flamegraph profiling inspired by Quasar** — Wire up `solana-program-runtime` CU profiler output into a `scripts/profile.sh` that runs every instruction against a fixture and dumps SVG flamegraphs into `benches/flamegraphs/`. Commit the flamegraphs so reviewers can diff them.
- **Minimize `Box` where unnecessary after upgrading** — See §3 audit item. Post-Anchor-v1, some `Box` wraps may be safely removed.
- **Pack events** — Many events carry redundant fields (e.g., both `vault` and `vault_id`). Review `svs-*/src/events.rs` and drop redundant indexed fields; prefer `#[event_cpi]` where indexability via logs matters for off-chain indexers.
- **Hot-path `checked_arith` → `unchecked_arith` with invariants** — In proof-of-safety places (e.g., after a prior `require!` already bounds the operand) consider `wrapping_*` / `unchecked_*` guarded by debug asserts. Document the invariant next to each usage.
- **Remaining-accounts iteration** — svs-8 `deposit_proportional` and svs-10 fulfill paths walk `remaining_accounts` multiple times. Cache into stack arrays on first pass.

## 5. Testing Infrastructure

- **Introduce LiteSVM-first unit tests per program** — `programs/svs-*/tests/` with `#[cfg(test)]` Rust tests using `litesvm` for fast pre-commit runs. The ts-mocha `anchor test` suite stays for end-to-end integration.
- **Add Mollusk benchmark harnesses** — See §4. Every public instruction gets a Mollusk test asserting a CU ceiling.
- **Add Surfpool-based integration tests** for cross-program flows (svs-9 allocator → svs-1 child deposit, svs-11 request → approve → claim with attestation + oracle). Anchor v1 makes Surfpool the default backend — lean into it.
- **Fuzz critical math and waterfall logic** — Use `cargo-fuzz` against `svs-math::convert_to_*`, `svs-12/waterfall::check_subordination`, and `svs-8` oracle-weighted share computation. Wire into CI as a nightly job.
- **Property-based tests for invariants** — `total_shares * price ≈ total_assets`, `sum(tranches) == vault.total_assets`, `preview_deposit ≥ actual_deposit` (floor rounding), `preview_redeem ≤ actual_redeem`. Use `proptest` in `tests/invariants/`.
- **Snapshot tests for IDL** — Commit `target/idl/*.json` hashes and fail CI on unintentional IDL changes. Catches accidental ABI breaks during refactors.
- **Add CU regression CI job** — Runs the Mollusk benches on every PR, comments the delta on the PR via GitHub Actions.
- **Adopt Trident or native `cargo-fuzz` for the module-hooks layer** — Modules touching access control, caps, and fees must be fuzzed end-to-end through the vault.

## 6. SDK Modernization

- **Migrate `sdk/core` to `@anchor-lang/core`** — Drop-in import rewrite, regenerate types from new IDL via `declare_program!`-backed generation.
- **Add `@solana/kit` (web3.js 2.0) target** — Keep `@coral-xyz/anchor`-era surface for a deprecation window, but expose a `sdk/core/src/kit/` tree with tree-shakeable, async-iterator-friendly helpers for every vault operation. Default new examples to `@solana/kit`.
- **Codama-based client generation** — Replace the hand-written wrappers in `vault.ts`, `credit-vault.ts`, `tranched-vault.ts`, etc. with a Codama pipeline fed by the IDLs. Retain thin hand-written helpers only for non-trivial composition (async vault lifecycle, tranched-waterfall previews).
- **Unify the CLI** — `sdk/core/src/cli/` currently has per-operation scripts. Replace with a single `svs` binary using `commander` or `clipanion`, with sub-commands per program (`svs credit request-deposit ...`).
- **Typed simulation + fee estimation helpers** — Wrap every send-transaction path with auto-`simulate → setComputeUnitLimit → setComputeUnitPrice` using Helius `getPriorityFeeEstimate` when available. Current SDK uses static CU budgets.
- **Document module interactions in SDK** — Add `modules.ts` quick-start showing how to compose fees + caps + locks + access on top of a vault.
- **Ship SDK for both Node and browser** — Current package assumes Node. Add a browser build that excludes `fs`-dependent paths (fixture loading, keypair file I/O).

## 7. CI/CD & Tooling

- **Move the CI logic into Anchor.toml lifecycle hooks** (§2) — GitHub Actions becomes a thin runner that calls `anchor build`, `anchor test`, and the hooks handle everything else.
- **Verifiable builds job** — Add `anchor build --verifiable` for every program and upload the SBF artifacts as release assets. Required for mainnet deploy per `CLAUDE.md`.
- **Devnet canary deployment job** — On merge to `main`, deploy every program to devnet, run the full SDK test suite against the devnet deployment, and post a Slack / GitHub status. Required for any dApp integration work.
- **Release automation** — GitHub Actions workflow that, on a `v*` tag, publishes `@solana-vault-standard/core` to npm, publishes the Rust crates to crates.io, uploads verifiable artifacts, and opens a GitHub Release with auto-generated changelog from Conventional Commits.
- **Pin all tool versions** — Rust toolchain (via `rust-toolchain.toml`), Anchor (via `Anchor.toml` `[toolchain]`), Solana CLI (via explicit install URL), Node (via `.nvmrc`), Yarn (via `packageManager` in `package.json`).
- **Add security scanning** — `cargo audit`, `cargo deny`, `npm audit`, and `solana-security-txt` generation for each program. Run on every PR.
- **Docs site** — Build an mdBook or Nextra site from `docs/` and deploy to GitHub Pages. `docs/TODO.md` becomes part of the site's "Roadmap" page.

## 8. Documentation & DX

- **Rustdoc coverage** — Every public function in `programs/*/src/lib.rs` and `modules/*/src/lib.rs` needs `///` docs including examples. Enforce via `#![warn(missing_docs)]`.
- **Architecture diagrams per vault family** — ASCII-art or mermaid diagrams in each program's `README.md` showing account graph, instruction flow, and composition with modules.
- **End-to-end examples** — `examples/` tree with runnable Node scripts covering: "launch a credit vault with KYC", "compose fees + locks on a basic vault", "set up a tranched vault with oracle-driven waterfall", "async deposit lifecycle". Each example references the SDK from source (not npm) so it doubles as integration tests.
- **`CLAUDE.md` refresh** — Document the new Anchor v1 rules (e.g., `AccountInfo` → `UncheckedAccount`, one `#[error_code]` per program, `dup` constraint) in `.claude/rules/anchor.md`.
- **Migration guide** — `docs/migrations/v2-to-v3.md` describing every breaking change, how to upgrade client code, how to upgrade on-chain state via the new `Migration<From,To>` instructions.
- **Security review checklist** — `docs/security-checklist.md` to be ticked for every release. Inflation attack vector, share price manipulation, reentrancy (via CPI), oracle staleness, attestation revocation, tranche subordination invariants, waterfall rounding.
- **Contribution guide** — `CONTRIBUTING.md` with branch convention, `/quick-commit` workflow, PR template, required checks.

## Execution Notes

- Every item in §1 must land before items in §2–§8 can be attempted — v1 compatibility is the gate.
- Prefer incremental PRs per section over a single mega-PR. Each section lands independently behind a feature flag or on its own branch.
- Maintain v2 compatibility via the `v2-maintenance` branch for critical security fixes during the migration window.
