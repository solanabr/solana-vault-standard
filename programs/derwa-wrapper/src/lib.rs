use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("8zf7pTE29kmMHoGJCbKP6QRre9RPEPboPad7X3dGutsH");

#[program]
pub mod derwa_wrapper {
    use super::*;

    /// Bind a pool to its (cPOOL, dePOOL) mint pair + capture per-pool
    /// trust anchors (attestation_program, attestation_issuer,
    /// required_attestation_type) used by `unwrap` to validate the
    /// destination wallet. One-shot per pool — Anchor's `init` constraint
    /// on `wrapper_config` prevents re-init.
    pub fn initialize(
        ctx: Context<InitializeWrapper>,
        args: InitializeWrapperArgs,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    /// Wrap permissioned cPOOL → freely-transferable dePOOL at 1:1.
    /// Investor transfers cPOOL into wrapper-PDA-owned ATA; wrapper mints
    /// dePOOL to investor. `locked_supply` increments to enforce the
    /// invariant `locked_supply == dePOOL.supply`.
    pub fn wrap<'info>(
        ctx: Context<'_, '_, '_, 'info, Wrap<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::wrap::handler(ctx, amount)
    }

    /// Unwrap dePOOL → cPOOL at 1:1. Burns dePOOL and releases cPOOL back
    /// to investor — but ONLY if the destination wallet has a valid,
    /// non-revoked, non-expired attestation. Prevents non-KYB buyers from
    /// escaping the permissioned token via DEX-purchased dePOOL → unwrap.
    pub fn unwrap<'info>(
        ctx: Context<'_, '_, '_, 'info, Unwrap<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::unwrap::handler(ctx, amount)
    }
}
