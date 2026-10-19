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
    #[msg("Transfers are paused")]
    TransfersPaused,
    #[msg("Transfer amount exceeds the configured limit")]
    TransferTooLarge,
    #[msg("Address is on the denylist")]
    AddressDenied,
    #[msg("Denylist is full")]
    DenylistFull,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The source account is not in the middle of a transfer")]
    NotTransferring,
    #[msg("Provided accounts do not match the extra account metas list")]
    ExtraAccountsMismatch,
    #[msg("Mint account mismatch")]
    MintMismatch,
    #[msg("No accounts to collect the fees from")]
    NoFeeSources,
    #[msg("Invalid admin address")]
    InvalidAdmin,
    #[msg("Invalid metadata: name, symbol or uri is out of bounds")]
    InvalidMetadata,
}
