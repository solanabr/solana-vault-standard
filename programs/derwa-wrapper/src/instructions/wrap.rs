use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::extension::{
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Mint as Token2022Mint;
use anchor_spl::token_interface::{mint_to, Mint, MintTo, TokenAccount, TokenInterface};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

use crate::error::DeRwaError;
use crate::state::WrapperConfig;

/// Extract the hook program ID from a Token-2022 mint's `TransferHook`
/// extension. Returns `None` for legacy SPL mints, mints without the
/// extension, or mints with the extension explicitly cleared.
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

/// Wrap permissioned cPOOL → freely-transferable dePOOL at 1:1.
///
/// Investor transfers `amount` cPOOL to the wrapper PDA's ATA, and the wrapper
/// program signs a `mint_to` for `amount` dePOOL into the investor's dePOOL ATA.
/// `locked_supply` increments to maintain the on-chain invariant
/// `locked_supply == dePOOL.supply`.
///
/// ─── HOOK ACCOUNT FORWARDING ──────────────────────────────────────────────
/// The cPOOL `transfer_checked` CPI invokes ComplianceHook (typically in
/// Permissioned mode). Token-2022 auto-resolves the hook's
/// ExtraAccountMetaList for top-level user txs, but for a CPI the CALLER
/// must pass the extra accounts in `remaining_accounts`. We forward
/// `ctx.remaining_accounts` verbatim to the CPI via
/// `with_remaining_accounts(...)`. Off-chain SDK callers must build the
/// `wrap` instruction with the resolved EAML extras for the source =
/// investor → destination = wrapper_signer transfer; the SDK's
/// `DeRwaWrapper.wrap` helper exposes this as a caller-supplied
/// `remainingAccounts` parameter.
///
/// The wrapper PDA (`wrapper_signer`) is the destination of the cPOOL
/// transfer. In Permissioned mode the hook validates BOTH owners — so the
/// wrapper deploy must issue a "system attestation" for `wrapper_signer`
/// in the same attestation program as regular investors (subject =
/// wrapper_signer, issuer + type matching `WrapperConfig`'s anchors).
/// Without it, the destination-attestation check fails. The operator
/// bootstrap flow must create this attestation before opening wrapping.
/// ──────────────────────────────────────────────────────────────────────────
#[derive(Accounts)]
pub struct Wrap<'info> {
    /// Per-pool wrapper config. Mut because we increment `locked_supply`.
    /// Mint constraints validate that the (cPOOL, dePOOL) pair matches the
    /// pair this wrapper was initialised with — prevents an attacker from
    /// passing a different mint to mint themselves dePOOL out of thin air.
    #[account(
        mut,
        seeds = [WrapperConfig::SEED_PREFIX, wrapper_config.pool.as_ref()],
        bump = wrapper_config.bump,
        constraint = wrapper_config.permissioned_mint == permissioned_mint.key() @ DeRwaError::MintMismatch,
        constraint = wrapper_config.derwa_mint == derwa_mint.key() @ DeRwaError::MintMismatch,
    )]
    pub wrapper_config: Box<Account<'info, WrapperConfig>>,

    /// CHECK: PDA owning the locked cPOOL ATA + acting as dePOOL mint authority.
    /// Seeds: [b"wrapper_signer", wrapper_config.pool]. We use UncheckedAccount
    /// because this PDA holds no data — it's pure authority. The seed
    /// constraint is the validation; only the wrapper program can sign for it.
    #[account(
        seeds = [b"wrapper_signer", wrapper_config.pool.as_ref()],
        bump,
    )]
    pub wrapper_signer: UncheckedAccount<'info>,

    #[account(mut)]
    pub permissioned_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub derwa_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Investor's cPOOL ATA — source of the wrap.
    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = investor,
    )]
    pub investor_permissioned_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Wrapper PDA's cPOOL ATA — destination of the wrap. The cPOOL stays
    /// here for the lifetime of the dePOOL position; unwrap moves it back.
    #[account(
        mut,
        token::mint = permissioned_mint,
        token::authority = wrapper_signer,
    )]
    pub wrapper_locked_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Investor's dePOOL ATA — receives the minted dePOOL.
    #[account(
        mut,
        token::mint = derwa_mint,
        token::authority = investor,
    )]
    pub investor_derwa_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub investor: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(ctx: Context<'_, '_, '_, 'info, Wrap<'info>>, amount: u64) -> Result<()> {
    require!(amount > 0, DeRwaError::ZeroAmount);

    // 1. Transfer cPOOL from investor → wrapper PDA's ATA.
    //    `transfer_checked` is the Token-2022 path that respects the
    //    TransferHook extension. Token-2022's `invoke_execute` looks up
    //    the hook program + EAML PDA + resolved extras in the INNER ix's
    //    keys list (not in the surrounding tx accounts), so we cannot
    //    rely on Anchor's `with_remaining_accounts` alone — that only
    //    extends the CPI account_infos, not the inner ix's `accounts`
    //    field. We build the bare `transfer_checked` ix from
    //    spl-token-2022 and let `add_extra_accounts_for_execute_cpi`
    //    extend BOTH the ix keys list AND the cpi_account_infos with
    //    the hook program + EAML + resolved extras (sourced from
    //    `ctx.remaining_accounts`). The off-chain SDK's `wrap` helper
    //    builds the corresponding `remainingAccounts` slice so this
    //    extension finds what it needs.
    let mut transfer_ix = spl_token_2022::instruction::transfer_checked(
        &spl_token_2022::ID,
        &ctx.accounts.investor_permissioned_ata.key(),
        &ctx.accounts.permissioned_mint.key(),
        &ctx.accounts.wrapper_locked_ata.key(),
        &ctx.accounts.investor.key(),
        &[],
        amount,
        ctx.accounts.permissioned_mint.decimals,
    )?;
    let mut transfer_account_infos: Vec<AccountInfo<'info>> = vec![
        ctx.accounts.investor_permissioned_ata.to_account_info(),
        ctx.accounts.permissioned_mint.to_account_info(),
        ctx.accounts.wrapper_locked_ata.to_account_info(),
        ctx.accounts.investor.to_account_info(),
    ];
    if let Some(hook_program_id) =
        read_hook_program_id(&ctx.accounts.permissioned_mint.to_account_info())?
    {
        add_extra_accounts_for_execute_cpi(
            &mut transfer_ix,
            &mut transfer_account_infos,
            &hook_program_id,
            ctx.accounts.investor_permissioned_ata.to_account_info(),
            ctx.accounts.permissioned_mint.to_account_info(),
            ctx.accounts.wrapper_locked_ata.to_account_info(),
            ctx.accounts.investor.to_account_info(),
            amount,
            ctx.remaining_accounts,
        )
        .map_err(|e| -> Error { e.into() })?;
    }
    invoke_signed(&transfer_ix, &transfer_account_infos, &[])?;

    // 2. Mint dePOOL to investor (1:1).
    //
    //    Anchor's `bumps` only contains entries for accounts that were
    //    derived in this ix's accounts struct. `wrapper_signer` IS one of
    //    those (via the `seeds = [...]` constraint above), so
    //    `ctx.bumps.wrapper_signer` is the canonical bump.
    let pool_key = ctx.accounts.wrapper_config.pool;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"wrapper_signer",
        pool_key.as_ref(),
        &[ctx.bumps.wrapper_signer],
    ]];
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.derwa_mint.to_account_info(),
            to: ctx.accounts.investor_derwa_ata.to_account_info(),
            authority: ctx.accounts.wrapper_signer.to_account_info(),
        },
        signer_seeds,
    );
    mint_to(cpi_ctx, amount)?;

    // 3. Update locked_supply.
    let cfg = &mut ctx.accounts.wrapper_config;
    cfg.locked_supply = cfg
        .locked_supply
        .checked_add(amount)
        .ok_or(DeRwaError::LockedSupplyOverflow)?;

    msg!(
        "wrap | investor={} amount={} new_locked={}",
        ctx.accounts.investor.key(),
        amount,
        cfg.locked_supply,
    );
    Ok(())
}
