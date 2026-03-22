// Load modules
MDS.load('./app/js/decimal.js');
MDS.load('./app/js/sql.js');
MDS.load('./app/js/utils.js');
MDS.load('./app/js/wallet.js');
MDS.load('./app/js/crypto.js');
MDS.load('./app/js/maxima.js');
MDS.load('./app/js/channel.js');
MDS.load('./app/js/poker.js');

var SHOW_LOGS = true;
var myMaximaKey  = '';
var myMaximaName = '';
var pendingUpdates = {};

// Eltoo timing constants (matching thunder protocol)
var MIN_UPDATE_COINAGE  = 5;
var MIN_SETTLE_COINAGE  = 30;
var DECIMAL_ZERO = new Decimal(0);

function log(msg) { if (SHOW_LOGS) MDS.log(msg); }

function getMyMaximaKey() {
    if (myMaximaKey) return myMaximaKey;
    if (typeof window !== 'undefined' && window.myMaximaKey) return window.myMaximaKey;
    return '';
}

// Notify frontend to refresh lobby
function refreshLobby() { MDS.comms.solo(JSON.stringify({ type: 'REFRESH_LOBBY' })); }
function refreshTable(tableId) { MDS.comms.solo(JSON.stringify({ type: 'REFRESH_TABLE', tableId: tableId })); }

// Debounced refresh helpers
var _refreshLobbyTimeout = null;
function debouncedRefreshLobby() {
    if (_refreshLobbyTimeout) clearTimeout(_refreshLobbyTimeout);
    _refreshLobbyTimeout = setTimeout(function() { refreshLobby(); _refreshLobbyTimeout = null; }, 100);
}

var _refreshTableTimeouts = {};
function debouncedRefreshTable(tableId) {
    if (_refreshTableTimeouts[tableId]) clearTimeout(_refreshTableTimeouts[tableId]);
    _refreshTableTimeouts[tableId] = setTimeout(function() {
        refreshTable(tableId);
        delete _refreshTableTimeouts[tableId];
    }, 100);
}

// Load channel from memory cache or DB
function getChannel(channelId, callback) {
    if (typeof sql === 'undefined') { callback('sql not available', null); return; }
    var chan = channel.get(channelId);
    if (chan) { callback(null, chan); return; }
    sql.getChannelById(channelId, function(row) {
        if (!row) { callback('Channel not found', null); return; }
        try {
            chan = channel.fromRow(row);
            channel.set(channelId, chan);
            callback(null, chan);
        } catch (e) {
            callback('Error reconstructing channel: ' + e, null);
        }
    });
}

// Async wrappers
function signTxnAsync(tx, key, callback) {
    channel.signTxn(tx, key, function(err, signed) {
        if (err) callback(new Error('Failed to sign: ' + err), null);
        else callback(null, signed);
    });
}

function postTxnAsync(tx, callback) {
    channel.postTxn(tx, function(err, res) {
        if (err) callback(new Error('Failed to post: ' + err), null);
        else callback(null, res);
    });
}

function sendWithAckAsync(to, msg, callback) {
    maxima.sendWithAck(to, msg, function(ok, err) {
        if (ok) callback(null, ok);
        else callback(new Error(err || 'Send failed'), null);
    });
}

