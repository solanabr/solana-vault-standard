//! Initialize instruction for SVS-9 allocator vault.

use anchor_lang::prelude::*;

use crate::{
    constants::{ALLOCATOR_VAULT_SEED, IDLE_VAULT_SEED, SHARES_MINT_SEED},
    error::VaultError,
    events::AllocatorInitialized,
    state::AllocatorVault,
};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = AllocatorVault::LEN,
        seeds = [ALLOCATOR_VAULT_SEED, asset_mint.key().as_ref(), vault_id.to_le_bytes().as_ref()],
        bump
    )]
    pub allocator: Box<Account<'info, AllocatorVault>>,

    #[account(
        init,
        payer = payer,
        mint::decimals = asset_mint.decimals,
        seeds = [SHARES_MINT_SEED, allocator.key().as_ref()],
        bump,
        mint::authority = allocator,
    )]
    pub shares_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        token::mint = asset_mint,
        token::authority = allocator,
        seeds = [IDLE_VAULT_SEED, allocator.key().as_ref()],
        bump,
    )]
    pub idle_vault: Box<Account<'info, TokenAccount>>,

    #[account(constraint = asset_mint.supply > 0)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(seeds = ["metadata", shares_mint.key().as_ref(), "metadata"])]
    /// CHECK: Metadata account for shares mint
    pub shares_metadata: UncheckedAccount<'info>,

    #[account(seeds = ["metadata", asset_mint.key().as_ref(), "metadata"])]
    /// CHECK: Metadata account for asset mint
    pub asset_metadata: UncheckedAccount<'info>,

    #[account(address = "mplTokenMetadata::ID")]
    /// CHECK: Token metadata program
    pub token_metadata_program: UncheckedAccount<'info>,

    #[account(address = "anchor::spl::token::ID")]
    /// CHECK: Token program for creating metadata
    pub token_program: Program<'info, Token>,

    #[account(address = "anchor::spl::associated_token::ID")]
    /// CHECK: Associated token program
    pub associated_token_program: Program<'info, AssociatedToken>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitializeParams {
    pub vault_id: u64,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub idle_buffer_bps: u16,
}

pub fn handler(ctx: Context<Initialize>, params: InitializeParams) -> Result<()> {
    let allocator = &mut ctx.accounts.allocator;

    // Validate inputs
    require!(params.idle_buffer_bps <= 10_000, VaultError::InvalidWeight);
    require!(params.name.len() <= 32, VaultError::InvalidAccountData);
    require!(params.symbol.len() <= 10, VaultError::InvalidAccountData);

    // Initialize vault state
    allocator.authority = ctx.accounts.payer.key();
    allocator.curator = ctx.accounts.payer.key(); // Initially same as authority
    allocator.asset_mint = ctx.accounts.asset_mint.key();
    allocator.shares_mint = ctx.accounts.shares_mint.key();
    allocator.idle_vault = ctx.accounts.idle_vault.key();
    allocator.total_shares = 0;
    allocator.num_children = 0;
    allocator.idle_buffer_bps = params.idle_buffer_bps;
    allocator.decimals_offset = 0; // Will be set based on asset decimals
    allocator.bump = ctx.bumps.allocator;
    allocator.paused = false;
    allocator.vault_id = params.vault_id;
    allocator.cached_total_assets = 0;
    allocator.cache_timestamp = Clock::get()?.unix_timestamp;

    // Set decimals offset based on asset mint
    allocator.decimals_offset = if ctx.accounts.asset_mint.decimals > 8 {
        return Err(error!(VaultError::AssetDecimalsTooHigh));
    } else {
        9 - ctx.accounts.asset_mint.decimals as u8
    };

    // Create metadata for shares token
    let metadata_accounts = anchor_spl::metadata::CreateMetadataAccountsV3 {
        mint: &ctx.accounts.shares_mint,
        metadata: &ctx.accounts.shares_metadata,
        mint_authority: &allocator,
        update_authority: &allocator,
        payer: &ctx.accounts.payer,
        system_program: &ctx.accounts.system_program,
        rent: &ctx.accounts.rent,
    };

    let metadata_data = anchor_spl::metadata::DataV3 {
        name: format!("{} Shares", params.name),
        symbol: format!("{}s", params.symbol),
        uri: params.uri,
        creators: None,
        seller_fee_basis_points: 0,
        collection: None,
        uses: None,
    };

    anchor_spl::metadata::create_metadata_v3(
        CpiContext::new(
            &ctx.accounts.token_metadata_program.to_account_info(),
            &metadata_accounts,
        ),
        metadata_data,
        true, // is_mutable
        false, // is_update_authority_signer
        None, // collection_details
    )?;

    emit_cpi!(AllocatorInitialized {
        vault: allocator.key(),
        authority: allocator.authority,
        curator: allocator.curator,
        asset_mint: allocator.asset_mint,
        shares_mint: allocator.shares_mint,
        idle_buffer_bps: allocator.idle_buffer_bps,
    });

    Ok(())
}
