//! CPI into compliance-hook to initialize the cPOOL mint's `MintConfig`
//! + `ExtraAccountMetaList` PDAs. Vault PDA signs as `mint_authority`.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::Mint;

use crate::constants::{COMPLIANCE_HOOK_PROGRAM_ID, VAULT_SEED};
use crate::error::VaultError;
use crate::state::CreditVault;

use compliance_hook::cpi::accounts::{
    InitializeExtraAccountMetaList as ComplianceHookInitEaml,
    InitializeMintConfig as ComplianceHookInitMintConfig,
};
use compliance_hook::program::ComplianceHook;
use compliance_hook::{
    state::{ComplianceMode as ComplianceHookMode, MintConfig},
    InitializeMintConfigArgs as ComplianceHookInitMintConfigArgs,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct BootstrapSharesComplianceArgs {
    pub mode: BootstrapComplianceMode,
    /// `Some(_)` required when `mode == Permissioned`; `None` required for `FreelyTransferable`.
    pub pool_policy: Option<Pubkey>,
    pub attestation_program: Pubkey,
    pub attestation_issuer: Pubkey,
    pub required_attestation_type: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum BootstrapComplianceMode {
    FreelyTransferable,
    Permissioned,
}

impl From<BootstrapComplianceMode> for ComplianceHookMode {
    fn from(value: BootstrapComplianceMode) -> Self {
        match value {
            BootstrapComplianceMode::FreelyTransferable => ComplianceHookMode::FreelyTransferable,
            BootstrapComplianceMode::Permissioned => ComplianceHookMode::Permissioned,
        }
    }
}

#[derive(Accounts)]
pub struct BootstrapSharesCompliance<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, vault.asset_mint.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump,
        has_one = authority @ VaultError::Unauthorized,
        constraint = vault.shares_mint == shares_mint.key() @ VaultError::InvalidMintAccount,
    )]
    pub vault: Box<Account<'info, CreditVault>>,

    pub shares_mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: compliance-hook `init` validates seed derivation.
    #[account(
        mut,
        seeds = [MintConfig::SEED_PREFIX, shares_mint.key().as_ref()],
        bump,
        seeds::program = COMPLIANCE_HOOK_PROGRAM_ID,
    )]
    pub mint_config: UncheckedAccount<'info>,

    /// CHECK: Token-2022 canonical seed literal (note the hyphen); validated by compliance-hook `init`.
    #[account(
        mut,
        seeds = [b"extra-account-metas", shares_mint.key().as_ref()],
        bump,
        seeds::program = COMPLIANCE_HOOK_PROGRAM_ID,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    pub compliance_hook_program: Program<'info, ComplianceHook>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<BootstrapSharesCompliance>,
    args: BootstrapSharesComplianceArgs,
) -> Result<()> {
    let vault_id_bytes = ctx.accounts.vault.vault_id.to_le_bytes();
    let asset_mint_key = ctx.accounts.vault.asset_mint;
    let vault_bump_bytes = [ctx.accounts.vault.bump];
    let vault_seeds: &[&[u8]] = &[
        VAULT_SEED,
        asset_mint_key.as_ref(),
        vault_id_bytes.as_ref(),
        &vault_bump_bytes,
    ];
    let vault_signer_seeds: &[&[&[u8]]] = &[vault_seeds];

    compliance_hook::cpi::initialize_mint_config(
        CpiContext::new_with_signer(
            ctx.accounts.compliance_hook_program.to_account_info(),
            ComplianceHookInitMintConfig {
                mint_config: ctx.accounts.mint_config.to_account_info(),
                mint: ctx.accounts.shares_mint.to_account_info(),
                mint_authority: ctx.accounts.vault.to_account_info(),
                payer: ctx.accounts.authority.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            vault_signer_seeds,
        ),
        ComplianceHookInitMintConfigArgs {
            mode: args.mode.into(),
            pool_policy: args.pool_policy,
            attestation_program: args.attestation_program,
            attestation_issuer: args.attestation_issuer,
            required_attestation_type: args.required_attestation_type,
        },
    )?;

    compliance_hook::cpi::initialize_extra_account_meta_list(CpiContext::new_with_signer(
        ctx.accounts.compliance_hook_program.to_account_info(),
        ComplianceHookInitEaml {
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            mint: ctx.accounts.shares_mint.to_account_info(),
            mint_config: ctx.accounts.mint_config.to_account_info(),
            mint_authority: ctx.accounts.vault.to_account_info(),
            payer: ctx.accounts.authority.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        vault_signer_seeds,
    ))?;

    Ok(())
}
