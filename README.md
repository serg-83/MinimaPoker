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

The lobby includes a **global P2P chat** where players can communicate with all their Maxima contacts. Messages are sent directly peer-to-peer through the Maxima network — no central chat server required.

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

## Thunder in Poker: Under the Hood

MinimaPoker is adapted from the [Thunder project](https://github.com/minima-global/Thunder) — Minima's eltoo-based payment channel implementation. Here's how Thunder channels work during a poker game:

### 1. Channel Opening (Before Game)

```
Player A creates table → Player B joins
↓
Funding transaction created (400 Minima: 200+200)
↓
Initial trigger and settlement transactions created (sequence=0)
↓
Signatures exchanged via Maxima P2P
↓
Funding transaction posted on-chain
↓
Channel OPEN, game can start
```

### 2. Off-Chain Updates (During Game)

**After every bet, call, raise, or fold:**

1. **Enforcer** (player with lowest pubKey) calculates new balances from current stacks
2. **Sequence increments** (0→1→2→3...)
3. **Two new transactions created:**
   - **Update TX**: spends eltoo output, creates new output with sequence+1
   - **Settlement TX**: spends eltoo output, distributes funds by new balances

4. **Enforcer sends via Maxima:**
   ```javascript
   SEND_FUNDS: {
     channelId, sequence, balances,
     updateTx: "hex...",
     settlementTx: "hex...",
     gameState: {...}
   }
   ```

5. **Other player signs and replies:**
   ```javascript
   REPLY_SEND_FUNDS: {
     settlementTx: "signed_hex...",
     updateTx: "signed_hex...",
     sequence: N
   }
   ```

**Result:** Both players hold fully-signed update and settlement transactions with current balances, but **do NOT post them on-chain**.

### 3. Example Game Flow

```
Start: A=200, B=200, sequence=0
↓
A bets 10 (big blind)
→ sendChannelUpdate: A=190, B=200, sequence=1
→ Signatures exchanged via SEND_FUNDS/REPLY_SEND_FUNDS
↓
B calls 10
→ sendChannelUpdate: A=190, B=190, sequence=2
→ Signatures exchanged
↓
A raises to 30
→ sendChannelUpdate: A=170, B=190, sequence=3
→ Signatures exchanged
↓
B folds
→ sendChannelUpdate: A=210, B=190, sequence=4
→ Signatures exchanged
```

**Key:** Each update creates a **new pair of transactions** (update + settlement) with increased sequence. Old transactions become invalid thanks to eltoo's `sequence GT prevsequence` check.

### 4. Showdown and Channel Close

```javascript
// After showdown determines winner and distributes pot
PokerGame.prototype.showdown = function() {
    this.lastWinners = [...];
    this.round = 'finished';

    // Enforcer sends final channel update
    if (isEnforcer) {
        sendChannelUpdate(self, function(ok) {
            // After 2 seconds, trigger auto-close
            setTimeout(function() {
                MDS.comms.solo({
                    type: 'GAME_END_AUTO_CLOSE',
                    channelId: self.channelId,
                    finalStacks: {A: 210, B: 190}
                });
            }, 2000);
        });
    }
}
```

**GAME_END_AUTO_CLOSE handler:**
1. Updates channel balances with final stacks
2. Cooperative close with `autoClose=true`
3. One player creates and signs settlement
4. Other player **automatically** signs and posts on-chain
5. Settlement transaction mined → funds distributed
6. Table deleted, players return to lobby

### 5. Local Storage During Game

**Each player stores in database:**

```javascript
{
  channelId: "...",
  sequence: 4,  // Current sequence (updates after each bet)

  balances: {
    playerA_pubKey: "210",
    playerB_pubKey: "190"
  },

  // Fully-signed transactions (updated after each bet):
  updateTx: "hex...",      // Update with sequence=4
  settlementTx: "hex...",  // Settlement with sequence=4 and balances 210/190

  // Initial transactions (unchanged):
  fundingTx: "hex...",
  triggerTx: "hex...",

  status: "OPEN"
}
```

### Key Features

1. **Enforcer Pattern**: Player with lowest pubKey creates channel updates → prevents conflicts

2. **Off-Chain Updates**: Every bet creates new transactions, but they're **not posted** on-chain until channel closes

3. **Sequence Protection**: Eltoo script checks `sequence GT prevsequence` → newer transaction always replaces older

4. **Automatic Close**: After showdown, channel closes automatically with `autoClose=true` → one player signs, other auto-posts

5. **Cooperative Settlement**: Both players sign settlement → posted on-chain → funds distributed by final balances

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
