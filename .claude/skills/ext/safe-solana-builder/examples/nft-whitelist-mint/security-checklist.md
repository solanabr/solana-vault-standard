# Security Checklist — NFT Whitelist Mint

## Framework
Anchor

---

## Rules Applied

| # | Category | Rule | Status | Notes |
|---|----------|------|--------|-------|
| 1 | Account Validation | Signer check on all authority operations | ✅ Applied | `Signer<'info>` used for `authority` in admin instructions, `payer` in mint |
| 2 | Account Validation | Ownership check on all typed accounts | ✅ Applied | `Account<'info, T>` on `MintConfig` and `WhitelistEntry` — Anchor auto-verifies owner + discriminator |
| 3 | Account Validation | Cross-account relationship enforcement | ✅ Applied | `has_one = authority` on `AddToWhitelist`, `RemoveFromWhitelist`; `constraint = whitelist_entry.user == payer.key()` on `MintNft` |
| 4 | Account Validation | Type cosplay prevention | ✅ Applied | Anchor discriminators on all state accounts via `#[account]` derive |
| 5 | Account Validation | Reinitialization prevention | ✅ Applied | `init` constraint on `MintConfig` and `WhitelistEntry` — fails if already exists |
| 6 | Account Validation | Writable flag enforcement | ✅ Applied | `mut` only on accounts that are modified; read-only accounts have no `mut` |
| 7 | PDA Security | Canonical bump only | ✅ Applied | Bumps stored in `MintConfig.bump` and `WhitelistEntry.bump` at init time; reused in all subsequent `seeds + bump` constraints |
| 8 | PDA Security | PDA sharing prevention | ✅ Applied | `WhitelistEntry` seeds include `user.key()` — each user has their own isolated PDA |
| 9 | PDA Security | Seed collision prevention | ✅ Applied | `b"mint_config"` and `b"whitelist"` are distinct prefixes for distinct PDA types |
| 10 | PDA Security | PDA purpose isolation | ✅ Applied | MintConfig and WhitelistEntry are separate PDAs with separate seeds and purposes |
| 11 | Arithmetic | Checked arithmetic on all financial values | ✅ Applied | `checked_add` on `current_supply`; `checked_sub` and `checked_add` on balance verification |
| 12 | Arithmetic | SOL balance check around CPI | ✅ Applied | `payer_balance_before` recorded pre-CPI; verified post-CPI that drain ≤ price + small buffer |
| 13 | Duplicate Accounts | Distinct mutable accounts enforced | ✅ Applied | `constraint = payer.key() != nft_mint.key()` on MintNft |
| 14 | CPI Safety | Program ID validation | ✅ Applied | `Program<'info, System>`, `Interface<'info, TokenInterface>`, `Program<'info, AssociatedToken>` auto-validate; `require_keys_eq!` on `token_metadata_program` against hardcoded `TOKEN_METADATA_PROGRAM_ID` constant |
| 15 | CPI Safety | No arbitrary CPI | ✅ Applied | All CPI targets are either `Program<T>` typed accounts or verified via `require_keys_eq!` before use |
| 16 | CPI Safety | Post-CPI state reload | ✅ Applied | `ctx.accounts.mint_config.reload()?` called after Metaplex CPIs before mutating supply counter |
| 17 | CPI Safety | Error propagation | ✅ Applied | All CPI calls use `?` operator — any inner failure reverts the full transaction |
| 18 | CPI Safety | invoke vs invoke_signed | ✅ Applied | `invoke_signed` only where MintConfig PDA must authorize (mint_to, create_metadata, create_edition); system transfer uses `invoke` via Anchor CpiContext |
| 19 | CPI Safety | Signer seeds use stored canonical bump | ✅ Applied | `&[config.bump]` used in signer seeds — never re-derived with `find_program_address` |
| 20 | Account Lifecycle | Rent exemption | ✅ Applied | All `init` accounts are payer-funded to rent-exempt threshold automatically by Anchor |
| 21 | Account Lifecycle | Safe account closing | ✅ Applied | `close = authority` constraint on `whitelist_entry` in `RemoveFromWhitelist` — zeroes data, transfers lamports, reassigns to system program |
| 22 | Account Lifecycle | Anti-revival close | ✅ Applied | Anchor's `close` constraint performs the full 3-step safe close; lamports return to trusted `authority`, not user-supplied address |
| 23 | Token Operations | Token-2022 compatibility | ✅ Applied | `Interface<'info, TokenInterface>`, `InterfaceAccount<'info, Mint>`, `InterfaceAccount<'info, TokenAccount>`, `token_interface::mint_to` used throughout |
| 24 | Business Logic | Double-mint prevention | ✅ Applied | `has_minted: bool` flag in `WhitelistEntry`; checked at instruction entry with `require!(!entry.has_minted, ...)`; set to `true` after successful mint |
| 25 | Business Logic | Supply cap enforcement | ✅ Applied | `require!(config.current_supply < config.max_supply, MintError::MaxSupplyReached)` checked before any state change |
| 26 | Business Logic | Input validation | ✅ Applied | `price > 0`, `max_supply > 0`, non-empty + length-bounded metadata fields all validated |
| 27 | Business Logic | State mutation after all CPIs | ✅ Applied | `current_supply` increment and `has_minted = true` set only after all CPIs succeed |
| 28 | Error Handling | Descriptive custom error codes | ✅ Applied | 13 distinct `#[error_code]` variants with clear messages |
| 29 | Error Handling | `require!` macros | ✅ Applied | All validation checks use `require!`, `require_keys_eq!`, `require_eq!` — no raw `if/return Err` |
| 30 | Sysvar | Sysvar account verification | ✅ Applied | `Sysvar<'info, Rent>` type used — Anchor validates the pubkey matches the canonical sysvar address |
| 31 | UncheckedAccount | All UncheckedAccount fields documented | ✅ Applied | Every `UncheckedAccount` has a `/// CHECK:` comment explaining why it's safe |

