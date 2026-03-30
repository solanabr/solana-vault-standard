//! Vault instruction handlers.

pub mod admin;
pub mod cancel_deposit;
pub mod cancel_redeem;
pub mod claim_deposit;
pub mod claim_redeem;
pub mod fulfill_deposit;
pub mod fulfill_redeem;
pub mod initialize;
pub mod request_deposit;
pub mod request_redeem;
pub mod set_operator;
pub mod view;

#[cfg(feature = "modules")]
pub mod module_admin;

#[allow(ambiguous_glob_reexports)]
pub use admin::*;
#[allow(ambiguous_glob_reexports)]
pub use cancel_deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use cancel_redeem::*;
#[allow(ambiguous_glob_reexports)]
pub use claim_deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use claim_redeem::*;
#[allow(ambiguous_glob_reexports)]
pub use fulfill_deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use fulfill_redeem::*;
#[allow(ambiguous_glob_reexports)]
pub use initialize::*;
#[allow(ambiguous_glob_reexports)]
pub use request_deposit::*;
#[allow(ambiguous_glob_reexports)]
pub use request_redeem::*;
#[allow(ambiguous_glob_reexports)]
pub use set_operator::*;
#[allow(ambiguous_glob_reexports)]
pub use view::*;

#[cfg(feature = "modules")]
#[allow(ambiguous_glob_reexports)]
pub use module_admin::*;
