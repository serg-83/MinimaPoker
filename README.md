# 🃏 Minima Poker

> Decentralized Texas Hold'em on the [Minima](https://minima.global) blockchain — trustless, peer-to-peer, with off-chain payment channels.

---

## How It Works

### Off-Chain Payment Channels (eltoo)
All bets happen **off-chain** using eltoo-style payment channels built on Minima's scripting layer:

1. **Open** — Two players lock funds into a shared on-chain UTXO (the channel). A funding transaction is co-signed by both parties.
2. **Play** — Every bet, call, raise or fold updates the channel state off-chain. Each update is a signed settlement transaction that supersedes the previous one.
3. **Close (Cooperative)** — Both players agree on the final balance and broadcast the latest settlement. Funds are released instantly.
4. **Close (Dispute)** — If one party is unresponsive, the other triggers the channel on-chain. After a timelock (~30 blocks), the latest valid settlement is enforced automatically.

No third party, no escrow, no trust required.

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
  channel.js    — Payment channel: open / update / trigger / settle / dispute
  poker.js      — Texas Hold'em game logic (blinds, betting rounds, showdown)
  table.js      — Table UI rendering (seats, cards, pot, channel status)
  maxima.js     — Maxima send/receive wrapper
  sql.js        — Local SQLite DB (tables, players, channel state)
  modal.js      — UI modals (alert / confirm / prompt / choice)
  wallet.js     — Balance, keys, coin management
app/css/
  style.css     — All styles (table, lobby, splash, modals)
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
   |── CLOSE_REQUEST ─────────────────►  |
   |◄─ CLOSE_CONFIRM (final settle) ───  |
   |   [settlement broadcast]            |
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Blockchain | [Minima](https://minima.global) |
| P2P Messaging | Maxima |
| Payment Channels | eltoo (update + trigger + settlement scripts) |
| Frontend | Vanilla JS (ES5, Rhino-compatible) |
| Storage | Minima SQLite (MDS) |
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
