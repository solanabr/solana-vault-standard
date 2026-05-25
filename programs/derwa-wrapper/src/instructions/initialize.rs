use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::Mint;

use crate::error::DeRwaError;
use crate::state::WrapperConfig;

/// Trust anchors for `unwrap` attestation validation. Immutable after init —
/// rotating any requires re-deploying the wrapper for a new pool.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct InitializeWrapperArgs {
    pub attestation_program: Pubkey,
    pub attestation_issuer: Pubkey,
    /// Encodes KYC tier (e.g. 0 = generic KYC, 2 = accredited investor).
    pub required_attestation_type: u8,
}

/// Bind a pool to its (cPOOL, dePOOL) mint pair + capture per-pool trust
/// posture. On-chain invariants: dePOOL `mint_authority == wrapper_signer`
/// and `supply == 0`. cPOOL hook + dePOOL hook configuration are operator-
/// script responsibility; misconfiguration fails first `wrap`/`unwrap`.
#[derive(Accounts)]
#[instruction(args: InitializeWrapperArgs)]
pub struct InitializeWrapper<'info> {
    /// CHECK: stored verbatim; not dereferenced (avoids svs-11 IDL coupling).
    pub pool: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = WrapperConfig::SPACE,
        seeds = [WrapperConfig::SEED_PREFIX, pool.key().as_ref()],
        bump,
    )]
    pub wrapper_config: Account<'info, WrapperConfig>,

    pub permissioned_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: seed-validated; asserted as `derwa_mint.mint_authority` below.
    #[account(
        seeds = [b"wrapper_signer", pool.key().as_ref()],
        bump,
    )]
    pub wrapper_signer: UncheckedAccount<'info>,

    #[account(
        constraint = derwa_mint.mint_authority == COption::Some(wrapper_signer.key())
            @ DeRwaError::InvalidDerwaMint,
        constraint = derwa_mint.supply == 0
            @ DeRwaError::InvalidDerwaMint,
    )]
    pub derwa_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeWrapper>, args: InitializeWrapperArgs) -> Result<()> {
    require!(
        args.attestation_program != Pubkey::default(),
        DeRwaError::InvalidAttestationConfig
    );
    require!(
        args.attestation_issuer != Pubkey::default(),
        DeRwaError::InvalidAttestationConfig
    );

    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.pool = ctx.accounts.pool.key();
    cfg.permissioned_mint = ctx.accounts.permissioned_mint.key();
    cfg.derwa_mint = ctx.accounts.derwa_mint.key();
    cfg.locked_supply = 0;
    cfg.bump = ctx.bumps.wrapper_config;
    cfg.attestation_program = args.attestation_program;
    cfg.attestation_issuer = args.attestation_issuer;
    cfg.required_attestation_type = args.required_attestation_type;

    emit!(crate::events::WrapperInitialized {
        pool: cfg.pool,
        permissioned_mint: cfg.permissioned_mint,
        derwa_mint: cfg.derwa_mint,
        attestation_program: cfg.attestation_program,
        attestation_issuer: cfg.attestation_issuer,
        required_attestation_type: cfg.required_attestation_type,
    });
    Ok(())
}