// ===== MAIN INIT =====
MDS.init(function(msg) {
    if (msg.event === 'inited') {
        log('Service initialized');
        if (typeof sql === 'undefined') { log('ERROR: sql not available'); return; }
        sql.createTables(function() {
            initWallet(function(user) {
                if (user) {
                    myMaximaKey  = user.maximaPublicKey;
                    myMaximaName = user.maximaName;
                }
                // Register unified Maxima message handler
                maxima.registerHandler('*', function(message, fromPubKey) {
                    // Skip internal ACK messages
                    if (message.type === 'ACK_MESSAGE' || message.type === 'SYNACK_MESSAGE') return;
                    var handler = messageHandlers[message.type];
                    if (handler) {
                        try { handler(message, fromPubKey); }
                        catch (e) { log('Error in handler ' + message.type + ': ' + e); }
                    } else {
                        log('Unknown message type: ' + message.type);
                    }
                });
                log('Service ready');
            });
        });

    } else if (msg.event === 'NEWBLOCK') {
        if (typeof sql === 'undefined') return;

        // Clean up stale ACK requests (Rhino has no setInterval)
        maxima.cleanupStaleAcks();

        // Mark channels as closed when conditions are met
        if (sql.updateClosedChannels) {
            sql.updateClosedChannels(function(found) {
                if (found) debouncedRefreshLobby();
            });
        }

        // Only check eltoo every 5 blocks
        var block = 0;
        if (msg.data && msg.data.txpow && msg.data.txpow.header) block = +msg.data.txpow.header.block;
        else if (msg.data && msg.data.block) block = +msg.data.block;
        if (block % 5 !== 0) return;

        MDS.cmd('coins simplestate:true relevant:true', function(allcoins) {
            var coincount = allcoins.response.length;
            sql.selectEltooChannels(function(eltoocoins) {
                if (!eltoocoins || !eltoocoins.count) return;
                for (var i = 0; i < coincount; i++) {
                    var coin = allcoins.response[i];
                    for (var j = 0; j < eltoocoins.count; j++) {
                        var row = eltoocoins.rows[j];
                        if (row.ELTOOADDRESS !== coin.miniaddress) continue;
                        var age = coin.age;
                        var seq = coin.state[101];
                        if (row.SEQUENCE > seq) {
                            if (sql.insertLog) sql.insertLog(row.HASHID, seq == 0 ? 'TRIGGER_ELTOO_FOUND' : 'INVALID_ELTOO_SEQUENCE_FOUND', 'coinage:' + age + '/' + MIN_UPDATE_COINAGE);
                            if (age >= MIN_UPDATE_COINAGE) {
                                if (sql.insertLog) sql.insertLog(row.HASHID, 'POST_LATEST_UPDATE', 'sequence:' + row.SEQUENCE);
                                (function(hashId) {
                                    getChannel(hashId, function(err, chan) {
                                        if (err || !chan) return;
                                        postTxnAsync(chan.updateTx, function(err) {
                                            if (!err) debouncedRefreshTable(chan.tableId);
                                        });
                                    });
                                })(row.HASHID);
                            } else {
                                debouncedRefreshTable(row.HASHID);
                            }
                        } else {
                            if (sql.insertLog) sql.insertLog(row.HASHID, 'VALID_ELTOO_FOUND', 'coinage:' + age + '/' + MIN_SETTLE_COINAGE);
                            if (age >= MIN_SETTLE_COINAGE) {
                                if (sql.insertLog) sql.insertLog(row.HASHID, 'POST_LATEST_SETTLEMENT', 'sequence:' + row.SEQUENCE);
                                (function(hashId) {
                                    getChannel(hashId, function(err, chan) {
                                        if (err || !chan) return;
                                        postTxnAsync(chan.settlementTx, function(err) {
                                            if (!err) debouncedRefreshTable(chan.tableId);
                                        });
                                    });
                                })(row.HASHID);
                            } else {
                                debouncedRefreshTable(row.HASHID);
                            }
                        }
                    }
                }
            });
        });

    } else if (msg.event === 'NEWCOIN') {
        if (typeof sql === 'undefined') return;
        var coin = msg.data.coin;

        // Check for funding coin
        sql.selectRelevantFundingCoin(coin.miniaddress, function(res) {
            if (!res || !res.count) return;
            var row = res.rows[0];
            if (coin.spent) {
                if (sql.insertLog) sql.insertLog(row.HASHID, 'FUNDING_COIN_SPENT', 'address:' + coin.miniaddress);
                sql.updateFundingSpent(row.HASHID, function() { debouncedRefreshTable(row.HASHID); });
            } else {
                if (sql.insertLog) sql.insertLog(row.HASHID, 'NEW_FUNDING_COIN', 'address:' + coin.miniaddress);
                debouncedRefreshTable(row.HASHID);
            }
        });

        // Check for payout coin (settlement output — state[200] = channelId)
        if (!coin.spent) {
            var payoutHashId = coin.state ? coin.state['200'] : undefined;
            if (payoutHashId === undefined) return;
            var myAddr = window && window.myMinimaAddress ? window.myMinimaAddress : null;
            if (!myAddr || coin.miniaddress !== myAddr) return;
            sql.selectPayoutCoin(payoutHashId, function(res) {
                if (!res || !res.count) return;
                var hashId = res.rows[0].HASHID;
                if (sql.insertLog) sql.insertLog(hashId, 'PAYOUT_COIN_FOUND', 'amount:' + coin.amount);
                if (sql.updatePayoutFound) sql.updatePayoutFound(hashId, coin.amount, function() { debouncedRefreshTable(hashId); });
            });
        }

    } else if (msg.event === 'MAXIMA') {
        maxima.handleIncoming(msg);
    }
});

