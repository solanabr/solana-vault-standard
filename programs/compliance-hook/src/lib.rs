use anchor_lang::prelude::*;
use spl_transfer_hook_interface::instruction::TransferHookInstruction;

pub mod compliance;
pub mod error;
pub mod instructions;
pub mod state;

pub use compliance::*;
pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P");

#[program]
pub mod compliance_hook {
    use super::*;

    pub fn initialize_sanctions_list(ctx: Context<InitializeSanctionsList>) -> Result<()> {
        instructions::initialize_sanctions_list::handler(ctx)
    }

    pub fn initialize_mint_config(
        ctx: Context<InitializeMintConfig>,
        args: InitializeMintConfigArgs,
    ) -> Result<()> {
        instructions::initialize_mint_config::handler(ctx, args)
    }

    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        instructions::initialize_extra_account_meta_list::handler(ctx)
    }

    pub fn update_sanctions_list(
        ctx: Context<UpdateSanctionsList>,
        additions: Vec<Pubkey>,
        removals: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::update_sanctions_list::handler(ctx, additions, removals)
    }

    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        instructions::freeze_account::handler(ctx)
    }

    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        instructions::unfreeze_account::handler(ctx)
    }

    /// Token-2022 TransferHook entry point. `amount` is supplied by
    /// `transfer_checked` (interface signature) but unused — all checks
    /// are policy-only on source/destination owners.
    pub fn execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
        instructions::execute::handler(ctx)
    }

    /// Anchor's `sighash("global", name)` discriminators don't match
    /// Token-2022's `sighash("spl-transfer-hook-interface", name)`. This
    /// fallback intercepts the unmatched-discriminator path and routes
    /// the Execute variant to Anchor's auto-generated handler. EAML
    /// init/update variants are rejected — we expose typed instructions
    /// for those.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        let instruction = TransferHookInstruction::unpack(data)?;
        match instruction {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::execute(program_id, accounts, &amount_bytes)
            }
            _ => Err(ProgramError::InvalidInstructionData.into()),
        }
    }
}
