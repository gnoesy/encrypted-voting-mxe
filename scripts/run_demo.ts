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
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  x25519,
} from "@arcium-hq/client";

const PROGRAM_ID = new PublicKey(
  "GQZv1j3V2sHsZsipyiN9yf6iVYKbBYQLfsWAo87ggVrj"
);
const LEGACY_PROGRAM_ID = "FoCgMmXj37JaMcbYrAnBDCWaaQE6FYzEBzMuAkXBZ7XF";
const EVIDENCE_PATH = path.join(__dirname, "../evidence/mxe_runs.jsonl");
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_WS_URL = "wss://api.devnet.solana.com";

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...data, ts: new Date().toISOString() }));
}

function appendEvidence(event: string, data: Record<string, unknown> = {}) {
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.appendFileSync(
    EVIDENCE_PATH,
    `${JSON.stringify({ event, ...data, ts: new Date().toISOString() })}\n`
  );
}

function deriveWsUrl(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) {
    return `wss://${httpUrl.slice("https://".length)}`;
  }
  if (httpUrl.startsWith("http://")) {
    return `ws://${httpUrl.slice("http://".length)}`;
  }
  return DEFAULT_WS_URL;
}

async function withRpcRetry<T>(fn: () => Promise<T>, retries = 8): Promise<T> {
  let delayMs = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const message = error?.message || String(error);
      if (attempt >= retries || !message.includes("429")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}

async function confirmSignatureByPolling(
  connection: anchor.web3.Connection,
  signature: string,
  lastValidBlockHeight: number,
  commitment: anchor.web3.Commitment
): Promise<void> {
  for (;;) {
    const [{ value: status }, currentBlockHeight] = await Promise.all([
      withRpcRetry(() => connection.getSignatureStatuses([signature])),
      withRpcRetry(() => connection.getBlockHeight(commitment)),
    ]);

    const sigStatus = status[0];
    if (sigStatus?.err) {
      throw new Error(
        `Signature ${signature} failed: ${JSON.stringify(sigStatus.err)}`
      );
    }
    if (
      sigStatus &&
      (sigStatus.confirmationStatus === "confirmed" ||
        sigStatus.confirmationStatus === "finalized")
    ) {
      return;
    }
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new Error(
        `Signature ${signature} has expired: block height exceeded.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function sendAndConfirmCompat(
  provider: anchor.AnchorProvider,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Signer[] = [],
  opts: anchor.web3.ConfirmOptions = {}
): Promise<string> {
  const commitment = opts.commitment || opts.preflightCommitment || "confirmed";
  const latest = await withRpcRetry(() =>
    provider.connection.getLatestBlockhash({ commitment })
  );

  tx.feePayer ||= provider.publicKey;
  tx.recentBlockhash ||= latest.blockhash;
  tx.lastValidBlockHeight ||= latest.lastValidBlockHeight;

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  const signed = await provider.wallet.signTransaction(tx);
  const sig = await withRpcRetry(() =>
    provider.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: opts.skipPreflight,
      preflightCommitment: opts.preflightCommitment || commitment,
      maxRetries: opts.maxRetries,
    })
  );

  await withRpcRetry(() =>
    confirmSignatureByPolling(
      provider.connection,
      sig,
      tx.lastValidBlockHeight!,
      commitment
    )
  );

  return sig;
}

async function getMxePublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  retries = 5,
  delayMs = 1000
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const key = await getMXEPublicKey(provider, programId);
    if (key) {
      return key;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `MXE public key unavailable for program ${programId.toString()}`
  );
}

function asBytes(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

async function awaitSumEvent(
  program: anchor.Program<any>,
  timeoutMs = 120000
): Promise<{ sum: Uint8Array; nonce: Uint8Array }> {
  let listenerId: number | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    const event = await new Promise<any>((resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("Timed out waiting for sumEvent")),
        timeoutMs
      );
      try {
        listenerId = program.addEventListener("sumEvent", (payload: any) =>
          resolve(payload)
        );
      } catch (error) {
        reject(error);
      }
    });

    return {
      sum: asBytes(event.sum),
      nonce: asBytes(event.nonce),
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (listenerId !== undefined) {
      await program.removeEventListener(listenerId);
    }
  }
}

async function main() {
  process.env.ARCIUM_CLUSTER_OFFSET = "456";
  process.env.ANCHOR_PROVIDER_URL =
    process.env.ANCHOR_PROVIDER_URL || process.env.RPC_URL || DEFAULT_RPC_URL;
  process.env.WS_RPC_URL =
    process.env.WS_RPC_URL || deriveWsUrl(process.env.ANCHOR_PROVIDER_URL);

  const walletPath =
    process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/devnet.json`;
  const conn = new anchor.web3.Connection(process.env.ANCHOR_PROVIDER_URL, {
    commitment: "confirmed",
    wsEndpoint: process.env.WS_RPC_URL,
  });
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath).toString()))
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
    commitment: "confirmed",
    skipPreflight: true,
  });
  provider.sendAndConfirm = (
    tx: anchor.web3.Transaction,
    signers?: anchor.web3.Signer[],
    opts?: anchor.web3.ConfirmOptions
  ) => sendAndConfirmCompat(provider, tx, signers || [], opts || {});
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../target/idl/encrypted_voting.json"),
      "utf-8"
    )
  );
  const program = new anchor.Program(idl, provider) as anchor.Program<any>;
  const arciumEnv = getArciumEnv();

  log("demo_start", {
    program: PROGRAM_ID.toString(),
    legacyProgram: LEGACY_PROGRAM_ID,
    wallet: owner.publicKey.toString(),
    description:
      "Sealed-bid auction — encrypted bids aggregated in MXE without revealing individual values",
  });
  appendEvidence("demo_start", {
    stage: "fresh_456_cutover",
    program: PROGRAM_ID.toString(),
    legacyProgram: LEGACY_PROGRAM_ID,
    cluster: 456,
    status: "active",
  });

  const privKey = x25519.utils.randomSecretKey();
  const pubKey = x25519.getPublicKey(privKey);
  const mxePubKey = await getMxePublicKeyWithRetry(provider, PROGRAM_ID);

  // Two sealed bids
  const bid1 = Math.floor(Math.random() * 100) + 50; // 50-150
  const bid2 = Math.floor(Math.random() * 100) + 50;
  log("bids_sealed", {
    bid1: "encrypted",
    bid2: "encrypted",
    note: "Actual values hidden until MXE reveals winner",
  });

  const nonce = randomBytes(16);
  const sharedSecret = x25519.getSharedSecret(privKey, mxePubKey);
  const cipher = new RescueCipher(sharedSecret);
  const ciphertext = cipher.encrypt([BigInt(bid1), BigInt(bid2)], nonce);
  // Start listening before queueing, but do not block the submission path.
  const sumEventPromise = awaitSumEvent(program);

  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const clusterOffset = arciumEnv.arciumClusterOffset;

  try {
    const sig = await program.methods
      .aggregateBidsV2(
        computationOffset,
        ciphertext[0],
        ciphertext[1],
        Array.from(pubKey),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        payer: owner.publicKey,
        mxeAccount: getMXEAccAddress(PROGRAM_ID),
        mempoolAccount: getMempoolAccAddress(clusterOffset),
        executingPool: getExecutingPoolAccAddress(clusterOffset),
        computationAccount: getComputationAccAddress(
          clusterOffset,
          computationOffset
        ),
        compDefAccount: getCompDefAccAddress(
          PROGRAM_ID,
          Buffer.from(getCompDefAccOffset("aggregate_bids_v2")).readUInt32LE()
        ),
        clusterAccount: getClusterAccAddress(clusterOffset),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    log("bid_queued", {
      sig,
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      note: "Sealed bids queued in MXE cluster 456 for private aggregation",
    });
    appendEvidence("bid_queued", {
      stage: "meaningful",
      program: PROGRAM_ID.toString(),
      legacyProgram: LEGACY_PROGRAM_ID,
      cluster: 456,
      status: "ok",
      tx_hash: sig,
      note: "Fresh 456 queue proof after legacy 69420 cutover",
    });

    const finalizeSig = await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      computationOffset,
      PROGRAM_ID,
      "confirmed"
    );
    log("bid_finalized", {
      queueSig: sig,
      finalizeSig,
      note: "MXE finalization confirmed on cluster 456",
    });

    let sumEvent;
    try {
      sumEvent = await sumEventPromise;
    } catch (error: any) {
      const message = error?.message || String(error);
      log("bid_callback_pending", {
        queueSig: sig,
        finalizeSig,
        message,
        note: "Finalize succeeded but callback event was not observed before timeout",
      });
      appendEvidence("bid_callback_pending", {
        stage: "meaningful",
        program: PROGRAM_ID.toString(),
        legacyProgram: LEGACY_PROGRAM_ID,
        cluster: 456,
        status: "pending",
        tx_hash: sig,
        finalize_tx_hash: finalizeSig,
        message,
      });
      return;
    }

    const decrypted = Number(
      cipher.decrypt(
        [Array.from(sumEvent.sum)],
        Uint8Array.from(sumEvent.nonce)
      )[0]
    );
    const expectedTotal = bid1 + bid2;

    log("bid_callback_verified", {
      queueSig: sig,
      finalizeSig,
      expectedTotal,
      decryptedTotal: decrypted,
      verified: decrypted === expectedTotal,
      note: "Queue, finalization, and callback event all verified on cluster 456",
    });
    appendEvidence("bid_callback_verified", {
      stage: "meaningful",
      program: PROGRAM_ID.toString(),
      legacyProgram: LEGACY_PROGRAM_ID,
      cluster: 456,
      status: decrypted === expectedTotal ? "ok" : "mismatch",
      tx_hash: sig,
      finalize_tx_hash: finalizeSig,
      expected_total: expectedTotal,
      decrypted_total: decrypted,
    });

    if (decrypted !== expectedTotal) {
      throw new Error(
        `Callback verification mismatch: expected ${expectedTotal}, received ${decrypted}`
      );
    }
  } catch (e: any) {
    log("bid_fail", {
      message: e.message || String(e),
      raw: JSON.stringify(e),
    });
    appendEvidence("bid_fail", {
      stage: "meaningful",
      program: PROGRAM_ID.toString(),
      legacyProgram: LEGACY_PROGRAM_ID,
      cluster: 456,
      status: "error",
      message: e.message || String(e),
    });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ event: "fatal", message: e.message }));
  process.exit(1);
});
