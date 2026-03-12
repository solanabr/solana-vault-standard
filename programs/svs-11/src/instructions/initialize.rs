use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::{
    token_2022::{
        spl_token_2022::{
            extension::ExtensionType, instruction::initialize_mint2,
            solana_program::program_pack::Pack,
        },
        Token2022,
    },
    token_interface::{Mint, TokenInterface},
};

use crate::{constants::*, error::VaultError, events::CreditVaultInitialized, state::CreditVault};

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Manager address stored on vault
    pub manager: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = CreditVault::LEN,
        seeds = [CREDIT_VAULT_SEED, asset_mint.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, CreditVault>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: NAV oracle PDA address from external oracle program — validated in handler
    pub nav_oracle: UncheckedAccount<'info>,

    /// CHECK: Oracle program — must be executable
    #[account(constraint = oracle_program.executable @ VaultError::InvalidOraclePrice)]
    pub oracle_program: UncheckedAccount<'info>,

    /// CHECK: Trusted KYC attester address
    pub attester: UncheckedAccount<'info>,

    /// CHECK: Attestation program — must be executable
    #[account(constraint = attestation_program.executable @ VaultError::InvalidAttester)]
    pub attestation_program: UncheckedAccount<'info>,

    /// CHECK: Shares mint initialized via CPI
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref()],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    /// CHECK: Deposit vault token account initialized via CPI
    #[account(
        mut,
        seeds = [DEPOSIT_VAULT_SEED, vault.key().as_ref()],
        bump
    )]
    pub deposit_vault: UncheckedAccount<'info>,

    /// CHECK: Redemption escrow token account initialized via CPI
    #[account(
        mut,
        seeds = [REDEMPTION_ESCROW_SEED, vault.key().as_ref()],
        bump
    )]
    pub redemption_escrow: UncheckedAccount<'info>,

    pub asset_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<Initialize>,
    vault_id: u64,
    minimum_investment: u64,
    max_staleness: i64,
) -> Result<()> {
    let asset_decimals = ctx.accounts.asset_mint.decimals;
    require!(
        asset_decimals <= MAX_DECIMALS,
        VaultError::InvalidAssetDecimals
    );
    require!(max_staleness >= 0, VaultError::InvalidMaxStaleness);
    require!(
        ctx.accounts.manager.key() != Pubkey::default(),
        VaultError::InvalidManager
    );

    let vault_key = ctx.accounts.vault.key();
    let vault_bump = ctx.bumps.vault;
    let shares_mint_bump = ctx.bumps.shares_mint;
    let deposit_vault_bump = ctx.bumps.deposit_vault;
    let redemption_escrow_bump = ctx.bumps.redemption_escrow;

    // === Create shares mint (Token-2022) ===
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| VaultError::MathOverflow)?;

    let rent = &ctx.accounts.rent;
    let lamports = rent.minimum_balance(mint_size);

    let shares_mint_seeds: &[&[u8]] = &[SHARES_MINT_SEED, vault_key.as_ref(), &[shares_mint_bump]];

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
        &[shares_mint_seeds],
    )?;

    invoke_signed(
        &initialize_mint2(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.shares_mint.key(),
            &vault_key,
            None,
            SHARES_DECIMALS,
        )?,
        &[ctx.accounts.shares_mint.to_account_info()],
        &[shares_mint_seeds],
    )?;

    // === Create deposit vault (PDA-owned token account) ===
    let asset_mint_key = ctx.accounts.asset_mint.key();
    let token_account_size = spl_token_2022::state::Account::LEN;
    let deposit_vault_lamports = rent.minimum_balance(token_account_size);

    let deposit_vault_seeds: &[&[u8]] = &[
        DEPOSIT_VAULT_SEED,
        vault_key.as_ref(),
        &[deposit_vault_bump],
    ];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.deposit_vault.key(),
            deposit_vault_lamports,
            token_account_size as u64,
            &ctx.accounts.asset_token_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.deposit_vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[deposit_vault_seeds],
    )?;

    invoke_signed(
        &spl_token_2022::instruction::initialize_account3(
            &ctx.accounts.asset_token_program.key(),
            &ctx.accounts.deposit_vault.key(),
            &asset_mint_key,
            &vault_key,
        )?,
        &[
            ctx.accounts.deposit_vault.to_account_info(),
            ctx.accounts.asset_mint.to_account_info(),
        ],
        &[deposit_vault_seeds],
    )?;

    // === Create redemption escrow (PDA-owned token account for locked shares) ===
    let shares_mint_key = ctx.accounts.shares_mint.key();
    let escrow_size =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[])
            .map_err(|_| VaultError::MathOverflow)?;
    let escrow_lamports = rent.minimum_balance(escrow_size);

    let redemption_escrow_seeds: &[&[u8]] = &[
        REDEMPTION_ESCROW_SEED,
        vault_key.as_ref(),
        &[redemption_escrow_bump],
    ];

    invoke_signed(
        &anchor_lang::solana_program::system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &ctx.accounts.redemption_escrow.key(),
            escrow_lamports,
            escrow_size as u64,
            &ctx.accounts.token_2022_program.key(),
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.redemption_escrow.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[redemption_escrow_seeds],
    )?;

    invoke_signed(
        &spl_token_2022::instruction::initialize_account3(
            &ctx.accounts.token_2022_program.key(),
            &ctx.accounts.redemption_escrow.key(),
            &shares_mint_key,
            &vault_key,
        )?,
        &[
            ctx.accounts.redemption_escrow.to_account_info(),
            ctx.accounts.shares_mint.to_account_info(),
        ],
        &[redemption_escrow_seeds],
    )?;

    // === Set vault state ===
    let vault = &mut ctx.accounts.vault;
    vault.authority = ctx.accounts.authority.key();
    vault.manager = ctx.accounts.manager.key();
    vault.asset_mint = asset_mint_key;
    vault.shares_mint = shares_mint_key;
    vault.deposit_vault = ctx.accounts.deposit_vault.key();
    vault.redemption_escrow = ctx.accounts.redemption_escrow.key();
    vault.nav_oracle = ctx.accounts.nav_oracle.key();
    vault.oracle_program = ctx.accounts.oracle_program.key();
    vault.attester = ctx.accounts.attester.key();
    vault.attestation_program = ctx.accounts.attestation_program.key();
    vault.total_assets = 0;
    vault.total_shares = 0;
    vault.minimum_investment = minimum_investment;
    vault.investment_window_open = false;
    vault.decimals_offset = MAX_DECIMALS - asset_decimals;
    vault.bump = vault_bump;
    vault.paused = false;
    vault.vault_id = vault_id;
    vault.max_staleness = max_staleness;
    vault._reserved = [0u8; 64];

    emit!(CreditVaultInitialized {
        vault: vault.key(),
        authority: vault.authority,
        manager: vault.manager,
        asset_mint: vault.asset_mint,
        shares_mint: vault.shares_mint,
        vault_id,
    });

    Ok(())
}
