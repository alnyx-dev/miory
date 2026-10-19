use anchor_lang::prelude::*;

/// Errors of the MIORY program.
#[error_code]
pub enum MioryError {
    #[msg("Invalid number of decimals")]
    InvalidDecimals,
    #[msg("Transfer fee is out of bounds")]
    InvalidFee,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Mint account mismatch")]
    MintMismatch,
    #[msg("No accounts to collect the fees from")]
    NoFeeSources,
    #[msg("Invalid admin address")]
    InvalidAdmin,
    #[msg("Denylist is full")]
    DenylistFull,
    #[msg("Invalid metadata: name, symbol or uri is out of bounds")]
    InvalidMetadata,
}
