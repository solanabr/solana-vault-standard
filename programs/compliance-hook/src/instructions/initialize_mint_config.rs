use anchor_lang::prelude::*;

use crate::state::{ComplianceMode, MintConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct InitializeMintConfigArgs {
    pub mode: ComplianceMode,
    /// `Some(_)` required when `mode == Permissioned`; `None` required for `FreelyTransferable`.
    pub pool_policy: Option<Pubkey>,
    /// Required (non-default) for Permissioned mode; ignored for FreelyTransferable.
    pub attestation_program: Pubkey,
    /// Required (non-default) for Permissioned mode.
    pub attestation_issuer: Pubkey,
    pub required_attestation_type: u8,
}

#[derive(Accounts)]
#[instruction(args: InitializeMintConfigArgs)]
pub struct InitializeMintConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = MintConfig::SPACE,
        seeds = [MintConfig::SEED_PREFIX, mint.key().as_ref()],
        bump,
    )]
    pub mint_config: Account<'info, MintConfig>,

    /// CHECK: handler validates `mint.owner == spl_token_2022::id()` and
    /// `mint.mint_authority == mint_authority.key()` via unpacked state.
    pub mint: AccountInfo<'info>,

    pub mint_authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeMintConfig>, args: InitializeMintConfigArgs) -> Result<()> {
    use anchor_lang::solana_program::program_pack::Pack;
    use anchor_spl::token_2022::spl_token_2022;
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;

    // Legacy SPL mints can't carry a TransferHook extension; binding a
    // MintConfig to one produces a structurally-valid but unenforceable
    // configuration.
    require_keys_eq!(
        *ctx.accounts.mint.owner,
        spl_token_2022::id(),
        crate::error::ComplianceHookError::InvalidMintAccount
    );

    let mint_data = ctx.accounts.mint.try_borrow_data()?;
    require!(
        mint_data.len() >= Token2022Mint::LEN,
        crate::error::ComplianceHookError::InvalidMintAccount
    );
    let mint_state = Token2022Mint::unpack(&mint_data[..Token2022Mint::LEN])
        .map_err(|_| crate::error::ComplianceHookError::InvalidMintAccount)?;

    let mint_authority_opt: Option<Pubkey> = mint_state.mint_authority.into();
    let actual_authority: Pubkey =
        mint_authority_opt.ok_or(crate::error::ComplianceHookError::UnauthorizedAuthority)?;

    require_keys_eq!(
        actual_authority,
        ctx.accounts.mint_authority.key(),
        crate::error::ComplianceHookError::UnauthorizedAuthority
    );

    match (args.mode, args.pool_policy) {
        (ComplianceMode::Permissioned, None) => {
            return err!(crate::error::ComplianceHookError::MissingPoolPolicyForPermissioned);
        }
        (ComplianceMode::FreelyTransferable, Some(_)) => {
            return err!(crate::error::ComplianceHookError::PoolPolicySetOnFreelyTransferable);
        }
        _ => {}
    }

    if args.mode == ComplianceMode::Permissioned {
        require_keys_neq!(
            args.attestation_program,
            Pubkey::default(),
            crate::error::ComplianceHookError::InvalidAttestationConfig
        );
        require_keys_neq!(
            args.attestation_issuer,
            Pubkey::default(),
            crate::error::ComplianceHookError::InvalidAttestationConfig
        );
    }

    let cfg = &mut ctx.accounts.mint_config;
    cfg.mint = ctx.accounts.mint.key();
    cfg.mode = args.mode;
    cfg.pool_policy = args.pool_policy;
    cfg.attestation_program = args.attestation_program;
    cfg.attestation_issuer = args.attestation_issuer;
    cfg.required_attestation_type = args.required_attestation_type;

    Ok(())
}
