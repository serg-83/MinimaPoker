# Plan: API Audit Fixes + Chat Feature

## Part 1: API Fixes (verified against Java source)

### 1. crypto.js — WRONG command name
- **Bug**: `MDS.cmd('crypto hash:' + hexInput)` (line 48)
- **Fix**: `MDS.cmd('hash data:' + hexInput)`
- **Also**: response is `resp.response.hash` (not `resp.response` directly)
- **Note**: Default hash is SHA3, not SHA2. For commit-reveal that's fine.

### 2. wallet.js — WRONG command names and response fields

#### 2a. `signTxn` (line 89)
- **Bug**: `MDS.cmd("signature sign publickey:" + key + " data:" + txnHex)`
- **Fix**: `MDS.cmd("sign publickey:" + key + " data:" + txnHex)`
- **Also**: `sign` response is `res.response` directly (the hex string), NOT `res.response.signature`

#### 2b. `postTxn` (line 105)
- **Bug**: `MDS.cmd("posttxn data:" + txnHex)` — command doesn't exist
- **Fix**: Import into temp txn then post: `txnimport id:RAND data:HEX;txnpost id:RAND auto:true;txndelete id:RAND`

#### 2c. `checkTxn` (line 116)
- **Bug**: `MDS.cmd("checktxn data:" + txnHex)` — command doesn't exist
- **Fix**: `txnimport id:RAND data:HEX;txncheck id:RAND;txndelete id:RAND`
- Response: `txncheck` returns transaction details, use `res.status` for validity

#### 2d. `getBalance` (line 52)
- **Bug**: `res.response.balance` — balance returns a JSONArray, not object
- **Fix**: Iterate `res.response` array, find entry with matching `tokenid`, return `sendable`

### 3. channel.js — WRONG postTxn
- **Bug** (line 373): `MDS.cmd('txnpost data:' + txHex)` — `txnpost` needs `id:`, not `data:`
- **Fix**: Import, then post by id: `txnimport id:RAND data:HEX;txnpost id:RAND auto:true;txndelete id:RAND`

## Part 2: Chat Feature

### Design
- New message type: `CHAT_MESSAGE` through existing Maxima P2P
- Chat visible on table.html (in-game chat between seated players)
- Messages sent via `maxima.sendWithAck()` to all players at the table
- Stored in-memory only (no DB persistence needed for chat)
- Simple UI: collapsible chat panel at bottom/side of table

### Message format
```json
{
  "type": "CHAT_MESSAGE",
  "tableId": "...",
  "sender": "pubkey",
  "senderName": "PlayerName",
  "text": "Hello!",
  "timestamp": 1234567890
}
```

### Files to modify
- **service.js**: Add `CHAT_MESSAGE` handler → forward to frontend via `MDS.comms.solo()`
- **table.js**: Add chat UI rendering, send button, receive handler
- **table.html**: Add chat container HTML
- **app/css/table-fix.css**: Chat panel styles
- **maxima.js**: No changes needed (uses existing sendWithAck)

### Chat UI
- Small chat icon/button near controls at bottom
- Opens a panel with message history (scrollable)
- Input field + send button
- Messages show sender name + time + text
- Auto-scroll to latest message
- Max 50 messages in memory
