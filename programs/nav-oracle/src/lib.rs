use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7");

#[program]
pub mod nav_oracle {
    use super::*;

    /// Initialize the per-pool `NavAccount` PDA at `[b"nav_oracle", pool]`.
    /// Sets the publisher key + `key_rotation_authority` (typically a
    /// governance or multisig authority). Initial NAV fields zeroed; first
    /// `update` call sets real values.
    pub fn initialize(ctx: Context<InitializeNavAccount>) -> Result<()> {
        instructions::initialize::handler(ctx)
    }

    /// Publisher-only NAV update. Verifies a preceding ed25519 verify ix
    /// over the canonical 133-byte signing payload, enforces strictly
    /// increasing sequence, bounds timestamp to now+60s, and checks
    /// nav_net = nav_gross × (1 − ter − loss) within 1bps tolerance.
    pub fn update(ctx: Context<UpdateNav>, args: UpdateArgs) -> Result<()> {
        instructions::update::handler(ctx, args)
    }

    /// Rotate the publisher pubkey on a NavAccount. Gated by
    /// `key_rotation_authority` (typically a governance or multisig
    /// authority). Old publisher is rejected on next `update` once
    /// rotation completes.
    pub fn rotate_publisher(ctx: Context<RotatePublisher>) -> Result<()> {
        instructions::rotate_publisher::handler(ctx)
    }
}