// ===== MESSAGE HANDLERS =====
var messageHandlers = {
    TABLE_CREATE: function(message, fromPubKey) {
        sql.getTableById(message.table.tableId, function(existing) {
            if (existing) { debouncedRefreshLobby(); return; }
            if (!message.table.creatorName) message.table.creatorName = '';
            sql.insertTable(message.table, function(res) {
                if (res && res.status) log('Table from peer inserted: ' + message.table.tableId);
                debouncedRefreshLobby();
            });
        });
    },

    TABLE_DELETE: function(message, fromPubKey) {
        sql.deleteTable(message.tableId, function() { debouncedRefreshLobby(); });
    },

    TABLE_JOIN: function(message, fromPubKey) {
        sql.addPlayerToTable(message.tableId, message.player, function() {
            debouncedRefreshLobby();
            debouncedRefreshTable(message.tableId);
        });
    },

    TABLE_LEAVE: function(message, fromPubKey) {
        sql.removePlayerFromTable(message.tableId, fromPubKey, function() {
            debouncedRefreshLobby();
            debouncedRefreshTable(message.tableId);
        });
    },

    GAME_START: function(message, fromPubKey) {
        poker.initGame(message.tableId, message.channelId, message.players, message.blinds, function() {
            debouncedRefreshTable(message.tableId);
        });
    },

    REQUEST_NEW_CHANNEL: function(message, fromPubKey) {
        MDS.comms.solo(JSON.stringify({
            type: 'CHANNEL_REQUEST',
            tableId: message.tableId,
            from: fromPubKey,
            participants: message.participants,
            tokenId: message.tokenId,
            timeout: message.timeout
        }));
    },

    REQUEST_ACCEPTED: function(message, fromPubKey) {
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for REQUEST_ACCEPTED: ' + message.channelId); return; }
            chan.init(function(err) {
                if (err) { log('Error initializing channel: ' + err); return; }
                // Find my amount from participants
                var myKey = getMyMaximaKey();
                var myAmount = '0';
                var totalAmount = new Decimal(0);
                for (var i = 0; i < chan.participants.length; i++) {
                    totalAmount = totalAmount.plus(chan.participants[i].amount);
                    if (chan.participants[i].pubKey === myKey) myAmount = chan.participants[i].amount;
                }
                // Create funding tx (initiator contributes their share)
                channel.createFundingTxn(chan.fundingAddress, myAmount, totalAmount.toString(), chan.tokenId, function(err, fundingHex) {
                    if (err) { log('createFundingTxn failed: ' + err); return; }
                    chan.fundingTx = fundingHex;
                    signTxnAsync(chan.triggerTx, myKey, function(err, signedTrigger) {
                        if (err) { log(err); return; }
                        signTxnAsync(chan.settlementTx, myKey, function(err, signedSettle) {
                            if (err) { log(err); return; }
                            sendWithAckAsync(fromPubKey, {
                                type: 'CREATE_CHANNEL', channelId: chan.id,
                                fundingTx: chan.fundingTx, triggerTx: signedTrigger, settlementTx: signedSettle
                            }, function(err) {
                                if (!err) sql.updateChannelAfterFunding(chan.id, null, 'FUNDING', function() {});
                            });
                        });
                    });
                });
            });
        });
    },

    REQUEST_DENIED: function(message, fromPubKey) {
        MDS.comms.solo(JSON.stringify({ type: 'CHANNEL_DENIED', tableId: message.tableId }));
    },

    CREATE_CHANNEL: function(message, fromPubKey) {
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for CREATE_CHANNEL: ' + message.channelId); return; }
            chan.fundingTx    = message.fundingTx;
            chan.triggerTx    = message.triggerTx;
            chan.settlementTx = message.settlementTx;
            // Find my amount to add to the funding tx
            var myKey = getMyMaximaKey();
            var myAmount = '0';
            for (var i = 0; i < chan.participants.length; i++) {
                if (chan.participants[i].pubKey === myKey) { myAmount = chan.participants[i].amount; break; }
            }
            channel.addToFundingTxn(chan.fundingTx, myAmount, chan.tokenId, function(err, fundingWithMyFunds) {
                if (err) { log('addToFundingTxn failed: ' + err); return; }
                chan.fundingTx = fundingWithMyFunds;
                signTxnAsync(chan.triggerTx, myKey, function(err, trigger) {
                    if (err) { log(err); return; }
                    signTxnAsync(chan.settlementTx, myKey, function(err, settle) {
                        if (err) { log(err); return; }
                        signTxnAsync(chan.fundingTx, 'auto', function(err, funding) {
                            if (err) { log(err); return; }
                            sendWithAckAsync(fromPubKey, {
                                type: 'FINISH_START_CHANNEL', channelId: chan.id,
                                fundingTx: funding, triggerTx: trigger, settlementTx: settle
                            }, function(err) {
                                if (!err) sql.updateChannelAfterFunding(chan.id, null, 'FUNDING', function() {});
                            });
                        });
                    });
                });
            });
        });
    },

    FINISH_START_CHANNEL: function(message, fromPubKey) {
        var chan = channel.get(message.channelId);
        if (!chan) { log('Channel not in memory for FINISH_START_CHANNEL'); return; }
        // Accumulate signatures: each participant sends their signed funding tx
        if (!chan._finishResponses) chan._finishResponses = {};
        chan._finishResponses[fromPubKey] = {
            fundingTx: message.fundingTx,
            triggerTx: message.triggerTx,
            settlementTx: message.settlementTx
        };
        // Count non-self participants
        var myKey = getMyMaximaKey();
        var needed = 0;
        for (var i = 0; i < chan.participants.length; i++) {
            if (chan.participants[i].pubKey !== myKey) needed++;
        }
        var received = 0;
        for (var k in chan._finishResponses) { if (chan._finishResponses.hasOwnProperty(k)) received++; }
        if (received < needed) {
            log('FINISH_START_CHANNEL: got ' + received + '/' + needed + ' responses');
            return;
        }
        // All responses received — use the last funding tx (has all participants' funds added)
        // Take the most-signed versions of trigger and settlement
        var lastResp = chan._finishResponses[fromPubKey];
        chan.triggerTx    = lastResp.triggerTx;
        chan.settlementTx = lastResp.settlementTx;
        chan.fundingTx    = lastResp.fundingTx;
        signTxnAsync(chan.fundingTx, 'auto', function(err, signed) {
            if (err) { log(err); return; }
            chan.fundingTx = signed;
            // Validate before posting (Thunder pattern)
            var checkId = 'chk_' + randomString();
            MDS.cmd('txnimport id:' + checkId + ' data:' + chan.fundingTx + ';txncheck id:' + checkId + ';txndelete id:' + checkId, function(chkRes) {
                if (!chkRes || !Array.isArray(chkRes) || !chkRes[1] || !chkRes[1].response || !chkRes[1].response.validtransaction) {
                    log('FINISH_START_CHANNEL: funding tx invalid: ' + JSON.stringify(chkRes && chkRes[1]));
                    return;
                }
                postTxnAsync(chan.fundingTx, function(err, res) {
                    if (err) { log(err); return; }
                    chan.fundingTxId = res.response && res.response.txid ? res.response.txid : '';
                    chan.status = 'OPEN';
                    delete chan._finishResponses;
                    sql.updateChannelAfterFunding(chan.id, chan.fundingTxId, 'OPEN', function() {
                        debouncedRefreshTable(chan.tableId);
                    });
                });
            });
        });
    },

    SEND_FUNDS: function(message, fromPubKey) {
        var chan = channel.get(message.channelId);
        if (!chan) { log('Channel not found for SEND_FUNDS'); return; }
        signTxnAsync(message.settlementTx, getMyMaximaKey(), function(err, settle) {
            if (err) { log(err); return; }
            signTxnAsync(message.updateTx, getMyMaximaKey(), function(err, update) {
                if (err) { log(err); return; }
                sendWithAckAsync(fromPubKey, {
                    type: 'REPLY_SEND_FUNDS', channelId: message.channelId,
                    settlementTx: settle, updateTx: update, sequence: message.sequence
                }, function(err) {
                    if (err) { log(err); return; }
                    chan.settlementTx  = settle;
                    chan.updateTx      = update;
                    chan.sequence      = message.sequence;
                    chan.balances      = message.balances;
                    chan.lastGameState = message.gameState;
                    sql.updateChannelAfterUpdate(chan.id, chan.settlementTx, chan.updateTx, chan.balances, chan.lastGameState, chan.sequence, function() {
                        channel.set(chan.id, chan);
                        debouncedRefreshTable(chan.tableId);
                    });
                });
            });
        });
    },

    REPLY_SEND_FUNDS: function(message, fromPubKey) {
        var chan = channel.get(message.channelId);
        if (!chan) return;
        var pending = pendingUpdates[message.channelId];
        if (!pending) { log('No pending update for channel ' + message.channelId); return; }
        chan.settlementTx  = message.settlementTx;
        chan.updateTx      = message.updateTx;
        chan.sequence      = message.sequence;
        chan.balances      = pending.balances;
        chan.lastGameState = pending.gameState;
        sql.updateChannelAfterUpdate(chan.id, chan.settlementTx, chan.updateTx, chan.balances, chan.lastGameState, chan.sequence, function() {
            delete pendingUpdates[message.channelId];
            sql.saveChannelState(chan.id, { sequence: chan.sequence, balances: chan.balances, gameState: chan.lastGameState }, {}, function() {
                debouncedRefreshTable(chan.tableId);
            });
        });
    },

    SPEND_CHANNEL: function(message, fromPubKey) {
        var chan = channel.get(message.channelId);
        if (!chan) return;
        signTxnAsync(message.spendTx, getMyMaximaKey(), function(err, signed) {
            if (err) { log(err); return; }
            postTxnAsync(signed, function(err) {
                if (err) { log(err); return; }
                chan.status = 'CLOSED';
                sql.updateChannelAfterFunding(chan.id, null, 'CLOSED', function() {
                    debouncedRefreshTable(chan.tableId);
                });
            });
        });
    },

    CHANNEL_CLOSE: function(message, fromPubKey) {
        sql.getChannelByTable(message.tableId, function(row) {
            if (row) sql.updateChannelAfterFunding(row.hashId, null, 'CLOSED', function() {
                debouncedRefreshTable(message.tableId);
            });
        });
    },

    DISPUTE: function(message, fromPubKey) {
        if (!message.channelId) { log('DISPUTE missing channelId'); return; }
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for DISPUTE'); return; }
            chan.startDispute(function(err, result) {
                if (err) { log('Failed to start dispute: ' + err); return; }
                for (var i = 0; i < chan.participants.length; i++) {
                    var p = chan.participants[i];
                    if (p.pubKey !== getMyMaximaKey()) {
                        sendWithAckAsync(p.pubKey, { type: 'DISPUTE_STARTED', channelId: chan.id, tableId: chan.tableId, startBlock: result.startBlock }, function() {});
                    }
                }
                MDS.comms.solo(JSON.stringify({ type: 'DISPUTE_STARTED', tableId: chan.tableId, channelId: chan.id }));
            });
        });
    },

    COMMIT: function(message, fromPubKey) {
        var game = poker.getGame(message.tableId);
        if (game) { game.receiveCommit(message.playerPubKey, message.commitHash); debouncedRefreshTable(message.tableId); }
    },

    REVEAL: function(message, fromPubKey) {
        var game = poker.getGame(message.tableId);
        if (game) { game.receiveReveal(message.playerPubKey, message.secret); debouncedRefreshTable(message.tableId); }
    }
};
