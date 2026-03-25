/**
 * lobby.js - Lobby UI for Minima Poker (ES5 compatible)
 */

var tables = [];

function initLobby(callback) {
    loadTables(callback);
    setupEventListeners();
}

function loadTables(callback) {
    sql.getTables(function(rows) {
        tables = rows || [];
        renderTableList();
        if (typeof window.loadTablesList === 'function') window.loadTablesList();
        if (callback) callback();
    });
}

function getTables(callback) {
    sql.getTables(function(rows) {
        callback(rows || []);
    });
}

function renderTableList() {
    var list = $('#tables');
    list.empty();
    if (tables.length === 0) {
        list.append('<li>No active tables. Create one!</li>');
        return;
    }
    for (var i = 0; i < tables.length; i++) {
        (function(table) {
            var tableId     = table.TABLEID     || table.tableId;
            var maxPlayers  = table.MAXPLAYERS  || table.maxPlayers  || '2';
            var blinds      = table.BLINDS      || table.blinds      || '10/20';
            var buyIn       = table.BUYIN       || table.buyIn       || '1000';
            var creatorName = table.CREATORNAME || table.creatorName || '';
            if (!tableId) return;

            sql.getPlayers(tableId, function(players) {
                var count = players ? players.length : 1;
                var title = creatorName ? creatorName + "'s Table" : 'Table ' + tableId.substring(0, 8);
                var item = document.createElement('li');
                item.className = 'table-item-clickable';
                item.innerHTML =
                    '<div class="table-info">' +
                        '<div class="table-name">' + title + '</div>' +
                        '<div class="table-details">' +
                            '<span>👥 ' + count + '/' + maxPlayers + '</span>' +
                            '<span>💰 ' + blinds + '</span>' +
                            '<span>🪙 ' + buyIn + '</span>' +
                        '</div>' +
                    '</div>';
                item.onclick = function() { joinTable(tableId); };

                // Show delete button only for the creator
                if (table.CREATOR === window.myMaximaKey || table.creator === window.myMaximaKey) {
                    var btn = document.createElement('button');
                    btn.className = 'table-delete-btn';
                    btn.title = 'Delete table';
                    btn.innerHTML = '🗑';
                    btn.onclick = function(e) {
                        e.stopPropagation();
                        pokerModal.confirm('Delete this table?', function(ok) {
                            if (!ok) return;
                            sql.getPlayers(tableId, function(players) {
                                var others = (players || []).filter(function(p) {
                                    return (p.playerPubKey || p.PLAYERPUBKEY) !== window.myMaximaKey;
                                });
                                if (others.length > 0) {
                                    pokerModal.alert('Cannot delete: ' + others.length + ' player(s) still at the table', 'error');
                                    return;
                                }
                                sql.deleteTable(tableId, function() {
                                    MDS.cmd('maxcontacts action:list', function(res) {
                                        var contacts = (res && res.response && res.response.contacts) ? res.response.contacts : [];
                                        var msg = { type: 'TABLE_DELETE', tableId: tableId };
                                        for (var c = 0; c < contacts.length; c++) {
                                            var key = contacts[c].publickey || '';
                                            if (key) maxima.sendWithAck(key, msg, function() {});
                                        }
                                    });
                                    loadTables();
                                });
                            });
                        });
                    };
                    item.appendChild(btn);
                }
                list.append(item);
            });
        })(tables[i]);
    }
}

function createTable() {
    if (!window.myMaximaKey) {
        pokerModal.alert('Wallet not initialized. Please wait and try again.', 'error');
        return;
    }
    pokerModal.prompt('Max players (2):', '2', function(maxPlayers) {
        if (!maxPlayers) return;
        var n = parseInt(maxPlayers);
        if (isNaN(n) || n !== 2) {
            pokerModal.alert('Max players must be 2', 'error');
            return;
        }
        pokerModal.prompt('Blinds (e.g. "10/20"):', '10/20', function(blinds) {
            if (!blinds) return;
            var parts = blinds.split('/');
            var sb = parseInt(parts[0]);
            var bb = parseInt(parts[1]);
            if (isNaN(sb) || isNaN(bb) || sb <= 0 || bb <= sb) {
                pokerModal.alert('Invalid blinds. Big blind must be greater than small blind.', 'error');
                return;
            }
            var minBuyIn  = bb * 20;
            var defBuyIn  = bb * 100;
            pokerModal.prompt(
                'Buy-in (min ' + minBuyIn + ' = 20BB, default ' + defBuyIn + ' = 100BB):',
                String(defBuyIn),
                function(buyIn) {
                    if (!buyIn) return;
                    var b = parseInt(buyIn);
                    if (isNaN(b) || b < minBuyIn) {
                        pokerModal.alert('Buy-in must be at least ' + minBuyIn + ' (' + '20 × ' + bb + ' BB)', 'error');
                        return;
                    }
                    _doCreateTable(n, blinds, b);
                }
            );
        });
    });
}

