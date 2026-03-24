/**
 * sql.js - SQLite wrapper for Minima Poker via MDS.sql (ES5 compatible)
 */

var SQL = {
    // Simple query cache: { key: { ts, rows } }
    _cache: {},

    _invalidateCache: function(pattern) {
        if (!pattern) { this._cache = {}; return; }
        for (var k in this._cache) {
            if (this._cache.hasOwnProperty(k) && k.indexOf(pattern) !== -1) delete this._cache[k];
        }
    },

    // Escape a string value for inline SQL
    _esc: function(v) {
        if (v === null || v === undefined) return "''";
        return "'" + String(v).replace(/'/g, "''") + "'";
    },

    createTables: function(callback) {
        var queries = [
            'CREATE TABLE IF NOT EXISTS tables (' +
                'tableId TEXT PRIMARY KEY, creator TEXT, creatorName TEXT DEFAULT \'\', ' +
                'maxPlayers INTEGER, blinds TEXT, buyIn TEXT DEFAULT \'1000\', state TEXT DEFAULT \'waiting\', created INTEGER)',
            'CREATE TABLE IF NOT EXISTS players (' +
                'tableId TEXT, playerPubKey TEXT, playerName TEXT, address TEXT, walletKey TEXT DEFAULT \'\', joined BIGINT, ' +
                'PRIMARY KEY (tableId, playerPubKey))',
            'CREATE TABLE IF NOT EXISTS channels (' +
                'hashId TEXT PRIMARY KEY, tableId TEXT, fundingTx TEXT, triggerTx TEXT, ' +
                'settlementTx TEXT, updateTx TEXT, fundingAddress TEXT, eltooAddress TEXT, ' +
                'participants TEXT, balances TEXT, lastGameState TEXT, signatures TEXT, ' +
                'status TEXT, sequence INTEGER DEFAULT 0, timeout INTEGER, fundingTxId TEXT, ' +
                'disputeStartBlock INTEGER, fundingSpent INTEGER DEFAULT 0, ' +
                'payoutFound INTEGER DEFAULT 0, payoutAmount TEXT, createdAt BIGINT, ' +
                'spendTx TEXT DEFAULT \'\', closedAt BIGINT DEFAULT 0)',
            'CREATE TABLE IF NOT EXISTS channel_states (' +
                'id INTEGER AUTO_INCREMENT PRIMARY KEY, channelId TEXT, sequence INTEGER, ' +
                'state TEXT, signatures TEXT, createdAt BIGINT)',
            'CREATE TABLE IF NOT EXISTS game_states (' +
                'tableId TEXT PRIMARY KEY, round TEXT, pot TEXT, communityCards TEXT, ' +
                'playerCards TEXT, players TEXT, turn INTEGER, lastAction TEXT, commits TEXT, reveals TEXT)',
            'CREATE TABLE IF NOT EXISTS logs (' +
                'hashId TEXT, timestamp BIGINT, event TEXT, details TEXT)',
            'CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER PRIMARY KEY)'
        ];
        var self = this;
        // Check if migration already done (version 2 = BIGINT timestamps)
        MDS.sql("CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER PRIMARY KEY)", function() {
            MDS.sql("SELECT version FROM _schema_version WHERE version=2", function(vres) {
                if (vres && vres.status && vres.rows && vres.rows.length > 0) {
                    // v2 done — check v3 (add spendTx, closedAt to channels)
                    MDS.sql("SELECT version FROM _schema_version WHERE version=3", function(v3res) {
                        if (v3res && v3res.status && v3res.rows && v3res.rows.length > 0) {
                            runCreates();
                        } else {
                            var m3 = [
                                "ALTER TABLE channels ADD COLUMN spendTx TEXT DEFAULT ''",
                                "ALTER TABLE channels ADD COLUMN closedAt BIGINT DEFAULT 0",
                                "INSERT INTO _schema_version (version) VALUES (3)"
                            ];
                            var mi3 = 0;
                            function runM3() {
                                if (mi3 >= m3.length) { runCreates(); return; }
                                MDS.sql(m3[mi3++], function() { runM3(); });
                            }
                            runM3();
                        }
                    });
                } else {
                    // Run migration
                    var migrations = [
                        'DROP TABLE IF EXISTS players',
                        'DROP TABLE IF EXISTS channels',
                        'DROP TABLE IF EXISTS channel_states',
                        'DROP TABLE IF EXISTS logs',
                        'DELETE FROM _schema_version',
                        'INSERT INTO _schema_version (version) VALUES (2)',
                        'INSERT INTO _schema_version (version) VALUES (3)'
                    ];
                    var mi = 0;
                    function runMigrations() {
                        if (mi >= migrations.length) { runCreates(); return; }
                        MDS.sql(migrations[mi++], function() { runMigrations(); });
                    }
                    runMigrations();
                }
            });
        });
        function runCreates() {
            var remaining = queries.length;
            for (var i = 0; i < queries.length; i++) {
                (function(q) {
                    MDS.sql(q, function() {
                        if (--remaining === 0) { self._invalidateCache('tables'); if (callback) callback(); }
                    });
                })(queries[i]);
            }
        }
    },

    // -------------------- Tables --------------------
    insertTable: function(table, callback) {
        var self = this;
        var q = 'MERGE INTO tables (tableId, creator, creatorName, maxPlayers, blinds, buyIn, state, created) KEY(tableId) VALUES (' +
            this._esc(table.tableId) + ',' + this._esc(table.creator) + ',' + this._esc(table.creatorName) + ',' +
            parseInt(table.maxPlayers) + ',' + this._esc(table.blinds) + ',' + this._esc(table.buyIn || '1000') + ',' +
            this._esc(table.state || 'waiting') + ',' + Math.floor(Date.now() / 1000) + ')';
        MDS.sql(q, function(res) {
            if (res && res.status) self._invalidateCache('tables');
            if (callback) callback(res);
        });
    },

    getTables: function(callback) {
        this._invalidateCache('tables');
        MDS.sql("SELECT * FROM tables WHERE state != 'finished' ORDER BY created DESC", function(res) {
            callback((res && res.status && res.rows) ? res.rows : []);
        });
    },

    getTableById: function(tableId, callback) {
        MDS.sql("SELECT * FROM tables WHERE tableId=" + this._esc(tableId), function(res) {
            if (!res || !res.status || !res.rows || !res.rows.length) { callback(null); return; }
            var row = res.rows[0];
            // Normalize uppercase MDS column names to lowercase
            var r = {};
            for (var k in row) { if (row.hasOwnProperty(k)) r[k.toLowerCase()] = row[k]; }
            r.tableId     = r.tableid;
            r.creatorName = r.creatorname;
            r.maxPlayers  = r.maxplayers;
            r.buyIn       = r.buyin;
            callback(r);
        });
    },

    deleteTable: function(tableId, callback) {
        var self = this;
        var id = this._esc(tableId);
        MDS.sql("DELETE FROM tables WHERE tableId=" + id, function() {
            MDS.sql("DELETE FROM players WHERE tableId=" + id, function() {
                // Keep channel in history — just clear tableId link
                MDS.sql("UPDATE channels SET tableId='' WHERE tableId=" + id, function() {
                    // Trim history to 100 most recent
                    MDS.sql("DELETE FROM channels WHERE hashId NOT IN (SELECT hashId FROM channels ORDER BY rowid DESC LIMIT 100)", function() {
                        self._invalidateCache('tables');
                        self._invalidateCache(tableId);
                        if (callback) callback();
                    });
                });
            });
        });
    },

    getAllChannels: function(callback) {
        var self = this;
        MDS.sql("SELECT * FROM channels ORDER BY rowid DESC LIMIT 100", function(res) {
            var rows = (res && res.status && res.rows) ? res.rows : [];
            callback(rows.map(function(r) { return self._parseChannelRow(r); }));
        });
    },

    deleteChannel: function(channelId, callback) {
        var id = this._esc(channelId);
        MDS.sql("DELETE FROM channels WHERE id=" + id, function(res) {
            if (callback) callback(res);
        });
    },

    // -------------------- Players --------------------
    addPlayerToTable: function(tableId, player, callback) {
        var self = this;
        var q = 'MERGE INTO players (tableId, playerPubKey, playerName, address, walletKey, joined) KEY(tableId, playerPubKey) VALUES (' +
            this._esc(tableId) + ',' + this._esc(player.pubKey) + ',' + this._esc(player.name) + ',' +
            this._esc(player.address) + ',' + this._esc(player.walletKey || '') + ',' + Math.floor(Date.now()/1000) + ')';
        MDS.sql(q, function(res) {
            self._invalidateCache('players');
            self._invalidateCache(tableId);
            if (callback) callback(res);
        });
    },

    removePlayerFromTable: function(tableId, pubKey, callback) {
        var self = this;
        MDS.sql("DELETE FROM players WHERE tableId=" + this._esc(tableId) + " AND playerPubKey=" + this._esc(pubKey), function(res) {
            self._invalidateCache('players');
            self._invalidateCache(tableId);
            if (callback) callback(res);
        });
    },

    getPlayers: function(tableId, callback) {
        MDS.sql("SELECT * FROM players WHERE tableId=" + this._esc(tableId), function(res) {
            if (!res || !res.status || !res.rows) { callback([]); return; }
            var rows = res.rows.map(function(row) {
                var r = {};
                for (var k in row) { if (row.hasOwnProperty(k)) r[k.toLowerCase()] = row[k]; }
                r.playerPubKey = r.playerpubkey;
                r.playerName   = r.playername;
                r.tableId      = r.tableid;
                r.walletKey    = r.walletkey || '';
                return r;
            });
            callback(rows);
        });
    },

    // -------------------- Channels --------------------
    insertChannelFull: function(ch, callback) {
        var q = 'MERGE INTO channels (' +
            'hashId, tableId, fundingTx, triggerTx, settlementTx, updateTx, fundingAddress, eltooAddress, ' +
            'participants, balances, lastGameState, signatures, status, sequence, timeout, fundingTxId, ' +
            'disputeStartBlock, createdAt) KEY(hashId) VALUES (' +
            this._esc(ch.id) + ',' + this._esc(ch.tableId) + ',' + this._esc(ch.fundingTx || '') + ',' +
            this._esc(ch.triggerTx || '') + ',' + this._esc(ch.settlementTx || '') + ',' + this._esc(ch.updateTx || '') + ',' +
            this._esc(ch.fundingAddress || '') + ',' + this._esc(ch.eltooAddress || '') + ',' +
            this._esc(JSON.stringify(ch.participants || [])) + ',' + this._esc(JSON.stringify(ch.balances || {})) + ',' +
            this._esc(JSON.stringify(ch.lastGameState || {})) + ',' + this._esc(JSON.stringify(ch.signatures || {})) + ',' +
            this._esc(ch.status || 'FUNDING') + ',' + (ch.sequence || 0) + ',' + (ch.timeoutBlocks || 0) + ',' +
            this._esc(ch.fundingTxId || '') + ',' + (ch.disputeStartBlock || 'NULL') + ',' + Math.floor(Date.now()/1000) + ')';
        MDS.sql(q, callback);
    },

    updateChannelAfterFunding: function(channelId, fundingTxId, status, disputeStartBlock, callback) {
        if (typeof disputeStartBlock === 'function') { callback = disputeStartBlock; disputeStartBlock = null; }
        var sets = [];
        if (fundingTxId !== null && fundingTxId !== undefined) sets.push("fundingTxId=" + this._esc(fundingTxId));
        if (status !== null && status !== undefined) sets.push("status=" + this._esc(status));
        if (disputeStartBlock !== null && disputeStartBlock !== undefined) sets.push("disputeStartBlock=" + disputeStartBlock);
        if (status === 'CLOSED') sets.push("closedAt=" + Date.now());
        if (sets.length === 0) { if (callback) callback(null); return; }
        MDS.sql("UPDATE channels SET " + sets.join(',') + " WHERE hashId=" + this._esc(channelId), callback);
    },

    saveChannelSpendTx: function(channelId, spendTx, callback) {
        MDS.sql("UPDATE channels SET spendTx=" + this._esc(spendTx) + ",status='CLOSED',closedAt=" + Date.now() +
            " WHERE hashId=" + this._esc(channelId), callback);
    },

    updateChannelStateWithSignatures: function(channelId, balances, gameState, sequence, signatures, callback) {
        MDS.sql("UPDATE channels SET balances=" + this._esc(JSON.stringify(balances)) +
            ",lastGameState=" + this._esc(JSON.stringify(gameState)) +
            ",sequence=" + sequence + ",signatures=" + this._esc(JSON.stringify(signatures)) +
            " WHERE hashId=" + this._esc(channelId), callback);
    },

    updateChannelAfterUpdate: function(channelId, settlementTx, updateTx, balances, gameState, sequence, callback) {
        MDS.sql("UPDATE channels SET settlementTx=" + this._esc(settlementTx) +
            ",updateTx=" + this._esc(updateTx) +
            ",balances=" + this._esc(JSON.stringify(balances)) +
            ",lastGameState=" + this._esc(JSON.stringify(gameState)) +
            ",sequence=" + sequence + " WHERE hashId=" + this._esc(channelId), callback);
    },

    updateChannelTransactions: function(channelId, fundingTx, triggerTx, settlementTx, callback) {
        MDS.sql("UPDATE channels SET fundingTx=" + this._esc(fundingTx) +
            ",triggerTx=" + this._esc(triggerTx) +
            ",settlementTx=" + this._esc(settlementTx) +
            " WHERE hashId=" + this._esc(channelId), callback);
    },

    _parseChannelRow: function(row) {
        // MDS.sql returns uppercase column names — normalize to lowercase
        var r = {};
        for (var k in row) {
            if (row.hasOwnProperty(k)) r[k.toLowerCase()] = row[k];
        }
        r.participants  = JSON.parse(r.participants  || '[]');
        r.balances      = JSON.parse(r.balances      || '{}');
        r.lastgamestate = JSON.parse(r.lastgamestate || '{}');
        r.signatures    = JSON.parse(r.signatures    || '{}');
        // Alias for Channel.fromRow compatibility
        r.lastGameState = r.lastgamestate;
        r.tableId       = r.tableid;
        r.fundingTx     = r.fundingtx;
        r.triggerTx     = r.triggertx;
        r.settlementTx  = r.settlementtx;
        r.updateTx      = r.updatetx;
        r.fundingAddress = r.fundingaddress;
        r.eltooAddress  = r.eltooaddress;
        r.tokenId       = r.tokenid;
        r.hashId        = r.hashid;
        r.fundingTxId   = r.fundingtxid;
        r.disputeStartBlock = r.disputestartblock;
        r.fundingSpent  = r.fundingspent;
        r.payoutFound   = r.payoutfound;
        r.payoutAmount  = r.payoutamount;
        return r;
    },

    getChannelById: function(channelId, callback) {
        var self = this;
        MDS.sql("SELECT * FROM channels WHERE hashId=" + this._esc(channelId), function(res) {
            callback((res && res.status && res.rows && res.rows.length > 0) ? self._parseChannelRow(res.rows[0]) : null);
        });
    },

    getChannelByTable: function(tableId, callback) {
        var self = this;
        MDS.sql("SELECT * FROM channels WHERE tableId=" + this._esc(tableId), function(res) {
            callback((res && res.status && res.rows && res.rows.length > 0) ? self._parseChannelRow(res.rows[0]) : null);
        });
    },

    selectChannelByCoin: function(address, callback) {
        var self = this;
        MDS.sql("SELECT * FROM channels WHERE fundingAddress=" + this._esc(address), function(res) {
            callback((res && res.status && res.rows && res.rows.length > 0) ? self._parseChannelRow(res.rows[0]) : null);
        });
    },

    getDisputedChannels: function(callback) {
        var self = this;
        MDS.sql("SELECT * FROM channels WHERE status='DISPUTE'", function(res) {
            if (!res || !res.status || !res.rows) { callback([]); return; }
            var rows = [];
            for (var i = 0; i < res.rows.length; i++) rows.push(self._parseChannelRow(res.rows[i]));
            callback(rows);
        });
    },

    updateClosedChannels: function(callback) {
        var where = " status!='CLOSED' AND ((fundingSpent=1 AND payoutFound=1) OR status='CANCELLED' OR status='DENIED')";
        var self = this;
        MDS.sql("SELECT hashId FROM channels WHERE" + where, function(res) {
            if (!res || !res.count) { if (callback) callback(false); return; }
            for (var i = 0; i < res.count; i++) {
                if (self.insertLog) self.insertLog(res.rows[i].HASHID, 'CHANNEL_CLOSE', 'Channel closed');
            }
            MDS.sql("UPDATE channels SET status='CLOSED' WHERE" + where, function() {
                if (callback) callback(true);
            });
        });
    },

    selectEltooChannels: function(callback) {
        MDS.sql("SELECT hashId, status, eltooAddress, sequence FROM channels WHERE eltooAddress IS NOT NULL AND eltooAddress != '' AND status NOT IN ('CLOSED','CANCELLED')", function(res) {
            if (callback) callback(res);
        });
    },

    selectRelevantFundingCoin: function(address, callback) {
        MDS.sql("SELECT * FROM channels WHERE fundingAddress=" + this._esc(address), function(res) {
            if (callback) callback(res);
        });
    },

    selectPayoutCoin: function(hashId, callback) {
        MDS.sql("SELECT * FROM channels WHERE hashId=" + this._esc(hashId), function(res) {
            if (callback) callback(res);
        });
    },

    updateFundingSpent: function(hashId, callback) {
        MDS.sql("UPDATE channels SET fundingSpent=1, status='START_CLOSE' WHERE hashId=" + this._esc(hashId), function(res) {
            if (callback) callback(res);
        });
    },

    updatePayoutFound: function(hashId, amount, callback) {
        MDS.sql("UPDATE channels SET payoutFound=1, payoutAmount=" + this._esc(amount) + " WHERE hashId=" + this._esc(hashId), function(res) {
            if (callback) callback(res);
        });
    },

    // -------------------- Channel states --------------------
    saveChannelState: function(channelId, state, signatures, callback) {
        var q = 'INSERT INTO channel_states (channelId, sequence, state, signatures, createdAt) VALUES (' +
            this._esc(channelId) + ',' + state.sequence + ',' +
            this._esc(JSON.stringify(state)) + ',' + this._esc(JSON.stringify(signatures)) + ',' + Math.floor(Date.now()/1000) + ')';
        MDS.sql(q, callback);
    },

    getLatestChannelState: function(channelId, callback) {
        MDS.sql("SELECT * FROM channel_states WHERE channelId=" + this._esc(channelId) + " ORDER BY sequence DESC LIMIT 1", function(res) {
            if (!res || !res.status || !res.rows || !res.rows.length) { callback(null); return; }
            var raw = res.rows[0];
            var row = {};
            for (var k in raw) { if (raw.hasOwnProperty(k)) row[k.toLowerCase()] = raw[k]; }
            row.state      = JSON.parse(row.state      || '{}');
            row.signatures = JSON.parse(row.signatures || '{}');
            callback(row);
        });
    },

    // -------------------- Game states --------------------
    setGameState: function(state, callback) {
        var q = 'MERGE INTO game_states (tableId, round, pot, communityCards, playerCards, players, turn, lastAction, commits, reveals) KEY(tableId) VALUES (' +
            this._esc(state.tableId) + ',' + this._esc(state.round) + ',' + this._esc(state.pot) + ',' +
            this._esc(JSON.stringify(state.communityCards || [])) + ',' + this._esc(JSON.stringify(state.playerCards || [])) + ',' +
            this._esc(JSON.stringify(state.bets || {})) + ',' +
            (state.turn || 0) + ',' + this._esc(state.lastAction) + ',' +
            this._esc(JSON.stringify(state.commits || {})) + ',' + this._esc(JSON.stringify(state.reveals || {})) + ')';
        MDS.sql(q, callback);
    },

    getGameState: function(tableId, callback) {
        MDS.sql("SELECT * FROM game_states WHERE tableId=" + this._esc(tableId), function(res) {
            if (!res || !res.status || !res.rows || !res.rows.length) { callback(null); return; }
            var raw = res.rows[0];
            var row = {};
            for (var k in raw) { if (raw.hasOwnProperty(k)) row[k.toLowerCase()] = raw[k]; }
            row.communityCards = JSON.parse(row.communitycards || '[]');
            row.playerCards    = JSON.parse(row.playercards    || '[]');
            row.commits        = JSON.parse(row.commits        || '{}');
            row.reveals        = JSON.parse(row.reveals        || '{}');
            var bets = JSON.parse(row.players || '{}');
            row.bets = bets;
            row.currentBet = 0;
            for (var k2 in bets) { if (bets.hasOwnProperty(k2) && bets[k2] > row.currentBet) row.currentBet = bets[k2]; }
            callback(row);
        });
    },

    // -------------------- Logs --------------------
    insertLog: function(hashId, event, details, callback) {
        if (typeof SHOW_LOGS !== 'undefined' && SHOW_LOGS && typeof MDS !== 'undefined' && MDS.log) {
            MDS.log(hashId + '> ' + event + ': ' + (typeof details === 'string' ? details : JSON.stringify(details)));
        }
        var q = 'INSERT INTO logs (hashId, timestamp, event, details) VALUES (' +
            this._esc(hashId) + ',' + Math.floor(Date.now()/1000) + ',' + this._esc(event) + ',' +
            this._esc(typeof details === 'string' ? details : JSON.stringify(details)) + ')';
        MDS.sql(q, callback || function() {});
    },

    getLogs: function(hashId, callback) {
        MDS.sql("SELECT * FROM logs WHERE hashId=" + this._esc(hashId) + " ORDER BY timestamp DESC", function(res) {
            callback((res && res.status && res.rows) ? res.rows : []);
        });
    }
};

if (typeof window !== 'undefined') window.sql = SQL;
if (typeof sql === 'undefined') var sql = SQL;
