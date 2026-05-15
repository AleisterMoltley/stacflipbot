/**
 * Repeatedly invokes curve_launchpad `buy` on mainnet (program GpNQ...).
 *
 * IMPORTANT
 * - This address on Solscan is an on-chain PROGRAM, not a wallet. Native SOL transfers
 *   do not “call” it; you interact via instructions (here: `buy`).
 * - Global config uses a SPL quote mint (often Token-2022/LST), not wrapped SOL.
 *   MAX_QUOTE_COST_RAW is in the quote mint’s smallest units (respect decimals).
 *
 * Env
 * - RPC_URL                (default https://api.mainnet-beta.solana.com)
 * - SECRET_KEY             base58-encoded secret key bytes (recommended)
 *   or KEYPAIR_JSON       JSON array of 64 secret key bytes
 * - TARGET_MINT            meme/base mint pubkey you want to buy
 * - TOKEN_AMOUNT           u64 string, minimum tokens to receive (program enforces >= 1)
 * - MAX_QUOTE_COST_RAW     optional u64 string; if unset, MAX_QUOTE_UI_AMOUNT is converted using quote mint decimals
 * - MAX_QUOTE_UI_AMOUNT    human quote spend per attempt (default 0.1), ignored when MAX_QUOTE_COST_RAW is set
 * - INTERVAL_MS            loop delay between attempts (default 60000)
 * - PORT                   optional; if set (Railway injects this), binds GET /health and GET /
 */

import http from "node:http";
import dotenv from "dotenv";
import bs58 from "bs58";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

dotenv.config();

const PROGRAM_ID = new PublicKey("GpNQyoZyi8unNu8dpYGHEqJXCHQy9B8mUFNgBs4sqDSQ");

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

const GLOBAL_DISCRIMINATOR = Buffer.from([167, 232, 232, 177, 200, 108, 114, 127]);

function requireEnv(name, fallback) {
  const v = process.env[name];
  if ((v === undefined || v === "") && fallback !== undefined) return fallback;
  if (v === undefined || v === "") throw new Error(`Missing env ${name}`);
  return v;
}

function optionalEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return v;
}

