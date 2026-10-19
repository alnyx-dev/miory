import { AnchorProvider, BN, Wallet, web3 } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { expect } from "chai";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import {
  programId,
  createProgram,
  derivePdas,
  parseOnChainMetadata,
  transferChecked,
} from "../scripts/miory-client";

const DECIMALS = 9;
const FEE_BPS = 100; // 1%
const MINT_AMOUNT = new BN(100_000_000);
const TRANSFER_AMOUNT = new BN(10_000_000);

const connection = new web3.Connection(
  process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899",
  "confirmed",
);

/** Balance of a token account, `0` when the account does not exist yet. */
async function balanceOf(ata: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(ata, "processed");
  if (!info) {
    return BigInt(0);
  }
  return BigInt((await connection.getTokenAccountBalance(ata, "processed")).value.amount);
}

describe("MIORY", () => {
  // `preflightCommitment` is pinned to "confirmed": the local validator drops
  // blockhashes from its queue faster than the "finalized" view catches up,
  // which makes the default ("finalized") blockhash flaky.
  const provider = new AnchorProvider(connection, AnchorProvider.env().wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = createProgram(provider);
  const admin = provider.wallet.publicKey;
  const { authority, config, denylist, mint } = derivePdas();

  let recipient: Keypair;
  let recipientAta: PublicKey;
  let adminAta: PublicKey;
  let supplyBeforeMint: bigint;
  let balanceBeforeMint: bigint;

  const initialize = () =>
    (program.methods as any)
      .initialize({
        decimals: DECIMALS,
        transferFeeBps: FEE_BPS,
        maxFee: new BN(1_000_000),
        name: "MIORY",
        symbol: "MIORY",
        uri: "https://miory.example/metadata.json",
      })
      .accounts({
        admin,
        authority,
        config,
        denylist,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

  const mintTokens = (amount: BN) =>
    (program.methods as any)
      .mintTo(amount)
      .accounts({
        config,
        admin,
        authority,
        mint,
        destination: adminAta,
        recipient: admin,
        payer: admin,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();

  const collectFees = (source: PublicKey) =>
    (program.methods as any)
      .collectFees()
      .accounts({
        config,
        authority,
        mint,
        vault: getAssociatedTokenAddressSync(mint, authority, true, TOKEN_2022_PROGRAM_ID),
        payer: admin,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: source, isSigner: false, isWritable: true }])
      .rpc();

  before(async () => {
    // The local validator has a faucet, on other clusters the wallet has to be
    // funded beforehand.
    const adminBalance = await connection.getBalance(admin, "processed");
    if (adminBalance < LAMPORTS_PER_SOL) {
      try {
        const signature = await connection.requestAirdrop(admin, 10 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction(signature, "confirmed");
      } catch (error) {
        console.warn(
          `could not fund the test wallet: ${(error as Error).message}. ` +
            "The wallet needs SOL to pay for the transactions.",
        );
      }
    }

    recipient = Keypair.generate();
    adminAta = getAssociatedTokenAddressSync(mint, admin, true, TOKEN_2022_PROGRAM_ID);
    recipientAta = getAssociatedTokenAddressSync(
      mint,
      recipient.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID,
    );

    // The protocol can only be initialized once, so a rerun against a
    // validator that already has the state skips it.
    if (!(await connection.getAccountInfo(config))) {
      await initialize();
    }

    const createAtaIx = createAssociatedTokenAccountInstruction(
      admin,
      recipientAta,
      recipient.publicKey,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    await provider.sendAndConfirm(new web3.Transaction().add(createAtaIx), [], { commitment: "confirmed" });

    supplyBeforeMint = (
      await getMint(connection, mint, "processed", TOKEN_2022_PROGRAM_ID)
    ).supply;
    balanceBeforeMint = await balanceOf(adminAta);

    await mintTokens(MINT_AMOUNT);
  });

  it("creates the mint with the program controlled authorities", async () => {
    const mintState = await getMint(connection, mint, "processed", TOKEN_2022_PROGRAM_ID);
    expect(mintState.decimals).to.equal(DECIMALS);
    expect(mintState.supply - supplyBeforeMint).to.equal(BigInt(MINT_AMOUNT.toString()));
    expect(mintState.mintAuthority?.toBase58()).to.equal(authority.toBase58());
    expect(mintState.freezeAuthority?.toBase58()).to.equal(authority.toBase58());
  });

  it("mints to the admin", async () => {
    const balance = await connection.getTokenAccountBalance(adminAta, "processed");
    expect(BigInt(balance.value.amount) - balanceBeforeMint).to.equal(
      BigInt(MINT_AMOUNT.toString()),
    );
  });

  it("withholds the transfer fee on every transfer", async () => {
    const before = new BN(
      (await balanceOf(recipientAta)).toString(),
    );

    const ix = transferChecked(
      adminAta,
      mint,
      recipientAta,
      admin,
      TRANSFER_AMOUNT,
      DECIMALS,
    );
    await provider.sendAndConfirm(new web3.Transaction().add(ix), [], { commitment: "confirmed" });

    const after = new BN(
      (await balanceOf(recipientAta)).toString(),
    );
    const fee = TRANSFER_AMOUNT.sub(after.sub(before));
    expect(fee.toString()).to.equal(new BN(TRANSFER_AMOUNT.toNumber() / 100).toString());
  });

  it("burns the withheld fees", async () => {
    const before = (await getMint(connection, mint, "processed", TOKEN_2022_PROGRAM_ID)).supply;
    await collectFees(recipientAta);
    const after = (await getMint(connection, mint, "processed", TOKEN_2022_PROGRAM_ID)).supply;
    expect(before - after).to.equal(BigInt(TRANSFER_AMOUNT.toNumber() / 100));
  });

  it("schedules a new fee for the next epochs", async () => {
    await (program.methods as any)
      .setTransferFee(200, new BN(1_000_000))
      .accounts({
        config,
        admin,
        authority,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const before = new BN(
      (await balanceOf(recipientAta)).toString(),
    );

    const amount = new BN(1_000_000);
    const ix = transferChecked(
      adminAta,
      mint,
      recipientAta,
      admin,
      amount,
      DECIMALS,
    );
    await provider.sendAndConfirm(new web3.Transaction().add(ix), [], { commitment: "confirmed" });

    const after = new BN(
      (await balanceOf(recipientAta)).toString(),
    );
    const fee = amount.sub(after.sub(before));
    // The token program activates a new fee two epochs ahead to avoid a rug
    // pull at the end of an epoch, so the old fee is still in effect.
    expect(fee.toString()).to.equal(new BN(10_000).toString()); // 1%
  });

  it("freezes and thaws a holder", async () => {
    await (program.methods as any)
      .freezeAccount()
      .accounts({
        config,
        admin,
        authority,
        mint,
        holder: recipientAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const ix = transferChecked(
      adminAta,
      mint,
      recipientAta,
      admin,
      TRANSFER_AMOUNT,
      DECIMALS,
    );

    let failed = false;
    try {
      await provider.sendAndConfirm(new web3.Transaction().add(ix), [], { commitment: "confirmed" });
    } catch (error) {
      failed = true;
    }
    expect(failed).to.equal(true);

    await (program.methods as any)
      .thawAccount()
      .accounts({
        config,
        admin,
        authority,
        mint,
        holder: recipientAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
  });

  it("hands the admin role over in two steps", async () => {
    const nextAdmin = Keypair.generate();
    // fund the new admin from the test wallet, the local faucet is flaky
    const funding = web3.SystemProgram.transfer({
      fromPubkey: admin,
      toPubkey: nextAdmin.publicKey,
      lamports: 1 * LAMPORTS_PER_SOL,
    });
    await provider.sendAndConfirm(new web3.Transaction().add(funding), [], {
      commitment: "confirmed",
    });

    // the current admin proposes the new one
    await (program.methods as any)
      .proposeAdmin(nextAdmin.publicKey)
      .accounts({ config, admin })
      .rpc();

    // the new admin accepts the handover
    const nextProvider = new AnchorProvider(connection, new Wallet(nextAdmin), {
      commitment: "confirmed",
    });
    const nextProgram = createProgram(nextProvider);
    await (nextProgram.methods as any)
      .acceptAdmin()
      .accounts({ config, pendingAdmin: nextAdmin.publicKey })
      .rpc();

    // the old admin is locked out, the new one works
    let failed = false;
    try {
      await (program.methods as any)
        .setTransferPolicy(false, new BN(0))
        .accounts({ config, admin })
        .rpc();
    } catch (error) {
      failed = true;
    }
    expect(failed).to.equal(true);

    await (nextProgram.methods as any)
      .setTransferPolicy(false, new BN(0))
      .accounts({ config, admin: nextAdmin.publicKey })
      .rpc();

    // hand the role back to the original admin for the rest of the suite
    await (nextProgram.methods as any)
      .proposeAdmin(admin)
      .accounts({ config, admin: nextAdmin.publicKey })
      .rpc();
    await (program.methods as any)
      .acceptAdmin()
      .accounts({ config, pendingAdmin: admin })
      .rpc();
  });

  it("stores the metadata on chain", async () => {
    const rawMint = (await connection.getAccountInfo(mint, "processed"))!;
    const metadata = parseOnChainMetadata(rawMint.data)!;
    expect(metadata).to.not.equal(null);
    // the exact values may have been changed by a previous run of the suite
    expect(metadata.name.length).to.be.greaterThan(0);
    expect(metadata.symbol.length).to.be.greaterThan(0);
    expect(metadata.mint).to.equal(mint.toBase58());
    expect(metadata.updateAuthority).to.equal(authority.toBase58());
  });

  it("updates the metadata on chain", async () => {
    await (program.methods as any)
      .setMetadata("MIORY Token", "MIORY", "https://miory.example/v2.json")
      .accounts({
        config,
        admin,
        authority,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
        rent: web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const rawMint = (await connection.getAccountInfo(mint, "processed"))!;
    const metadata = parseOnChainMetadata(rawMint.data)!;
    expect(metadata.name).to.equal("MIORY Token");
    expect(metadata.uri).to.equal("https://miory.example/v2.json");
  });

  it("freezes the accounts of the denylisted addresses", async () => {
    // the recipient holds tokens, its account is the one that gets frozen
    await (program.methods as any)
      .setDenylist([recipient.publicKey])
      .accounts({ denylist, admin })
      .rpc();

    await (program.methods as any)
      .syncDenylist()
      .accounts({
        denylist,
        admin,
        config,
        authority,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    // a frozen account cannot transfer its tokens
    const ix = transferChecked(
      recipientAta,
      mint,
      adminAta,
      recipient.publicKey,
      TRANSFER_AMOUNT,
      DECIMALS,
    );

    let failed = false;
    try {
      await provider.sendAndConfirm(new web3.Transaction().add(ix), [], { commitment: "confirmed" });
    } catch (error) {
      failed = true;
    }
    expect(failed).to.equal(true);

    // removing the address from the list thaws the account again
    await (program.methods as any)
      .setDenylist([])
      .accounts({ denylist, admin })
      .rpc();
    await (program.methods as any)
      .syncDenylist()
      .accounts({
        denylist,
        admin,
        config,
        authority,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: recipientAta, isSigner: false, isWritable: true },
      ])
      .rpc();

    const account = await getAccount(connection, recipientAta, "processed");
    expect(account.isFrozen).to.equal(false);
  });
});







