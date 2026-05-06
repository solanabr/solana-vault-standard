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

/// Read the configured TransferHook program from the mint's Token-2022
/// extension. Returns None when the mint isn't a Token-2022 mint.
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

/// Unwrap dePOOL → cPOOL at 1:1, attestation-gated.
///
/// Burns dePOOL from the investor and releases cPOOL from the wrapper PDA
/// back to the investor's cPOOL ATA. The destination wallet must hold a
/// valid attestation against the wrapper's configured trust anchors; see
/// `validate_investor_attestation` below for the validation contract.
/// The handler-level check is redundant with the ComplianceHook on the
/// cPOOL `transfer_checked` CPI in Permissioned mode and acts as the
/// authoritative gate when the cPOOL hook is configured as
/// FreelyTransferable.
///
/// The wrap is strict 1:1 by design — there is no slippage parameter
/// because dePOOL is minted/burned at exactly the cPOOL amount. The 1:1
/// invariant is asserted by the `locked_supply` arithmetic and the
/// matched `Burn` / `transfer_checked` amounts in the handler.
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
    /// Seeds: [b"wrapper_signer", wrapper_config.pool].
    #[account(
        seeds = [b"wrapper_signer", wrapper_config.pool.as_ref()],
        bump,
    )]
    pub wrapper_signer: UncheckedAccount<'info>,

    #[account(mut)]
    pub permissioned_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub derwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Wrapper PDA's cPOOL ATA — source of the cPOOL release.
    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = wrapper_signer,
    )]
    pub wrapper_locked_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Investor's cPOOL ATA — receives the released cPOOL.
    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = investor,
    )]
    pub investor_permissioned_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Investor's dePOOL ATA — source of the dePOOL burn.
    #[account(
        mut,
        token::mint = derwa_mint,
        token::authority = investor,
    )]
    pub investor_derwa_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Attestation PDA from the configured attestation program.
    /// Validated in the handler against `wrapper_config`'s trust anchors
    /// (program / issuer / type) and against the canonical PDA derivation
    /// `[b"attestation", subject, issuer, attestation_type]`. See
    /// `validate_investor_attestation` below.
    pub investor_attestation: UncheckedAccount<'info>,

    pub investor: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, Unwrap<'info>>, amount: u64) -> Result<()> {
    require!(amount > 0, DeRwaError::ZeroAmount);
    require!(
        ctx.accounts.wrapper_config.locked_supply >= amount,
        DeRwaError::InsufficientLockedSupply
    );

    validate_investor_attestation(
        &ctx.accounts.investor_attestation,
        &ctx.accounts.investor.key(),
        &ctx.accounts.wrapper_config,
    )?;

    // Burn dePOOL from the investor.
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.derwa_mint.to_account_info(),
            from: ctx.accounts.investor_derwa_ata.to_account_info(),
            authority: ctx.accounts.investor.to_account_info(),
        },
    );
    burn(cpi_ctx, amount)?;

    // Release cPOOL from wrapper PDA back to the investor. When the cPOOL
    // mint has a TransferHook configured, the inner `transfer_checked` ix
    // is extended with the resolved EAML extras supplied via
    // `ctx.remaining_accounts` (source = wrapper_signer, destination =
    // investor).
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
        .ok_or(DeRwaError::InsufficientLockedSupply)?;

    emit!(Unwrapped {
        pool: cfg.pool,
        investor: ctx.accounts.investor.key(),
        amount,
        locked_supply: cfg.locked_supply,
    });
    Ok(())
}

#[event]
pub struct Unwrapped {
    pub pool: Pubkey,
    pub investor: Pubkey,
    pub amount: u64,
    pub locked_supply: u64,
}

/// Validate an SVS-11-shaped attestation account against the wrapper's
/// trust anchors and the unwrapping investor.
///
/// Account layout (post-discriminator payload, so `payload[i] = data[i + 8]`):
///
/// | offset    | field             | size |
/// |-----------|-------------------|------|
/// | 0..32     | subject           | 32   |
/// | 32..64    | issuer            | 32   |
/// | 64        | attestation_type  | 1    |
/// | 65..67    | country_code      | 2    |
/// | 67..75    | issued_at         | 8    |
/// | 75..83    | expires_at        | 8    |
/// | 83        | revoked           | 1    |
/// | 84        | bump              | 1    |
/// | 85..117   | _reserved         | 32   |
/// | 117..119  | jurisdiction      | 2    |
/// | 119       | investor_class    | 1    |
/// | 120       | kyc_risk_tier     | 1    |
///
/// Total: 121-byte payload + 8-byte discriminator = 129 bytes minimum.
/// Must stay in sync with `programs/svs-11/src/attestation.rs` and
/// `programs/compliance-hook/src/instructions/execute.rs::check_attestation`.
fn validate_investor_attestation(
    att: &AccountInfo,
    investor: &Pubkey,
    cfg: &WrapperConfig,
) -> Result<()> {
    // 1. Account owner: must be the configured attestation program.
    require!(
        att.owner == &cfg.attestation_program,
        DeRwaError::InvalidAttestationProgram
    );

    // 2. Existence and size. A non-existent PDA shows up as a default-zero
    //    system account (lamports == 0, data.len() == 0).
    require!(
        att.lamports() > 0 && att.data_len() > 0,
        DeRwaError::AttestationRequired
    );

    let data = att.try_borrow_data()?;
    require!(data.len() >= 129, DeRwaError::AttestationRequired);
    let payload = &data[8..];

    // 3. Subject: payload[0..32] must match the unwrapping investor.
    let subject_bytes: [u8; 32] = payload[0..32]
        .try_into()
        .map_err(|_| error!(DeRwaError::AttestationRequired))?;
    let subject = Pubkey::new_from_array(subject_bytes);
    require!(&subject == investor, DeRwaError::InvalidAttestationSubject);

    // 4. Issuer: payload[32..64] must match the wrapper-configured issuer.
    let issuer_bytes: [u8; 32] = payload[32..64]
        .try_into()
        .map_err(|_| error!(DeRwaError::AttestationRequired))?;
    let issuer = Pubkey::new_from_array(issuer_bytes);
    require!(
        issuer == cfg.attestation_issuer,
        DeRwaError::InvalidAttestationIssuer
    );

    // 5. Attestation type: payload[64] must match the wrapper-required type.
    let attestation_type = payload[64];
    require!(
        attestation_type == cfg.required_attestation_type,
        DeRwaError::InvalidAttestationType
    );

    // 6. Revoked: payload[83] must be 0.
    let revoked = payload[83] != 0;
    require!(!revoked, DeRwaError::AttestationRequired);

    // 7. Not expired: now < payload[75..83] (i64 LE).
    let expires_at_bytes: [u8; 8] = payload[75..83]
        .try_into()
        .map_err(|_| error!(DeRwaError::AttestationRequired))?;
    let expires_at = i64::from_le_bytes(expires_at_bytes);
    let now = Clock::get()?.unix_timestamp;
    require!(now < expires_at, DeRwaError::AttestationRequired);

    // 8. Canonical PDA derivation. Re-derives
    //    `[b"attestation", subject, issuer, attestation_type, bump]` and
    //    asserts the input account's address matches. Atomically binds 3-5
    //    to the same physical account.
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
