use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;
use anchor_spl::token_interface::{burn, Burn, Mint, TokenAccount, TokenInterface};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

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
        token::mint = permissioned_mint,
        token::authority = wrapper_signer,
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

/// Validate an SVS-11 Attestation against wrapper trust anchors + the
/// unwrapping investor. Canonical-PDA derivation atomically binds the
/// owner/subject/issuer/type checks to the same physical account.
///
/// Field offsets MUST stay in sync with `svs-11/src/attestation.rs` AND
/// `compliance-hook/src/instructions/execute.rs::check_attestation`.
/// Offsets after the 8-byte discriminator:
///   0..32  subject  | 32..64  issuer  | 64  type  | 65..67  country
///   67..75  issued_at  | 75..83  expires_at  | 83  revoked  | 84  bump
fn validate_investor_attestation(
    att: &AccountInfo,
    investor: &Pubkey,
    cfg: &WrapperConfig,
) -> Result<()> {
    require!(
        att.owner == &cfg.attestation_program,
        DeRwaError::InvalidAttestationProgram
    );
    require!(
        att.lamports() > 0 && att.data_len() > 0,
        DeRwaError::AttestationRequired
    );

    let data = att.try_borrow_data()?;
    require!(data.len() >= 129, DeRwaError::AttestationRequired);
    let payload = &data[8..];
    let bytes_at = |range: std::ops::Range<usize>| -> Result<[u8; 32]> {
        payload[range]
            .try_into()
            .map_err(|_| -> Error { error!(DeRwaError::AttestationRequired) })
    };

    let subject = Pubkey::new_from_array(bytes_at(0..32)?);
    require!(&subject == investor, DeRwaError::InvalidAttestationSubject);

    let issuer = Pubkey::new_from_array(bytes_at(32..64)?);
    require!(
        issuer == cfg.attestation_issuer,
        DeRwaError::InvalidAttestationIssuer
    );

    let attestation_type = payload[64];
    require!(
        attestation_type == cfg.required_attestation_type,
        DeRwaError::InvalidAttestationType
    );

    let revoked = payload[83] != 0;
    require!(!revoked, DeRwaError::AttestationRequired);

    let expires_bytes: [u8; 8] = payload[75..83]
        .try_into()
        .map_err(|_| -> Error { error!(DeRwaError::AttestationRequired) })?;
    let expires_at = i64::from_le_bytes(expires_bytes);
    let now = Clock::get()?.unix_timestamp;
    require!(now < expires_at, DeRwaError::AttestationRequired);

    let bump = payload[84];
    let expected_pda = Pubkey::create_program_address(
        &[
            b"attestation",
            subject.as_ref(),
            issuer.as_ref(),
            &[attestation_type],
            &[bump],
        ],
        &cfg.attestation_program,
    )
    .map_err(|_| -> Error { error!(DeRwaError::InvalidAttestationPda) })?;
    require!(att.key() == expected_pda, DeRwaError::InvalidAttestationPda);

    Ok(())
}
