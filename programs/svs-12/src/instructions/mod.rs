pub mod add_tranche;
pub mod admin;
pub mod deposit;
pub mod distribute_yield;
pub mod initialize;
pub mod rebalance;
pub mod record_loss;
pub mod redeem;
pub mod update_tranche_config;
pub mod view;

#[cfg(feature = "modules")]
pub mod module_admin;

// Glob re-exports required by Anchor's #[program] macro expansion.
// Ambiguity is limited to `handler` names, which are always called
// via qualified path (e.g., instructions::deposit::handler).
#[allow(ambiguous_glob_reexports)]
pub use {
    add_tranche::*, admin::*, deposit::*, distribute_yield::*, initialize::*, rebalance::*,
    record_loss::*, redeem::*, update_tranche_config::*, view::*,
};

#[cfg(feature = "modules")]
pub use module_admin::*;
