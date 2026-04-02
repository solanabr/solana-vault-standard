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
    constants::{
        CLAIMABLE_TOKENS_SEED, OPERATOR_APPROVAL_SEED, REDEEM_REQUEST_SEED, SHARE_ESCROW_SEED,
        VAULT_SEED,
    },
    error::VaultError,
    events::RedeemFulfilled,
    state::{AsyncVault, OperatorApproval, RedeemRequest, RequestStatus},
};

#[cfg(feature = "modules")]
use svs_module_hooks as module_hooks;

#[derive(Accounts)]
pub struct FulfillRedeem<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump = redeem_request.bump,
        constraint = redeem_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    /// V9-P3: Manual PDA validation is intentional — Anchor constraints don't support
    /// conditional seeds on `Option<Account>` types. The handler validates the PDA key
    /// via `create_program_address` + key comparison when this account is `Some`.
    pub operator_approval: Option<Account<'info, OperatorApproval>>,

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
        bump = vault.share_escrow_bump,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
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

pub fn handler(
    ctx: Context<FulfillRedeem>,
    oracle_price: Option<u64>,
    min_price_per_share: u64,
) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let redeem_request = &ctx.accounts.redeem_request;
    let clock = &ctx.accounts.clock;
    let shares_locked = redeem_request.shares_locked;

    // Use shares_mint.supply as the authoritative total shares instead of the
    // cached vault.total_shares, which can be stale when fulfilled-but-unclaimed
    // deposits exist. Subtract total_pending_redeems because escrowed shares are
    // still in the mint supply but their backing assets remain in total_assets.
    let live_total_shares = ctx
        .accounts
        .shares_mint
        .supply
        .checked_sub(vault.total_pending_redeems)
        .ok_or(VaultError::MathOverflow)?;

    let is_vault_operator = vault.operator == ctx.accounts.operator.key();
    if !is_vault_operator {
        let approval = ctx
            .accounts
            .operator_approval
            .as_ref()
            .ok_or(VaultError::OperatorNotApproved)?;
        require!(
            approval.can_fulfill_redeem
                && approval.owner == redeem_request.owner
                && approval.operator == ctx.accounts.operator.key()
                && approval.vault == vault.key(),
            VaultError::OperatorNotApproved
        );
        let expected_pda = anchor_lang::solana_program::pubkey::Pubkey::create_program_address(
            &[
                OPERATOR_APPROVAL_SEED,
                vault.key().as_ref(),
                redeem_request.owner.as_ref(),
                ctx.accounts.operator.key().as_ref(),
                &[approval.bump],
            ],
            &crate::ID,
        )
        .map_err(|_| VaultError::OperatorNotApproved)?;
        require!(
            approval.key() == expected_pda,
            VaultError::OperatorNotApproved
        );
    }

    if vault.cancel_after > 0 {
        let deadline = redeem_request
            .requested_at
            .checked_add(vault.cancel_after)
            .ok_or(VaultError::MathOverflow)?;
        require!(clock.unix_timestamp < deadline, VaultError::RequestExpired);
    }

    #[cfg(feature = "modules")]
    {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let owner_key = redeem_request.owner;
        module_hooks::check_withdrawal_access(remaining, &crate::ID, &vault_key, &owner_key)?;
    }

    let assets = if let Some(price) = oracle_price {
        svs_oracle::validate_price(price).map_err(|e| match e {
            svs_oracle::OracleError::InvalidPrice => VaultError::ZeroAmount,
            svs_oracle::OracleError::StalePrice => VaultError::OracleStale,
            svs_oracle::OracleError::PriceDeviationExceeded => VaultError::OracleDeviationExceeded,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            _ => VaultError::MathOverflow,
        })?;

        // Deviation check: compare oracle price against vault-derived price when
        // shares exist, or against PRICE_SCALE (1:1) on the first redeem to prevent
        // an operator from setting an extreme price.
        //
        // Include pending and fulfilled deposits in the NAV calculation so that large
        // queued deposits don't loosen the deviation guard (V4-P6).
        let nav_total_assets = vault
            .total_assets
            .checked_add(vault.total_pending_deposits)
            .and_then(|v| v.checked_add(vault.total_fulfilled_deposits))
            .ok_or(VaultError::MathOverflow)?;
        let expected_price = if nav_total_assets > 0 || live_total_shares > 0 {
            crate::math::convert_to_assets(
                svs_oracle::PRICE_SCALE,
                nav_total_assets,
                live_total_shares,
                vault.decimals_offset,
                crate::math::Rounding::Floor,
            )?
        } else {
            svs_oracle::PRICE_SCALE
        };
        svs_oracle::validate_deviation(price, expected_price, vault.max_deviation_bps).map_err(
            |e| match e {
                svs_oracle::OracleError::PriceDeviationExceeded => {
                    VaultError::OracleDeviationExceeded
                }
                svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
                _ => VaultError::MathOverflow,
            },
        )?;

        svs_oracle::shares_to_assets(shares_locked, price).map_err(|e| match e {
            svs_oracle::OracleError::InvalidPrice => VaultError::ZeroAmount,
            svs_oracle::OracleError::MathOverflow => VaultError::MathOverflow,
            _ => VaultError::MathOverflow,
        })?
    } else {
        // V5-P8: Vault-priced path intentionally uses raw vault.total_assets (the real
        // backing assets) for share-to-asset conversion, NOT the expanded NAV used in
        // the deviation check above. The deviation guard uses total_assets + pending +
        // fulfilled to prevent the oracle from drifting too far from the full economic
        // picture, while the actual conversion must use real total_assets so redeemers
        // receive assets proportional to what the vault truly holds.
        crate::math::convert_to_assets(
            shares_locked,
            vault.total_assets,
            live_total_shares,
            vault.decimals_offset,
            crate::math::Rounding::Floor,
        )?
    };

    // V4-P27 / V9-P13: Slippage guard. A zero min_price_per_share intentionally disables
    // this check for the request. The oracle deviation check (max_deviation_bps) provides
    // secondary protection against extreme price manipulation. Integrators should set
    // non-zero bounds for production use.
    if min_price_per_share > 0 && shares_locked > 0 {
        let effective_price: u64 = (assets as u128)
            .checked_mul(svs_oracle::PRICE_SCALE as u128)
            .ok_or(VaultError::MathOverflow)?
            .checked_div(shares_locked as u128)
            .ok_or(VaultError::MathOverflow)?
            .try_into()
            .map_err(|_| VaultError::MathOverflow)?;
        require!(
            effective_price >= min_price_per_share,
            VaultError::SlippageExceeded
        );
    }

    #[cfg(feature = "modules")]
    let net_assets = {
        let remaining = ctx.remaining_accounts;
        let vault_key = vault.key();
        let result = module_hooks::apply_exit_fee(remaining, &crate::ID, &vault_key, assets)?;
        result.net_assets
    };
    #[cfg(not(feature = "modules"))]
    let net_assets = assets;

    require!(net_assets > 0, VaultError::ZeroAmount);

    // Exclude both pending deposits (awaiting fulfill) and fulfilled-but-unclaimed
    // deposits (awaiting claim) — those assets are earmarked for depositors.
    let available = ctx
        .accounts
        .asset_vault
        .amount
        .checked_sub(vault.total_pending_deposits)
        .and_then(|v| v.checked_sub(vault.total_fulfilled_deposits))
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
    vault.total_pending_redeems = vault
        .total_pending_redeems
        .checked_sub(shares_locked)
        .ok_or(VaultError::MathOverflow)?;

    let fee_amount = assets
        .checked_sub(net_assets)
        .ok_or(VaultError::MathOverflow)?;
    if fee_amount > 0 {
        vault.cumulative_redeem_fees = vault
            .cumulative_redeem_fees
            .checked_add(fee_amount)
            .ok_or(VaultError::MathOverflow)?;
    }

    emit!(RedeemFulfilled {
        vault: vault.key(),
        owner: redeem_request.owner,
        shares: shares_locked,
        assets: net_assets,
    });

    Ok(())
}
