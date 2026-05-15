# stacflipbot

This repository contains a small Solana bot that repeatedly sends the `buy` instruction to the `curve_launchpad` program on mainnet.

## Files

- `bot.mjs` – main bot logic
- `package.json` – Node.js package manifest
- `Dockerfile` – container image definition
- `railway.toml` – Railway deployment config

## Environment variables

### Required

| Variable | Required | Description |
| --- | --- | --- |
| `TARGET_MINT` | Yes | Mint address of the token you want to buy from the bonding curve. |

### Wallet configuration

Provide **one** of the following:

| Variable | Required | Description |
| --- | --- | --- |
| `SECRET_KEY` | Recommended | Base58-encoded Solana secret key bytes. |
| `KEYPAIR_JSON` | Alternative | JSON array containing the 64 secret key bytes. |

### Optional

| Variable | Default | Description |
| --- | --- | --- |
| `RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint. A dedicated provider such as Helius or QuickNode is recommended because public RPC endpoints are often rate-limited. |
| `TOKEN_AMOUNT` | `1` | Minimum amount of tokens to receive per buy attempt. The program requires a value of at least `1`. |
| `MAX_QUOTE_COST_RAW` | none | Maximum quote-token spend per attempt in the quote mint's smallest units. If this is set, it overrides `MAX_QUOTE_UI_AMOUNT`. |
| `MAX_QUOTE_UI_AMOUNT` | `0.1` | Human-readable quote-token amount to spend per attempt. This is converted using the quote mint decimals discovered on-chain. It is not automatically SOL. |
| `INTERVAL_MS` | `60000` | Delay in milliseconds between buy attempts. |
| `PORT` | none | If set, the bot starts a small health server that responds to `GET /` and `GET /health`. Useful for Railway or similar platforms. |

## Notes

- The bot loads environment variables with `dotenv`, so you can place them in a local `.env` file.
- The quote mint is read from the program's global account on-chain.
- If the associated token account balance is below the configured max quote cost, the bot skips that attempt.

## Run locally

```bash
npm install
npm start
```
