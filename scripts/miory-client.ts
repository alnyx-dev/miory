/**
 * Shared helpers of the MIORY client and the test suite.
 */
import fs from "fs";
import path from "path";
import { Program } from "@coral-xyz/anchor";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * The program id is taken from the IDL: it is the id the program was actually
 * built with, so a rebuild with another keypair does not break the client.
 * `ANCHOR_PROGRAM_ID` overrides it.
 */
export function programId(): PublicKey {
  return new PublicKey(loadIdl().address);
}

export const IDL_PATH = path.join(__dirname, "..", "target", "idl", "miory.json");

/** Loads the IDL that `anchor build` produces. */
export function loadIdl(): any {
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(`IDL not found at ${IDL_PATH}. Run \`anchor build\` first.`);
  }
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  if (process.env.ANCHOR_PROGRAM_ID) {
    idl.address = process.env.ANCHOR_PROGRAM_ID;
  }
  return idl;
}

/** Builds a program client out of the IDL and a provider. */
export function createProgram(provider: any): Program {
  return new Program(loadIdl(), provider) as Program;
}

const seed = (value: string) => Buffer.from(value, "utf8");

/** All the PDAs of the program. */
export function derivePdas(program: PublicKey = programId()) {
  const [authority] = PublicKey.findProgramAddressSync([seed("authority")], program);
  const [config] = PublicKey.findProgramAddressSync([seed("config")], program);
  const [denylist] = PublicKey.findProgramAddressSync([seed("denylist")], program);
  const [mint] = PublicKey.findProgramAddressSync([seed("mint")], program);
  const [extraMetas] = PublicKey.findProgramAddressSync(
    [seed("extra-account-metas"), mint.toBuffer()],
    program,
  );
  return { authority, config, denylist, mint, extraMetas };
}

/**
 * On-chain metadata of a Token-2022 mint, stored in the `TokenMetadata`
 * extension.
 */
export interface OnChainMetadata {
  name: string;
  symbol: string;
  uri: string;
  updateAuthority: string;
  mint: string;
}

const TOKEN_METADATA_EXTENSION = 19;
/**
 * The TLV area of a Token-2022 account starts right after the account type
 * byte: base state (82) + padding + account type (1) = 166.
 */
const TLV_OFFSET = 166;

/** Parses the `TokenMetadata` extension out of the raw mint account data. */
export function parseOnChainMetadata(data: Buffer): OnChainMetadata | null {
  let offset = TLV_OFFSET;
  while (offset + 4 <= data.length) {
    // TLV entry: type (u16) + length (u16) + value
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    const value = data.subarray(offset + 4, offset + 4 + length);
    if (type === TOKEN_METADATA_EXTENSION && value.length >= 68) {
      const updateAuthority = new PublicKey(value.subarray(0, 32));
      const mint = new PublicKey(value.subarray(32, 64));
      const nameLength = value.readUInt32LE(64);
      const name = value.subarray(68, 68 + nameLength).toString("utf8");
      const symbolOffset = 68 + nameLength;
      const symbolLength = value.readUInt32LE(symbolOffset);
      const symbol = value
        .subarray(symbolOffset + 4, symbolOffset + 4 + symbolLength)
        .toString("utf8");
      const uriOffset = symbolOffset + 4 + symbolLength;
      const uriLength = value.readUInt32LE(uriOffset);
      const uri = value.subarray(uriOffset + 4, uriOffset + 4 + uriLength).toString("utf8");
      return {
        name,
        symbol,
        uri,
        updateAuthority: updateAuthority.toBase58(),
        mint: mint.toBase58(),
      };
    }
    offset += 4 + length;
  }
  return null;
}

/**
 * `TransferChecked` with the extra accounts the token program needs in order
 * to resolve and forward the transfer hook accounts.
 *
 * The SPL SDK does not expose a builder with extra accounts, so the
 * instruction is assembled by hand: `TokenInstruction.TransferChecked` (12),
 * `amount` (u64) and `decimals` (u8).
 */
export function transferCheckedWithExtraAccounts(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: BNLike,
  decimals: number,
  extraAccounts: PublicKey[],
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amount.toString()), 1);
  data.writeUInt8(decimals, 9);

  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      ...extraAccounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    ],
    data,
  });
}

type BNLike = { toString(): string };
