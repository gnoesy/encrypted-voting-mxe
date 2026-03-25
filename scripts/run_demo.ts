/**
 * encrypted-voting-mxe demo
 * Sealed-bid style voting — bids submitted encrypted, MXE aggregates
 *
 * Usage:
 *   ANCHOR_WALLET=~/.config/solana/devnet.json npx ts-node --transpile-only scripts/run_demo.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getArciumEnv,
  getCompDefAccOffset,
  RescueCipher,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  x25519,
} from "@arcium-hq/client";

const PROGRAM_ID = new PublicKey("FoCgMmXj37JaMcbYrAnBDCWaaQE6FYzEBzMuAkXBZ7XF");

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
}

async function main() {
  process.env.ARCIUM_CLUSTER_OFFSET = "456";

  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/devnet.json`;
  const conn = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath).toString()))
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
    commitment: "confirmed", skipPreflight: true,
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/encrypted_voting.json"), "utf-8"));
  const program = new anchor.Program(idl, provider) as anchor.Program<any>;
  const arciumEnv = getArciumEnv();

  log("demo_start", {
    program: PROGRAM_ID.toString(),
    wallet: owner.publicKey.toString(),
    description: "Sealed-bid auction — encrypted bids aggregated in MXE without revealing individual values",
  });

  const privKey = x25519.utils.randomPrivateKey();
  const pubKey = x25519.getPublicKey(privKey);
  const mxePubKey = await getMXEPublicKey(conn, arciumEnv.arciumClusterOffset);

  // Two sealed bids
  const bid1 = Math.floor(Math.random() * 100) + 50;  // 50-150
  const bid2 = Math.floor(Math.random() * 100) + 50;
  log("bids_sealed", {
    bid1: "encrypted",
    bid2: "encrypted",
    note: "Actual values hidden until MXE reveals winner",
  });

  const nonce = BigInt("0x" + randomBytes(16).toString("hex"));
  const sharedSecret = x25519.getSharedSecret(privKey, mxePubKey);
  const cipher = new RescueCipher(sharedSecret);
  const enc_bid1 = cipher.encrypt([BigInt(bid1)], nonce);
  const enc_bid2 = cipher.encrypt([BigInt(bid2)], nonce + 1n);

  const computationOffset = BigInt("0x" + randomBytes(8).toString("hex"));
  const clusterOffset = arciumEnv.arciumClusterOffset;

  try {
    const sig = await program.methods
      .addTogether(
        computationOffset,
        Array.from(enc_bid1[0]),
        Array.from(enc_bid2[0]),
        Array.from(pubKey),
        nonce
      )
      .accountsPartial({
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(PROGRAM_ID),
        mempoolAccount: getMempoolAccAddress(clusterOffset),
        executingPool: getExecutingPoolAccAddress(clusterOffset),
        computationAccount: getComputationAccAddress(clusterOffset, computationOffset),
        compDefAccount: getCompDefAccAddress(
          PROGRAM_ID,
          Buffer.from(getCompDefAccOffset("add_together")).readUInt32LE()
        ),
        clusterAccount: getClusterAccAddress(clusterOffset),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    log("bid_queued", {
      sig,
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      note: "Sealed bids queued in MXE cluster 456 for private aggregation",
    });
  } catch (e: any) {
    log("bid_fail", { message: e.message || String(e), raw: JSON.stringify(e) });
    process.exit(1);
  }
}

main().catch(e => {
  console.error(JSON.stringify({ event: "fatal", message: e.message }));
  process.exit(1);
});
