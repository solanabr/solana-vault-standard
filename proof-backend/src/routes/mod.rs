//! API Routes

pub mod health;
pub mod proofs;

pub use health::health_router;
pub use proofs::proofs_router;
