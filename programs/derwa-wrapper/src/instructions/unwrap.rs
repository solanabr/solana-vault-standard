use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;
use anchor_spl::token_interface::{burn, Burn, Mint, TokenAccount, TokenInterface};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;
use svs_attestation::{verify_attestation, AttestationError};

use crate::error::DeRwaError;
use crate::state::WrapperConfig;

/// ComplianceHook program ID. Mirrors `svs-11/src/constants.rs` and
/// `compliance-hook/src/lib.rs::declare_id!`.
pub const COMPLIANCE_HOOK_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P");

fn read_hook_program_id(mint: &AccountInfo) -> Result<Option<Pubkey>> {
    if mint.owner != &spl_token_2022::ID {
        return Ok(None);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Mint>::unpack(&data)
        .map_err(|_| error!(DeRwaError::MintMismatch))?;
    match state.get_extension::<TransferHook>() {
        Ok(ext) => Ok(Option::<Pubkey>::from(ext.program_id)),
        Err(_) => Ok(None),
    }
}

/// Unwrap dePOOL → cPOOL at 1:1, attestation-gated on the destination
/// wallet. Without the gate, dePOOL bought on a DEX could be unwrapped
/// into permissioned cPOOL without ever passing KYB.
#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(
        mut,
        seeds = [WrapperConfig::SEED_PREFIX, wrapper_config.pool.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.permissioned_mint == permissioned_mint.key() @ DeRwaError::MintMismatch,
        constraint = wrapper_config.derwa_mint == derwa_mint.key() @ DeRwaError::MintMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    /// CHECK: PDA owning the locked cPOOL ATA + acting as dePOOL mint authority.
    #[account(
        seeds = [b"wrapper_signer", wrapper_config.pool.as_ref()],
        bump,
    )]
    pub wrapper_signer: UncheckedAccount<'info>,

    #[account(mut)]
    pub permissioned_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub derwa_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = permissioned_mint,
        associated_token::authority = wrapper_signer,
        associated_token::token_program = token_program,
    )]
    pub wrapper_locked_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = investor,
    )]
    pub investor_permissioned_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = derwa_mint,
        token::authority = investor,
    )]
    pub investor_derwa_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated in handler against wrapper trust anchors + canonical PDA.
    pub investor_attestation: UncheckedAccount<'info>,

    /// Protocol-level singleton sanctions list (owned by compliance-hook).
    #[account(
        seeds = [compliance_hook::state::SanctionsList::SEED_PREFIX],
        bump,
        seeds::program = COMPLIANCE_HOOK_PROGRAM_ID,
    )]
    pub sanctions_list: Box<Account<'info, compliance_hook::state::SanctionsList>>,

    /// CHECK: [b"frozen", investor] in compliance-hook. Existence (program-owned,
    /// non-empty) = frozen. Validated by assert_wallet_compliant.
    #[account(
        seeds = [compliance_hook::state::FrozenAccount::SEED_PREFIX, investor.key().as_ref()],
        bump,
        seeds::program = COMPLIANCE_HOOK_PROGRAM_ID,
    )]
    pub frozen_check: UncheckedAccount<'info>,

    pub investor: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, Unwrap<'info>>, amount: u64) -> Result<()> {
    require!(amount > 0, DeRwaError::ZeroAmount);
    require!(
        ctx.accounts.wrapper_config.locked_supply >= amount,
        DeRwaError::InsufficientLockedSupply
    );

    compliance_hook::assert_wallet_compliant(
        &ctx.accounts.sanctions_list,
        &ctx.accounts.frozen_check.to_account_info(),
        &ctx.accounts.investor.key(),
    )?;

    validate_investor_attestation(
        &ctx.accounts.investor_attestation,
        &ctx.accounts.investor.key(),
        &ctx.accounts.wrapper_config,
    )?;

    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.derwa_mint.to_account_info(),
            from: ctx.accounts.investor_derwa_ata.to_account_info(),
            authority: ctx.accounts.investor.to_account_info(),
        },
    );
    burn(cpi_ctx, amount)?;

    let pool_key = ctx.accounts.wrapper_config.pool;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"wrapper_signer",
        pool_key.as_ref(),
        &[ctx.bumps.wrapper_signer],
    ]];
    let mut transfer_ix = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &ctx.accounts.wrapper_locked_ata.key(),
        &ctx.accounts.permissioned_mint.key(),
        &ctx.accounts.investor_permissioned_ata.key(),
        &ctx.accounts.wrapper_signer.key(),
        &[],
        amount,
        ctx.accounts.permissioned_mint.decimals,
    )?;
    let mut transfer_account_infos: Vec<AccountInfo<'info>> = vec![
        ctx.accounts.wrapper_locked_ata.to_account_info(),
        ctx.accounts.permissioned_mint.to_account_info(),
        ctx.accounts.investor_permissioned_ata.to_account_info(),
        ctx.accounts.wrapper_signer.to_account_info(),
    ];
    if let Some(hook_program_id) =
        read_hook_program_id(&ctx.accounts.permissioned_mint.to_account_info())?
    {
        add_extra_accounts_for_execute_cpi(
            &mut transfer_ix,
            &mut transfer_account_infos,
            &hook_program_id,
            ctx.accounts.wrapper_locked_ata.to_account_info(),
            ctx.accounts.permissioned_mint.to_account_info(),
            ctx.accounts.investor_permissioned_ata.to_account_info(),
            ctx.accounts.wrapper_signer.to_account_info(),
            amount,
            ctx.remaining_accounts,
        )
        .map_err(|e| -> Error { e.into() })?;
    }
    invoke_signed(&transfer_ix, &transfer_account_infos, signer_seeds)?;

    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.locked_supply = cfg
        .locked_supply
        .checked_sub(amount)
        .ok_or(DeRwaError::LockedSupplyOverflow)?;

    emit!(crate::events::Unwrapped {
        pool: cfg.pool,
        investor: ctx.accounts.investor.key(),
        amount,
        locked_supply_after: cfg.locked_supply,
        attestation_subject: ctx.accounts.investor.key(),
    });
    Ok(())
}

/// Map the shared module's granular error onto deRWA error codes.
fn map_attestation_err(e: AttestationError) -> DeRwaError {
    match e {
        AttestationError::WrongOwner => DeRwaError::InvalidAttestationProgram,
        AttestationError::SubjectMismatch => DeRwaError::InvalidAttestationSubject,
        AttestationError::IssuerMismatch => DeRwaError::InvalidAttestationIssuer,
        AttestationError::WrongType => DeRwaError::InvalidAttestationType,
        AttestationError::InvalidPda => DeRwaError::InvalidAttestationPda,
        AttestationError::Malformed | AttestationError::Revoked | AttestationError::Expired => {
            DeRwaError::AttestationRequired
        }
    }
}

/// Validate an SVS attestation against wrapper trust anchors + the unwrapping
/// investor. The canonical layout + checks live in the shared `svs-attestation`
/// module; this maps the result onto deRWA error codes.
fn validate_investor_attestation(
    att: &AccountInfo,
    investor: &Pubkey,
    cfg: &WrapperConfig,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    verify_attestation(
        att,
        &cfg.attestation_program,
        investor,
        &cfg.attestation_issuer,
        cfg.required_attestation_type,
        now,
    )
    .map_err(|e| error!(map_attestation_err(e)))?;
    Ok(())
}
