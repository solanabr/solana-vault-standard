use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::{
    spl_token_2022::{extension::ExtensionType, instruction::initialize_mint2},
    Token2022,
};

use crate::{
    constants::{
        MAX_TRANCHES, SHARES_DECIMALS, SHARES_MINT_SEED, TRANCHED_VAULT_SEED, TRANCHE_SEED,
    },
    error::TranchedVaultError,
    events::TrancheAdded,
    state::{Tranche, TranchedVault},
};

#[derive(Accounts)]
pub struct AddTranche<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        has_one = authority @ TranchedVaultError::Unauthorized,
        constraint = !vault.paused @ TranchedVaultError::VaultPaused,
        constraint = !vault.wiped @ TranchedVaultError::VaultWiped,
        constraint = vault.num_tranches < MAX_TRANCHES @ TranchedVaultError::MaxTranchesReached,
    )]
    pub vault: Account<'info, TranchedVault>,

    #[account(
        init,
        payer = authority,
        space = Tranche::LEN,
        seeds = [TRANCHE_SEED, vault.key().as_ref(), &[vault.num_tranches]],
        bump
    )]
    pub tranche: Account<'info, Tranche>,

    /// CHECK: Shares mint initialized via CPI
    #[account(
        mut,
        seeds = [SHARES_MINT_SEED, vault.key().as_ref(), &[vault.num_tranches]],
        bump
    )]
    pub shares_mint: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<AddTranche>,
    priority: u8,
    subordination_bps: u16,
    target_yield_bps: u16,
    cap_bps: u16,
) -> Result<()> {
    require!(
        subordination_bps <= 10_000,
        TranchedVaultError::InvalidSubordinationConfig
    );
    require!(
        cap_bps > 0 && cap_bps <= 10_000,
        TranchedVaultError::InvalidCapConfig
    );
    require!(
        target_yield_bps <= 10_000,
        TranchedVaultError::InvalidYieldConfig
    );

    // Priority uniqueness via bitmap
    require!(priority < 8, TranchedVaultError::DuplicatePriority);
    let mask = 1u8 << priority;
    require!(
        ctx.accounts.vault.priority_bitmap & mask == 0,
        TranchedVaultError::DuplicatePriority
    );

    let vault = &ctx.accounts.vault;
    let vault_key = vault.key();
    let index = vault.num_tranches;
    let shares_mint_bump = ctx.bumps.shares_mint;

    // Create shares mint (Token-2022)
    let mint_size = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&[])
        .map_err(|_| TranchedVaultError::MathOverflow)?;
    let lamports = ctx.accounts.rent.minimum_balance(mint_size);

    let shares_mint_seeds: &[&[u8]] = &[
        SHARES_MINT_SEED,
        vault_key.as_ref(),
        &[index],
        &[shares_mint_bump],
    ];

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

    // Initialize mint with vault PDA as mint authority
    let asset_mint_key = vault.asset_mint;
    let vault_id_bytes = vault.vault_id.to_le_bytes();
    let vault_bump = vault.bump;
    let _vault_seeds: &[&[u8]] = &[
        TRANCHED_VAULT_SEED,
        asset_mint_key.as_ref(),
        &vault_id_bytes,
        &[vault_bump],
    ];

    let init_mint_ix = initialize_mint2(
        &ctx.accounts.token_2022_program.key(),
        &ctx.accounts.shares_mint.key(),
        &vault_key,
        None,
        SHARES_DECIMALS,
    )?;

    invoke_signed(
        &init_mint_ix,
        &[ctx.accounts.shares_mint.to_account_info()],
        &[shares_mint_seeds],
    )?;

    // Set tranche state
    let tranche = &mut ctx.accounts.tranche;
    tranche.vault = vault_key;
    tranche.shares_mint = ctx.accounts.shares_mint.key();
    tranche.shares_mint_bump = shares_mint_bump;
    tranche.total_shares = 0;
    tranche.total_assets_allocated = 0;
    tranche.priority = priority;
    tranche.subordination_bps = subordination_bps;
    tranche.target_yield_bps = target_yield_bps;
    tranche.cap_bps = cap_bps;
    tranche.index = index;
    tranche.bump = ctx.bumps.tranche;
    tranche._reserved = [0u8; 31];

    // Update vault: increment count, set priority bit
    let vault = &mut ctx.accounts.vault;
    vault.num_tranches = vault
        .num_tranches
        .checked_add(1)
        .ok_or(TranchedVaultError::MathOverflow)?;
    vault.priority_bitmap |= mask;

    emit!(TrancheAdded {
        vault: vault_key,
        index,
        priority,
        subordination_bps,
        target_yield_bps,
        cap_bps,
    });

    Ok(())
}
