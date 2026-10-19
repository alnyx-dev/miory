//! MIORY — a custom SPL Token-2022 mint with program controlled authorities,
//! a burn-on-transfer fee and a custom transfer hook.
//!
//! Authority model
//! ---------------
//! * `authority` PDA owns every privileged right of the token: mint authority,
//!   freeze authority, transfer-fee authority and transfer-hook authority. It
//!   is program owned, therefore only this program can ever sign on its behalf.
//! * `config` PDA holds the mutable protocol parameters and is owned by the
//!   admin wallet (`has_one = admin` on every privileged instruction).
//!
//! Burn on transfer
//! ----------------
//! The mint carries a Token-2022 `TransferFeeConfig` extension: the token
//! program itself withholds `fee = amount * bps / 10_000` (capped by
//! `max_fee`) from every transfer and keeps it in the destination account as
//! withheld fees. Those fees can only be moved by the fee authority, which is
//! the `authority` PDA, so the protocol can withdraw them into its vault and
//! burn them (`collect_fees`). The effective supply of the token is therefore
//! reduced on every transfer, and the reduction is finalised on chain.
//!
//! The fee starts at zero: the extension is installed from the start, so the
//! mint passes the extension checks of the AMMs, and the rate is raised later
//! with `set_transfer_fee` once there is liquidity. A changed rate becomes
//! active two epochs later, that is the behaviour of Token-2022.
//!
//! Why there is no transfer hook
//! -----------------------------
//! A hook needs its state accounts to be passed by the client: the token
//! program forwards them from the `ExtraAccountMetaList` of the mint. A DEX
//! router does not know about them and does not pass them, so every transfer
//! through a generic router would fail with `AccountNotEnoughKeys`. On top of
//! that, the AMMs refuse to create a pool for a mint with the `TransferHook`
//! extension. The policy is therefore enforced by the freeze authority
//! instead: `freeze_account` / `thaw_account` block the tokens of a holder at
//! the token program level, and `sync_denylist` applies the blocked list.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022::spl_token_2022::{
    extension::StateWithExtensions, instruction::initialize_mint2,
    state::Account as Token2022Account, state::Mint as Token2022Mint,
};
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use spl_pod::optional_keys::OptionalNonZeroPubkey;
use spl_token_metadata_interface::state::TokenMetadata;

mod constants;
mod errors;
mod state;

use constants::*;
use errors::MioryError;
use state::{Authority, Config, Denylist};

declare_id!("FmoRzYQcTNoFsWFXYwaqNCjsmN4gHjufp4kGTJXJrAx5");

/// Extensions of the MIORY mint. All of them have a fixed size, so the size
/// of the mint is known upfront; the variable length `TokenMetadata`
/// extension is added afterwards and grows the mint account.
const MINT_EXTENSIONS: [anchor_spl::token_2022::spl_token_2022::extension::ExtensionType; 2] = [
    anchor_spl::token_2022::spl_token_2022::extension::ExtensionType::TransferFeeConfig,
    anchor_spl::token_2022::spl_token_2022::extension::ExtensionType::MetadataPointer,
];

/// Arguments of the `initialize` instruction.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitArgs {
    /// Decimals of the mint.
    pub decimals: u8,
    /// Transfer fee in basis points. Zero keeps the token free to move, the
    /// rate is raised later with `set_transfer_fee`.
    pub transfer_fee_bps: u16,
    /// Absolute cap of the fee, in base units.
    pub max_fee: u64,
    /// On-chain metadata: name of the token.
    pub name: String,
    /// On-chain metadata: symbol of the token.
    pub symbol: String,
    /// On-chain metadata: URI of the metadata document.
    pub uri: String,
}

#[program]
pub mod miory {
    use super::*;

