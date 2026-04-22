import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  getMXEAccAddress,
  getLookupTableAddress,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { configureUploadEnvironment, safeUploadCircuit } from "./upload_utils";

async function main() {
  const uploadSettings = configureUploadEnvironment();

  const conn = new anchor.web3.Connection(process.env.ANCHOR_PROVIDER_URL, {
    commitment: "confirmed",
    wsEndpoint: process.env.WS_RPC_URL,
  });
  const owner = Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(
        fs.readFileSync(`${os.homedir()}/.config/solana/devnet.json`).toString()
      )
    )
  );
  const wallet = new anchor.Wallet(owner);
  const provider = new anchor.AnchorProvider(conn, wallet, {
    commitment: "confirmed",
    skipPreflight: true,
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync("target/idl/encrypted_voting.json", "utf-8")
  );
  const program = new anchor.Program(idl, provider) as Program<any>;
  const arciumProgram = getArciumProgram(provider);

  console.log("Program ID:", program.programId.toString());

  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount"
  );
  const offset = getCompDefAccOffset("aggregate_bids_v2");

  const compDefPDA = PublicKey.findProgramAddressSync(
    [
      Buffer.from(baseSeedCompDefAcc),
      program.programId.toBuffer(),
      Buffer.from(offset),
    ],
    getArciumProgramId() as PublicKey
  )[0];

  console.log("Comp def PDA:", compDefPDA.toString());

  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(
    program.programId,
    mxeAcc.lutOffsetSlot
  );

  try {
    const initBuilder: any = (
      program.methods as any
    ).initAggregateBidsV2CompDef();
    initBuilder.accounts({
      compDefAccount: compDefPDA,
      payer: owner.publicKey,
      mxeAccount,
      addressLookupTable: lutAddress,
    });
    const sig = await initBuilder
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("init_aggregate_bids_v2_comp_def sig:", sig);
  } catch (e: any) {
    console.log("Comp def already exists or error:", e.message || String(e));
  }

  console.log("Uploading circuit...");
  const rawCircuit = fs.readFileSync("build/aggregate_bids_v2.arcis");
  await safeUploadCircuit(
    provider,
    "aggregate_bids_v2",
    program.programId,
    rawCircuit,
    true,
    {
      skipPreflight: true,
      preflightCommitment: "confirmed",
      commitment: "confirmed",
    },
    uploadSettings
  );
  console.log("Circuit uploaded!");
}

main().catch((e) => {
  console.error("Fatal:", e.message || String(e));
  process.exit(1);
});
