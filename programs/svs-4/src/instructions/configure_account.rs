use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{Mint, TokenAccount};
use bytemuck::{try_from_bytes, Zeroable};
use solana_zk_sdk::encryption::pod::auth_encryption::PodAeCiphertext;
use solana_zk_sdk::zk_elgamal_proof_program::proof_data::PubkeyValidityProofData;
use spl_token_2022::extension::confidential_transfer::instruction::inner_configure_account;
use spl_token_2022::extension::confidential_transfer::DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER;
use spl_token_2022::extension::ExtensionType;
use spl_token_2022::instruction::reallocate;
use spl_token_confidential_transfer_proof_extraction::instruction::{ProofData, ProofLocation};

use crate::state::ConfidentialVault;

/// Configure a user's shares account for confidential transfers.
/// Must be called before the user can receive confidential shares.
///
/// The user must either:
/// 1. Include a VerifyPubkeyValidity instruction in the same transaction
///    (at offset -1 from this instruction)
/// 2. OR provide a pre-verified proof context account
#[derive(Accounts)]
pub struct ConfigureAccount<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub vault: Account<'info, ConfidentialVault>,

    #[account(constraint = shares_mint.key() == vault.shares_mint)]
    pub shares_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_shares_account.mint == vault.shares_mint,
        constraint = user_shares_account.owner == user.key(),
    )]
    pub user_shares_account: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: Optional pre-verified proof context account.
    /// If provided, skips instruction sysvar proof verification.
    pub proof_context_account: Option<UncheckedAccount<'info>>,

    /// CHECK: Instructions sysvar - needed when proof is in same transaction
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Configure account for confidential transfers
///
/// # Arguments
/// * `decryptable_zero_balance` - AE ciphertext representing zero balance,
///   encrypted with the user's AES key (for balance decryption)
/// * `proof_instruction_offset` - Offset to the VerifyPubkeyValidity instruction
///   in the same transaction (usually -1). Ignored if proof_context_account is provided.
pub fn handler(
    ctx: Context<ConfigureAccount>,
    decryptable_zero_balance: [u8; 36], // PodAeCiphertext is 36 bytes
    proof_instruction_offset: i8,
) -> Result<()> {
    let user = &ctx.accounts.user;
    let user_shares_account = &ctx.accounts.user_shares_account;
    let shares_mint = &ctx.accounts.shares_mint;

    // Step 1: Reallocate account to add ConfidentialTransferAccount extension
    let reallocate_ix = reallocate(
        &ctx.accounts.token_2022_program.key(),
        &user_shares_account.key(),
        &user.key(),
        &user.key(),
        &[],
        &[ExtensionType::ConfidentialTransferAccount],
    )?;

    invoke(
        &reallocate_ix,
        &[
            user_shares_account.to_account_info(),
            user.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // Step 2: Configure the confidential transfer account
    // Convert decryptable_zero_balance bytes to PodAeCiphertext (safe conversion)
    let decryptable_balance: PodAeCiphertext =
        *try_from_bytes::<PodAeCiphertext>(&decryptable_zero_balance)
            .map_err(|_| crate::error::VaultError::InvalidCiphertext)?;

    // Create configure instruction based on proof location
    let configure_ix = if let Some(proof_context) = &ctx.accounts.proof_context_account {
        // Use pre-verified context state account
        inner_configure_account(
            &ctx.accounts.token_2022_program.key(),
            &user_shares_account.key(),
            &shares_mint.key(),
            decryptable_balance,
            DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
            &user.key(),
            &[],
            ProofLocation::ContextStateAccount(proof_context.key),
        )?
    } else {
        // Proof is in the instructions sysvar at the given offset
        use std::num::NonZeroI8;
        let offset = NonZeroI8::new(proof_instruction_offset)
            .ok_or_else(|| error!(crate::error::VaultError::InvalidProof))?;
        // Create the proof data placeholder (proof is read from instructions sysvar)
        let proof_data = PubkeyValidityProofData::zeroed();
        inner_configure_account(
            &ctx.accounts.token_2022_program.key(),
            &user_shares_account.key(),
            &shares_mint.key(),
            decryptable_balance,
            DEFAULT_MAXIMUM_PENDING_BALANCE_CREDIT_COUNTER,
            &user.key(),
            &[],
            ProofLocation::InstructionOffset(offset, ProofData::InstructionData(&proof_data)),
        )?
    };

    invoke(
        &configure_ix,
        &[
            user_shares_account.to_account_info(),
            shares_mint.to_account_info(),
            ctx.accounts.instructions_sysvar.to_account_info(),
            user.to_account_info(),
        ],
    )?;

    msg!("Configured confidential account for user: {}", user.key());

    Ok(())
}
