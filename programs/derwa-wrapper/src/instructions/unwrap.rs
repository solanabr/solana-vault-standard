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

/// Same helper as `wrap.rs::read_hook_program_id` — extract the hook
/// program from the mint's TransferHook extension. Duplicated rather
/// than refactored into a shared module to keep the unwrap CPI
/// self-contained; the function is small enough that the duplication
/// reads cleaner than a cross-module dependency.
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
/// Burns dePOOL from investor and releases cPOOL from the wrapper PDA back to
/// the investor — but ONLY if the destination wallet (the investor) has a
/// valid, non-revoked, non-expired attestation. Without this gate, an attacker
/// could buy dePOOL on a DEX without ever passing KYB and then unwrap to
/// receive permissioned cPOOL — the entire point of the Permissioned mode
/// would be defeated.
///
/// ── DEFENSE-IN-DEPTH ATTESTATION VALIDATION ───────────────────────────
/// `validate_investor_attestation` below performs FIVE checks that must
/// all pass before the unwrap proceeds:
///
///   1. **Account owner**: `att.owner == wrapper_config.attestation_program`.
///      Without this, an attacker could pass an account from a foreign
///      program with attacker-controlled data.
///
///   2. **Subject binding**: `payload[0..32] == investor.key()`. This is
///      the most subtle check, and it is NOT redundant with the canonical
///      PDA derivation in (5). One might reason that "passing a stranger's
///      attestation would require finding one whose subject equals the
///      investor, which is the same as having a real attestation"; that
///      reasoning is incorrect. Without reading the subject field
///      directly, the handler accepts any pre-existing valid attestation
///      (e.g. a friend's KYC'd account) for ANY investor passed as the
///      tx authority — silently unwrapping permissioned cPOOL into a
///      non-attested wallet. Re-deriving the canonical PDA in (5) closes
///      the same hole atomically, but explicit subject comparison
///      surfaces a clear, mode-specific error code on mismatch
///      (`InvalidAttestationSubject`) rather than the generic
///      `InvalidAttestationPda`, which makes downstream incident
///      response easier.
///
///   3. **Issuer match**: `payload[32..64] ==
///      wrapper_config.attestation_issuer`. Pins the trust anchor to a
///      specific compliance attester so an attestation from a different
///      jurisdiction's issuer can't satisfy this pool.
///
///   4. **Type match**: `payload[64] ==
///      wrapper_config.required_attestation_type`. Prevents a low-tier
///      attestation (generic KYC) from satisfying a vault that
///      semantically requires a higher tier (accredited investor) when
///      the same issuer issues multiple types.
///
///   5. **Canonical PDA derivation**:
///      `Pubkey::create_program_address([b"attestation", subject, issuer,
///      attestation_type, bump], attestation_program) == att.key()`.
///      Atomically binds checks 1-4 to the same physical account — the
///      attestation account address is a function of (program, subject,
///      issuer, type), so a mismatch in any of those produces a
///      different PDA than the one passed.
///
/// Together with the existing `revoked` and `expires_at` checks (6 and 7
/// in the validation list), this gives the full SVS-11-aligned
/// attestation enforcement. The check is intentionally redundant with
/// the on-chain ComplianceHook on the cPOOL `transfer_checked` CPI —
/// once the hook is fully wired up, both layers will reject an
/// unauthorized unwrap. Until then, this explicit check is the only
/// gate on the destination wallet, and a bug here voids the entire
/// Permissioned-mode invariant.
/// ────────────────────────────────────────────────────────────────────
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
    /// Validated comprehensively in the handler against `wrapper_config`'s
    /// trust anchors (program / issuer / type) AND against the canonical
    /// PDA derivation `[b"attestation", subject, issuer, attestation_type]`.
    /// See the DEFENSE-IN-DEPTH ATTESTATION VALIDATION block on `Unwrap`'s
    /// doc-comment for the full list of checks.
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

    // 1. Validate the investor's attestation against the wrapper's trust
    //    anchors. Reads the SVS-11-aligned 129-byte attestation payload
    //    and rejects any of: foreign program owner, mismatched subject /
    //    issuer / type, revoked, expired, or non-canonical PDA.
    validate_investor_attestation(
        &ctx.accounts.investor_attestation,
        &ctx.accounts.investor.key(),
        &ctx.accounts.wrapper_config,
    )?;

    // 2. Burn dePOOL from investor (investor signs).
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.derwa_mint.to_account_info(),
            from: ctx.accounts.investor_derwa_ata.to_account_info(),
            authority: ctx.accounts.investor.to_account_info(),
        },
    );
    burn(cpi_ctx, amount)?;

    // 3. Transfer cPOOL from wrapper PDA back to investor (wrapper PDA
    //    signs via signer_seeds). Goes through ComplianceHook in
    //    Permissioned mode — investor must be attested AND the wrapper
    //    PDA itself must hold a system attestation (issued at wrapper
    //    deploy time). Our explicit check in step 1 already validated the
    //    investor's attestation; the hook check is defense-in-depth on
    //    the source side (wrapper_signer) and reaffirms the destination.
    //
    //    `ctx.remaining_accounts` carries the EAML extras for the cPOOL
    //    transfer with `(source = wrapper_signer, destination = investor)`;
    //    the SDK's `DeRwaWrapper.unwrap` helper exposes these as a
    //    caller-supplied `remainingAccounts` parameter.
    // Same CPI-extension dance as `wrap.rs`: build the bare
    // transfer_checked ix and let `add_extra_accounts_for_execute_cpi`
    // append the hook program + EAML + resolved extras to the inner ix
    // keys list. wrapper_signer signs via `signer_seeds`.
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

    // 4. Update locked_supply.
    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.locked_supply = cfg
        .locked_supply
        .checked_sub(amount)
        .ok_or(DeRwaError::LockedSupplyOverflow)?;

    msg!(
        "unwrap | investor={} amount={} new_locked={}",
        ctx.accounts.investor.key(),
        amount,
        cfg.locked_supply,
    );
    Ok(())
}

