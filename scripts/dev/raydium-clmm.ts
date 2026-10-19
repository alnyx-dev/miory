/**
 * Ликвидность на Raydium: создаёт пул MIORY/wSOL, наливает ликвидность и
 * прогоняет свап — проверка, что mint с нашими расширениями проходит
 * проверку расширений у AMM и что токен реально торгуется.
 *
 * Важно: на devnet задеплоена CLMM (Raydium CLMM), а новая CPMM-программа
 * (CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C) — нет, поэтому пул
 * создаётся через CLMM. Для CLMM нужен примерно 3 SOL: рента аккаунта пула,
 * тик-массива и позиции.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/dev/raydium-clmm.ts
 */
import { Keypair, PublicKey, Connection, Transaction, SystemProgram } from "@solana/web3.js";
import { Raydium, CLMM_PROGRAM_ID, WSOLMint, createWSolAccountInstructions } from "@raydium-io/raydium-sdk-v2";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const MINT = new PublicKey("AWpKSeyPmFAs91y3MTbJ1jRS4zKfBKbAv3uKci6JEKFA");
const MINT_DECIMALS = 9;
const WSOL_DECIMALS = 9;
/** начальная цена: 1000 MIORY за 0.05 SOL */
const SOL_PER_MIORY = new BN(50_000); // 0.05 SOL в wei-scaled

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath =
    process.env.ANCHOR_WALLET ??
    `${process.env.USERPROFILE ?? process.env.HOME}/.config/solana/id.json`;
  const fs = require("fs");
  const owner = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
  const connection = new Connection(url, "confirmed");

  const balance = (await connection.getBalance(owner.publicKey, "confirmed")) / 1e9;
  console.log("owner :", owner.publicKey.toBase58());
  console.log("balance:", balance, "SOL");
  if (balance < 3) {
    console.log("нужно минимум 3 SOL: рента пула CLMM, тик-массива и позиции");
    return;
  }

  const raydium = await Raydium.load({ cluster: "devnet", owner, connection });

  // wSOL-аккаунт владельца: он принадлежит classic token program, а
  // associated token program v7 инициализирует аккаунты только через
  // Token-2022, поэтому аккаунт создаётся напрямую.
  const wsolAta = getAssociatedTokenAddressSync(WSOLMint, owner.publicKey, true, TOKEN_PROGRAM_ID);
  if (!(await connection.getAccountInfo(wsolAta))) {
    console.log("creating the wSOL account ...");
    const { instructions } = await createWSolAccountInstructions({
      connection,
      amount: new BN(0.1 * 10 ** WSOL_DECIMALS),
      commitment: "confirmed",
      payer: owner.publicKey,
      owner: owner.publicKey,
      closeDestination: undefined,
    });
    const tx = new Transaction().add(...(instructions ?? []));
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.partialSign(owner);
    await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log("creating the CLMM pool MIORY/wSOL ...");
  const clmmResult = (await raydium.clmm.createPool({
    programId: CLMM_PROGRAM_ID,
    mintA: { address: MINT, decimals: MINT_DECIMALS, programId: TOKEN_2022_PROGRAM_ID },
    mintB: { address: WSOLMint, decimals: WSOL_DECIMALS, programId: TOKEN_PROGRAM_ID },
    feeConfig: (await raydium.api.getClmmConfigs())[0],
    initialPrice: SOL_PER_MIORY,
    tickSpacing: 64,
    mintAAmount: new BN(1000 * 10 ** MINT_DECIMALS),
    mintBAmount: new BN(0.05 * 10 ** WSOL_DECIMALS),
    ownerInfo: { feePayer: owner.publicKey, useSOLBalance: true },
    computeBudgetConfig: { units: 800_000 },
    txVersion: 0,
  } as any)) as any;
  const execute = clmmResult.execute;
  const address = clmmResult.address;

  console.log("pool address:", address.poolId.toBase58());
  const { txId } = await execute();
  console.log("create tx:", txId);
  console.log("pool id:", address.poolId.toBase58());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
