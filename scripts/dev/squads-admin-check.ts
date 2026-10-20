/**
 * Проверка, что Squads-мультисиг действительно управляет протоколом:
 * внутри vault-транзакции Squads вызывается админ-инструкция MIORY
 * (`set_transfer_fee`), и она проходит.
 *
 * Транзакция намеренно ставит 0 bps — это ничего не меняет, но доказывает,
 * что новый админ (vault PDA Squads) подписывает админ-вызовы.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   npx tsx scripts/dev/squads-admin-check.ts
 */
import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey, Transaction, TransactionMessage } from "@solana/web3.js";
import { AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
import {
  getMultisigPda,
  getVaultPda,
  getTransactionPda,
  getProposalPda,
  instructions as squadsInstructions,
} from "@sqds/multisig";

const { derivePdas, createProgram, programId } = require("../miory-client");

const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
const WALLET_PATH =
  process.env.ANCHOR_WALLET ??
  `${process.env.USERPROFILE ?? process.env.HOME}/.config/solana/id.json`;
const STATE_PATH = path.join(__dirname, ".squads-state.json");

async function main() {
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"))),
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const members = state.members.map((k: number[]) =>
    Keypair.fromSecretKey(Uint8Array.from(k)),
  );
  const createKey = Keypair.fromSecretKey(Uint8Array.from(state.createKey));
  const [multisigPda] = getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = getVaultPda({ multisigPda, index: 0 });

  const provider = new AnchorProvider(connection, new Wallet(admin), {
    commitment: "confirmed",
  });
  const program = createProgram(provider);
  const { config, authority, mint } = derivePdas(programId());

  // Инструкция вызывается Squads-мультисигом: подписант — vault PDA.
  const setFeeIx = await (program.methods as any)
    // 0 bps при max_fee = 1 base unit: комиссия фактически нулевая, тест
    // проверяет только право управления, а не политику комиссии.
    // Валидатор требует max_fee > 0, поэтому 0 bps нельзя оставить.
    .setTransferFee(0, new BN(1))
    .accounts({ config, admin: vaultPda, authority, mint })
    .instruction();

  const innerMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [setFeeIx],
  });

  // Индекс следующей транзакции мультисига: он растёт на каждую
  // vault-транзакцию, поэтому берём его из аккаунта.
  const multisigAccount = await connection.getAccountInfo(multisigPda, "confirmed");
  const transactionIndex = BigInt(
    multisigAccount!.data.readBigUInt64LE(8 + 32 + 32 + 2 + 4),
  ) + 1n;
  console.log("next squads transaction index:", transactionIndex.toString());

  const createVaultTxIx = squadsInstructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex,
    creator: members[0].publicKey,
    rentPayer: admin.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: innerMessage,
    memo: "Set transfer fee 0 via squads",
  });

  const vaultCreateTx = new Transaction().add(createVaultTxIx);
  vaultCreateTx.feePayer = admin.publicKey;
  vaultCreateTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  vaultCreateTx.partialSign(admin, members[0]);
  const vaultCreateSig = await connection.sendRawTransaction(vaultCreateTx.serialize(), {
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(vaultCreateSig, "confirmed");
  console.log("vault transaction created, tx:", vaultCreateSig);

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
  await connection.confirmTransaction(proposalCreateSig, "confirmed");
  console.log("proposal created, tx:", proposalCreateSig);

  for (const member of members.slice(0, 2)) {
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
    await connection.confirmTransaction(approveSig, "confirmed");
    console.log("approved by", member.publicKey.toBase58());
  }

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
  await connection.confirmTransaction(executeSig, "confirmed");
  console.log("executed, tx:", executeSig);

  const cfg = (await connection.getAccountInfo(config, "confirmed"))!.data;
  console.log("---");
  console.log("config.admin      :", new PublicKey(cfg.subarray(8, 40)).toBase58());
  console.log("transfer_fee_bps  :", cfg.readUInt16LE(8 + 32 + 32 + 32 + 32 + 32 + 1 + 1));
  console.log("proposal pda      :", getProposalPda({ multisigPda, transactionIndex })[0].toBase58());
  console.log("transaction pda   :", getTransactionPda({ multisigPda, index: transactionIndex })[0].toBase58());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
