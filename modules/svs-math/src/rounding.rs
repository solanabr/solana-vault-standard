//! Rounding modes for vault math operations.

/// Rounding direction for division operations.
///
/// The vault uses rounding strategically to protect existing shareholders:
/// - `Floor`: Round down (user gets less) - used for deposit, redeem
/// - `Ceiling`: Round up (user pays more) - used for mint, withdraw
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Rounding {
    /// Round down to the nearest integer (truncate).
    Floor,
    /// Round up to the nearest integer.
    Ceiling,
}