    /// Creates the protocol state and the Token-2022 mint.
    ///
    /// The mint is a PDA of this program. Its extensions have to be
    /// initialized before the mint state itself, therefore the mint account is
    /// created here instead of by an account constraint.
    pub fn initialize(ctx: Context<Initialize>, args: InitArgs) -> Result<()> {
        require!(args.decimals <= DECIMALS, MioryError::InvalidDecimals);
        require!(
            args.transfer_fee_bps <= MAX_TRANSFER_FEE_BPS,
            MioryError::InvalidFee
        );
        require!(args.max_fee > 0, MioryError::InvalidFee);
        require_metadata_len(&args.name, &args.symbol, &args.uri)?;

        let mint = ctx.accounts.mint.to_account_info();
        let authority = ctx.accounts.authority.to_account_info();
        let token_program = ctx.accounts.token_program.to_account_info();

        // 1) Transfer fee config: the token program withholds the fee on every
        //    transfer, the fee authority (our PDA) is the only account that can
        //    move the withheld fees afterwards.
        let fee_ix = anchor_spl::token_2022::spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config(
            token_program.key,
            mint.key,
            Some(authority.key),
            Some(authority.key),
            args.transfer_fee_bps,
            args.max_fee,
        )?;
        invoke(&fee_ix, &[mint.clone(), token_program.clone()])?;

        // 2) Metadata pointer. The on-chain metadata lives in the mint
        //    account itself, the token program only allows that.
        let pointer_ix = anchor_spl::token_2022::spl_token_2022::extension::metadata_pointer::instruction::initialize(
            token_program.key,
            mint.key,
            Some(*authority.key),
            Some(*mint.key),
        )?;
        invoke(&pointer_ix, &[mint.clone(), token_program.clone()])?;

        // 3) Mint state. The token program checks that the allocated space
        //    matches the initialized extensions exactly.
        let init_ix = initialize_mint2(
            token_program.key,
            mint.key,
            authority.key,
            Some(authority.key),
            args.decimals,
        )?;
        invoke(&init_ix, &[mint.clone(), token_program.clone()])?;

        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.bumps.authority]];

        // 4) On-chain metadata. The `TokenMetadata` extension has a variable
        //    length, so the token program grows the mint account: the mint has
        //    to be funded for the bigger size before the write, otherwise it
        //    would not be rent exempt anymore.
        let metadata = build_metadata(&mint, &authority, &args.name, &args.symbol, &args.uri)?;
        fund_mint_for_metadata(&ctx, &metadata)?;

        let metadata_ix = spl_token_metadata_interface::instruction::initialize(
            token_program.key,
            mint.key,
            authority.key,
            mint.key,
            authority.key,
            args.name,
            args.symbol,
            args.uri,
        );
        invoke_signed(
            &metadata_ix,
            &[
                mint.clone(),
                authority.clone(),
                mint.clone(),
                authority.clone(),
            ],
            &[seeds],
        )?;

        // 5) Vault of the protocol: the withheld fees are withdrawn into it
        //    and burnt from it. The account itself is created by the first
        //    `collect_fees` call, the address is deterministic.
        let vault = anchor_spl::associated_token::get_associated_token_address_with_program_id(
            authority.key,
            mint.key,
            token_program.key,
        );

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.pending_admin = Pubkey::default();
        config.mint = mint.key();
        config.authority = authority.key();
        config.vault = vault;
        config.decimals = args.decimals;
        config.transfer_fee_bps = args.transfer_fee_bps;
        config.max_fee = args.max_fee;
        config.authority_bump = ctx.bumps.authority;
        config.total_minted = 0;
        config.total_burned = 0;
        config.bump = ctx.bumps.config;

        let authority_state = &mut ctx.accounts.authority;
        authority_state.admin = ctx.accounts.admin.key();
        authority_state.bump = ctx.bumps.authority;

        let denylist_state = &mut ctx.accounts.denylist;
        denylist_state.admin = ctx.accounts.admin.key();
        denylist_state.bump = ctx.bumps.denylist;

        Ok(())
    }

    /// Mints tokens to the associated token account of `recipient`.
    ///
    /// The mint authority is the `authority` PDA, so the program signs the
    /// mint CPI itself; the admin signature is what authorises the action.
    pub fn mint_to(ctx: Context<MintTo>, amount: u64) -> Result<()> {
        require!(amount > 0, MioryError::InvalidAmount);

        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.config.authority_bump]];

        anchor_spl::token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        let config = &mut ctx.accounts.config;
        config.total_minted = config
            .total_minted
            .checked_add(amount)
            .ok_or(MioryError::Overflow)?;

        Ok(())
    }

    /// Burns tokens held by the signer.
    pub fn burn(ctx: Context<Burn>, amount: u64) -> Result<()> {
        require!(amount > 0, MioryError::InvalidAmount);

        anchor_spl::token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.from.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        let config = &mut ctx.accounts.config;
        config.total_burned = config
            .total_burned
            .checked_add(amount)
            .ok_or(MioryError::Overflow)?;

        Ok(())
    }

    /// Withdraws the fees withheld by the token program and burns them.
    ///
    /// Permissionless on purpose: anybody may crank the burn of the fees that
    /// the token program already withheld from the holders, which only
    /// benefits them. The source accounts are the token accounts that hold the
    /// withheld fees, they are passed as remaining accounts.
    pub fn collect_fees<'info>(ctx: Context<'_, '_, '_, 'info, CollectFees<'info>>) -> Result<()> {
        require!(!ctx.remaining_accounts.is_empty(), MioryError::NoFeeSources);

        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.config.authority_bump]];

        // Withdraw the withheld fees into the vault of the protocol. The fee
        // authority is the only account that is allowed to move them.
        let source_keys: Vec<Pubkey> = ctx.remaining_accounts.iter().map(|a| *a.key).collect();
        let source_key_refs: Vec<&Pubkey> = source_keys.iter().collect();
        let withdraw_ix = anchor_spl::token_2022::spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_accounts(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.vault.key(),
            &ctx.accounts.authority.key(),
            &[],
            &source_key_refs,
        )?;
        let mut account_infos = vec![
            ctx.accounts.token_program.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        ];
        account_infos.extend_from_slice(ctx.remaining_accounts);
        invoke_signed(&withdraw_ix, &account_infos, &[seeds])?;

        // Burn everything the vault received. The mint authority is our PDA.
        // The balance has to be re-read: the deserialized account still holds
        // the value from before the withdrawal.
        let vault_info = ctx.accounts.vault.to_account_info();
        let amount = {
            let data = vault_info.try_borrow_data()?;
            let account = StateWithExtensions::<Token2022Account>::unpack(&data)?;
            account.base.amount
        };
        if amount > 0 {
            anchor_spl::token_interface::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token_interface::Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
            )?;

            let config = &mut ctx.accounts.config;
            config.total_burned = config
                .total_burned
                .checked_add(amount)
                .ok_or(MioryError::Overflow)?;
        }

        Ok(())
    }

    /// Admin only: updates the transfer fee.
    ///
    /// The fee itself lives in the `TransferFeeConfig` extension of the mint,
    /// so the extension is updated as well: only the fee authority may do
    /// that, and the fee authority is the authority PDA.
    pub fn set_transfer_fee(ctx: Context<AdminFee>, bps: u16, max_fee: u64) -> Result<()> {
        require!(bps <= MAX_TRANSFER_FEE_BPS, MioryError::InvalidFee);
        require!(max_fee > 0, MioryError::InvalidFee);

        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.config.authority_bump]];
        let set_fee_ix = anchor_spl::token_2022::spl_token_2022::extension::transfer_fee::instruction::set_transfer_fee(
            &ctx.accounts.token_program.key(),
            &ctx.accounts.mint.key(),
            &ctx.accounts.authority.key(),
            &[],
            bps,
            max_fee,
        )?;
        invoke_signed(
            &set_fee_ix,
            &[
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.authority.to_account_info(),
            ],
            &[seeds],
        )?;

        ctx.accounts.config.transfer_fee_bps = bps;
        ctx.accounts.config.max_fee = max_fee;

        Ok(())
    }

    /// Admin only: applies the blocked list to the token accounts.
    ///
    /// A blocked address cannot move its tokens: the freeze authority of the
    /// mint is the authority PDA, so the program signs the freeze itself. The
    /// token accounts to synchronise are passed as remaining accounts, the
    /// client derives them from the addresses of the list.
    pub fn sync_denylist<'info>(
        ctx: Context<'_, '_, '_, 'info, SyncDenylist<'info>>,
    ) -> Result<()> {
        let denylist = &ctx.accounts.denylist;
        let mint = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.config.authority_bump]];

        for account in ctx.remaining_accounts.iter() {
            let account_info = account.to_account_info();
            let (owner, account_mint) = {
                let data = account_info.try_borrow_data()?;
                let token_account = StateWithExtensions::<Token2022Account>::unpack(&data)?;
                (token_account.base.owner, token_account.base.mint)
            };
            if account_mint != mint {
                return Err(MioryError::MintMismatch.into());
            }
            let blocked = denylist.contains(&owner);

            if blocked {
                anchor_spl::token_interface::freeze_account(CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token_interface::FreezeAccount {
                        account: account_info.clone(),
                        mint: ctx.accounts.mint.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                    &[seeds],
                ))?;
            } else {
                anchor_spl::token_interface::thaw_account(CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token_interface::ThawAccount {
                        account: account_info.clone(),
                        mint: ctx.accounts.mint.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                    &[seeds],
                ))?;
            }
        }

        Ok(())
    }

    /// Admin only: replaces the list of blocked addresses.
    pub fn set_denylist(ctx: Context<AdminDenylist>, addresses: Vec<Pubkey>) -> Result<()> {
        require!(
            addresses.len() <= MAX_DENYLIST_LEN,
            MioryError::DenylistFull
        );

        let denylist = &mut ctx.accounts.denylist;
        denylist.admin = ctx.accounts.admin.key();
        denylist.addresses = addresses;
        denylist.bump = ctx.bumps.denylist;

        Ok(())
    }

    /// Admin only: freezes the token account of a holder.
    ///
    /// The freeze authority of the mint is the authority PDA, so the program
    /// signs the freeze CPI itself.
    pub fn freeze_account(ctx: Context<AdminToken>) -> Result<()> {
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.config.authority_bump]];
        anchor_spl::token_interface::freeze_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token_interface::FreezeAccount {
                account: ctx.accounts.holder.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
            &[seeds],
        ))?;

        Ok(())
    }

    /// Admin only: thaws a frozen token account.
    pub fn thaw_account(ctx: Context<AdminToken>) -> Result<()> {
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.config.authority_bump]];
        anchor_spl::token_interface::thaw_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token_interface::ThawAccount {
                account: ctx.accounts.holder.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
            &[seeds],
        ))?;

        Ok(())
    }

    /// Admin only: proposes a new admin.
    ///
    /// The handover is two phased on purpose: a typo in the address would
    /// lock the protocol out forever, so the new admin has to accept the
    /// handover with its own signature.
    pub fn propose_admin(ctx: Context<AdminConfig>, new_admin: Pubkey) -> Result<()> {
        require!(new_admin != Pubkey::default(), MioryError::InvalidAdmin);
        require!(
            new_admin != ctx.accounts.config.admin,
            MioryError::InvalidAdmin
        );

        ctx.accounts.config.pending_admin = new_admin;

        Ok(())
    }

    /// Accepts the handover of the admin role.
    ///
    /// Signed by the pending admin, not by the current one.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = config.pending_admin;
        config.pending_admin = Pubkey::default();

        Ok(())
    }

    /// Admin only: updates the on-chain metadata of the token.
    ///
    /// The metadata lives in the `TokenMetadata` extension of the mint. The
    /// extension has a variable length, so the token program grows the mint
    /// account: the mint has to be funded for the new size beforehand,
    /// otherwise it would not be rent exempt anymore.
    pub fn set_metadata(
        ctx: Context<AdminMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        require_metadata_len(&name, &symbol, &uri)?;

        let mint = ctx.accounts.mint.to_account_info();
        let authority = ctx.accounts.authority.to_account_info();
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.config.authority_bump]];

        let metadata = build_metadata(&mint, &authority, &name, &symbol, &uri)?;
        let required = metadata_rent(&metadata, &ctx.accounts.rent)?;
        if required > mint.lamports() {
            let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.admin.key(),
                &ctx.accounts.mint.key(),
                required - mint.lamports(),
            );
            invoke(
                &transfer_ix,
                &[
                    ctx.accounts.admin.to_account_info(),
                    mint.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // The token metadata interface updates the fields one by one.
        for (field, value) in [
            (spl_token_metadata_interface::state::Field::Name, name),
            (spl_token_metadata_interface::state::Field::Symbol, symbol),
            (spl_token_metadata_interface::state::Field::Uri, uri),
        ] {
            let ix = spl_token_metadata_interface::instruction::update_field(
                &ctx.accounts.token_program.key(),
                &mint.key(),
                &authority.key(),
                field,
                value,
            );
            invoke_signed(&ix, &[mint.clone(), authority.clone()], &[seeds])?;
        }

        Ok(())
    }
}

