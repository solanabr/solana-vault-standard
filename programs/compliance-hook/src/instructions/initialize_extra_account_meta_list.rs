use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::state::{ComplianceMode, MintConfig, SanctionsList};

/// Token-2022 TransferHook spec: this PDA tells the runtime which accounts
/// beyond the canonical 4 (source, mint, destination, owner) `execute`
/// consumes. The seed is a fixed literal string per the spec — do NOT
/// change it. Note the HYPHEN (not underscore): the Token-2022 program
/// looks up exactly `b"extra-account-metas"`.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Capacity sized for max-case (`Permissioned` mode = 8 extras: 4 fixed-program
/// PDAs + 1 fixed pubkey for the attestation program + 2 cross-program
/// PDAs for source/destination attestations + 1 fixed pubkey for pool_policy).
/// `FreelyTransferable` underuses the slack (4 entries), but the per-PDA
/// waste (~4 ExtraAccountMeta entries = ~140 bytes) is acceptable in exchange
/// for avoiding realloc CPIs on mode switches.
const MAX_EXTRA_METAS: usize = 8;

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    /// PDA at the canonical Token-2022 seed; payer initializes.
    /// CHECK: validated via the seed constraint + the manual-capacity
    /// budget passed to `space`. Anchor's `init` constraint guards
    /// re-initialization (returns `account already in use`).
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(MAX_EXTRA_METAS).unwrap(),
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// CHECK: the Token-2022 mint this hook is bound to. The handler
    /// validates `mint.owner == spl_token_2022::id()` to reject legacy
    /// SPL mints and `mint.mint_authority == mint_authority.key()` for
    /// per-mint EAML init authority.
    pub mint: UncheckedAccount<'info>,

    /// Per-mint configuration. Mode is read directly via the typed
    /// `Account<'info, MintConfig>` wrapper. The handler also reads
    /// `attestation_program` for `Permissioned` mode to bake into the
    /// EAML's attestation-program extra (used as `program_index` for the
    /// cross-program PDA derivation of source/destination attestations).
    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
        seeds::program = crate::ID,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// Mint authority — MUST be the `Mint::mint_authority` recorded on
    /// the bound Token-2022 mint. The handler verifies this by reading
    /// the unpacked mint state and comparing with `mint_authority.key()`,
    /// rejecting with `UnauthorizedAuthority` on mismatch. Without this
    /// check, any signer could write the EAML for any mint (the
    /// extra-account-meta-list PDA is seeded only by `mint`), which would
    /// let a stranger pin a mint's hook-extra resolution to whatever
    /// account list they choose. This is distinct from
    /// `Mint::transfer_hook_authority`, which lives in the TransferHook
    /// extension and gates mint-level hook re-binding rather than
    /// per-mint EAML init.
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token_2022::spl_token_2022;
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    // Reject legacy SPL mints — only Token-2022 mints can carry a
    // TransferHook extension. Without this guard, the EAML init would
    // succeed against a legacy mint, producing a configuration the
    // runtime would never invoke.
    require_keys_eq!(
        *ctx.accounts.mint.owner,
        spl_token_2022::id(),
        crate::error::ComplianceHookError::InvalidMintAccount
    );

    // Verify the signer is the actual mint authority. Reading
    // mint_authority off the unpacked mint avoids relying on the EAML
    // PDA's `init` constraint as the only access gate.
    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    let mint_state = Token2022Mint::unpack(&mint_data[..Token2022Mint::LEN])
        .map_err(|_| crate::error::ComplianceHookError::InvalidMintAccount)?;
    let mint_authority_opt: Option<Pubkey> = mint_state.mint_authority.into();
    let actual_authority: Pubkey =
        mint_authority_opt.ok_or(crate::error::ComplianceHookError::UnauthorizedAuthority)?;
    drop(mint_data); // release the borrow before further mut access below.
    require_keys_eq!(
        actual_authority,
        ctx.accounts.mint_authority.key(),
        crate::error::ComplianceHookError::UnauthorizedAuthority
    );

    let mode = ctx.accounts.mint_config.mode;
    let extra_metas = build_extra_account_metas(
        mode,
        &ctx.accounts.mint_config.attestation_program,
        ctx.accounts.mint_config.pool_policy.as_ref(),
    )?;

    let mut data = ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut data, &extra_metas)?;

    msg!(
        "ExtraAccountMetaList initialized | mint={} mode={:?} extras={}",
        ctx.accounts.mint.key(),
        mode,
        extra_metas.len()
    );
    Ok(())
}

