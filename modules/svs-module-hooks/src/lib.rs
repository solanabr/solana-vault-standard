//! Shared module state definitions and integration hooks for SVS vault programs.
//!
//! This crate eliminates duplication of module state accounts, PDA seed constants,
//! and hook functions across SVS-1 through SVS-4. Each vault program imports this
//! crate instead of maintaining its own copy.

pub mod error;
pub mod hooks;
pub mod state;

pub use error::*;
pub use hooks::*;
pub use state::*;
