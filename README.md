# 🃏 MinimaPoker

> Decentralized peer-to-peer Texas Hold'em poker running as a MiniDAPP on the [Minima](https://minima.global) blockchain.

---

## What is it?

MinimaPoker is a fully trustless poker game — no server, no house, no third party. Every player runs the game on their own Minima node. Cards are dealt fairly using a cryptographic commit-reveal scheme, and chips are backed by real Minima tokens locked in off-chain payment channels.

---

## Features

- **Truly decentralized** — P2P messaging via Maxima, no central server
- **Provably fair** — commit-reveal card dealing, no player can manipulate the deck
- **Real stakes** — funds secured by eltoo payment channels (N-of-N multisig)
- **2–4 players** per table
- **No host** — a deterministic enforcer role replaces the host, auto-starts each hand
- **Dispute protection** — any player can trigger an on-chain dispute if a peer goes offline
- **Auto-timeouts** — 30s per turn, 20s per commit/reveal phase

---

## How it works

```
Players connect via Maxima contacts
        │
        ▼
  Create a table (set blinds + buy-in)
        │
        ▼
  Open a payment channel (N-of-N multisig on-chain)
        │
        ▼
  Play hands off-chain (commit → reveal → bet → settle)
        │
        ▼
  Close channel cooperatively or via dispute
```

### Provably Fair Card Dealing

1. Each player generates a secret random hex string and sends its SHA3 hash to all others (**commit**)
2. Each player reveals their secret; the game verifies it matches the hash (**reveal**)
3. All secrets are XOR-combined into a shared seed
4. The 52-card deck is shuffled deterministically — identical result for all players

### Payment Channels (Eltoo)

- Funds are locked in an on-chain N-of-N multisig script
- Every bet that changes chip counts produces a new off-chain state update signed by all players
- The blockchain is only touched to open and close the channel
- If a player disappears, any participant can post a trigger transaction and claim funds after a timeout

---

## Installation

1. Run a [Minima node](https://minima.global/get-started)
2. Open the MiniDAPP Manager
3. Install `MinimaPoker.mds.zip`
4. Add other players as Maxima contacts
5. Create a table and start playing

---

## Game Flow

| Step | Action |
|------|--------|
| 1 | Create or join a table |
| 2 | Click **Create Channel** — funds locked on-chain |
| 3 | Commit phase — each player submits a secret hash |
| 4 | Reveal phase — secrets verified, deck shuffled |
| 5 | Pre-flop → Flop → Turn → River → Showdown |
| 6 | Channel closes cooperatively or via dispute |

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Blockchain | [Minima](https://minima.global) |
| P2P messaging | Maxima |
| Payment channels | Eltoo (N-of-N multisig, KISSVM) |
| JS runtime | Rhino (ES5, service) + Browser (UI) |
| Storage | MDS SQLite |
| Card dealing | Commit-reveal + XOR seed + Fisher-Yates shuffle |

---

## Documentation

- [Game Guide](GAME_GUIDE_EN.md)
- [MDS Commands Reference](MDS_COMMANDS.md)

---

## License

MIT
