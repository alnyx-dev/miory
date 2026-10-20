/**
 * Передаёт права админа протокола Squads-мультисигу (Squads v4).
 *
 * Схема:
 *   1. создаётся Squads-мультисиг (2-of-3) на devnet;
 *   2. текущий админ MIORY вызывает `propose_admin(<vault PDA мультисига>)`;
 *   3. внутри Squads создаётся vault-транзакция, сообщение которой вызывает
 *      `accept_admin` программы MIORY;
 *   4. два участника голосуют, третий исполняет транзакцию.
 *
 * Важная деталь Squads v4: подписент исполняемой транзакции — не сам
 * мультисиг, а его **vault PDA** (`invoke_signed` c seeds
 * [multisig, multisig_pda, "vault", index]). Поэтому новым админом должен
 * стать именно vault PDA: у MIORY `accept_admin` требует, чтобы админ был
 * подписантом.
 *
 * Скрипт возобновляемый: состояние (ключи участников, create key, адрес
 * мультисига) лежит в `scripts/dev/.squads-state.json` (в .gitignore), так
 * что повторный запуск продолжает с того же места, а не создаёт новый
 * мультисиг.
 *
 * Ключи участников для демо генерируются локально. В продакшене эти ключи
 * должны жить на разных устройствах, а деплой-кошелёк не должен быть среди
 * них.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/dev/squads-admin.ts
 */
import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey, Transaction, TransactionMessage } from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  getMultisigPda,
  getProgramConfigPda,
  getVaultPda,
  getProposalPda,
  getTransactionPda,
  instructions as squadsInstructions,
  types as squadsTypes,
} from "@sqds/multisig";

const { derivePdas, createProgram, programId } = require("../miory-client");

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const WALLET_PATH =
  process.env.ANCHOR_WALLET ??
  `${process.env.USERPROFILE ?? process.env.HOME}/.config/solana/id.json`;
const STATE_PATH = path.join(__dirname, ".squads-state.json");
const THRESHOLD = 2;
const MEMBER_COUNT = 3;
const MEMBER_FUNDING_LAMPORTS = 1_000_000; // 0.001 SOL, чтобы аккаунт существовал

interface SquadsState {
  members: number[][];
  createKey?: number[];
  multisigPda?: string;
}

