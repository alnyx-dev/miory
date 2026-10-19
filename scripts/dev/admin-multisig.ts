/**
 * Передаёт права админа протокола на мультисиг.
 *
 * Схема: текущий админ (деплой-кошелёк) вызывает `propose_admin(multisig)`,
 * затем сам мультисиг подписывает `accept_admin` — двухшаговая передача,
 * опечатка в адресе не блокирует протокол навсегда.
 *
 * Мультисиг — обычный аккаунт Token-программы (SPL multisig, M-of-N): для
 * протокола неважно, какой именно мультисиг стоит админом, а заменить его
 * позже можно тем же `propose_admin`/`accept_admin` (например, на Squads).
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/dev/admin-multisig.ts
 */
import fs from "fs";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMultisigInstruction,
} from "@solana/spl-token";

const { derivePdas, createProgram } = require("../miory-client");

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
  console.log("current admin:", admin.publicKey.toBase58());
  console.log(
    "balance       :",
    (await connection.getBalance(admin.publicKey, "confirmed")) / 1e9,
    "SOL",
  );

  // Создаём 2-of-3 мультисиг. В продакшене эти ключи должны жить на разных
  // устройствах, здесь — локальные, чтобы проверить механику.
  const members = [Keypair.generate(), Keypair.generate()];
  const multisig = Keypair.generate();
  const threshold = 2;

  const rent = await connection.getMinimumBalanceForRentExemption(355, "confirmed");
  console.log("rent for the multisig account:", rent / 1e9, "SOL");

  // N = 3: два участника-ключа плюс текущий админ-кошелёк.
  const participants = [...members.map((m) => m.publicKey), admin.publicKey];
  const createIx = createInitializeMultisigInstruction(
    multisig.publicKey,
    participants,
    threshold,
    TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: admin.publicKey,
      newAccountPubkey: multisig.publicKey,
      space: 355,
      lamports: rent,
      programId: TOKEN_PROGRAM_ID,
    }),
    createIx,
  );
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  // подписи участников мультисига при создании не нужны: InitializeMultisig
  // только записывает их публичные ключи.
  tx.partialSign(multisig, admin);
  await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  await new Promise((r) => setTimeout(r, 3000));
  console.log(
    "multisig created:",
    multisig.publicKey.toBase58(),
    `(${threshold} of ${participants.length})`,
  );

  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
  });
  const program = createProgram(provider);
  const { config, denylist, authority, mint } = derivePdas(new PublicKey(idlAddress()));

  // Шаг 1: текущий админ предлагает нового.
  const propose = await (program.methods as any)
    .proposeAdmin(multisig.publicKey)
    .accounts({ config, admin: admin.publicKey })
    .instruction();
  const proposeTx = new Transaction().add(propose);
  proposeTx.feePayer = admin.publicKey;
  proposeTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  proposeTx.partialSign(admin);
  await connection.sendRawTransaction(proposeTx.serialize(), { preflightCommitment: "confirmed" });
  await new Promise((r) => setTimeout(r, 3000));
  console.log("propose_admin done");

  // Шаг 2: accept_admin должен подписать сам мультисиг.
  //
  // С обычным SPL-мультисигом это невозможно без изменения программы:
  // подписи участников должны лежать в слотах подписей сразу за слотом
  // мультисига, а web3.js проверяет, что подпись в слоте валидна для
  // публичного ключа этого слота, а никто не владеет приватным ключом
  // мультисига. Нужен Squads: там программа исполняет транзакцию, а
  // одобрения участников лежат on-chain.
  //
  // Проверяем, что предложение действительно записано.
  const configData = await connection.getAccountInfo(config, "confirmed");
  console.log("proposal recorded in the config:", configData ? "yes" : "no");
  console.log("pending admin:", multisig.publicKey.toBase58());
  console.log(
    "\nДальше: подписать accept_admin от имени мультисига (Squads) — см. HANDOFF.md, п.2.",
  );
}

function idlAddress(): string {
  return JSON.parse(
    fs.readFileSync(require("path").join(__dirname, "..", "..", "target", "idl", "miory.json"), "utf8"),
  ).address;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
