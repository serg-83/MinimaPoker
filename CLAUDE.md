# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MinimaPoker is a decentralized peer-to-peer Texas Hold'em poker game running as a MiniDAPP on the Minima blockchain. There is no central server — all game logic is distributed across participants using Maxima P2P messaging, with eltoo payment channels for secure off-chain betting.

**Author:** SeregaKi | **Version:** 1.0.0 | **Language:** Mixed Russian/English comments

## Build & Deployment

There is no build system (no npm, webpack, or transpilation). All JavaScript is ES5 and served directly as static files.

- **Install as MiniDAPP:** Package the project root as a `.mds.zip` and install via the Minima node's MiniDAPP hub
- **MDS permissions:** Requires `write` access (configured in `dapp.conf`)
- **No tests exist** — testing is done manually through the MDS debugging console on a running Minima node

## Architecture

### Runtime Contexts

Code runs in **two distinct contexts** — this is critical to understand:

1. **Browser context** — `index.html` (lobby) and `table.html` (poker table) run in a webview with DOM/jQuery access
2. **Service context** — `service.js` runs in Java's Rhino engine (headless, no DOM) as a persistent background service managing eltoo channels and processing incoming Maxima messages

Both contexts share the same JS modules loaded via `MDS.load()` (service) or `<script>` tags (browser). Code must be ES5-compatible for Rhino.

### Module Responsibilities

| Module | Role |
|--------|------|
| `service.js` | Background service: eltoo channel lifecycle, dispute resolution, incoming message routing |
| `poker.js` | Game engine: hand evaluation, betting rounds, commit-reveal dealing, pot distribution |
| `channel.js` | Eltoo payment channels: multi-party funding, state updates, settlement scripts (KISSVM) |
| `table.js` | Poker table UI: seat rendering, action buttons, game state display |
| `lobby.js` | Lobby UI: table creation/joining, contact management, channel negotiation |
| `sql.js` | SQLite persistence via `MDS.sql()`: tables, channels, players, game state |
| `maxima.js` | P2P messaging with ACK/SYNACK reliability layer |
| `crypto.js` | SHA-256 commit-reveal for fair deck shuffling, distributed randomness |
| `wallet.js` | Balance queries and transaction signing via `MDS.cmd()` |
| `utils.js` | Hex/string conversion, ID generation, helper functions |
| `mds.js` | MDS (Minima DApp Service) API wrapper — provided by Minima, do not modify |
| `decimal.js` | Bundled Decimal.js library for arbitrary-precision arithmetic — do not modify |

### Data Flow

```
Player Action → poker.js (game logic) → maxima.js (broadcast to peers)
                                       → channel.js (state update via eltoo)
                                       → sql.js (persist to SQLite)

Incoming Message → service.js (route by message type)
                 → channel.js (update channel state)
                 → poker.js (update game state)
                 → notify frontend via MDS.comms
```

### Message Protocol

Game messages (`TABLE_CREATE`, `TABLE_JOIN`, `GAME_START`, `COMMIT`, `REVEAL`, etc.) flow through Maxima P2P. Channel messages (`REQUEST_NEW_CHANNEL`, `CREATE_CHANNEL`, `SEND_FUNDS`, `DISPUTE`, etc.) handle the eltoo payment lifecycle. All messages use ACK/SYNACK for reliability.

### Key Design Decisions

- **ES5 only** — no Promises, arrow functions, let/const, or template literals (Rhino compatibility)
- **Callback-based async** — all MDS operations use nested callbacks
- **In-memory caching** with debounced DB writes to reduce I/O during active gameplay
- **Commit-reveal protocol** — players commit SHA-256 hashes before revealing secrets to ensure fair dealing
- **N-of-N multisig** funding scripts for payment channels using KISSVM

### Database Tables (SQLite via MDS)

Managed by `sql.js`: `tables`, `channels`, `players`, `game_state`, `logs`. Schema is created on first run via `sql.createDB()`.

## Key Conventions

- All monetary values use `Decimal` (from decimal.js), never native floats
- Eltoo constants: `MIN_UPDATE_COINAGE = 5`, `MIN_SETTLE_COINAGE = 30` (block maturity)
- Player identification uses Maxima public keys (`0x...` hex strings)
- Table IDs and channel IDs are hex-encoded random values from `utils.generateId()`
- UI uses jQuery for DOM manipulation with a casino-themed CSS design
