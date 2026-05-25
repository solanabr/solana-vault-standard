use anchor_lang::prelude::*;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::state::{ComplianceMode, MintConfig, SanctionsList};

/// Token-2022 TransferHook canonical seed (hyphen, not underscore).
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// EAML capacity sized for max-case (Permissioned mode: 8 extras).
/// FreelyTransferable underuses 4 entries; the slack avoids realloc CPIs
/// on mode switches.
const MAX_EXTRA_METAS: usize = 8;

/// Byte size of one `ExtraAccountMeta`: 1 (discriminator) + 32 (addr_config)
/// + 1 (is_signer PodBool) + 1 (is_writable PodBool).
const EXTRA_ACCOUNT_META_BYTES: usize = 35;

/// EAML PDA storage size = 8 (Token-2022 discriminator) + 4 (Vec length)
/// + N × `EXTRA_ACCOUNT_META_BYTES`. CI test asserts byte-equivalence with
/// `ExtraAccountMetaList::size_of(MAX_EXTRA_METAS)`.
const EAML_SPACE: usize = 8 + 4 + (EXTRA_ACCOUNT_META_BYTES * MAX_EXTRA_METAS);

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    /// CHECK: seed-constrained init; capacity from `EAML_SPACE`.
    #[account(
        init,
        payer = payer,
        space = EAML_SPACE,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// CHECK: handler validates `owner == spl_token_2022::id()` and
    /// `mint_authority == mint_authority.key()`.
    pub mint: UncheckedAccount<'info>,

    #[account(
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
        seeds::program = crate::ID,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// Mint authority — required signer. Without verification against the
    /// unpacked mint, any signer could write the EAML for any mint (the
    /// PDA is seeded only by `mint`).
    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeExtraAccountMetaList>) -> Result<()> {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token_2022::spl_token_2022;
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    require_keys_eq!(
        *ctx.accounts.mint.owner,
        spl_token_2022::id(),
        crate::error::ComplianceHookError::InvalidMintAccount
    );

    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    let mint_state = Token2022Mint::unpack(&mint_data[..Token2022Mint::LEN])
        .map_err(|_| crate::error::ComplianceHookError::InvalidMintAccount)?;
    let mint_authority_opt: Option<Pubkey> = mint_state.mint_authority.into();
    let actual_authority: Pubkey =
        mint_authority_opt.ok_or(crate::error::ComplianceHookError::UnauthorizedAuthority)?;
    drop(mint_data);
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

    Ok(())
}

/// Build the EAML entries. CPI account index layout `execute` receives
/// (the SPL TLV resolver evaluates seeds against this list):
///
///   Canonical (0..4): source_ata, mint, destination_ata, source_owner
///   Index 4: extra_account_meta_list (inserted by Token-2022)
///   Index 5+: resolved extras (this function's output)
///
///   FreelyTransferable (4 extras, 9 total):
///     5 mint_config  6 sanctions_list  7 source_frozen  8 destination_frozen
///
///   Permissioned (+4 = 8 extras, 13 total):
///     9 attestation_program  10 source_attestation
///    11 destination_attestation  12 pool_policy
///
/// `source_owner` (bytes 32..64 of source_ata) and the `attestation_issuer`
/// + `attestation_type` reads at offsets 106 / 138 of mint_config are
/// load-bearing for seed derivation — do not reorder MintConfig.
fn build_extra_account_metas(
    mode: ComplianceMode,
    attestation_program: &Pubkey,
    pool_policy: Option<&Pubkey>,
) -> Result<Vec<ExtraAccountMeta>> {
    let mut v = vec![
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: MintConfig::SEED_PREFIX.to_vec(),
                },
                Seed::AccountKey { index: 1 },
            ],
            false,
            false,
        )?,
        ExtraAccountMeta::new_with_seeds(
            &[Seed::Literal {
                bytes: SanctionsList::SEED_PREFIX.to_vec(),
            }],
            false,
            false,
        )?,
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
        v.push(ExtraAccountMeta::new_with_pubkey(
            attestation_program,
            false,
            false,
        )?);

        v.push(ExtraAccountMeta::new_external_pda_with_seeds(
            9,
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

        v.push(ExtraAccountMeta::new_external_pda_with_seeds(
            9,
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
