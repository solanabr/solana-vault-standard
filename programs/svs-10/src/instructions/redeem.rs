use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use svs_math::{convert_to_assets, Rounding};
use crate::{
    constants::*,
    error::VaultError,
    events::*,
    state::{AsyncVault, RedeemRequest, RequestStatus},
};

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::InvalidAccount,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint @ VaultError::InvalidAccount,
        constraint = user_shares_account.owner == owner.key() @ VaultError::Unauthorized,
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = share_escrow.key() == vault.share_escrow @ VaultError::InvalidAccount,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init, payer = owner,
        space = RedeemRequest::LEN,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn request_redeem(ctx: Context<RequestRedeem>, shares: u64, receiver: Pubkey) -> Result<()> {
    require!(shares > 0, VaultError::ZeroAmount);

    anchor_spl::token_2022::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_2022_program.to_account_info(),
            anchor_spl::token_2022::TransferChecked {
                from: ctx.accounts.user_shares_account.to_account_info(),
                to: ctx.accounts.share_escrow.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        shares,
        9,
    )?;

    let req = &mut ctx.accounts.redeem_request;
    req.vault = ctx.accounts.vault.key();
    req.owner = ctx.accounts.owner.key();
    req.receiver = receiver;
    req.shares_locked = shares;
    req.assets_claimable = 0;
    req.status = RequestStatus::Pending;
    req.requested_at = Clock::get()?.unix_timestamp;
    req.fulfilled_at = 0;
    req.bump = ctx.bumps.redeem_request;

    emit!(RedeemRequested {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        receiver,
        shares,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelRedeem<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AsyncVault>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = redeem_request.bump,
        has_one = owner,
        close = owner,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    #[account(
        mut,
        constraint = share_escrow.key() == vault.share_escrow @ VaultError::InvalidAccount,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
    require!(
        ctx.accounts.redeem_request.status == RequestStatus::Pending,
        VaultError::RequestNotPending
    );

    let shares = ctx.accounts.redeem_request.shares_locked;
    let vault = &ctx.accounts.vault;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let asset_mint_key = vault.asset_mint;
    let bump = vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED, asset_mint_key.as_ref(), vault_id_bytes.as_ref(), &[bump],
    ]];

    anchor_spl::token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            anchor_spl::token_2022::TransferChecked {
                from: ctx.accounts.share_escrow.to_account_info(),
                to: ctx.accounts.user_shares_account.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
        9,
    )?;

    emit!(RedeemRequestCancelled {
        vault: ctx.accounts.vault.key(),
        owner: ctx.accounts.owner.key(),
        shares_returned: shares,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct FulfillRedeem<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(
        mut,
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.operator == operator.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, AsyncVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::InvalidAccount,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault @ VaultError::InvalidAccount,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = share_escrow.key() == vault.share_escrow @ VaultError::InvalidAccount,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init, payer = operator,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), redeem_request.owner.as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = asset_token_program,
    )]
    pub claimable_tokens: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = redeem_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn fulfill_redeem(ctx: Context<FulfillRedeem>) -> Result<()> {
    let shares = ctx.accounts.redeem_request.shares_locked;
    let owner = ctx.accounts.redeem_request.owner;

    let assets = convert_to_assets(
        shares,
        ctx.accounts.vault.total_assets,
        ctx.accounts.vault.total_shares,
        ctx.accounts.vault.decimals_offset,
        Rounding::Floor,
    ).map_err(|_| error!(VaultError::MathOverflow))?;

    require!(assets > 0, VaultError::ZeroAmount);
    require!(assets <= ctx.accounts.asset_vault.amount, VaultError::InsufficientAssets);

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED, asset_mint_key.as_ref(), vault_id_bytes.as_ref(), &[bump],
    ]];

    anchor_spl::token_2022::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            anchor_spl::token_2022::Burn {
                mint: ctx.accounts.shares_mint.to_account_info(),
                from: ctx.accounts.share_escrow.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
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
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    ctx.accounts.redeem_request.assets_claimable = assets;
    ctx.accounts.redeem_request.status = RequestStatus::Fulfilled;
    ctx.accounts.redeem_request.fulfilled_at = Clock::get()?.unix_timestamp;

    ctx.accounts.vault.total_assets = ctx.accounts.vault.total_assets
        .checked_sub(assets).ok_or(VaultError::MathOverflow)?;
    ctx.accounts.vault.total_shares = ctx.accounts.vault.total_shares
        .checked_sub(shares).ok_or(VaultError::MathOverflow)?;

    emit!(RedeemFulfilled {
        vault: ctx.accounts.vault.key(),
        owner,
        shares,
        assets,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRedeem<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        seeds = [ASYNC_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, AsyncVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [REDEEM_REQUEST_SEED, vault.key().as_ref(), redeem_request_owner.key().as_ref()],
        bump = redeem_request.bump,
        constraint = redeem_request.status == RequestStatus::Fulfilled @ VaultError::RequestNotFulfilled,
        close = redeem_request_owner,
    )]
    pub redeem_request: Account<'info, RedeemRequest>,

    /// CHECK: validated as request owner
    #[account(mut)]
    pub redeem_request_owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [CLAIMABLE_TOKENS_SEED, vault.key().as_ref(), redeem_request_owner.key().as_ref()],
        bump,
    )]
    pub claimable_tokens: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub receiver_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn claim_redeem(ctx: Context<ClaimRedeem>) -> Result<()> {
    let req = &ctx.accounts.redeem_request;
    require!(
        ctx.accounts.claimer.key() == req.receiver || ctx.accounts.claimer.key() == req.owner,
        VaultError::Unauthorized
    );

    let assets = req.assets_claimable;
    let owner = req.owner;
    let receiver = req.receiver;
    require!(assets > 0, VaultError::NothingToClaim);

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        ASYNC_VAULT_SEED, asset_mint_key.as_ref(), vault_id_bytes.as_ref(), &[bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.claimable_tokens.to_account_info(),
                to: ctx.accounts.receiver_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    emit!(RedeemClaimed {
        vault: ctx.accounts.vault.key(),
        owner,
        receiver,
        assets,
    });
    Ok(())
}
