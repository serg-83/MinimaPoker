# MinimaPoker — MDS Commands Reference

## MDS.cmd() — Wallet / Address

| Command | File | Description |
|---|---|---|
| `balance` | wallet.js, index.html | Get token balances |
| `maxima;getaddress` | wallet.js | Get own Maxima pubkey + name |
| `maxima action:info` | index.html | Get own Maxima contact address (MxAddr@host:port) |
| `maxima action:send publickey:... application:MinimaPoker data:...` | maxima.js | Send P2P message via Maxima |
| `maxcontacts action:list` | index.html, lobby.js, service.js | List contacts |
| `maxcontacts action:add contact:...` | index.html | Add a contact |
| `maxcontacts action:remove id:...` | index.html | Remove a contact |
| `sign publickey:... data:...` | wallet.js | Sign data with a key |
| `hash data:0x...` | crypto.js | SHA3 hash (used in commit-reveal) |
| `send address:... amount:... tokenid:... automation:` | wallet.js | Send tokens from wallet |

## MDS.cmd() — Channel Transactions (channel.js)
Chained with `;` in a single MDS.cmd() call.

| Command | Description |
|---|---|
| `txncreate id:...` | Create a transaction in memory |
| `txninput id:... amount:... address:... floating:true` | Add floating input |
| `txnoutput id:... amount:... address:... storestate:true` | Add output |
| `txnstate id:... port:... value:...` | Set state variable (100=settlement flag, 101=sequence, 200=channel hashId) |
| `txnaddamount id:... tokenid:... amount:... onlychange:true` | Add funds from wallet (auto-selects coins) |
| `txnsign id:... publickey:...` | Sign transaction with a key |
| `txnimport id:... data:...` | Import a hex-encoded transaction |
| `txnexport id:...` | Export transaction to hex |
| `txncheck id:...` | Validate transaction before posting |
| `txnscript id:... auto:true` | Attach scripts to inputs (required before posting floating inputs) |
| `txnmmr id:...` | Attach MMR proofs to inputs (required before posting) |
| `txnpost id:... auto:true` | Post transaction to the network |
| `txndelete id:...` | Delete transaction from memory |

## MDS.cmd() — Scripts / Blockchain

| Command | File | Description |
|---|---|---|
| `runscript script:"..."` | channel.js | Compute address of a KISSVM script |
| `newscript trackall:true script:"..."` | channel.js | Start tracking coins at a script address |
| `removescript address:...` | channel.js | Stop tracking a script address |
| `coins simplestate:true relevant:true` | service.js | Get all coins at tracked addresses |
| `block` | channel.js | Get current block height |

## MDS API (not MDS.cmd)

| Call | Where | Description |
|---|---|---|
| `MDS.init(callback)` | index.html, table.html, service.js | Initialize MDS; receive events: inited, NEWBLOCK, NEWCOIN, MAXIMA, MDSCOMMS |
| `MDS.sql(query, callback)` | sql.js | Execute SQLite query |
| `MDS.log(msg)` | everywhere | Print to Minima node log |
| `MDS.load(path)` | service.js | Load a JS module into the background service (Rhino) |
| `MDS.comms.solo(json)` | service.js | Send message from service to frontend (triggers MDSCOMMS event) |
| `MDS.minidappuid` | index.html, table.html | UID of this MiniDAPP instance |

## Maxima Message Structure

```javascript
// Incoming MAXIMA event:
msg = { event: 'MAXIMA', data: maxjson }
msg.data.from        // "0x..." sender pubkey
msg.data.application // "MinimaPoker"
msg.data.data        // "0x..." hex-encoded JSON payload

// Encoding (UTF-8 safe):
// Send:    '0x' + encodeURIComponent(JSON.stringify(obj)) → hex
// Receive: decodeURIComponent(hexToBytes(strip0x(msg.data.data)))
```

## postTxn Pattern (channel.js)

```javascript
'txnimport id:X data:HEX;' +
'txnscript id:X auto:true;' +   // attach scripts
'txnmmr id:X;' +                 // attach MMR proofs
'txnpost id:X auto:true;' +      // post — result is res[3]
'txndelete id:X'
```

## Fund Flow

```
Player wallet
    │  txnaddamount
    ▼
fundingAddress  ← N-of-N multisig (runscript + newscript trackall:true)
    │  trigger tx
    ▼
eltooAddress    ← eltoo script, timeout=30 blocks (runscript + newscript trackall:true)
    │  update txs / settlement tx
    ▼
participants[i].address  ← each player's address (newaddress)
```

## Dispute Timeline

| Event | Blocks | Time (~50s/block) |
|---|---|---|
| Trigger tx posted | 0 | t=0 |
| Latest update tx posted | MIN_UPDATE_COINAGE = 5 | ~4 min |
| Settlement tx posted, funds distributed | MIN_SETTLE_COINAGE = 30 | ~25 min |

## Channel Scripts (KISSVM)

### fundingAddress — N-of-N multisig
```
LET randid=[<channelId>] ASSERT MULTISIG(N pubkey1 pubkey2 ...) RETURN TRUE
```

### eltooAddress — eltoo update/settlement script
```
LET randid=[<channelId>]
LET settlement=STATE(100)
LET sequence=STATE(101)
LET prevsequence=PREVSTATE(101)
ASSERT MULTISIG(N pubkey1 pubkey2 ...)
IF settlement THEN
    IF sequence EQ prevsequence AND @COINAGE GTE <timeoutBlocks> THEN RETURN TRUE ENDIF
ELSE
    IF sequence GT prevsequence THEN RETURN TRUE ENDIF
ENDIF
```

| State port | Value | Meaning |
|---|---|---|
| `STATE(100)` | FALSE / TRUE | FALSE = update tx, TRUE = settlement tx |
| `STATE(101)` | integer | Sequence number of this tx |
| `PREVSTATE(101)` | integer | Sequence of the coin being spent |
| `STATE(200)` | channelId | Written to settlement outputs for payout lookup |

## Database Schema

### tables
```sql
CREATE TABLE IF NOT EXISTS tables (
  tableId TEXT PRIMARY KEY, creator TEXT, creatorName TEXT DEFAULT '',
  maxPlayers INTEGER, blinds TEXT, buyIn TEXT DEFAULT '1000',
  state TEXT DEFAULT 'waiting', created INTEGER
)
```

### channels
```sql
CREATE TABLE IF NOT EXISTS channels (
  hashId TEXT PRIMARY KEY, tableId TEXT,
  fundingTx TEXT, triggerTx TEXT, settlementTx TEXT, updateTx TEXT,
  fundingAddress TEXT, eltooAddress TEXT,
  participants TEXT, balances TEXT, lastGameState TEXT, signatures TEXT,
  status TEXT, sequence INTEGER DEFAULT 0, timeout INTEGER,
  fundingTxId TEXT, disputeStartBlock INTEGER,
  fundingSpent INTEGER DEFAULT 0,
  payoutFound INTEGER DEFAULT 0, payoutAmount TEXT,
  createdAt INTEGER
)
```
