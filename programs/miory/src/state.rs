use anchor_lang::prelude::*;

use crate::constants::MAX_DENYLIST_LEN;

/// PDA that carries every privileged right of the token.
///
/// It is the mint authority, the freeze authority, the permanent delegate
/// (used by the transfer hook to burn the fee) and the transfer-fee/hook
/// authority. Because it is program owned, only this program can sign on
/// its behalf.
#[account]
#[derive(InitSpace)]
pub struct Authority {
    /// Administrative wallet allowed to call the privileged instructions.
    pub admin: Pubkey,
    /// Canonical bump of the PDA.
    pub bump: u8,
}

/// Mutable protocol configuration.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Administrative wallet allowed to call the privileged instructions.
    pub admin: Pubkey,
    /// Admin proposed by the current admin, has to accept the handover with
    /// its own signature.
    pub pending_admin: Pubkey,
    /// Token-2022 mint (PDA).
    pub mint: Pubkey,
    /// PDA holding the privileged rights of the token.
    pub authority: Pubkey,
    /// Associated token account of the authority, the withheld fees are
    /// withdrawn into it and burnt from it.
    pub vault: Pubkey,
    /// Canonical bump of the authority PDA.
    pub authority_bump: u8,
    /// Decimals of the mint.
    pub decimals: u8,
    /// Transfer fee requested by the admin, in basis points of the transferred
    /// amount. The token program activates a new fee two epochs ahead, so the
    /// effective fee can still differ from this value right after the change.
    pub transfer_fee_bps: u16,
    /// Absolute cap of the fee, in base units.
    pub max_fee: u64,
    /// Lifetime amount of minted tokens.
    pub total_minted: u64,
    /// Lifetime amount of burnt tokens.
    pub total_burned: u64,
    /// Canonical bump of the config PDA.
    pub bump: u8,
}

/// List of addresses that are not allowed to transfer the token.
///
/// The list is stored in a `Vec` on purpose: an inline array would be copied
/// on the stack on every deserialization and would blow the 4KB BPF stack
/// frame of the transfer hook.
#[account]
#[derive(InitSpace)]
pub struct Denylist {
    /// Administrative wallet allowed to modify the list.
    pub admin: Pubkey,
    /// Blocked addresses.
    #[max_len(MAX_DENYLIST_LEN)]
    pub addresses: Vec<Pubkey>,
    /// Canonical bump of the denylist PDA.
    pub bump: u8,
}

impl Denylist {
    /// Returns `true` if the address is blocked.
    pub fn contains(&self, address: &Pubkey) -> bool {
        self.addresses.iter().any(|denied| denied == address)
    }
}
