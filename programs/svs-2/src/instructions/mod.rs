//! Vault instruction handlers: deposit, mint, withdraw, redeem, admin, sync.

pub mod admin;
pub mod deposit;
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
pub use deposit::*;
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