/// Build the `ExtraAccountMeta` vector for a given compliance mode.
///
/// Order matters: the Token-2022 runtime appends these entries to the
/// canonical 4 accounts (source_ata, mint, destination_ata, source_owner)
/// PLUS the EAML PDA itself (inserted at index 4 by
/// `spl-transfer-hook-interface::onchain::invoke_execute`) when invoking
/// `execute`. Resolved extras land at indices 5+ in the CPI account list,
/// and the SPL TLV resolver evaluates each `Seed::AccountKey` /
/// `Seed::AccountData` against the running CPI list (canonical 4 + EAML
/// PDA + extras already pushed). Any reordering invalidates the indices.
///
/// Index layout in `execute`'s CPI account list after resolution:
///
///   FreelyTransferable mode (4 extras → 9 total CPI accounts):
///     0 source_ata          (canonical)
///     1 mint                (canonical)
///     2 destination_ata     (canonical)
///     3 source_owner        (canonical)
///     4 extra_account_meta_list  (inserted by Token-2022)
///     5 mint_config         (FIRST extra)
///     6 sanctions_list
///     7 source_frozen_check
///     8 destination_frozen_check
///
///   Permissioned mode (8 extras → 13 total CPI accounts):
///     0..8 same as FreelyTransferable
///     9 attestation_program      (fixed pubkey, baked from
///                                 MintConfig.attestation_program at
///                                 EAML-init time)
///    10 source_attestation       (cross-program PDA under index 9,
///                                 seeds [b"attestation", source_owner,
///                                 attestation_issuer, attestation_type])
///    11 destination_attestation  (same shape, dest_owner)
///    12 pool_policy              (fixed pubkey from MintConfig.pool_policy)
fn build_extra_account_metas(
    mode: ComplianceMode,
    attestation_program: &Pubkey,
    pool_policy: Option<&Pubkey>,
) -> Result<Vec<ExtraAccountMeta>> {
    let mut v = vec![
        // mint_config: PDA at [b"mint_config", mint] under our program.
        // The `mint` is canonical account index 1.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: MintConfig::SEED_PREFIX.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false, // is_signer
            false, // is_writable
        )?,
        // sanctions_list: singleton PDA at [b"sanctions_list"].
        ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal {
                bytes: SanctionsList::SEED_PREFIX.to_vec(),
            }],
            false,
            false,
        )?,
        // source_frozen_check: PDA at [b"frozen", source_owner].
        // `source_owner` lives at bytes 32..64 of `source_ata` (canonical
        // index 0) per the SPL Token-2022 account layout. The
        // FrozenAccount PDA is created/closed by `freeze_account` /
        // `unfreeze_account` instructions.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"frozen".to_vec(),
                },
                Seed::AccountData {
                    account_index: 0,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
        // destination_frozen_check: same shape, sourced from
        // `destination_ata` (canonical index 2).
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: b"frozen".to_vec(),
                },
                Seed::AccountData {
                    account_index: 2,
                    data_index: 32,
                    length: 32,
                },
            ],
            false,
            false,
        )?,
    ];

    if mode == ComplianceMode::Permissioned {
        // attestation_program: fixed pubkey baked from
        // MintConfig.attestation_program. Required as a separate extra
        // because `new_external_pda_with_seeds` (used below) takes a
        // `program_index` — it derives the source/destination
        // attestation PDAs against the program at THIS index in the
        // resolved account list. Reading at EAML-init time and baking
        // means rotation requires re-init; for the current threat model
        // (per-pool trust anchor, set once) that's acceptable.
        v.push(ExtraAccountMeta::new_with_pubkey(
            attestation_program,
            false,
            false,
        )?);

        // source_attestation: cross-program PDA at
        //   [b"attestation", source_owner, attestation_issuer, attestation_type]
        // derived under MintConfig.attestation_program (the account at
        // CPI index 9 in the resolved list — see CPI index map at the
        // top of this function).
        //
        // Seed sources (account_index resolved against the running CPI
        // account list, which has the canonical 4 + EAML PDA inserted
        // at index 4 by Token-2022 + the extras pushed before this entry):
        //   - source_owner: source_ata (CPI index 0) bytes 32..64
        //   - attestation_issuer: mint_config (CPI index 5) bytes 106..138
        //     (MintConfig layout: discriminator 8 + mint 32 + mode 1 +
        //      Option_tag 1 + Pubkey 32 + attestation_program 32 = 106;
        //      attestation_issuer is the next 32 bytes)
        //   - attestation_type: mint_config (CPI index 5) byte 138
        v.push(ExtraAccountMeta::new_external_pda_with_seeds(
            9, // program_index → attestation_program (CPI index 9)
            &[
                Seed::Literal {
                    bytes: b"attestation".to_vec(),
                },
                Seed::AccountData {
                    account_index: 0,
                    data_index: 32,
                    length: 32,
                },
                Seed::AccountData {
                    account_index: 5,
                    data_index: 106,
                    length: 32,
                },
                Seed::AccountData {
                    account_index: 5,
                    data_index: 138,
                    length: 1,
                },
            ],
            false,
            false,
        )?);

        // destination_attestation: same shape with destination_ata (CPI index 2).
        v.push(ExtraAccountMeta::new_external_pda_with_seeds(
            9, // program_index → attestation_program (CPI index 9)
            &[
                Seed::Literal {
                    bytes: b"attestation".to_vec(),
                },
                Seed::AccountData {
                    account_index: 2,
                    data_index: 32,
                    length: 32,
                },
                Seed::AccountData {
                    account_index: 5,
                    data_index: 106,
                    length: 32,
                },
                Seed::AccountData {
                    account_index: 5,
                    data_index: 138,
                    length: 1,
                },
            ],
            false,
            false,
        )?);

        // pool_policy: fixed pubkey baked from MintConfig.pool_policy.
        // It may be owned by another program, so deriving it as a PDA
        // under compliance-hook would resolve the wrong account. A
        // policy rotation therefore requires re-initializing the EAML,
        // which matches the current "set once per mint" posture.
        let pool_policy = pool_policy
            .ok_or(crate::error::ComplianceHookError::MissingPoolPolicyForPermissioned)?;
        v.push(ExtraAccountMeta::new_with_pubkey(
            pool_policy,
            false,
            false,
        )?);
    }

    Ok(v)
}
