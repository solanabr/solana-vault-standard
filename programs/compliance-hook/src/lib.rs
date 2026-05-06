use anchor_lang::prelude::*;
use spl_transfer_hook_interface::instruction::TransferHookInstruction;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("6JKauKWVJqs9duaCqXCMS6UN9KvqHxMjLS5KwJxGqH5P");

#[program]
pub mod compliance_hook {
    use super::*;

    /// Initialize the global `SanctionsList` PDA. Called once per
    /// program deployment; the `authority` set here gates all future
    /// updates. Production deployments should use their configured
    /// governance authority.
    pub fn initialize_sanctions_list(ctx: Context<InitializeSanctionsList>) -> Result<()> {
        instructions::initialize_sanctions_list::handler(ctx)
    }

    /// Initialize the per-mint `MintConfig` PDA. Called per Token-2022
    /// mint that uses this hook; binds the mint's compliance posture
    /// (`FreelyTransferable` vs `Permissioned`, optional `pool_policy`)
    /// so `execute` can branch without further state lookup. Authorized
    /// by the mint's `mint_authority` signer — fails with
    /// `UnauthorizedAuthority` if the signer doesn't match.
    pub fn initialize_mint_config(
        ctx: Context<InitializeMintConfig>,
        args: InitializeMintConfigArgs,
    ) -> Result<()> {
        instructions::initialize_mint_config::handler(ctx, args)
    }

    /// Initialize the per-mint `ExtraAccountMetaList` PDA at
    /// `[b"extra-account-metas", mint]` — the Token-2022 TransferHook
    /// spec requires this PDA so the runtime can resolve the extra
    /// accounts `execute` consumes beyond the canonical 4. Sized for
    /// `Permissioned` mode (8 extras: mint_config, sanctions_list,
    /// source_frozen_check, destination_frozen_check, attestation_program,
    /// source_attestation, destination_attestation, pool_policy) so a
    /// future mode switch does not require realloc. Pre-condition:
    /// `MintConfig` for the mint must already exist (typed account
    /// constraint).
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        instructions::initialize_extra_account_meta_list::handler(ctx)
    }

    /// Authority-gated mutation of the sanctions list. Applies `removals`
    /// first, then `additions` (skipping already-present entries), bumps
    /// the version counter, and emits `SanctionsListUpdated`.
    pub fn update_sanctions_list(
        ctx: Context<UpdateSanctionsList>,
        additions: Vec<Pubkey>,
        removals: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::update_sanctions_list::handler(ctx, additions, removals)
    }

    /// Mark a wallet as frozen across all hook-bound mints. Authority-gated
    /// by `SanctionsList.authority` (typically a governance or multisig
    /// authority). Creates the `[b"frozen", owner]` PDA; `execute` reads its
    /// existence to reject transfers involving the frozen wallet.
    pub fn freeze_account(ctx: Context<FreezeAccount>) -> Result<()> {
        instructions::freeze_account::handler(ctx)
    }

    /// Unfreeze a previously-frozen wallet. Closes the
    /// `[b"frozen", owner]` PDA and returns rent to `rent_recipient`.
    /// Same authority as `freeze_account`.
    pub fn unfreeze_account(ctx: Context<UnfreezeAccount>) -> Result<()> {
        instructions::unfreeze_account::handler(ctx)
    }

    /// Token-2022 TransferHook entry point. Verifies that neither the source
    /// nor destination ATA owner is on the sanctions list and that no
    /// `FrozenAccount` PDA exists for either, then branches on the mint's
    /// `ComplianceMode`. `FreelyTransferable` returns `Ok`; `Permissioned`
    /// validates that BOTH source and destination wallets hold non-revoked,
    /// non-expired SVS-11-shaped Attestation PDAs (full identity binding via
    /// owner / subject / issuer / type / canonical PDA). Pool-policy
    /// threshold fields (jurisdiction / investor_class / kyc_risk_tier)
    /// are reserved for an optional policy-enforcement layer.
    ///
    /// `amount` is supplied by Token-2022's `transfer_checked` invocation
    /// (matches the SPL Transfer Hook Interface signature). Compliance-hook
    /// does not consult the amount itself — every check is policy-only on
    /// the source/destination owners — but accepting it keeps the
    /// instruction signature aligned with the interface so the fallback
    /// dispatch (below) can route directly to Anchor's auto-generated
    /// `__private::__global::execute`.
    pub fn execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
        instructions::execute::handler(ctx)
    }

    /// Anchor's instruction-discriminator scheme is `sighash("global", $name)`,
    /// but Token-2022 invokes hooks using the SPL Transfer Hook Interface
    /// discriminators (`sighash("spl-transfer-hook-interface", $name)`). The
    /// two byte slices DO NOT match, so a hook-bound mint's transfer
    /// would otherwise fail with `InstructionFallbackNotFound` (Anchor
    /// error 101) before ever reaching `execute`.
    ///
    /// This fallback intercepts the unmatched-discriminator path:
    /// it parses the instruction data through `TransferHookInstruction::
    /// unpack` (which understands all three SPL variants — Execute,
    /// InitializeExtraAccountMetaList, UpdateExtraAccountMetaList) and,
    /// for the `Execute` variant, re-dispatches into Anchor's auto-
    /// generated handler with the amount bytes serialized as the args
    /// payload. The other variants are ignored here because we expose
    /// our own typed `initialize_extra_account_meta_list` ix above and
    /// don't support live EAML updates (re-init via the same authority
    /// flow is the operational path).
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
