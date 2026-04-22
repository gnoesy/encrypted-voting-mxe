import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ConfirmOptions, PublicKey, Transaction } from "@solana/web3.js";
import {
  buildFinalizeCompDefTx,
  getArciumProgram,
  getArciumProgramId,
  getCircuitState,
  getCompDefAccOffset,
  getRawCircuitAccAddress,
} from "@arcium-hq/client";

const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_DEVNET_WS_URL = "wss://api.devnet.solana.com";

const MAX_ACCOUNT_SIZE = 10 * 1024 * 1024;
const MAX_REALLOC_PER_IX = 10240;
const MAX_UPLOAD_PER_TX_BYTES = 814;
const MAX_EMBIGGEN_IX_PER_TX = 18;
const RAW_CIRCUIT_ACCOUNT_OVERHEAD = 9;

type UploadSettings = {
  chunkSize: number;
  maxAttempts: number;
  baseDelayMs: number;
  chunkDelayMs: number;
};

export function configureUploadEnvironment(): UploadSettings {
  process.env.ARCIUM_CLUSTER_OFFSET =
    process.env.ARCIUM_CLUSTER_OFFSET || "456";
  process.env.ANCHOR_PROVIDER_URL =
    process.env.ANCHOR_PROVIDER_URL ||
    process.env.RPC_URL ||
    DEFAULT_DEVNET_RPC_URL;
  process.env.WS_RPC_URL = process.env.WS_RPC_URL || DEFAULT_DEVNET_WS_URL;

  return {
    chunkSize: readPositiveInt(process.env.UPLOAD_CHUNK_SIZE, 4),
    maxAttempts: readPositiveInt(process.env.UPLOAD_MAX_ATTEMPTS, 10),
    baseDelayMs: readPositiveInt(process.env.UPLOAD_RETRY_BASE_MS, 1000),
    chunkDelayMs: readPositiveInt(process.env.UPLOAD_CHUNK_DELAY_MS, 300),
  };
}

