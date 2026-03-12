use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{
        spl_token_2022::{
            extension::ExtensionType,
            instruction::{initialize_account3, initialize_mint2},
        },
        Token2022,
    },
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::constants::{
    MAX_DECIMALS, REDEMPTION_ESCROW_SEED, SHARES_DECIMALS, SHARES_MINT_SEED, VAULT_SEED,
};
use crate::error::VaultError;
use crate::events::VaultInitialized;
use crate::state::CreditVault;

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub manager: SystemAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = CreditVault::LEN,
        seeds = [VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, CreditVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: Shares mint initialized via CPI in handler
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = vault,
        associated_token::token_program = asset_token_program,
    )]
    pub deposit_vault: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Redemption escrow initialized via CPI in handler
    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump
    )]
    pub redemption_escrow: UncheckedAccount<'info>,

    /// CHECK: Oracle account validated when prices are consumed
    pub nav_oracle: UncheckedAccount<'info>,

    /// CHECK: Oracle program account stored for runtime validation
    pub oracle_program: UncheckedAccount<'info>,

    /// CHECK: Attester (issuer) pubkey stored for attestation validation
    pub attester: UncheckedAccount<'info>,

    /// CHECK: Attestation program owner stored for attestation validation
    pub attestation_program: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializePool>,
    vault_id: u64,
    minimum_investment: u64,
    max_staleness: i64,
) -> Result<()> {
    require!(
        ctx.accounts.oracle_program.key() != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.nav_oracle.key() != Pubkey::default(),
        VaultError::InvalidAddress
    );
    require!(
        ctx.accounts.oracle_program.executable,
        VaultError::OracleInvalidProgram
    );

    let asset_decimals = ctx.accounts.asset_mint.decimals;
    require!(
        asset_decimals <= MAX_DECIMALS,
        VaultError::InvalidAssetDecimals
    );

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;
    let redemption_escrow_bump = ctx.bumps.redemption_escrow;

    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;

    let token_account_size =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[])
            .map_err(|_| VaultError::MathOverflow)?;

    let rent = &ctx.accounts.rent;
    let mint_lamports = rent.minimum_balance(mint_size);
    let escrow_lamports = rent.minimum_balance(token_account_size);

    let shares_mint_bump_bytes = [shares_mint_bump];
    let shares_mint_seeds: &[&[u8]] = &[
        SHARES_MINT_SEED,
        vault_key.as_ref(),
        &shares_mint_bump_bytes,
    ];

    let asset_mint_key = ctx.accounts.asset_mint.key();
    let vault_id_bytes = vault_id.to_le_bytes();
    let vault_bump_bytes = [vault_bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &vault_bump_bytes,
    ];

    let redemption_escrow_bump_bytes = [redemption_escrow_bump];
    let redemption_escrow_seeds: &[&[u8]] = &[
        REDEMPTION_ESCROW_SEED,
        vault_key.as_ref(),
        &redemption_escrow_bump_bytes,
    ];

    // Create shares mint account
    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.shares_mint.key(),
            mint_lamports,
            mint_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[shares_mint_seeds],
    )?;

    // Initialize shares mint (vault PDA is mint authority)
    invoke_signed(
        &initialize_mint2(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.shares_mint.key(),
            &vault_key,
            None,
            SHARES_DECIMALS,
        )?,
        &[ctx.accounts.shares_mint.to_account_info()],
        &[vault_seeds],
    )?;

    // Create redemption escrow account
    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.redemption_escrow.key(),
            escrow_lamports,
            token_account_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.redemption_escrow.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[redemption_escrow_seeds],
    )?;

    // Initialize redemption escrow as a token account (mint = shares_mint, authority = vault PDA)
    invoke_signed(
        &initialize_account3(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.redemption_escrow.key(),
            &ctx.accounts.shares_mint.key(),
            &vault_key,
        )?,
        &[
            ctx.accounts.redemption_escrow.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
        ],
        &[vault_seeds],
    )?;

    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.manager = ctx.accounts.manager.key();
    vault.asset_mint = ctx.accounts.asset_mint.key();
    vault.shares_mint = ctx.accounts.shares_mint.key();
    vault.deposit_vault = ctx.accounts.deposit_vault.key();
    vault.redemption_escrow = ctx.accounts.redemption_escrow.key();
    vault.nav_oracle = ctx.accounts.nav_oracle.key();
    vault.oracle_program = ctx.accounts.oracle_program.key();
    svs_oracle::validate_staleness_config(max_staleness)
        .map_err(|_| VaultError::InvalidStalenessConfig)?;
    vault.max_staleness = max_staleness;
    vault.attester = ctx.accounts.attester.key();
    vault.attestation_program = ctx.accounts.attestation_program.key();
    vault.vault_id = vault_id;
    vault.total_assets = 0;
    vault.total_shares = 0;
    vault.total_pending_deposits = 0;
    vault.minimum_investment = minimum_investment;
    vault.investment_window_open = false;
    vault.decimals_offset = MAX_DECIMALS - asset_decimals;
    vault.bump = vault_bump;
    vault.redemption_escrow_bump = redemption_escrow_bump;
    vault.paused = false;
    vault._reserved = [0u8; 64];

    emit!(VaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        manager: vault.manager,
        asset_mint: vault.asset_mint,
        shares_mint: vault.shares_mint,
        vault_id,
    });

    Ok(())
}
