pub mod admin;
pub mod deposit_sol; // Alterado de deposit
pub mod initialize;
pub mod mint;
pub mod module_admin;
pub mod redeem;
pub mod view;
pub mod withdraw;

pub use admin::*;
pub use deposit_sol::*; // Alterado de deposit
pub use initialize::*;
pub use mint::*;
pub use module_admin::*;
pub use redeem::*;
pub use view::*;
pub use withdraw::*;

pub mod admin;
pub mod deposit_sol;
pub mod deposit_wsol;
pub mod initialize;
pub mod mint;
pub mod module_admin;
pub mod redeem;
pub mod view;
pub mod withdraw_sol; // Atualizado
pub mod withdraw_wsol; // Preparando o terreno para o dual interface

pub use admin::*;
pub use deposit_sol::*;
pub use deposit_wsol::*;
pub use initialize::*;
pub use mint::*;
pub use module_admin::*;
pub use redeem::*;
pub use view::*;
pub use withdraw_sol::*;
pub use withdraw_wsol::*;