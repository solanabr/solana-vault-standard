use anchor_lang::prelude::*;

pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

pub use error::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("8zf7pTE29kmMHoGJCbKP6QRre9RPEPboPad7X3dGutsH");

#[program]
pub mod derwa_wrapper {
    use super::*;

    pub fn initialize(ctx: Context<InitializeWrapper>, args: InitializeWrapperArgs) -> Result<()> {
        instructions::initialize::handler(ctx, args)
    }

    pub fn wrap<'info>(ctx: Context<'_, '_, '_, 'info, Wrap<'info>>, amount: u64) -> Result<()> {
        instructions::wrap::handler(ctx, amount)
    }

    pub fn unwrap<'info>(
        ctx: Context<'_, '_, '_, 'info, Unwrap<'info>>,
        amount: u64,
    ) -> Result<()> {
        instructions::unwrap::handler(ctx, amount)
    }
}
