//! Vault instruction handlers: deposit, mint, withdraw, redeem, admin, streaming yield, confidential transfers.

pub mod admin;
pub mod apply_pending;
pub mod checkpoint;
pub mod configure_account;
pub mod deposit;
pub mod distribute_yield;
pub mod initialize;
pub mod mint;
pub mod redeem;
pub mod view;
pub mod withdraw;

#[cfg(feature = "modules")]
pub mod module_admin;

#[allow(ambiguous_glob_reexports)]
pub use admin::*;
#[allow(ambiguous_glob_reexports)]
pub use apply_pending::*;
#[allow(ambiguous_glob_reexports)]
pub use checkpoint::*;
#[allow(ambiguous_glob_reexports)]
pub use configure_account::*;
#[allow(ambiguous_glob_reexports)]
pub use deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use distribute_yield::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize::*;
#[allow(ambiguous_glob_reexports)]
pub use mint::*;
#[allow(ambiguous_glob_reexports)]
pub use redeem::*;
#[allow(ambiguous_glob_reexports)]
pub use view::*;
#[allow(ambiguous_glob_reexports)]
pub use withdraw::*;

#[cfg(feature = "modules")]
#[allow(ambiguous_glob_reexports)]
pub use module_admin::*;
