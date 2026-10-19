/**
 * Создаёт пул MIORY/wSOL на Raydium devnet, наливает ликвидность и
 * прогоняет свап — проверка, что mint с нашими расширениями проходит
 * проверку расширений у AMM и что токен реально торгуется.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/dev/raydium-pool.ts
 */
import { Keypair, PublicKey, Connection, Transaction, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  Raydium,
  CREATE_CPMM_POOL_FEE_ACC,
  CREATE_CPMM_POOL_PROGRAM,
  WSOLMint,
  createWSolAccountInstructions,
} from "@raydium-io/raydium-sdk-v2";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const MINT = new PublicKey("AWpKSeyPmFAs91y3MTbJ1jRS4zKfBKbAv3uKci6JEKFA");
const MINT_DECIMALS = 9;
const WSOL_DECIMALS = 9;

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

  console.log("owner:", owner.publicKey.toBase58());
  console.log("balance:", (await connection.getBalance(owner.publicKey, "confirmed")) / 1e9, "SOL");

  const raydium = await Raydium.load({ cluster: "devnet", owner, connection });
  const feeConfig = (await raydium.api.getCpmmConfigs())[0];
  console.log("fee config:", JSON.stringify(feeConfig).slice(0, 200));

  // The SDK expects the token accounts of the pool owner to exist. wSOL wraps
  // the native mint, which belongs to the classic token program; the
  // associated token program v7 only initializes accounts through Token-2022,
  // so the account is created directly with the classic token program.
  const wsolAta = getAssociatedTokenAddressSync(
    WSOLMint,
    owner.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );
  if (!(await connection.getAccountInfo(wsolAta))) {
    console.log("creating the wSOL account ...");
    const { instructions } = await createWSolAccountInstructions({
      connection,
      amount: new BN(0.05 * 10 ** WSOL_DECIMALS),
      commitment: "confirmed",
      payer: owner.publicKey,
      owner: owner.publicKey,
      closeDestination: undefined,
    });
    const tx = new Transaction().add(...(instructions ?? []));
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.partialSign(owner);
    await connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: "confirmed",
    });
    await new Promise((r) => setTimeout(r, 4000));
  }
  const mintAAmount = new BN(1000 * 10 ** MINT_DECIMALS);
  const mintBAmount = new BN(0.05 * 10 ** WSOL_DECIMALS);

  console.log("creating the CPMM pool MIORY/wSOL ...");
  const result = (await raydium.cpmm.createPool({
    programId: CREATE_CPMM_POOL_PROGRAM,
    poolFeeAccount: CREATE_CPMM_POOL_FEE_ACC,
    mintA: {
      address: MINT,
      decimals: MINT_DECIMALS,
      programId: TOKEN_2022_PROGRAM_ID,
    },
    mintB: {
      address: WSOLMint,
      decimals: WSOL_DECIMALS,
      // wSOL wraps the native mint, it belongs to the classic token program
      programId: TOKEN_PROGRAM_ID,
    },
    mintAAmount,
    mintBAmount,
    startTime: new BN(0),
    feeConfig,
    associatedOnly: false,
    addSupportMintExt: true,
    ownerInfo: { feePayer: owner.publicKey, useSOLBalance: true },
    computeBudgetConfig: { units: 600_000 },
    txVersion: 0,
  } as any));

  console.log("result keys:", Object.keys(result));
  console.log("builder returns:", JSON.stringify((result.builder as any)?.returns ?? null));
  const { txId } = await result.execute();
  console.log("create tx:", txId);
  const poolId = ((result.builder as any)?.returns as any)?.address?.poolId;
  console.log("pool id:", poolId ? poolId.toBase58() : "n/a");
  if (poolId) {
    const { execute } = await raydium.cpmm.swap({
      poolInfo: { id: poolId.toBase58() } as any,
      inputMint: MINT,
      outputMint: WSOLMint,
      amountIn: new BN(10 * 10 ** MINT_DECIMALS),
      amountOutMin: new BN(1),
      slippage: 0.01,
      computeBudgetConfig: { units: 600_000 },
      txVersion: 0,
    } as any);
    const swap = await execute();
    console.log("swap tx:", swap.txId);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
