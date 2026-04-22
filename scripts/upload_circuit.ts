import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
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
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
    commitment: "confirmed",
    skipPreflight: true,
  });
  const idl = JSON.parse(
    fs.readFileSync("target/idl/encrypted_voting.json", "utf-8")
  );
  const program = new anchor.Program(idl, provider) as anchor.Program<any>;

  console.log(
    "Uploading aggregate_bids_v2 circuit (encrypted_voting) to cluster 456..."
  );
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
  console.error("Error:", e.message || String(e));
  process.exit(1);
});