function uiAmountToRaw(amountStr, decimals) {
  let s = amountStr.trim();
  if (s.startsWith(".")) s = `0${s}`;
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid MAX_QUOTE_UI_AMOUNT (expected digits with optional fraction): ${amountStr}`);
  }
  const [wholePart, fracPart = ""] = s.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  if (fracPart.length > decimals) {
    throw new Error(`MAX_QUOTE_UI_AMOUNT has more than ${decimals} decimal places`);
  }
  const fracPad = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole + fracPad);
}

function maybeStartHealthServer() {
  const portRaw = optionalEnv("PORT");
  if (!portRaw) return;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }
  http
    .createServer((req, res) => {
      if (req.url === "/" || req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    })
    .listen(port, "0.0.0.0", () => {
      console.log(`health ${port}`);
    });
}

function loadWallet() {
  const secretB58 = process.env.SECRET_KEY;
  const json = process.env.KEYPAIR_JSON;
  if (secretB58) return Keypair.fromSecretKey(bs58.decode(secretB58.trim()));
  if (json) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)));
  throw new Error("Set SECRET_KEY (base58) or KEYPAIR_JSON (json array)");
}

function readPubkey(data, offset) {
  return new PublicKey(data.subarray(offset, offset + 32));
}

/**
 * Layout verified against mainnet global account len=185 (may change after upgrades).
 */
function decodeGlobal(data) {
  if (!data.subarray(0, 8).equals(GLOBAL_DISCRIMINATOR)) {
    throw new Error("Global discriminator mismatch");
  }
  if (data.length !== 185) {
    throw new Error(`Unexpected global account length ${data.length}; decode offsets may need updating`);
  }
  return {
    feeRecipient: readPubkey(data, 41),
    quoteMint: readPubkey(data, 153),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchQuoteMintMeta(connection) {
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PROGRAM_ID);
  const globalInfo = await connection.getAccountInfo(global);
  if (!globalInfo) throw new Error("Global account missing");
  const { quoteMint } = decodeGlobal(globalInfo.data);
  const qi = await connection.getAccountInfo(quoteMint);
  if (!qi) throw new Error("quoteMint account missing");
  const mintInfo = await getMint(connection, quoteMint, undefined, qi.owner);
  return { quoteMint, decimals: mintInfo.decimals };
}

async function buildBuyIx({
  connection,
  payer,
  mint,
  tokenAmount,
  maxQuoteCost,
}) {
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PROGRAM_ID);
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    PROGRAM_ID,
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PROGRAM_ID);

  const globalInfo = await connection.getAccountInfo(global);
  if (!globalInfo) throw new Error("Global account missing");
  const { feeRecipient, quoteMint } = decodeGlobal(globalInfo.data);

  const quoteMintInfo = await connection.getAccountInfo(quoteMint);
  if (!quoteMintInfo) throw new Error("quoteMint account missing");
  const quoteTokenProgramId = quoteMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const bondingCurveQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    bondingCurve,
    true,
    quoteTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    mint,
    payer.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const userQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    payer.publicKey,
    false,
    quoteTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const feeRecipientQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    feeRecipient,
    false,
    quoteTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const data = Buffer.alloc(8 + 8 + 8);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(maxQuoteCost, 16);

  const keys = [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: global, isSigner: false, isWritable: false },
    { pubkey: feeRecipient, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: quoteMint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveTokenAccount, isSigner: false, isWritable: true },
    { pubkey: bondingCurveQuoteAccount, isSigner: false, isWritable: true },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: userQuoteAccount, isSigner: false, isWritable: true },
    { pubkey: feeRecipientQuoteAccount, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: quoteTokenProgramId, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    keys,
    programId: PROGRAM_ID,
    data,
  });

  const setupIxs = [];

  const maybeCreateAta = async (ownerPk, mintPk, tokenProgram, ataAddress) => {
    const info = await connection.getAccountInfo(ataAddress);
    if (info) return;
    setupIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        ataAddress,
        ownerPk,
        mintPk,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  };

  await maybeCreateAta(payer.publicKey, mint, TOKEN_PROGRAM_ID, userTokenAccount);
  await maybeCreateAta(payer.publicKey, quoteMint, quoteTokenProgramId, userQuoteAccount);

  return { setupIxs, buyIx: ix, quoteMint, userQuoteAccount };
}

async function main() {
  maybeStartHealthServer();

  const rpc = requireEnv("RPC_URL", "https://api.mainnet-beta.solana.com");
  const connection = new Connection(rpc, "confirmed");
  const payer = loadWallet();
  const mint = new PublicKey(requireEnv("TARGET_MINT"));
  const tokenAmount = BigInt(requireEnv("TOKEN_AMOUNT", "1"));
  const intervalMs = Number(requireEnv("INTERVAL_MS", "60000"));

  if (tokenAmount < 1n) throw new Error("TOKEN_AMOUNT must be >= 1");

  const { quoteMint: quoteMintPk, decimals } = await fetchQuoteMintMeta(connection);
  const rawOverride = optionalEnv("MAX_QUOTE_COST_RAW");
  const uiQuoteAmount = requireEnv("MAX_QUOTE_UI_AMOUNT", "0.1");
  const maxQuoteCost =
    rawOverride !== undefined ? BigInt(rawOverride) : uiAmountToRaw(uiQuoteAmount, decimals);

  console.log(`Wallet ${payer.publicKey.toBase58()}`);
  console.log(`Target mint ${mint.toBase58()}`);
  console.log(`Quote mint ${quoteMintPk.toBase58()} (${decimals} decimals)`);
  console.log(
    `TOKEN_AMOUNT=${tokenAmount.toString()} maxQuoteCostRaw=${maxQuoteCost.toString()}${rawOverride !== undefined ? " (MAX_QUOTE_COST_RAW)" : ` (MAX_QUOTE_UI_AMOUNT=${uiQuoteAmount})`} INTERVAL_MS=${intervalMs}`,
  );

  while (true) {
    try {
      const { setupIxs, buyIx, userQuoteAccount } = await buildBuyIx({
        connection,
        payer,
        mint,
        tokenAmount,
        maxQuoteCost,
      });

      const quoteAcct = await connection.getTokenAccountBalance(userQuoteAccount).catch(() => null);
      const rawBal = quoteAcct?.value?.amount ? BigInt(quoteAcct.value.amount) : 0n;
      if (rawBal < maxQuoteCost) {
        console.warn(
          `[skip] quote ATA balance ${rawBal.toString()} < maxQuoteCostRaw ${maxQuoteCost.toString()} (${userQuoteAccount.toBase58()})`,
        );
      } else {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
        for (const ix of setupIxs) tx.add(ix);
        tx.add(buyIx);
        tx.sign(payer);
        const sig = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        console.log(`sent ${sig}`);
        await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        console.log(`confirmed ${sig}`);
      }
    } catch (err) {
      console.error(err);
    }
    await sleep(intervalMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
