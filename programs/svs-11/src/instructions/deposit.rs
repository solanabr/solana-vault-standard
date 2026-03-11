use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::Token2022,
    token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked},
};
use svs_math::{convert_to_shares, Rounding};
use crate::{
    constants::*,
    error::VaultError,
    events::*,
    state::{CreditVault, DepositRequest, FrozenAccount, KycAttestation, RequestStatus},
};

fn check_kyc(kyc: &Account<KycAttestation>, owner: &Pubkey, now: i64) -> Result<()> {
    require!(!kyc.revoked, VaultError::KycNotVerified);
    require!(kyc.subject == *owner, VaultError::KycNotVerified);
    require!(kyc.valid_until == 0 || kyc.valid_until > now, VaultError::KycNotVerified);
    Ok(())
}

#[derive(Accounts)]
pub struct RequestDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = !vault.paused @ VaultError::VaultPaused,
        constraint = vault.window_open @ VaultError::WindowNotOpen,
    )]
    pub vault: Account<'info, CreditVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// KYC attestation for owner — checked at request time
    pub kyc_attestation: Account<'info, KycAttestation>,

    #[account(
        mut,
        constraint = user_asset_account.mint == vault.asset_mint @ VaultError::InvalidAccount,
        constraint = user_asset_account.owner == owner.key() @ VaultError::Unauthorized,
    )]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault @ VaultError::InvalidAccount,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init, payer = owner,
        space = DepositRequest::LEN,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn request_deposit(ctx: Context<RequestDeposit>, assets: u64, receiver: Pubkey) -> Result<()> {
    require!(assets >= MIN_DEPOSIT_AMOUNT, VaultError::DepositTooSmall);
    let now = Clock::get()?.unix_timestamp;
    check_kyc(&ctx.accounts.kyc_attestation, &ctx.accounts.owner.key(), now)?;

    transfer_checked(
        CpiContext::new(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.user_asset_account.to_account_info(),
                to: ctx.accounts.asset_vault.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    let req = &mut ctx.accounts.deposit_request;
    req.vault = ctx.accounts.vault.key();
    req.owner = ctx.accounts.owner.key();
    req.receiver = receiver;
    req.assets_locked = assets;
    req.shares_claimable = 0;
    req.status = RequestStatus::Pending;
    req.requested_at = now;
    req.bump = ctx.bumps.deposit_request;

    emit!(DepositRequested { vault: ctx.accounts.vault.key(), owner: ctx.accounts.owner.key(), assets });
    Ok(())
}

#[derive(Accounts)]
pub struct ApproveDeposit<'info> {
    pub manager: Signer<'info>,

    #[account(
        mut,
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
        constraint = shares_mint.key() == vault.shares_mint @ VaultError::InvalidAccount,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    /// KYC re-checked at approval time
    pub kyc_attestation: Account<'info, KycAttestation>,

    #[account(
        mut,
        constraint = deposit_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    pub token_2022_program: Program<'info, Token2022>,
}

pub fn approve_deposit(ctx: Context<ApproveDeposit>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    check_kyc(&ctx.accounts.kyc_attestation, &ctx.accounts.deposit_request.owner, now)?;

    let req = &ctx.accounts.deposit_request;
    let vault = &ctx.accounts.vault;

    let shares = convert_to_shares(
        req.assets_locked,
        vault.total_assets,
        vault.total_shares,
        vault.decimals_offset,
        Rounding::Floor,
    ).map_err(|_| error!(VaultError::MathOverflow))?;
    require!(shares > 0, VaultError::ZeroAmount);

    let assets = req.assets_locked;
    let owner = req.owner;

    let req = &mut ctx.accounts.deposit_request;
    req.shares_claimable = shares;
    req.status = RequestStatus::Approved;

    let vault = &mut ctx.accounts.vault;
    vault.total_assets = vault.total_assets.checked_add(assets).ok_or(VaultError::MathOverflow)?;
    vault.total_shares = vault.total_shares.checked_add(shares).ok_or(VaultError::MathOverflow)?;

    emit!(DepositApproved { vault: vault.key(), owner, assets, shares });
    Ok(())
}

#[derive(Accounts)]
pub struct RejectDeposit<'info> {
    pub manager: Signer<'info>,

    #[account(
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        constraint = vault.manager == manager.key() @ VaultError::Unauthorized,
    )]
    pub vault: Account<'info, CreditVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = deposit_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
        close = deposit_owner,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault @ VaultError::InvalidAccount,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub owner_asset_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: rent returned
    #[account(mut)]
    pub deposit_owner: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn reject_deposit(ctx: Context<RejectDeposit>) -> Result<()> {
    let assets = ctx.accounts.deposit_request.assets_locked;
    let owner = ctx.accounts.deposit_request.owner;

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED, asset_mint_key.as_ref(), vault_id_bytes.as_ref(), &[bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.owner_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    emit!(DepositRejected { vault: ctx.accounts.vault.key(), owner, assets_returned: assets });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelDeposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [DEPOSIT_REQUEST_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = deposit_request.bump,
        has_one = owner,
        constraint = deposit_request.status == RequestStatus::Pending @ VaultError::RequestNotPending,
        close = owner,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    #[account(
        mut,
        constraint = asset_vault.key() == vault.asset_vault @ VaultError::InvalidAccount,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user_asset_account: InterfaceAccount<'info, TokenAccount>,

    pub asset_token_program: Interface<'info, TokenInterface>,
}

pub fn cancel_deposit(ctx: Context<CancelDeposit>) -> Result<()> {
    let assets = ctx.accounts.deposit_request.assets_locked;

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED, asset_mint_key.as_ref(), vault_id_bytes.as_ref(), &[bump],
    ]];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.asset_token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.asset_vault.to_account_info(),
                to: ctx.accounts.user_asset_account.to_account_info(),
                mint: ctx.accounts.asset_mint.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        assets,
        ctx.accounts.asset_mint.decimals,
    )?;

    emit!(DepositCancelled { vault: ctx.accounts.vault.key(), owner: ctx.accounts.owner.key(), assets_returned: assets });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimDeposit<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(
        seeds = [CREDIT_VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, CreditVault>,

    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump,
    )]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = deposit_request.status == RequestStatus::Approved @ VaultError::RequestNotApproved,
        close = deposit_owner,
    )]
    pub deposit_request: Account<'info, DepositRequest>,

    /// CHECK: rent
    #[account(mut)]
    pub deposit_owner: UncheckedAccount<'info>,

    #[account(
        init_if_needed, payer = claimer,
        associated_token::mint = shares_mint,
        associated_token::authority = receiver,
        associated_token::token_program = token_2022_program,
    )]
    pub receiver_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: validated against request.receiver
    pub receiver: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_deposit(ctx: Context<ClaimDeposit>) -> Result<()> {
    let req = &ctx.accounts.deposit_request;
    require!(
        ctx.accounts.claimer.key() == req.receiver || ctx.accounts.claimer.key() == req.owner,
        VaultError::Unauthorized
    );
    require!(ctx.accounts.receiver.key() == req.receiver, VaultError::InvalidAccount);

    let shares = req.shares_claimable;
    let owner = req.owner;
    let receiver = req.receiver;

    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let bump = ctx.accounts.vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        CREDIT_VAULT_SEED, asset_mint_key.as_ref(), vault_id_bytes.as_ref(), &[bump],
    ]];

    anchor_spl::token_2022::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.to_account_info(),
            anchor_spl::token_2022::MintTo {
                mint: ctx.accounts.shares_mint.to_account_info(),
                to: ctx.accounts.receiver_shares_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        ),
        shares,
    )?;

    emit!(DepositClaimed { vault: ctx.accounts.vault.key(), owner, receiver, shares });
    Ok(())
}
