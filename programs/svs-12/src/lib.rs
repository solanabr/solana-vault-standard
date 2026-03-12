use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod waterfall;

use instructions::*;

declare_id!("85wwufKdhpHxiBe4kMeFBfidL1Kqo62T65DHb46qNugA");

#[program]
pub mod svs_12 {
    use super::*;
}