function loadState(): SquadsState {
  if (!fs.existsSync(STATE_PATH)) return { members: [] };
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state: SquadsState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function confirm(connection: Connection, signature: string) {
  await connection.confirmTransaction(signature, "confirmed");
}

async function main() {
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"))),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const state = loadState();

  console.log("deploy wallet (current admin):", admin.publicKey.toBase58());
  console.log(
    "balance:",
    ((await connection.getBalance(admin.publicKey, "confirmed")) / 1e9).toFixed(4),
    "SOL",
  );

  // --- Ключи участников мультисига -----------------------------------------
  if (state.members.length === 0) {
    state.members = Array.from({ length: MEMBER_COUNT }, () =>
      Array.from(Keypair.generate().secretKey),
    );
    saveState(state);
    console.log(`generated ${MEMBER_COUNT} member keys`);
  }
  const members = state.members.map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
  members.forEach((m, i) => console.log(`  member ${i + 1}:`, m.publicKey.toBase58()));

  // Участники должны существовать как аккаунты (иначе рантайм не даст
  // проставить подпись на writable-аккаунте голосования).
  for (const member of members) {
    const balance = await connection.getBalance(member.publicKey, "confirmed");
    if (balance === 0) {
      const tx = new Transaction().add({
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: member.publicKey, isSigner: false, isWritable: true },
        ],
        programId: PublicKey.default,
        data: Buffer.alloc(12),
      });
      // SystemProgram.transfer
      tx.instructions[0] = {
        keys: [
          { pubkey: admin.publicKey, isSigner: true, isWritable: true },
          { pubkey: member.publicKey, isSigner: false, isWritable: true },
        ],
        programId: new PublicKey("11111111111111111111111111111111"),
        data: (() => {
          const data = Buffer.alloc(12);
          data.writeUInt32LE(2, 0);
          data.writeBigUInt64LE(BigInt(MEMBER_FUNDING_LAMPORTS), 4);
          return data;
        })(),
      };
      tx.feePayer = admin.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.partialSign(admin);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        preflightCommitment: "confirmed",
      });
      await confirm(connection, sig);
      console.log(`  funded ${member.publicKey.toBase58()} with 0.001 SOL`);
    }
  }

  // --- Создание мультисига --------------------------------------------------
  if (!state.createKey) {
    state.createKey = Array.from(Keypair.generate().secretKey);
    saveState(state);
  }
  const createKey = Keypair.fromSecretKey(Uint8Array.from(state.createKey));
  const [multisigPda] = getMultisigPda({ createKey: createKey.publicKey });

  const multisigExists = await connection.getAccountInfo(multisigPda, "confirmed");
  if (!multisigExists) {
    const [programConfigPda] = getProgramConfigPda({});
    const programConfigInfo = await connection.getAccountInfo(programConfigPda, "confirmed");
    if (!programConfigInfo) {
      throw new Error(
        `Squads program config ${programConfigPda.toBase58()} not found on ${RPC_URL}`,
      );
    }
    // ProgramConfig: discriminator(8) + treasury(32) + creation_fee(u64)
    const treasury = new PublicKey(programConfigInfo.data.subarray(8, 40));
    const creationFee = programConfigInfo.data.readBigUInt64LE(40);
    console.log("squads treasury:", treasury.toBase58());
    console.log("squads creation fee:", creationFee.toString(), "lamports");

    const memberList = members.map((m) => ({
      key: m.publicKey,
      permissions: {
        mask:
          squadsTypes.Permission.Initiate |
          squadsTypes.Permission.Vote |
          squadsTypes.Permission.Execute,
      },
    }));

    const createIx = squadsInstructions.multisigCreateV2({
      treasury,
      creator: admin.publicKey,
      multisigPda,
      configAuthority: null, // автономный мультисиг: любые изменения — голосованием
      threshold: THRESHOLD,
      members: memberList,
      timeLock: 0,
      createKey: createKey.publicKey,
      rentCollector: admin.publicKey,
      memo: "MIORY admin",
    });

    const createTx = new Transaction().add(createIx);
    createTx.feePayer = admin.publicKey;
    createTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    createTx.partialSign(admin, createKey);
    const createSig = await connection.sendRawTransaction(createTx.serialize(), {
      preflightCommitment: "confirmed",
    });
    await confirm(connection, createSig);
    console.log("multisig created:", multisigPda.toBase58(), "tx:", createSig);
  } else {
    console.log("multisig already exists:", multisigPda.toBase58());
  }
  state.multisigPda = multisigPda.toBase58();
  saveState(state);

  // --- Новый админ = vault PDA мультисика ----------------------------------
  const [vaultPda] = getVaultPda({ multisigPda, index: 0 });
  console.log("vault PDA (new admin):", vaultPda.toBase58());

  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
  });
  const program = createProgram(provider);
  const { config } = derivePdas(programId());

  // --- Шаг 1: propose_admin от текущего админа ------------------------------
  const readConfig = async () => {
    const data = (await connection.getAccountInfo(config, "confirmed"))!.data;
    return {
      admin: new PublicKey(data.subarray(8, 40)),
      pending: new PublicKey(data.subarray(40, 72)),
    };
  };

  let cfg = await readConfig();
  if (!cfg.pending.equals(vaultPda)) {
    const proposeIx = await (program.methods as any)
      .proposeAdmin(vaultPda)
      .accounts({ config, admin: admin.publicKey })
      .instruction();
    const proposeTx = new Transaction().add(proposeIx);
    proposeTx.feePayer = admin.publicKey;
    proposeTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    proposeTx.partialSign(admin);
    const proposeSig = await connection.sendRawTransaction(proposeTx.serialize(), {
      preflightCommitment: "confirmed",
    });
    await confirm(connection, proposeSig);
    console.log("propose_admin tx:", proposeSig);
    cfg = await readConfig();
  } else {
    console.log("propose_admin already done");
  }

  // --- Шаг 2: vault-транзакция Squads с вызовом accept_admin ----------------
  // Внутреннее сообщение вызывает программу MIORY; подписант в нём — vault
  // PDA (Squads подписывает его через invoke_signed от своего имени).
  const transactionIndex = 1n;
  const [transactionPda] = getTransactionPda({ multisigPda, index: transactionIndex });
  const transactionExists = await connection.getAccountInfo(transactionPda, "confirmed");

  if (!transactionExists) {
    const acceptIx = await (program.methods as any)
      .acceptAdmin()
      .accounts({ config, pendingAdmin: vaultPda })
      .instruction();

    const innerMessage = new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [acceptIx],
    });

    const createVaultTxIx = squadsInstructions.vaultTransactionCreate({
      multisigPda,
      transactionIndex,
      creator: members[0].publicKey,
      rentPayer: admin.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: innerMessage,
      memo: "Accept MIORY admin handover",
    });

    const vaultCreateTx = new Transaction().add(createVaultTxIx);
    vaultCreateTx.feePayer = admin.publicKey;
    vaultCreateTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    vaultCreateTx.partialSign(admin, members[0]);
    const vaultCreateSig = await connection.sendRawTransaction(vaultCreateTx.serialize(), {
      preflightCommitment: "confirmed",
    });
    await confirm(connection, vaultCreateSig);
    console.log("squads vault transaction created, tx:", vaultCreateSig);
  } else {
    console.log("squads vault transaction already exists");
  }

  // --- Шаг 3: предложение ----------------------------------------------------
  const [proposalPda] = getProposalPda({ multisigPda, transactionIndex });
  const proposalExists = await connection.getAccountInfo(proposalPda, "confirmed");
  if (!proposalExists) {
    const proposalCreateIx = squadsInstructions.proposalCreate({
      multisigPda,
      transactionIndex,
      creator: members[0].publicKey,
      rentPayer: admin.publicKey,
      isDraft: false,
    });
    const proposalCreateTx = new Transaction().add(proposalCreateIx);
    proposalCreateTx.feePayer = admin.publicKey;
    proposalCreateTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    proposalCreateTx.partialSign(admin, members[0]);
    const proposalCreateSig = await connection.sendRawTransaction(
      proposalCreateTx.serialize(),
      { preflightCommitment: "confirmed" },
    );
    await confirm(connection, proposalCreateSig);
    console.log("proposal created, tx:", proposalCreateSig);
  } else {
    console.log("proposal already exists");
  }

  // --- Шаг 4: голоса ---------------------------------------------------------
  for (const member of members.slice(0, THRESHOLD)) {
    const approveIx = squadsInstructions.proposalApprove({
      multisigPda,
      transactionIndex,
      member: member.publicKey,
    });
    const approveTx = new Transaction().add(approveIx);
    approveTx.feePayer = admin.publicKey;
    approveTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    approveTx.partialSign(admin, member);
    const approveSig = await connection.sendRawTransaction(approveTx.serialize(), {
      preflightCommitment: "confirmed",
    });
    await confirm(connection, approveSig);
    console.log("approved by", member.publicKey.toBase58(), "tx:", approveSig);
  }

  // --- Шаг 5: исполнение -----------------------------------------------------
  cfg = await readConfig();
  if (cfg.admin.equals(vaultPda)) {
    console.log("handover already executed");
  } else {
    const { instruction: executeIx } = await squadsInstructions.vaultTransactionExecute({
      connection,
      multisigPda,
      transactionIndex,
      member: members[0].publicKey,
    });

    const executeTx = new Transaction().add(executeIx);
    executeTx.feePayer = admin.publicKey;
    executeTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    executeTx.partialSign(admin, members[0]);
    const executeSig = await connection.sendRawTransaction(executeTx.serialize(), {
      preflightCommitment: "confirmed",
    });
    await confirm(connection, executeSig);
    console.log("vault transaction executed, tx:", executeSig);
  }

  // --- Проверка --------------------------------------------------------------
  cfg = await readConfig();
  console.log("---");
  console.log("config.admin      :", cfg.admin.toBase58());
  console.log("config.pending    :", cfg.pending.toBase58());
  console.log(
    "handover complete  :",
    cfg.admin.equals(vaultPda) && cfg.pending.equals(PublicKey.default) ? "YES" : "NO",
  );
  console.log("multisig pda      :", multisigPda.toBase58());
  console.log("vault pda         :", vaultPda.toBase58());
  console.log("proposal pda      :", proposalPda.toBase58());
  console.log("transaction pda   :", transactionPda.toBase58());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
