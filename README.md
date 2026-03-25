# encrypted-voting-mxe — Sealed-Bid Voting on Arcium

> Sealed bids submitted as ciphertexts, aggregated inside Arcium MXE. No participant sees another's bid until the MXE reveals the outcome.

[![Solana Devnet](https://img.shields.io/badge/Solana-devnet-9945FF)](https://explorer.solana.com/address/FoCgMmXj37JaMcbYrAnBDCWaaQE6FYzEBzMuAkXBZ7XF?cluster=devnet)
[![Arcium MXE](https://img.shields.io/badge/Arcium-MXE%20cluster%20456-00D4FF)](https://arcium.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.32.1-orange)](https://anchor-lang.com)
[![arcium-client](https://img.shields.io/badge/arcium--client-0.9.3-blue)](https://www.npmjs.com/package/@arcium-hq/client)

---

## Deployed Program

| Network | Program ID |
|---|---|
| **Solana Devnet** | [`FoCgMmXj37JaMcbYrAnBDCWaaQE6FYzEBzMuAkXBZ7XF`](https://explorer.solana.com/address/FoCgMmXj37JaMcbYrAnBDCWaaQE6FYzEBzMuAkXBZ7XF?cluster=devnet) |
| MXE Cluster | offset `456` (Arcium devnet) |

---

## What It Does

Sealed-bid auction style computation: two encrypted bid values are submitted, the MXE aggregates them privately, and returns the encrypted result. Extends naturally to full winner-determination logic.

```
Bidder A: encrypt(bid_a) — sealed, MXE pubkey only
Bidder B: encrypt(bid_b) — sealed, MXE pubkey only
        │
        ▼
Solana: add_together instruction
        │  encrypted bids queued for cluster 456
        ▼
Arcium MXE
        │  aggregates bids inside encrypted execution environment
        ▼
Solana: callback
        │  emits SumEvent with encrypted aggregate
        ▼
Auctioneer decrypts → determines winner
```

---

## Quick Start

```bash
git clone https://github.com/gnoesy/encrypted-voting-mxe
cd encrypted-voting-mxe
yarn install

ANCHOR_WALLET=~/.config/solana/devnet.json \
npx ts-node --transpile-only scripts/run_demo.ts
```

Expected output:
```json
{"event":"demo_start","description":"Sealed-bid auction — encrypted bids aggregated in MXE"}
{"event":"bids_sealed","bid1":"encrypted","bid2":"encrypted"}
{"event":"bid_queued","sig":"...","explorer":"https://explorer.solana.com/tx/...?cluster=devnet"}
```

---

## On-chain Instructions

| Instruction | Description |
|---|---|
| `init_add_together_comp_def` | Register computation definition (run once) |
| `add_together` | Queue sealed-bid computation with two ciphertexts |
| `add_together_callback` | MXE callback — emits encrypted aggregate result |

---

## Project Structure

```
encrypted-voting-mxe/
├── programs/encrypted_voting/src/lib.rs  # Solana program
├── encrypted-ixs/src/lib.rs              # ARCIS aggregation circuit
├── scripts/
│   └── run_demo.ts                       # Demo: submit sealed bids
├── build/
│   └── add_together.arcis                # Compiled ARCIS circuit
├── Anchor.toml
└── Arcium.toml                           # cluster offset: 456
```

---

## Related MXE Programs

| Program | Program ID |
|---|---|
| [hello-world-mxe](https://github.com/gnoesy/hello-world-mxe) | `3TysCyYXyWpqNXDnQiwA4C2KiMSxGmBbTJADtGwFVeLr` |
| [encrypted-defi-mxe](https://github.com/gnoesy/encrypted-defi-mxe) | `AmzMmGcKUqMWf57WPXhHBkE9QzrbXCc1emFK6hsVJTj7` |
| [private-voting-mxe](https://github.com/gnoesy/private-voting-mxe) | `S43YKqU6x229PdY5oUssPoD2UgH4EDUvugYos6WxvDY` |
| [encrypted-identity-mxe](https://github.com/gnoesy/encrypted-identity-mxe) | `3zYA4ykzGofqeH6m6aET46AQNgBVtEa2XotAVX6TXgBV` |

---

## Devnet Explorer

- [Program](https://explorer.solana.com/address/FoCgMmXj37JaMcbYrAnBDCWaaQE6FYzEBzMuAkXBZ7XF?cluster=devnet)
- [Deployer](https://explorer.solana.com/address/4Y8R73V9QpmL2oUtS4LrwdZk3LrPRCLp7KGg2npPkB1u?cluster=devnet)
