//! Fulfill redeem instruction: compute assets for locked shares, burn shares, escrow assets.
//!
//! The operator calls this after reviewing the redeem request. Supports dual pricing:
//! oracle-priced (operator provides price) or vault-priced (svs-math conversion).
//! Shares are burned from escrow and assets moved to a per-user claimable account.

use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022,
    token_interface::{
        transfer_checked, Mint, Token2022, TokenAccount, TokenInterface, TransferChecked,
    },
};

use crate::{
    constants::{CLAIMABLE_TOKENS_SEED, REDEEM_REQUEST_SEED, SHARE_ESCROW_SEED, VAULT_SEED},
    error::VaultError,
    events::RedeemFulfilled,
    state::{AsyncVault, RedeemRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct FulfillRedeem<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        constraint = vault.operator == operator.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = redeem_request.bump,
        constraint = redeem_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    #[account(
        constraint = asset_mint.key() == vault.asset_mint,
    )]
    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = shares_mint.key() == vault.shares_mint,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = operator,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = asset_token_program,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump,
    )]
    pub claimable_tokens: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<FulfillRedeem>, oracle_price: Option<u64>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let redeem_request = &ctx.accounts.redeem_request;
    let clock = &ctx.accounts.clock;
    let shares_locked = redeem_request.shares_locked;

    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let owner_key = redeem_request.owner;
        module_hooks::check_deposit_access(remaining, &crate::ID, &vault_key, &owner_key, &[])?;
    }

    let assets = if let Some(price) = oracle_price {
        svs_oracle::validate_price(price).map_err(|e| match e {
            svs_oracle::OracleError::InvalidPrice => VaultError::ZeroAmount,
            svs_oracle::OracleError::StalePrice => VaultError::OracleStale,
            svs_oracle::OracleError::PriceDeviationExceeded => VaultError::OracleDeviationExceeded,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            _ => VaultError::MathOverflow,
        })?;

        if vault.total_assets > 0 || vault.total_shares > 0 {
            let vault_price = crate::math::convert_to_assets(
                svs_oracle::PRICE_SCALE,
                vault.total_assets,
                vault.total_shares,
                vault.decimals_offset,
                crate::math::Rounding::Floor,
            )?;
            svs_oracle::validate_deviation(price, vault_price, vault.max_deviation_bps).map_err(
                |e| match e {
                    svs_oracle::OracleError::PriceDeviationExceeded => {
                        VaultError::OracleDeviationExceeded
                    }
                    svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
                    _ => VaultError::MathOverflow,
                },
            )?;
        }

        svs_oracle::shares_to_assets(shares_locked, price).map_err(|e| match e {
            svs_oracle::OracleError::InvalidPrice => VaultError::ZeroAmount,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            _ => VaultError::MathOverflow,
        })?
    } else {
        crate::math::convert_to_assets(
            shares_locked,
            vault.total_assets,
            vault.total_shares,
            vault.decimals_offset,
            crate::math::Rounding::Floor,
        )?
    };

    #[cfg(feature = "modules")]
    let net_assets = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, assets)?;
        result.net_assets
    };
    #[cfg(not(feature = "modules"))]
    let net_assets = assets;

    let available = ctx
        .accounts
        .asset_vault
        .amount
        .checked_sub(vault.total_pending_deposits)
        .ok_or(VaultError::MathOverflow)?;
    require!(available >= net_assets, VaultError::InsufficientLiquidity);

    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &[vault_bump],
    ]];

    token_2022::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            token_2022::Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.share_escrow.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares_locked,
    )?;

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.claimable_tokens.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        net_assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    let redeem_request = &mut ctx.accounts.redeem_request;
    redeem_request.assets_claimable = net_assets;
    redeem_request.status = RequestStatus::Fulfilled;
    redeem_request.fulfilled_at = clock.unix_timestamp;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault
        .total_assets
        .checked_sub(net_assets)
        .ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(shares_locked)
        .ok_or(VaultError::MathOverflow)?;

    emit!(RedeemFulfilled {
        vault: vault.key(),
        owner: redeem_request.owner,
        shares: shares_locked,
        assets: net_assets,
    });

    Ok(())
}
