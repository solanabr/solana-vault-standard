use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use error::*;
pub use instructions::*;
pub use state::*;

declare_id!("7564bvScA3FjQ9w5nCx44EK4JkgitzZ3UstX1e4eKks7");

/// SVS-11 program ID. `rotate_publisher` requires the `pool` account be owned
/// by this program (it is a CreditVault PDA). Kept in sync with
/// `programs/svs-11/src/lib.rs::declare_id!`.
pub const SVS_11_PROGRAM_ID: Pubkey =
    anchor_lang::solana_program::pubkey!("CMeQ5Lx7AvjuW3DrzNvEkPZSdqKZjjhaTrAmgqBvPKHD");

#[program]
pub mod nav_oracle {
    use super::*;

    pub fn initialize(ctx: Context<InitializeNavAccount>, args: InitializeNavArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    pub fn update(ctx: Context<UpdateNav>, args: UpdateArgs) -> Result<()> {
        instructions::update::handler(ctx, args)
    }

    pub fn rotate_publisher(ctx: Context<RotatePublisher>) -> Result<()> {
        instructions::rotate_publisher::handler(ctx)
    }
}
