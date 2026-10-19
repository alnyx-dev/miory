//! Seeds and protocol-wide limits for the MIORY token.

/// PDA that owns every privileged role of the token:
/// mint authority, freeze authority, permanent delegate, transfer-hook authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";
/// PDA with the mutable protocol configuration.
pub const CONFIG_SEED: &[u8] = b"config";
/// PDA with the blocked addresses list.
pub const DENYLIST_SEED: &[u8] = b"denylist";
/// PDA of the Token-2022 mint itself.
pub const MINT_SEED: &[u8] = b"mint";
/// Seed of the transfer-hook validation account (must match the SPL interface).
pub const EXTRA_METAS_SEED: &[u8] = b"extra-account-metas";

/// Decimals of the MIORY mint.
pub const DECIMALS: u8 = 9;
/// Hard cap of the transfer fee: 5% of the transferred amount.
pub const MAX_TRANSFER_FEE_BPS: u16 = 500;
/// Maximum number of addresses in the denylist.
pub const MAX_DENYLIST_LEN: usize = 64;
/// Maximum length of the token name in the on-chain metadata.
pub const MAX_NAME_LEN: usize = 32;
/// Maximum length of the token symbol in the on-chain metadata.
pub const MAX_SYMBOL_LEN: usize = 10;
/// Maximum length of the metadata URI in the on-chain metadata.
pub const MAX_URI_LEN: usize = 200;