function _doCreateTable(maxPlayers, blinds, buyIn) {
    var table = {
        tableId:     utils.genTableId(),
        creator:     window.myMaximaKey,
        creatorName: window.myMaximaName || '',
        maxPlayers:  parseInt(maxPlayers),
        blinds:      blinds,
        buyIn:       String(buyIn || 1000),
        state:       'waiting'
    };

    sql.insertTable(table, function(res) {
        if (!res || !res.status) {
            pokerModal.alert('Failed to save table to database', 'error');
            return;
        }

        // Notify all contacts
        MDS.cmd('maxcontacts action:list', function(contactsRes) {
            var contacts = (contactsRes && contactsRes.status && contactsRes.response && contactsRes.response.contacts) ? contactsRes.response.contacts : [];
            var tableMsg = {
                type: 'TABLE_CREATE',
                protocolVersion: 1,
                table: {
                    tableId:     table.tableId,
                    creator:     table.creator,
                    creatorName: table.creatorName,
                    maxPlayers:  table.maxPlayers,
                    blinds:      table.blinds,
                    buyIn:       table.buyIn,
                    state:       table.state
                }
            };
            for (var i = 0; i < contacts.length; i++) {
                var key = contacts[i].publickey || '';
                if (key) maxima.sendWithAck(key, tableMsg, function() {});
            }
        });

        // Show share address and navigate
        MDS.cmd('maxima action:info', function(infoRes) {
            var addr = (infoRes && infoRes.status && infoRes.response && infoRes.response.contact) ? infoRes.response.contact : (window.myMaximaKey || '');
            pokerModal.alert(
                'Table created!<br><br>Share your address:<br>' +
                '<span style="font-family:monospace;font-size:0.75rem;word-break:break-all;color:#d4af37">' + addr + '</span>',
                'success',
                function() {
                    loadTables();
                    joinTable(table.tableId, true);
                }
            );
        });
    });
}

function joinTable(tableId, isCreator) {
    window.location.href = 'table.html?uid=' + MDS.minidappuid + '&tableId=' + tableId;
}

function setupEventListeners() {
    if (typeof $ !== 'undefined') {
        $('#createTable').off('click').click(createTable);
    }
}

function handleChannelRequest(data) {
    var shortFrom  = data.from    ? data.from.substring(0, 12)    + '...' : 'unknown';
    var shortTable = data.tableId ? data.tableId.substring(0, 8)  + '...' : 'unknown';

    pokerModal.confirm('Channel request from ' + shortFrom + ' for table ' + shortTable + '. Accept?', function(accepted) {
        if (!accepted) {
            maxima.sendWithAck(data.from, { type: 'REQUEST_DENIED', tableId: data.tableId }, function() {});
            return;
        }
        var chan = new channel.Channel(data.tableId, data.participants, data.tokenId || '0x00', data.timeout || 30);
        chan.id = data.channelId;
        chan.status = 'FUNDING';
        chan.blinds = data.blinds || '10/20';
        chan.buyIn = data.buyIn || '200';
        chan.init(function(err) {
            if (err) { pokerModal.alert('Failed to init channel: ' + err, 'error'); return; }
            sql.insertChannelFull(chan, function(res) {
                if (!res || !res.status) {
                    pokerModal.alert('Failed to save channel locally', 'error');
                    return;
                }
                channel.set(chan.id, chan);
                maxima.sendWithAck(data.from, { type: 'REQUEST_ACCEPTED', channelId: data.channelId, tableId: data.tableId, participants: data.participants }, function(success) {
                    if (success) pokerModal.alert('Channel accepted, waiting for funding...', 'success');
                    else pokerModal.alert('Failed to send acceptance', 'error');
                });
            });
        });
    });
}

function handleServiceMessage(message) {
    if (message.type === 'REFRESH_LOBBY') {
        loadTables();
    } else if (message.type === 'CHANNEL_REQUEST') {
        handleChannelRequest(message);
    } else if (message.type === 'LOBBY_CHAT') {
        if (window._lobbyChat && window._lobbyChat.receive) window._lobbyChat.receive(message);
    }
}

if (typeof window !== 'undefined') {
    window.lobby = {
        init:                 initLobby,
        handleServiceMessage: handleServiceMessage,
        createTable:          createTable,
        joinTable:            joinTable,
        loadTables:           loadTables,
        getTables:            getTables
    };
}