---

## Assumptions Made

- The program authority is set at `initialize` time and is a trusted admin keypair. Key rotation is not implemented — extend with a `transfer_authority` instruction if needed.
- `mpl_token_metadata` program is deployed at the canonical `TOKEN_METADATA_PROGRAM_ID` on the target cluster. Verified via `require_keys_eq!` before every CPI.
- NFT mints are true 1-of-1 (master edition `max_supply = Some(0)`). If prints are desired, `max_supply` logic must be revised.
- Metadata is set as `is_mutable = true` to allow post-reveal updates. If immutability is required after reveal, a `freeze_metadata` instruction should be added that calls Metaplex's update authority to revoke mutability.
- The whitelist is append-only from the user's perspective — users cannot add themselves. All `add_to_whitelist` calls are admin-only.
- Payment goes directly to the authority wallet. For revenue splits or escrow, replace the system transfer CPI with a more complex distribution pattern.

---

## Known Limitations / Follow-up for Auditor

1. **`init_if_needed` on `user_token_account`** — Used intentionally for the ATA, which is an idempotent operation by design. Security invariant is maintained by the `has_minted` flag, not by the ATA constraint. Auditor should verify the ATA is the correct mint/owner combination.

2. **Metadata `is_mutable = true`** — Authority can update name/URI after mint. If this is a reveal collection, this is intentional. If permanence is required, add a post-reveal `freeze_metadata` instruction.

3. **No royalty enforcement** — `seller_fee_basis_points = 0` and no creators array. If royalties are required, extend with creator/royalty fields in `MintConfig` and populate the `DataV2` struct accordingly.

4. **Metaplex `UncheckedAccount` for `metadata` and `master_edition`** — These PDAs are derived and validated inside the Metaplex program, not here. Auditor should verify the correct PDA addresses are passed from the client, and that the Metaplex program version matches expected behavior.

5. **No pause mechanism** — If the mint needs to be pauseable (e.g., during an incident), add a `paused: bool` flag to `MintConfig` and a `require!(!config.paused, ...)` at the top of `mint_nft`.

6. **No update_authority transfer** — Currently MintConfig PDA is the permanent update authority. For post-reveal immutability or for handing off to a DAO, a `transfer_update_authority` instruction is recommended.

7. **SOL balance buffer** — The post-CPI balance check allows `price + 10_000 lamports` tolerance for tx fees. This should be reviewed for the specific deployment environment — adjust if needed.

---

*Generated using Frank Castle's Safe Solana Builder*
