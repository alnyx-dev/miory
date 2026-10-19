/**
 * Обновляет on-chain метаданные токена: имя, символ и URI метаданных.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/dev/set-metadata.ts
 */
import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";

const { derivePdas, createProgram, programId } = require("../miory-client");

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const WALLET_PATH =
  process.env.ANCHOR_WALLET ??
  `${process.env.USERPROFILE ?? process.env.HOME}/.config/solana/id.json`;
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

async function main() {
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"))),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
  });
  const program = createProgram(provider);
  const { config, authority, mint } = derivePdas(programId());

  const name = process.env.MIORY_NAME ?? "MIORY";
  const symbol = process.env.MIORY_SYMBOL ?? "MIORY";
  const uri = process.env.MIORY_URI ?? "https://alnyx-dev.github.io/miory/metadata.json";

  console.log("admin  :", admin.publicKey.toBase58());
  console.log("mint   :", mint.toBase58());
  console.log("setting:", { name, symbol, uri });

  const ix = await (program.methods as any)
    .setMetadata(name, symbol, uri)
    .accounts({
      config,
      admin: admin.publicKey,
      authority,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: PublicKey.default,
      rent: new PublicKey("SysvarRent111111111111111111111111111111111"),
    })
    .instruction();

  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.partialSign(admin);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(signature, "confirmed");
  console.log("tx     :", signature);
  console.log("metadata updated");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
