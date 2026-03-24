//! SVS-7 instruction handlers: deposit/withdraw/redeem in both SOL and wSOL forms.

pub mod admin;
pub mod deposit_sol;
pub mod deposit_wsol;
pub mod initialize;
pub mod mint_sol;
pub mod mint_wsol;
pub mod redeem_sol;
pub mod redeem_wsol;
pub mod view;
pub mod withdraw_sol;
pub mod withdraw_wsol;

#[cfg(feature = "modules")]
pub mod module_admin;

#[allow(ambiguous_glob_reexports)]
pub use admin::*;
#[allow(ambiguous_glob_reexports)]
pub use deposit_sol::*;
#[allow(ambiguous_glob_reexports)]
pub use deposit_wsol::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize::*;
#[allow(ambiguous_glob_reexports)]
pub use mint_sol::*;
#[allow(ambiguous_glob_reexports)]
pub use mint_wsol::*;
#[allow(ambiguous_glob_reexports)]
pub use redeem_sol::*;
#[allow(ambiguous_glob_reexports)]
pub use redeem_wsol::*;
#[allow(ambiguous_glob_reexports)]
pub use view::*;
#[allow(ambiguous_glob_reexports)]
pub use withdraw_sol::*;
#[allow(ambiguous_glob_reexports)]
pub use withdraw_wsol::*;

#[cfg(feature = "modules")]
#[allow(ambiguous_glob_reexports)]
pub use module_admin::*;
