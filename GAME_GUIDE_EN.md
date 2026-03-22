# MinimaPoker — Game Guide

## Overview

MinimaPoker is a decentralized peer-to-peer Texas Hold'em poker game running as a MiniDAPP on the Minima blockchain. There is no central server — all game logic runs between players directly via the Maxima P2P messaging layer. Funds are secured by off-chain payment channels (eltoo protocol), so real Minima tokens are at stake without trusting any third party.

---

## Core Principles

### Decentralization
- No server, no house. Every player runs the game on their own Minima node.
- All messages are sent peer-to-peer via Maxima with application name `MinimaPoker`.
- The blockchain is only touched when opening or closing a payment channel.

### Provably Fair Card Dealing (Commit-Reveal)
Cards are dealt using a cryptographic commit-reveal scheme:

1. **Commit phase** — each player generates a secret 64-character hex string, hashes it (SHA3), and sends the hash to all others.
2. **Reveal phase** — each player reveals their secret. The game verifies it matches the committed hash.
3. **Seed combination** — all secrets are XOR-combined into a single shared seed.
4. **Shuffle** — the 52-card deck is shuffled deterministically from that seed. The result is identical for all players.

The dealer position is also derived from the seed: `parseInt(seed.substring(0,8), 16) % players.length`.

### Payment Channels (Eltoo)
- The channel uses an **eltoo** (N-of-N multisig) mechanism — the same approach as the Thunder project.
- Every action that changes chip counts produces a new off-chain state update signed by all players.
- If a player disappears or cheats, any participant can trigger a **dispute** — posting the trigger transaction on-chain and waiting for the settlement timeout.

### Enforcer (deterministic coordinator)
There is no host role. Instead, the **enforcer** — the player with the lowest pubKey among participants — automatically starts the game when the channel opens. This is deterministic and requires no trust.

---

## Game Flow

### 1. Lobby
- Players see each other's tables via Maxima contacts.
- **Create Table** — set max players (2–4), blinds (e.g. `10/20`), and buy-in (minimum 20 BB, default 100 BB).
- **Join Table** — navigate to an existing table.

### 2. Channel Creation
Any player clicks **Create Channel**:
- `REQUEST_NEW_CHANNEL` is sent to all participants.
- Each player accepts → signs trigger and settlement transactions → replies `REQUEST_ACCEPTED`.
- The initiator collects all responses, signs the funding transaction, posts it on-chain.
- Channel status becomes **OPEN** → enforcer automatically starts the first hand.

### 3. Commit Phase
- Each player generates a secret and sends `COMMIT` with its SHA3 hash.
- When all commits received → game enters reveal phase.

### 4. Reveal Phase
- Each player sends `REVEAL` with their original secret.
- If any secret doesn't match its hash → commit phase restarts.
- When all reveals valid → deck shuffled → hole cards dealt.

### 5. Betting Rounds
Standard Texas Hold'em structure:

| Round    | Community Cards | Action starts at            |
|----------|-----------------|-----------------------------|
| Pre-flop | none            | player after big blind       |
| Flop     | 3 cards         | first active after dealer    |
| Turn     | 1 card          | first active after dealer    |
| River    | 1 card          | first active after dealer    |
| Showdown | —               | best hand wins the pot       |

Available actions: **Fold**, **Check**, **Call**, **Raise**.

After each bet that changes balances, `SEND_FUNDS` is sent with new signed transactions. All players countersign and reply `REPLY_SEND_FUNDS`.

### 6. Timeouts
- **Player turn** — 30 seconds. On expiry, enforcer forces fold/check.
- **Commit/reveal phase** — 20 seconds. On expiry, enforcer substitutes a zero secret.
- **Dispute** — triggered automatically on detected inactivity. Channel timeout: **30 blocks** (~25 min).

### 7. Channel Close

**Cooperative** — a final spend transaction is signed by all and posted on-chain. Funds distributed immediately.

**Dispute (unilateral)**:
- Trigger transaction posted on-chain.
- After `MIN_UPDATE_COINAGE = 5 blocks` the latest update transaction is posted.
- After `MIN_SETTLE_COINAGE = 30 blocks` the settlement transaction is posted and funds distributed.

---

## Maxima Message Reference

All messages are JSON objects sent via `maxima.sendWithAck()` with `application: MinimaPoker`.

| Message                 | Sent by        | When                                        | Effect                                                          |
|-------------------------|----------------|---------------------------------------------|-----------------------------------------------------------------|
| `TABLE_CREATE`          | Creator        | After creating a table                      | Inserts table into all contacts' databases                      |
| `TABLE_DELETE`          | Creator        | After deleting a table                      | Removes table from all contacts' databases                      |
| `TABLE_JOIN`            | Joining player | When joining a table                        | Adds player to table's player list                              |
| `TABLE_LEAVE`           | Player         | When leaving a table                        | Removes player from table's player list                         |
| `REQUEST_NEW_CHANNEL`   | Initiator      | After clicking Create Channel               | Asks other players to accept channel creation                   |
| `REQUEST_ACCEPTED`      | Each player    | After accepting channel request             | Sends signed trigger + settlement txs back to initiator         |
| `REQUEST_DENIED`        | Each player    | After rejecting channel request             | Notifies initiator of refusal                                   |
| `CREATE_CHANNEL`        | Initiator      | After collecting all acceptances            | Sends assembled funding + signed txs to all players             |
| `FINISH_START_CHANNEL`  | Each player    | After receiving CREATE_CHANNEL              | Signs funding tx; initiator posts it; channel becomes OPEN      |
| `GAME_START`            | Enforcer       | Automatically when channel is OPEN          | Initializes game state; starts commit phase                     |
| `COMMIT`                | Each player    | During commit phase                         | Sends SHA3 hash of secret to all players                        |
| `REVEAL`                | Each player    | During reveal phase                         | Sends original secret; verified against stored hash             |
| `BET`                   | Active player  | On fold / check / call / raise              | Sends action to all; triggers channel state update              |
| `SEND_FUNDS`            | State updater  | After each bet that changes balances        | Sends new signed settlement + update txs to all players         |
| `REPLY_SEND_FUNDS`      | Each player    | After receiving SEND_FUNDS                  | Countersigns txs; state applied locally                         |
| `SPEND_CHANNEL`         | Any player     | On cooperative close                        | Final spend tx for all to sign; posted on-chain                 |
| `CHANNEL_CLOSE`         | Any player     | After channel is closed                     | Notifies all players to update channel status to CLOSED         |
| `DISPUTE`               | Any player     | On unilateral close / peer timeout          | Posts trigger tx on-chain; starts dispute timer                 |
| `LOBBY_CHAT`            | Any player     | When sending a message in lobby chat        | Broadcasts text message to all contacts                         |

---

## Database Schema

| Table      | Purpose                                                                       |
|------------|-------------------------------------------------------------------------------|
| `tables`   | Active poker tables (id, creator, blinds, buy-in, max players, state)         |
| `players`  | Players at each table                                                         |
| `channels` | Channel state (txs, balances, status, sequence, disputeStartBlock)            |

---

## Security Notes

- Secrets are generated locally with `utils.genRandomHexString(64)` — 256 bits of entropy.
- Commit hashes use SHA3 via Minima's `hash data:` command.
- All channel transactions require N-of-N signatures — no single player can steal funds.
- The eltoo mechanism ensures the latest state always wins on-chain, even if an old state is posted.
- Maxima data is encoded as UTF-8 hex (`encodeURIComponent` / `decodeURIComponent`).
