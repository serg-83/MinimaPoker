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
var myWalletKey  = '';
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
function getMyWalletKey() {
    return myWalletKey || '';
}

// Notify frontend to refresh lobby
function refreshLobby() { MDS.comms.solo(JSON.stringify({ type: 'REFRESH_LOBBY' })); }
function refreshTable(tableId) { MDS.comms.solo(JSON.stringify({ type: 'REFRESH_TABLE', tableId: tableId })); }

// Rhino has no setTimeout — call directly
function debouncedRefreshLobby() { refreshLobby(); }
function debouncedRefreshTable(tableId) { refreshTable(tableId); }

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
            // Re-track scripts so node monitors coins at these addresses after restart
            if (chan.fundingScript) channel.trackScript(chan.fundingScript, function() {});
            if (chan.eltooScript) channel.trackScript(chan.eltooScript, function() {});
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

function prepareTxnAsync(tx, callback) {
    channel.prepareTxn(tx, function(err, prepared) {
        if (err) callback(new Error('Failed to prepare: ' + err), null);
        else callback(null, prepared);
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
                    myWalletKey  = user.minimaPublicKey;
                    myMaximaName = user.maximaName;
                }
                maxima.init();
                log('Service ready');
            });
        });

    } else if (msg.event === 'NEWBLOCK') {
        if (typeof sql === 'undefined') return;

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
            if (!allcoins || !allcoins.response) return;
            var coincount = allcoins.response.length;
            sql.selectEltooChannels(function(eltoocoins) {
                if (!eltoocoins || !eltoocoins.count) return;
                for (var i = 0; i < coincount; i++) {
                    var coin = allcoins.response[i];
                    if (!coin.state) continue;
                    for (var j = 0; j < eltoocoins.count; j++) {
                        var row = eltoocoins.rows[j];
                        if (row.ELTOOADDRESS !== coin.miniaddress) continue;
                        var age = parseInt(coin.age) || 0;
                        var seq = parseInt(coin.state['101']) || 0;
                        var dbSeq = parseInt(row.SEQUENCE) || 0;
                        if (dbSeq > seq) {
                            if (sql.insertLog) sql.insertLog(row.HASHID, seq == 0 ? 'TRIGGER_ELTOO_FOUND' : 'INVALID_ELTOO_SEQUENCE_FOUND', 'coinage:' + age + '/' + MIN_UPDATE_COINAGE);
                            if (age >= MIN_UPDATE_COINAGE) {
                                if (sql.insertLog) sql.insertLog(row.HASHID, 'POST_LATEST_UPDATE', 'sequence:' + row.SEQUENCE);
                                (function(hashId) {
                                    getChannel(hashId, function(err, chan) {
                                        if (err || !chan) return;
                                        prepareTxnAsync(chan.updateTx, function(err, prepared) {
                                            if (err) return;
                                            postTxnAsync(prepared, function(err) {
                                                if (!err) debouncedRefreshTable(chan.tableId);
                                            });
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
                                        prepareTxnAsync(chan.settlementTx, function(err, prepared) {
                                            if (err) return;
                                            postTxnAsync(prepared, function(err) {
                                                if (!err) debouncedRefreshTable(chan.tableId);
                                            });
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
        if (!msg.data || !msg.data.coin) return;
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
            var myAddr = (typeof currentUser !== 'undefined' && currentUser.minimaAddress) ? currentUser.minimaAddress : null;
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
    } else if (msg.event === 'MDSCOMMS') {
        // Handle messages sent from browser via MDS.comms.solo (enforcer self-messages)
        // Only handle game-logic types, not chat/lobby (browser handles those directly)
        var allowedCommsTypes = { GAME_START: 1, COMMIT: 1, REVEAL: 1, BET: 1 };
        try {
            var commsData = msg.data && (msg.data.message || msg.data.data || msg.data);
            var commsMsg = typeof commsData === 'string' ? JSON.parse(commsData) : commsData;
            if (commsMsg && commsMsg.type && allowedCommsTypes[commsMsg.type] && messageHandlers[commsMsg.type]) {
                log('MDSCOMMS dispatch: type=' + commsMsg.type);
                messageHandlers[commsMsg.type](commsMsg, myMaximaKey);
            }
        } catch(e) { log('MDSCOMMS parse error: ' + e); }
    }
});

// ===== MESSAGE HANDLERS =====
var messageHandlers = {
    LOBBY_CHAT: function(message, fromPubKey) {
        // Forward to all other contacts so everyone sees the message
        MDS.cmd('maxcontacts action:list', function(res) {
            var contacts = (res && res.response && res.response.contacts) ? res.response.contacts : [];
            for (var i = 0; i < contacts.length; i++) {
                var key = contacts[i].publickey || '';
                if (key && key !== fromPubKey) maxima.sendRaw(key, message, function() {});
            }
        });
        // Notify frontend
        MDS.comms.solo(JSON.stringify(message));
    },

    TABLE_CREATE: function(message, fromPubKey) {
        log('TABLE_CREATE received: ' + (message.table ? message.table.tableId : 'no tableId'));
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
        sql.deleteTable(message.tableId, function() {
            debouncedRefreshLobby();
            MDS.comms.solo(JSON.stringify({ type: 'TABLE_DELETED', tableId: message.tableId }));
        });
    },

    TABLE_JOIN: function(message, fromPubKey) {
        sql.addPlayerToTable(message.tableId, message.player, function() {
            debouncedRefreshLobby();
            debouncedRefreshTable(message.tableId);
        });
        // Reply once with our own join so sender knows about us — but don't reply to replies
        if (!message._reply && myMaximaKey && message.player && message.player.pubKey !== myMaximaKey) {
            sql.getPlayers(message.tableId, function(players) {
                for (var i = 0; i < players.length; i++) {
                    if (players[i].playerPubKey === myMaximaKey) {
                        MDS.cmd('getaddress', function(res) {
                            var myAddr = (res && res.response) ? res.response.miniaddress : '';
                            maxima.sendRaw(fromPubKey, { type: 'TABLE_JOIN', tableId: message.tableId, player: { pubKey: myMaximaKey, name: myMaximaName || '', address: myAddr, walletKey: myWalletKey || '' }, _reply: true }, function() {});
                        });
                        break;
                    }
                }
            });
        }
    },

    TABLE_LEAVE: function(message, fromPubKey) {
        // If game is active and it's this player's turn — auto-fold
        var game = poker.getGame(message.tableId);
        if (game && game.round !== 'waiting' && game.round !== 'finished') {
            var currentPlayer = game.players[game.currentPlayer];
            if (currentPlayer && currentPlayer.pubKey === fromPubKey) {
                game.act(fromPubKey, 'fold');
                game._flushDbUpdate();
            }
        }
        sql.removePlayerFromTable(message.tableId, fromPubKey, function() {
            debouncedRefreshLobby();
            debouncedRefreshTable(message.tableId);
        });
    },

    GAME_START: function(message, fromPubKey) {
        var existing = poker.getGame(message.tableId);
        if (existing && existing.round !== 'waiting' && existing.round !== 'finished') return;
        // Don't start game if channel is closed
        sql.getChannelById(message.channelId, function(row) {
            if (row && (row.STATUS || row.status) === 'CLOSED') { log('GAME_START ignored: channel CLOSED'); return; }
            poker.initGame(message.tableId, message.channelId, message.players, message.blinds, function() {
                debouncedRefreshTable(message.tableId);
            });
        });
    },

    REQUEST_NEW_CHANNEL: function(message, fromPubKey) {
        // Recipient: init channel (creates scripts/addresses) then save to DB, then notify browser
        var chan = new channel.Channel(message.tableId, message.participants, message.tokenId || '0x00', message.timeout || 30);
        chan.id = message.channelId;
        chan.status = 'FUNDING';
        chan.init(function(err) {
            if (err) { log('REQUEST_NEW_CHANNEL init failed: ' + err); }
            sql.insertChannelFull(chan, function() {
                channel.set(chan.id, chan);
                log('REQUEST_NEW_CHANNEL: channel saved, notifying browser');
                MDS.comms.solo(JSON.stringify({
                    type: 'CHANNEL_REQUEST',
                    channelId: message.channelId,
                    tableId: message.tableId,
                    from: fromPubKey,
                    participants: message.participants,
                    tokenId: message.tokenId,
                    timeout: message.timeout
                }));
            });
        });
    },

    REQUEST_ACCEPTED: function(message, fromPubKey) {
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for REQUEST_ACCEPTED: ' + message.channelId); return; }
            var myKey = getMyMaximaKey();
            var myAmount = '0';
            var totalAmount = new Decimal(0);
            // If chan.participants empty (DB load issue), use message participants
            var parts = (chan.participants && chan.participants.length > 0) ? chan.participants : (message.participants || []);
            log('REQUEST_ACCEPTED: participants=' + JSON.stringify(parts) + ' fundingAddress=' + chan.fundingAddress);
            for (var i = 0; i < parts.length; i++) {
                totalAmount = totalAmount.plus(parts[i].amount);
                if (parts[i].pubKey === myKey) myAmount = parts[i].amount;
            }
            log('REQUEST_ACCEPTED: totalAmount=' + totalAmount + ' myAmount=' + myAmount);
            if (totalAmount.equals(0)) { log('REQUEST_ACCEPTED: totalAmount is 0, aborting'); return; }
            channel.createFundingTxn(chan.fundingAddress, myAmount, totalAmount.toString(), chan.tokenId, function(err, fundingHex) {
                if (err) { log('createFundingTxn failed: ' + err); return; }
                // Add scripts+MMR for our own inputs before sending to Player B
                var mmrId = 'mmr_' + randomString();
                MDS.cmd('txnimport id:' + mmrId + ' data:' + fundingHex + ';txnscript id:' + mmrId + ' auto:true;txnmmr id:' + mmrId + ';txnexport id:' + mmrId + ';txndelete id:' + mmrId, function(mmrResp) {
                    var fundingWithMMR = (mmrResp && Array.isArray(mmrResp) && mmrResp[3] && mmrResp[3].response && mmrResp[3].response.data) ? mmrResp[3].response.data : fundingHex;
                    chan.fundingTx = fundingWithMMR;
                    signTxnAsync(chan.triggerTx, 'auto', function(err, signedTrigger) {
                        if (err) { log(err); return; }
                        signTxnAsync(chan.settlementTx, 'auto', function(err, signedSettle) {
                            if (err) { log(err); return; }
                            log('REQUEST_ACCEPTED: sending CREATE_CHANNEL fundingLen=' + fundingWithMMR.length);
                            maxima.sendRaw(fromPubKey, {
                                type: 'CREATE_CHANNEL', channelId: chan.id,
                                fundingTx: fundingWithMMR, triggerTx: signedTrigger, settlementTx: signedSettle
                            }, function() {});
                            sql.updateChannelAfterFunding(chan.id, null, 'FUNDING', null, function() {});
                        });
                    });
                });
            });
        });
    },

    REQUEST_DENIED: function(message, fromPubKey) {
        MDS.comms.solo(JSON.stringify({ type: 'CHANNEL_DENIED', tableId: message.tableId }));
    },

    CHANNEL_OPEN: function(message, fromPubKey) {
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for CHANNEL_OPEN: ' + message.channelId); return; }
            chan.status = 'OPEN';
            sql.updateChannelAfterFunding(chan.id, null, 'OPEN', null, function() {
                debouncedRefreshTable(chan.tableId || message.tableId);
            });
        });
    },

    CREATE_CHANNEL: function(message, fromPubKey) {
        log('CREATE_CHANNEL received for: ' + message.channelId);
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for CREATE_CHANNEL: ' + message.channelId); return; }
            chan.triggerTx    = message.triggerTx;
            chan.settlementTx = message.settlementTx;
            var myKey = getMyMaximaKey();
            var myAmount = '0';
            for (var i = 0; i < chan.participants.length; i++) {
                if (chan.participants[i].pubKey === myKey) { myAmount = chan.participants[i].amount; break; }
            }
            log('CREATE_CHANNEL: myAmount=' + myAmount + ' myKey=' + myKey.substring(0,20));
            channel.addToFundingTxn(message.fundingTx, myAmount, chan.tokenId, function(err, fundingWithMyFunds) {
                if (err) { log('addToFundingTxn failed: ' + err); return; }
                log('CREATE_CHANNEL: addToFundingTxn ok, adding scripts+MMR');
                var mmrId = 'mmr_' + randomString();
                MDS.cmd('txnimport id:' + mmrId + ' data:' + fundingWithMyFunds + ';txnscript id:' + mmrId + ' auto:true;txnmmr id:' + mmrId + ';txnexport id:' + mmrId + ';txndelete id:' + mmrId, function(mmrResp) {
                    var fundingMmr = (mmrResp && Array.isArray(mmrResp) && mmrResp[3] && mmrResp[3].response && mmrResp[3].response.data) ? mmrResp[3].response.data : fundingWithMyFunds;
                    log('CREATE_CHANNEL: signing trigger/settle');
                    signTxnAsync(chan.triggerTx, 'auto', function(err, trigger) {
                        if (err) { log('CREATE_CHANNEL sign trigger failed: ' + err); return; }
                        signTxnAsync(chan.settlementTx, 'auto', function(err, settle) {
                            if (err) { log('CREATE_CHANNEL sign settle failed: ' + err); return; }
                            signTxnAsync(fundingMmr, 'auto', function(err, funding) {
                                if (err) { log('CREATE_CHANNEL sign funding failed: ' + err); return; }
                                log('CREATE_CHANNEL: all signed, sending FINISH_START_CHANNEL');
                                chan.triggerTx    = trigger;
                                chan.settlementTx = settle;
                                chan.fundingTx    = funding;
                                sql.updateChannelTransactions(chan.id, funding, trigger, settle, function() {});
                                maxima.sendRaw(fromPubKey, {
                                    type: 'FINISH_START_CHANNEL', channelId: chan.id,
                                    fundingTx: funding
                                }, function() {});
                                sql.updateChannelAfterFunding(chan.id, null, 'FUNDING', null, function() {});
                            });
                        });
                    });
                });
            });
        });
    },

    FINISH_START_CHANNEL: function(message, fromPubKey) {
        log('FINISH_START_CHANNEL received for: ' + message.channelId);
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for FINISH_START_CHANNEL: ' + message.channelId); return; }
            log('FINISH_START_CHANNEL: signing funding tx');
            signTxnAsync(message.fundingTx, 'auto', function(err, signed) {
                if (err) { log('FINISH_START_CHANNEL sign failed: ' + err); return; }
                log('FINISH_START_CHANNEL: posting funding tx (auto:false, MMR already set by both parties)');
                var txid = 'post_' + randomString();
                MDS.cmd('txnimport id:' + txid + ' data:' + signed + ';txnpost id:' + txid + ' auto:false;txndelete id:' + txid, function(res) {
                    var postRes = Array.isArray(res) ? res[1] : null;
                    if (!postRes || !postRes.status) {
                        log('FINISH_START_CHANNEL: post failed: ' + JSON.stringify(postRes));
                        return;
                    }
                    log('FINISH_START_CHANNEL post result: ' + JSON.stringify(postRes));
                    chan.status = 'OPEN';
                    sql.updateChannelAfterFunding(chan.id, null, 'OPEN', null, function() {
                        maxima.sendRaw(fromPubKey, { type: 'CHANNEL_OPEN', channelId: chan.id, tableId: chan.tableId }, function() {});
                        debouncedRefreshTable(chan.tableId);
                    });
                });
            });
        });
    },

    SEND_FUNDS: function(message, fromPubKey) {
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for SEND_FUNDS: ' + message.channelId); return; }
            signTxnAsync(message.settlementTx, 'auto', function(err, settle) {
                if (err) { log(err); return; }
                signTxnAsync(message.updateTx, 'auto', function(err, update) {
                    if (err) { log(err); return; }
                    maxima.sendRaw(fromPubKey, {
                        type: 'REPLY_SEND_FUNDS', channelId: message.channelId,
                        settlementTx: settle, updateTx: update, sequence: message.sequence,
                        balances: message.balances, gameState: message.gameState
                    }, function() {});
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
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for REPLY_SEND_FUNDS'); return; }
            chan.settlementTx  = message.settlementTx;
            chan.updateTx      = message.updateTx;
            chan.sequence      = message.sequence;
            chan.balances      = message.balances || chan.balances;
            chan.lastGameState = message.gameState || chan.lastGameState;
            sql.updateChannelAfterUpdate(chan.id, chan.settlementTx, chan.updateTx, chan.balances, chan.lastGameState, chan.sequence, function() {
                channel.set(chan.id, chan);
                delete pendingUpdates[message.channelId];
                debouncedRefreshTable(chan.tableId);
            });
        });
    },

    SPEND_CHANNEL: function(message, fromPubKey) {
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('Channel not found for SPEND_CHANNEL'); return; }
            signTxnAsync(message.spendTx, 'auto', function(err, signed) {
                if (err) { log(err); return; }
                postTxnAsync(signed, function(err) {
                    if (err) { log(err); return; }
                    chan.status = 'CLOSED';
                    sql.updateChannelAfterFunding(chan.id, null, 'CLOSED', null, function() {
                        debouncedRefreshTable(chan.tableId);
                    });
                });
            });
        });
    },

    CHANNEL_CLOSE: function(message, fromPubKey) {
        sql.getChannelByTable(message.tableId, function(row) {
            if (row) sql.updateChannelAfterFunding(row.hashId, null, 'CLOSED', null, function() {
                debouncedRefreshTable(message.tableId);
            });
        });
    },

    DISPUTE_NOTIFY: function(message, fromPubKey) {
        MDS.comms.solo(JSON.stringify({ type: 'DISPUTE_NOTIFY', tableId: message.tableId, channelId: message.channelId }));
    },

    CLOSE_REQUEST: function(message, fromPubKey) {
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) { log('CLOSE_REQUEST: channel not found'); return; }
            // Find our walletKey from participants
            var myMaxKey = getMyMaximaKey();
            var myWalletKey = '';
            for (var i = 0; i < chan.participants.length; i++) {
                if (chan.participants[i].pubKey === myMaxKey) {
                    myWalletKey = chan.participants[i].walletKey || '';
                    break;
                }
            }
            if (!myWalletKey) myWalletKey = getMyWalletKey();
            log('CLOSE_REQUEST: signing with walletKey=' + myWalletKey.substring(0, 20));
            signTxnAsync(message.spendTx, myWalletKey, function(err, signed) {
                if (err) { log('CLOSE_REQUEST sign error: ' + err); return; }
                postTxnAsync(signed, function(err, res) {
                    if (err) { log('CLOSE_REQUEST post error: ' + err); return; }
                    log('CLOSE_REQUEST: posted ok');
                    chan.status = 'CLOSED';
                    sql.saveChannelSpendTx(chan.id, signed, function() {
                        channel.set(chan.id, chan);
                        maxima.sendRaw(fromPubKey, { type: 'CLOSE_ACCEPT', channelId: chan.id, tableId: chan.tableId }, function() {});
                        MDS.comms.solo(JSON.stringify({ type: 'CHANNEL_CLOSED', tableId: chan.tableId, channelId: chan.id }));
                        debouncedRefreshTable(chan.tableId);
                    });
                });
            });
        });
    },

    CLOSE_ACCEPT: function(message, fromPubKey) {
        getChannel(message.channelId, function(err, chan) {
            if (err || !chan) return;
            chan.status = 'CLOSED';
            sql.updateChannelAfterFunding(chan.id, null, 'CLOSED', null, function() {
                channel.set(chan.id, chan);
                MDS.comms.solo(JSON.stringify({ type: 'CHANNEL_CLOSED', tableId: chan.tableId, channelId: chan.id }));
                debouncedRefreshTable(chan.tableId);
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

    BET: function(message, fromPubKey) {
        var game = poker.getGame(message.tableId);
        if (!game) return;
        // Dedup: attach nonce or use action+player+round as key
        var betKey = message.tableId + ':' + game.round + ':' + game.currentPlayer + ':' + message.player + ':' + message.action;
        if (!betKey || (poker._lastBetKey && poker._lastBetKey === betKey)) return;
        var ok = game.act(message.player, message.action, message.amount);
        if (ok) {
            poker._lastBetKey = betKey;
            game._flushDbUpdate();
            debouncedRefreshTable(message.tableId);
            // Only enforcer (lowest pubKey) sends channel update
            var myKey = getMyMaximaKey();
            var isEnforcer = true;
            for (var i = 0; i < game.players.length; i++) {
                if (game.players[i].pubKey < myKey) { isEnforcer = false; break; }
            }
            if (isEnforcer) {
                sendChannelUpdate(game, function(success) {
                    if (!success) log('BET: sendChannelUpdate failed');
                });
            }
        }
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
