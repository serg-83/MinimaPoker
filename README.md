# 🃏 Minima Poker

> Decentralized Texas Hold'em on the [Minima](https://minima.global) blockchain — trustless, peer-to-peer, with off-chain payment channels.

---

## How It Works

### One-Shot Games with Payment Channels
Simple, fast poker games using eltoo-style payment channels built on Minima's scripting layer:

1. **Open** — Two players lock funds into a shared on-chain UTXO (the channel). A funding transaction is co-signed by both parties.
2. **Play** — Every bet, call, raise or fold updates the channel state off-chain. Each update is a signed settlement transaction that supersedes the previous one.
3. **Auto-Close** — After showdown, the channel automatically closes and funds are distributed. Players return to lobby for the next game.
4. **Independent Close** — If needed, either player can close the channel independently without waiting for opponent agreement.

No third party, no escrow, no trust required. Each game is self-contained — play once, settle, start fresh.

### Card Privacy
Cards are **never stored on-chain or in the database**. Each player commits a random seed at game start. After the hand, seeds are revealed and combined — the full deck is deterministically derived client-side using `combineSeeds` + `seededShuffle`. Your hole cards are visible only to you.

### Peer-to-Peer Messaging
Game state (actions, seeds, channel updates) is exchanged directly between players via **Maxima** — Minima's encrypted P2P messaging layer. No central server, no relay.

---

## Architecture

```
index.html      — Splash screen: checks node, write permission, Maxima status
lobby.html      — Main lobby: create table, browse tables, manage contacts
table.html      — Poker table: game UI, channel status, betting controls
service.js      — Background service (Rhino/ES5): handles all Maxima messages,
                  channel state machine, game logic coordination
app/js/
  channel.js    — Payment channel: open / update / close / independent close
  poker.js      — Texas Hold'em game logic (blinds, betting rounds, showdown)
  table.js      — Table UI rendering (seats, cards, pot, channel status)
  lobby.js      — Lobby UI logic (table list, create/join/delete tables)
  maxima.js     — Maxima send/receive wrapper
  mds.js        — MDS (Minima Data Service) API wrapper
  sql.js        — Local SQLite DB (tables, players, channel state)
  modal.js      — UI modals (alert / confirm / prompt / choice)
  wallet.js     — Balance, keys, coin management
  crypto.js     — Cryptographic functions (hashing, signatures, seeds)
  decimal.js    — Arbitrary-precision decimal arithmetic library
  utils.js      — Utilities (ID generation, shuffling, validation)
  tooltips.js   — UI tooltips and help text
app/css/
  style.css     — Global styles (lobby, splash, modals)
  table.css     — Poker table specific styles
```

---

## Payment Channel Flow

```
Player A                              Player B
   |                                     |
   |── CREATE TABLE ──────────────────►  |
   |◄─ JOIN TABLE ──────────────────────  |
   |                                     |
   |── CHANNEL_OPEN (funding tx) ──────► |
   |◄─ CHANNEL_OPEN (co-signed) ────────  |
   |   [channel OPEN on-chain]           |
   |                                     |
   |  ←── game actions (Maxima) ──►      |
   |  ←── signed settlements    ──►      |
   |                                     |
   |   [showdown completed]              |
   |   [auto-close channel]              |
   |   [return to lobby]                 |
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Blockchain | [Minima](https://minima.global) |
| P2P Messaging | Maxima |
| Payment Channels | eltoo (update + trigger + settlement scripts) |
| Frontend | Vanilla JS (ES5, Rhino-compatible) |
| Storage | H2 (via MDS) |
| Runtime | MiniDApp (MiniHub) |

---

## Installation

1. Download `MinimaPoker.zip`
2. Open **MiniHub** on your Minima node
3. Install the `.zip` as a MiniDApp
4. Grant **write permission** when prompted
5. Add contacts via Maxima address and start a table

---

## License

MIT