/// Validate an SVS-11-shaped attestation account against a wrapper's
/// trust anchors and the expected subject (= investor unwrapping).
///
/// Layout reference (offsets are inside the post-discriminator payload,
/// so `payload[i] = data[i + 8]`):
///   0..32    subject (Pubkey)
///   32..64   issuer (Pubkey)
///   64       attestation_type (u8)
///   65..67   country_code ([u8; 2])
///   67..75   issued_at (i64)
///   75..83   expires_at (i64)
///   83       revoked (bool)
///   84       bump (u8)
///   85..117  _reserved ([u8; 32])
///   117..119 jurisdiction ([u8; 2])
///   119      investor_class (u8)
///   120      kyc_risk_tier (u8)
/// Total: 121 bytes payload + 8 disc = 129 bytes minimum.
///
/// MUST stay in sync with `programs/svs-11/src/attestation.rs` and
/// `programs/compliance-hook/src/instructions/execute.rs::check_attestation`.
fn validate_investor_attestation(
    att: &AccountInfo,
    investor: &Pubkey,
    cfg: &WrapperConfig,
) -> Result<()> {
    // (1) Account owner: must be the configured attestation program.
    require!(
        att.owner == &cfg.attestation_program,
        DeRwaError::InvalidAttestationProgram
    );

    // Existence + size. A non-existent PDA shows up as a default-zero
    // system account: lamports == 0, data.len() == 0.
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

    // (2) Subject: payload[0..32] must match the unwrapping investor.
    let subject = Pubkey::new_from_array(bytes_at(0..32)?);
    require!(&subject == investor, DeRwaError::InvalidAttestationSubject);

    // (3) Issuer: payload[32..64] must match wrapper-configured issuer.
    let issuer = Pubkey::new_from_array(bytes_at(32..64)?);
    require!(
        issuer == cfg.attestation_issuer,
        DeRwaError::InvalidAttestationIssuer
    );

    // (4) Attestation type: payload[64] must match wrapper-required type.
    let attestation_type = payload[64];
    require!(
        attestation_type == cfg.required_attestation_type,
        DeRwaError::InvalidAttestationType
    );

    // (6) Revoked: payload[83] must be 0.
    let revoked = payload[83] != 0;
    require!(!revoked, DeRwaError::AttestationRequired);

    // (7) Not expired: now < payload[75..83] (i64 LE).
    let expires_bytes: [u8; 8] = payload[75..83]
        .try_into()
        .map_err(|_| -> Error { error!(DeRwaError::AttestationRequired) })?;
    let expires_at = i64::from_le_bytes(expires_bytes);
    let now = Clock::get()?.unix_timestamp;
    require!(now < expires_at, DeRwaError::AttestationRequired);

    // (5) Canonical PDA derivation. Re-derives
    // `[b"attestation", subject, issuer, attestation_type, bump]` against
    // the configured attestation program and asserts the input account's
    // address matches. This atomically binds (1)-(4) to the same physical
    // account — a mismatch in subject / issuer / type would produce a
    // different PDA, which would not equal `att.key()`.
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