export async function safeUploadCircuit(
  provider: anchor.AnchorProvider,
  circuitName: string,
  programId: PublicKey,
  rawCircuit: Uint8Array,
  logging = true,
  confirmOptions?: ConfirmOptions,
  settings = configureUploadEnvironment()
): Promise<string[]> {
  const program = getArciumProgram(provider);
  const compDefOffset = Buffer.from(
    getCompDefAccOffset(circuitName)
  ).readUInt32LE(0);
  const compDefPubkey = PublicKey.findProgramAddressSync(
    [
      Buffer.from("ComputationDefinitionAccount", "utf-8"),
      programId.toBuffer(),
      Buffer.from(getCompDefAccOffset(circuitName)),
    ],
    getArciumProgramId()
  )[0];

  const compDefAcc = await retry(
    () => program.account.computationDefinitionAccount.fetch(compDefPubkey),
    settings,
    `fetch ${circuitName} comp def`
  );
  const state = getCircuitState(compDefAcc.circuitSource as any);
  if (state !== "OnchainPending") {
    optionalLog(logging, `Circuit ${circuitName} skipped: ${state}`);
    return [];
  }

  const numAccs = Math.ceil(
    rawCircuit.length / (MAX_ACCOUNT_SIZE - RAW_CIRCUIT_ACCOUNT_OVERHEAD)
  );
  const sigs: string[] = [];

  for (
    let rawCircuitIndex = 0;
    rawCircuitIndex < numAccs;
    rawCircuitIndex += 1
  ) {
    const rawCircuitPart = rawCircuit.subarray(
      rawCircuitIndex * (MAX_ACCOUNT_SIZE - RAW_CIRCUIT_ACCOUNT_OVERHEAD),
      (rawCircuitIndex + 1) * (MAX_ACCOUNT_SIZE - RAW_CIRCUIT_ACCOUNT_OVERHEAD)
    );
    const partSigs = await uploadToCircuitAccount(
      provider,
      program as Program<any>,
      rawCircuitPart,
      rawCircuitIndex,
      compDefOffset,
      compDefPubkey,
      programId,
      logging,
      confirmOptions,
      settings
    );
    sigs.push(...partSigs);
  }

  const finalizeTx = await buildFinalizeCompDefTx(
    provider,
    compDefOffset,
    programId
  );
  sigs.push(
    await sendTransactionWithFreshBlockhash(
      provider,
      finalizeTx,
      confirmOptions,
      settings,
      `finalize ${circuitName}`
    )
  );
  return sigs;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalLog(enabled: boolean, message: string): void {
  if (enabled) {
    console.log(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || "");
  return /429|too many requests|rate limit/i.test(message);
}

async function retry<T>(
  action: () => Promise<T>,
  settings: UploadSettings,
  label: string
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === settings.maxAttempts) {
        throw error;
      }
      const delay = settings.baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `${label} rate-limited, retrying in ${delay}ms (attempt ${attempt}/${settings.maxAttempts})`
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

async function uploadToCircuitAccount(
  provider: anchor.AnchorProvider,
  program: Program<any>,
  rawCircuitPart: Uint8Array,
  rawCircuitIndex: number,
  compDefOffset: number,
  compDefPubkey: PublicKey,
  programId: PublicKey,
  logging: boolean,
  confirmOptions: ConfirmOptions | undefined,
  settings: UploadSettings
): Promise<string[]> {
  const rawCircuitPda = getRawCircuitAccAddress(compDefPubkey, rawCircuitIndex);
  const existingAcc = await retry(
    () => provider.connection.getAccountInfo(rawCircuitPda),
    settings,
    `getAccountInfo raw circuit ${rawCircuitIndex}`
  );
  const existingCircuitBytes =
    existingAcc !== null
      ? existingAcc.data.subarray(
          RAW_CIRCUIT_ACCOUNT_OVERHEAD,
          Math.min(
            existingAcc.data.length,
            RAW_CIRCUIT_ACCOUNT_OVERHEAD + rawCircuitPart.length
          )
        )
      : null;
  const sigs: string[] = [];

  const requiredAccountSize =
    rawCircuitPart.length + RAW_CIRCUIT_ACCOUNT_OVERHEAD;
  if (existingAcc !== null && existingAcc.data.length >= requiredAccountSize) {
    optionalLog(
      logging,
      `Raw circuit acc ${rawCircuitIndex} already exists with sufficient size, skipping allocation`
    );
  } else {
    if (existingAcc === null) {
      const initTx = await (program.methods as any)
        .initRawCircuitAcc(compDefOffset, programId, rawCircuitIndex)
        .accounts({ signer: provider.publicKey })
        .transaction();
      sigs.push(
        await sendTransactionWithFreshBlockhash(
          provider,
          initTx,
          confirmOptions,
          settings,
          `init raw circuit ${rawCircuitIndex}`
        )
      );
      optionalLog(logging, `Initiated raw circuit acc ${rawCircuitIndex}`);
    }

    if (rawCircuitPart.length > MAX_REALLOC_PER_IX) {
      const resizeTxCount = Math.ceil(
        rawCircuitPart.length / (MAX_REALLOC_PER_IX * MAX_EMBIGGEN_IX_PER_TX)
      );
      for (let resizeIndex = 0; resizeIndex < resizeTxCount; resizeIndex += 1) {
        const resizeTx = await buildResizeTx(
          program,
          provider.publicKey,
          compDefOffset,
          programId,
          rawCircuitIndex,
          MAX_REALLOC_PER_IX +
            resizeIndex * (MAX_REALLOC_PER_IX * MAX_EMBIGGEN_IX_PER_TX),
          rawCircuitPart.length
        );
        sigs.push(
          await sendTransactionWithFreshBlockhash(
            provider,
            resizeTx,
            confirmOptions,
            settings,
            `resize raw circuit ${rawCircuitIndex} tx ${
              resizeIndex + 1
            }/${resizeTxCount}`
          )
        );
      }
    }
  }

  optionalLog(logging, `Uploading raw circuit acc ${rawCircuitIndex}`);
  const uploadTxCount = Math.ceil(
    rawCircuitPart.length / MAX_UPLOAD_PER_TX_BYTES
  );
  for (
    let offsetIndex = 0;
    offsetIndex < uploadTxCount;
    offsetIndex += settings.chunkSize
  ) {
    const currentChunkSize = Math.min(
      settings.chunkSize,
      uploadTxCount - offsetIndex
    );
    const chunkWork: Array<{ circuitOffset: number; bytes: Buffer }> = [];
    for (let chunkIndex = 0; chunkIndex < currentChunkSize; chunkIndex += 1) {
      const circuitOffset =
        MAX_UPLOAD_PER_TX_BYTES * (offsetIndex + chunkIndex);
      const bytes = Buffer.copyBytesFrom(
        rawCircuitPart,
        circuitOffset,
        MAX_UPLOAD_PER_TX_BYTES
      );
      if (
        existingCircuitBytes !== null &&
        existingCircuitBytes.length >= circuitOffset + bytes.length &&
        existingCircuitBytes
          .subarray(circuitOffset, circuitOffset + bytes.length)
          .equals(bytes)
      ) {
        continue;
      }
      chunkWork.push({ circuitOffset, bytes });
    }
    if (chunkWork.length === 0) {
      optionalLog(
        logging,
        `Chunk ${
          Math.floor(offsetIndex / settings.chunkSize) + 1
        } already uploaded for raw circuit ${rawCircuitIndex}, skipping`
      );
      continue;
    }
    const blockInfo = await retry(
      () =>
        provider.connection.getLatestBlockhash({
          commitment: confirmOptions?.commitment || "confirmed",
        }),
      settings,
      `getLatestBlockhash for raw circuit ${rawCircuitIndex} chunk`
    );
    optionalLog(
      logging,
      `Uploading chunk ${
        Math.floor(offsetIndex / settings.chunkSize) + 1
      } of ${Math.ceil(
        uploadTxCount / settings.chunkSize
      )} for raw circuit ${rawCircuitIndex}`
    );
    for (const { circuitOffset, bytes } of chunkWork) {
      const uploadTx = await buildUploadCircuitTx(
        program,
        provider.publicKey,
        compDefOffset,
        programId,
        bytes,
        circuitOffset,
        rawCircuitIndex
      );
      sigs.push(
        await sendTransactionWithKnownBlockhash(
          provider,
          uploadTx,
          blockInfo.blockhash,
          blockInfo.lastValidBlockHeight,
          confirmOptions,
          settings,
          `upload raw circuit ${rawCircuitIndex} bytes ${circuitOffset}`
        )
      );
    }
    if (settings.chunkDelayMs > 0) {
      await sleep(settings.chunkDelayMs);
    }
  }

  return sigs;
}

async function buildResizeTx(
  program: Program<any>,
  signerPubkey: PublicKey,
  compDefOffset: number,
  programId: PublicKey,
  rawCircuitIndex: number,
  currentSize: number,
  requiredSize: number
): Promise<Transaction> {
  const ix = await (program.methods as any)
    .embiggenRawCircuitAcc(compDefOffset, programId, rawCircuitIndex)
    .accounts({ signer: signerPubkey })
    .instruction();

  const resizeSize = Math.min(
    requiredSize - currentSize,
    MAX_EMBIGGEN_IX_PER_TX * MAX_REALLOC_PER_IX
  );
  const ixCount = Math.ceil(resizeSize / MAX_REALLOC_PER_IX);
  const tx = new anchor.web3.Transaction();
  for (let index = 0; index < ixCount; index += 1) {
    tx.add(ix);
  }
  return tx;
}

async function buildUploadCircuitTx(
  program: Program<any>,
  signerPubkey: PublicKey,
  compDefOffset: number,
  programId: PublicKey,
  bytes: Buffer,
  circuitOffset: number,
  rawCircuitIndex: number
): Promise<Transaction> {
  if (bytes.length > MAX_UPLOAD_PER_TX_BYTES) {
    throw new Error(
      `Upload circuit bytes must be ${MAX_UPLOAD_PER_TX_BYTES} bytes or less per tx`
    );
  }

  let bytesInner = bytes;
  if (bytesInner.length < MAX_UPLOAD_PER_TX_BYTES) {
    const paddedBytes = Buffer.allocUnsafe(MAX_UPLOAD_PER_TX_BYTES);
    paddedBytes.set(bytesInner);
    bytesInner = paddedBytes;
  }

  return (program.methods as any)
    .uploadCircuit(
      compDefOffset,
      programId,
      rawCircuitIndex,
      Array.from(bytesInner),
      circuitOffset
    )
    .accounts({ signer: signerPubkey })
    .transaction();
}

async function sendTransactionWithFreshBlockhash(
  provider: anchor.AnchorProvider,
  tx: Transaction,
  confirmOptions: ConfirmOptions | undefined,
  settings: UploadSettings,
  label: string
): Promise<string> {
  const blockInfo = await retry(
    () =>
      provider.connection.getLatestBlockhash({
        commitment: confirmOptions?.commitment || "confirmed",
      }),
    settings,
    `${label} blockhash`
  );
  return sendTransactionWithKnownBlockhash(
    provider,
    tx,
    blockInfo.blockhash,
    blockInfo.lastValidBlockHeight,
    confirmOptions,
    settings,
    label
  );
}

async function sendTransactionWithKnownBlockhash(
  provider: anchor.AnchorProvider,
  tx: Transaction,
  blockhash: string,
  lastValidBlockHeight: number,
  confirmOptions: ConfirmOptions | undefined,
  settings: UploadSettings,
  label: string
): Promise<string> {
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return retry(
    () =>
      provider.sendAndConfirm(
        tx,
        [],
        confirmOptions || { commitment: "confirmed" }
      ),
    settings,
    label
  );
}
