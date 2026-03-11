use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{
        spl_token_2022::{extension::ExtensionType, instruction::initialize_mint2},
        Token2022,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};
use crate::{constants::*, error::VaultError, events::PoolInitialized, state::CreditVault};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init, payer = authority,
        space = CreditVault::LEN,
        seeds = [CREDIT_VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, CreditVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: initialized via CPI
    #[account(mut, seeds = [SHARES_MINT_SEED, vault.key().as_ref()], bump)]
    pub shares_mint: UncheckedAccount<'info>,

    #[account(
        init, payer = authority,
        seeds = [ASSET_VAULT_SEED, vault.key().as_ref()],
        bump,
        token::mint = asset_mint,
        token::authority = vault,
        token::token_program = asset_token_program,
    )]
    pub asset_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init, payer = authority,
        seeds = [SHARE_ESCROW_SEED, vault.key().as_ref()],
        bump,
        token::mint = shares_mint_for_escrow,
        token::authority = vault,
        token::token_program = token_2022_program,
    )]
    pub share_escrow: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: placeholder for share_escrow init
    pub shares_mint_for_escrow: UncheckedAccount<'info>,

    /// CHECK: KYC registry program ID
    pub kyc_registry: UncheckedAccount<'info>,

    /// CHECK: NAV oracle account
    pub nav_oracle: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializePool>,
    vault_id: u64,
    manager: Pubkey,
) -> Result<()> {
    let asset_decimals = ctx.accounts.asset_mint.decimals;
    require!(asset_decimals <= MAX_DECIMALS, VaultError::InvalidAssetDecimals);

    let vault_key = ctx.accounts.vault.key();
    let shares_bump = ctx.bumps.shares_mint;

    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;
    let lamports = ctx.accounts.rent.minimum_balance(mint_size);
    let shares_seeds: &[&[u8]] = &[SHARES_MINT_SEED, vault_key.as_ref(), &[shares_bump]];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.shares_mint.key(),
            lamports,
            mint_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[shares_seeds],
    )?;

    let init_ix = initialize_mint2(
        &ctx.accounts.token_2022_program.key(),
        &ctx.accounts.shares_mint.key(),
        &vault_key,
        None,
        SHARES_DECIMALS,
    )?;
    invoke_signed(&init_ix, &[ctx.accounts.shares_mint.to_account_info()], &[shares_seeds])?;

    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.manager = manager;
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.asset_vault = ctx.accounts.asset_vault.key();
    vault.share_escrow = ctx.accounts.share_escrow.key();
    vault.kyc_registry = ctx.accounts.kyc_registry.key();
    vault.nav_oracle = ctx.accounts.nav_oracle.key();
    vault.total_assets = 0;
    vault.total_shares = 0;
    vault.decimals_offset = MAX_DECIMALS - asset_decimals;
    vault.bump = ctx.bumps.vault;
    vault.paused = false;
    vault.window_open = false;
    vault.vault_id = vault_id;
    vault._reserved = [0u8; 64];

    emit!(PoolInitialized {
        vault: vault.key(),
        authority: vault.authority,
        manager,
        asset_mint: vault.asset_mint,
        shares_mint: vault.shares_mint,
        vault_id,
    });
    Ok(())
}