/// Size of the mint account, including the room for the extensions.
fn mint_space() -> usize {
    anchor_spl::token_2022::spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
        Token2022Mint,
    >(&MINT_EXTENSIONS)
    .unwrap_or(0)
}

/// Size of the mint account without the variable length metadata extension.
fn mint_fixed_len() -> Result<usize> {
    Ok(anchor_spl::token_2022::spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
        Token2022Mint,
    >(&MINT_EXTENSIONS)?)
}

/// Checks the length limits of the on-chain metadata.
fn require_metadata_len(name: &str, symbol: &str, uri: &str) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= MAX_NAME_LEN,
        MioryError::InvalidMetadata
    );
    require!(
        !symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LEN,
        MioryError::InvalidMetadata
    );
    require!(uri.len() <= MAX_URI_LEN, MioryError::InvalidMetadata);
    Ok(())
}

/// Builds the on-chain metadata of the mint.
fn build_metadata(
    mint: &AccountInfo,
    authority: &AccountInfo,
    name: &str,
    symbol: &str,
    uri: &str,
) -> Result<TokenMetadata> {
    let update_authority = OptionalNonZeroPubkey::try_from(Some(*authority.key))
        .map_err(|_| MioryError::InvalidMetadata)?;
    Ok(TokenMetadata {
        update_authority,
        mint: *mint.key,
        name: name.to_string(),
        symbol: symbol.to_string(),
        uri: uri.to_string(),
        additional_metadata: vec![],
    })
}

