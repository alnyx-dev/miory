/**
 * MIORY — deploy / initialize / mint client.
 *
 * Flow:
 *   1. derives every PDA of the program,
 *   2. initializes the protocol (idempotent),
 *   3. mints a test amount to the admin wallet,
 *   4. performs a transfer that goes through the Token-2022 transfer hook and
 *      reports the fee the token program withheld,
 *   5. cranks `collect_fees` and reports how much of the supply was burnt.
 *
 * Environment:
 *   ANCHOR_PROVIDER_URL  rpc endpoint (default: devnet)
 *   ANCHOR_WALLET        path to the wallet keypair (default: solana config)
 *   ANCHOR_PROGRAM_ID    program id (default: the id in Anchor.toml)
 *   MIORY_DECIMALS       mint decimals (default: 9)
 *   MIORY_FEE_BPS        transfer fee in bps (default: 100 = 1%)
 *   MIORY_MAX_FEE        absolute cap of the fee, in base units
 *   MIORY_MINT_AMOUNT    amount to mint, in base units (default: 100_000_000)
 */
import fs from "fs";
import path from "path";
import { AnchorProvider, BN, Wallet, web3 } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  programId,
  createProgram,
  derivePdas,
  parseOnChainMetadata,
  transferChecked,
} from "./miory-client";

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const DECIMALS = Number(process.env.MIORY_DECIMALS ?? 9);
const FEE_BPS = Number(process.env.MIORY_FEE_BPS ?? 0);
const MAX_FEE = new BN(process.env.MIORY_MAX_FEE ?? 1_000_000);
const MINT_AMOUNT = new BN(process.env.MIORY_MINT_AMOUNT ?? 100_000_000);

function loadWallet(): Keypair {
  const explicit = process.env.ANCHOR_WALLET;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = explicit
    ? [explicit]
    : [
        path.join(home, ".config/solana/id.json"),
        path.join(home, ".config", "solana", "id.json"),
      ];
  const file = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!file) {
    throw new Error(
      `Wallet keypair not found. Set ANCHOR_WALLET or create ${candidates[0]} (solana-keygen new).`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

async function main() {
  const walletKeypair = loadWallet();
  const connection = new web3.Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(walletKeypair), {
    commitment: "confirmed",
  });
  const program = createProgram(provider);
  const { authority, config, denylist, mint } = derivePdas();

  console.log("program   :", programId().toBase58());
  console.log("rpc       :", RPC_URL);
  console.log("admin     :", walletKeypair.publicKey.toBase58());
  console.log("authority :", authority.toBase58());
  console.log("config    :", config.toBase58());
  console.log("denylist  :", denylist.toBase58());
  console.log("mint      :", mint.toBase58());

  // ---------------------------------------------------------- initialize
  const configAccount = await connection.getAccountInfo(config);
  if (!configAccount) {
    console.log("\n[1/4] initialize ...");
    await (program.methods as any)
      .initialize({
        decimals: DECIMALS,
        transferFeeBps: FEE_BPS,
        maxFee: MAX_FEE,
        name: process.env.MIORY_NAME ?? "MIORY",
        symbol: process.env.MIORY_SYMBOL ?? "MIORY",
        uri: process.env.MIORY_URI ?? "https://miory.example/metadata.json",
      })
      .accounts({
        admin: walletKeypair.publicKey,
        authority,
        config,
        denylist,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: web3.SystemProgram.programId,
      })
      .rpc();
    console.log("      done");
  } else {
    console.log("\n[1/4] initialize: already initialized, skipping");
  }

  const mintState = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log(
    `      decimals=${mintState.decimals} supply=${mintState.supply} ` +
      `mintAuthority=${mintState.mintAuthority?.toBase58() ?? "none"} ` +
      `freezeAuthority=${mintState.freezeAuthority?.toBase58() ?? "none"}`,
  );

  const rawMint = await connection.getAccountInfo(mint, "confirmed");
  const metadata = rawMint ? parseOnChainMetadata(rawMint.data) : null;
  if (metadata) {
    console.log(
      `      metadata: name="${metadata.name}" symbol="${metadata.symbol}" uri="${metadata.uri}"`,
    );
  } else {
    console.log("      metadata: not found");
  }

  // ---------------------------------------------------------------- mint
  console.log("\n[2/4] mint ...");
  const adminAta = getAssociatedTokenAddressSync(
    mint,
    walletKeypair.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  await (program.methods as any)
    .mintTo(MINT_AMOUNT)
    .accounts({
      config,
      admin: walletKeypair.publicKey,
      authority,
      mint,
      destination: adminAta,
      recipient: walletKeypair.publicKey,
      payer: walletKeypair.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    })
    .rpc();

  const adminBalance = await connection.getTokenAccountBalance(adminAta, "confirmed");
  console.log(`      admin ATA ${adminAta.toBase58()} = ${adminBalance.value.amount}`);

  // ------------------------------------------------------------- transfer
  console.log("\n[3/4] transfer through the hook ...");
  // The recipient does not need SOL: the admin pays for the associated token
  // account and for the fees.
  const recipient = Keypair.generate();
  const recipientAta = getAssociatedTokenAddressSync(
    mint,
    recipient.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  const transferIx = transferChecked(
    adminAta,
    mint,
    recipientAta,
    walletKeypair.publicKey,
    MINT_AMOUNT,
    DECIMALS,
  );

  const createAtaIx = createAssociatedTokenAccountInstruction(
    walletKeypair.publicKey,
    recipientAta,
    recipient.publicKey,
    mint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const transaction = new web3.Transaction({
    feePayer: walletKeypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  })
    .add(createAtaIx)
    .add(transferIx);

  const signed = await provider.wallet.signTransaction(transaction);
  const signature = await provider.connection.sendRawTransaction(signed.serialize(), {
    preflightCommitment: "confirmed",
  });
  await provider.connection.confirmTransaction(signature, "confirmed");

  const recipientBalance = await connection.getTokenAccountBalance(recipientAta, "confirmed");
  const fee = MINT_AMOUNT.sub(new BN(recipientBalance.value.amount));
  console.log(`      sent     : ${MINT_AMOUNT.toString()}`);
  console.log(`      received : ${recipientBalance.value.amount}`);
  console.log(
    `      fee      : ${fee.toString()} (${FEE_BPS} bps, withheld by the token program)`,
  );
  console.log(`      tx       : ${signature}`);

  // ------------------------------------------------------------ burn fees
  console.log("\n[4/4] collect and burn the withheld fees ...");
  const vault = getAssociatedTokenAddressSync(mint, authority, true, TOKEN_2022_PROGRAM_ID);
  const supplyBefore = (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;

  await (program.methods as any)
    .collectFees()
    .accounts({
      config,
      authority,
      mint,
      vault,
      payer: walletKeypair.publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: web3.SystemProgram.programId,
    })
    .remainingAccounts([{ pubkey: recipientAta, isSigner: false, isWritable: true }])
    .rpc();

  const supplyAfter = (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  console.log(`      supply before: ${supplyBefore}`);
  console.log(`      supply after : ${supplyAfter}`);
  console.log(`      burnt        : ${supplyBefore - supplyAfter}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});