/// Lamports the mint account needs to stay rent exempt once the token program
/// grows it for the metadata extension.
fn metadata_rent(metadata: &TokenMetadata, rent: &Sysvar<Rent>) -> Result<u64> {
    let size = mint_fixed_len()? + metadata.tlv_size_of()?;
    Ok(rent.minimum_balance(size))
}

/// Tops the mint account up so that it stays rent exempt after the token
/// program grows it for the metadata extension.
fn fund_mint_for_metadata(ctx: &Context<Initialize>, metadata: &TokenMetadata) -> Result<()> {
    let required = metadata_rent(metadata, &ctx.accounts.rent)?;
    let current = ctx.accounts.mint.lamports();
    if required > current {
        let transfer_ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.admin.key(),
            &ctx.accounts.mint.key(),
            required - current,
        );
        invoke(
            &transfer_ix,
            &[
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: InitArgs)]
pub struct Initialize<'info> {
    /// Administrative wallet.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// PDA holding every privileged right of the token.
    #[account(
        init,
        payer = admin,
        space = 8 + Authority::INIT_SPACE,
        seeds = [AUTHORITY_SEED],
        bump,
    )]
    pub authority: Account<'info, Authority>,

    /// Protocol configuration.
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// Blocked addresses.
    #[account(
        init,
        payer = admin,
        space = 8 + Denylist::INIT_SPACE,
        seeds = [DENYLIST_SEED],
        bump,
    )]
    pub denylist: Account<'info, Denylist>,

    /// Token-2022 mint. The account is created with the Token-2022 program as
    /// owner and with the room for the extensions; the mint state itself is
    /// initialized by CPI in the instruction handler, because the extensions
    /// have to be initialized before the mint.
    ///
    /// CHECK: state is written by the token program, validated by the seeds.
    #[account(
        init,
        payer = admin,
        owner = token_program.key(),
        space = mint_space(),
        seeds = [MINT_SEED],
        bump,
    )]
    pub mint: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintTo<'info> {
    #[account(mut, has_one = admin)]
    pub config: Account<'info, Config>,

    /// Administrative wallet, the only account allowed to mint.
    #[account(mut)]
    pub admin: Signer<'info>,

    /// PDA that holds the mint authority and signs the mint CPI.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED],
        bump = config.authority_bump,
    )]
    pub authority: Account<'info, Authority>,

    #[account(
        mut,
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Associated token account of the recipient.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub destination: InterfaceAccount<'info, TokenAccount>,

    /// Wallet that will own the associated token account.
    pub recipient: SystemAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Burn<'info> {
    #[account(mut, has_one = mint)]
    pub config: Account<'info, Config>,

    /// Token account of the signer.
    #[account(
        mut,
        token::mint = mint,
        token::authority = owner,
        token::token_program = token_program,
    )]
    pub from: InterfaceAccount<'info, TokenAccount>,

    /// Owner of the token account.
    pub owner: Signer<'info>,

    #[account(
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct CollectFees<'info> {
    #[account(mut, has_one = mint)]
    pub config: Account<'info, Config>,

    /// PDA that holds the fee authority and the mint authority.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED],
        bump = config.authority_bump,
    )]
    pub authority: Account<'info, Authority>,

    /// Mint of the token, the burn of the fees writes to it.
    #[account(
        mut,
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Vault of the protocol, the fees are withdrawn into it and burnt.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    #[account(mut, has_one = admin)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminFee<'info> {
    #[account(mut, has_one = admin)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// PDA that holds the fee authority.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED],
        bump = config.authority_bump,
    )]
    pub authority: Account<'info, Authority>,

    #[account(
        mut,
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct AdminDenylist<'info> {
    #[account(
        mut,
        has_one = admin,
        seeds = [DENYLIST_SEED],
        bump,
    )]
    pub denylist: Account<'info, Denylist>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SyncDenylist<'info> {
    #[account(
        mut,
        has_one = admin,
        seeds = [DENYLIST_SEED],
        bump,
    )]
    pub denylist: Account<'info, Denylist>,

    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(has_one = mint)]
    pub config: Account<'info, Config>,

    /// PDA that holds the freeze authority of the mint.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED],
        bump = config.authority_bump,
    )]
    pub authority: Account<'info, Authority>,

    #[account(
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct AdminMetadata<'info> {
    #[account(mut, has_one = admin)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// PDA that holds the update authority of the metadata.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED],
        bump = config.authority_bump,
    )]
    pub authority: Account<'info, Authority>,

    #[account(
        mut,
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminToken<'info> {
    #[account(mut, has_one = admin)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// PDA that holds the freeze authority of the mint.
    #[account(
        mut,
        seeds = [AUTHORITY_SEED],
        bump = config.authority_bump,
    )]
    pub authority: Account<'info, Authority>,

    #[account(
        mut,
        mint::token_program = token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Token account of the holder that is frozen or thawed.
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub holder: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,

    /// The pending admin, the one that accepted the handover.
    #[account(
        mut,
        constraint = config.pending_admin == pending_admin.key() @ MioryError::InvalidAdmin,
    )]
    pub pending_admin: Signer<'info>,
}
