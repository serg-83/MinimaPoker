/**
 * table.js - Poker table UI for Minima Poker (ES5 compatible)
 */

var tableUI = {
    tableId:         null,
    gameState:       null,
    channelInfo:     null,
    myPlayerIndex:   -1,
    isCreator:       false,
    mySecret:        null,
    myCommitHash:    null,
    players:         null,
    _positionCache:  null,
    _lastPlayerCount: 0,
    _updateScheduled: false,
    _dirtyComponents: {},
    _turnTimer:      null,
    _phaseTimer:     null,
    _disputePoller:  null,
    TURN_TIMEOUT:    30000,
    PHASE_TIMEOUT:   20000,

    init: function(tableId) {
        this.tableId = tableId;
        this.loadChannelInfo();
        this.loadGameState();
        this.setupMaximaHandlers();
        this.setupEventListeners();
    },

    loadChannelInfo: function() {
        var self = this;
        var prevStatus = this.channelInfo ? (this.channelInfo.status || this.channelInfo.STATUS) : null;
        sql.getChannelByTable(this.tableId, function(ch) {
            self.channelInfo = ch;
            self.renderChannelStatus();
            // Auto-start game when channel just became OPEN (enforcer only)
            var newStatus = ch ? (ch.status || ch.STATUS) : null;
            if (newStatus === 'OPEN' && prevStatus !== 'OPEN' && self._isEnforcer()) {
                self._autoStartGame();
            }
        });
    },

    loadGameState: function() {
        var self = this;
        var oldState = this.gameState;

        sql.getGameState(this.tableId, function(state) {
            if (!state) { self.renderWaiting(); return; }
            self.gameState = state;

            if (oldState) {
                if (JSON.stringify(oldState.communityCards) !== JSON.stringify(state.communityCards)) self._markDirty('community');
                if (oldState.pot !== state.pot) self._markDirty('pot');
                if (oldState.round !== state.round) self._markDirty('phase');
                if (oldState.turn !== state.turn || JSON.stringify(oldState.playerCards) !== JSON.stringify(state.playerCards)) {
                    self._markDirty('seats');
                    self._markDirty('controls');
                }
            } else {
                self._markDirty('all');
            }

            // Generate commit secret if needed
            if (state.round === 'commit' && !self.mySecret && self.myPlayerIndex !== -1) {
                self.mySecret = utils.genRandomHexString(64);
                if (window.cryptoUtils && window.cryptoUtils.commit) {
                    window.cryptoUtils.commit(self.mySecret, '', function(err, hash) {
                        if (!err && hash) { self.myCommitHash = hash; self._markDirty('phase'); self.scheduleUpdate(); }
                    });
                } else {
                    self.myCommitHash = btoa(self.mySecret);
                }
            }

            // Start timeout timers (host enforces)
            var prevRound = oldState ? oldState.round : null;
            var prevTurn  = oldState ? oldState.turn  : -1;
            if (state.round === 'commit' && prevRound !== 'commit') {
                self._startPhaseTimer('commit');
            } else if (state.round === 'reveal' && prevRound !== 'reveal') {
                self._startPhaseTimer('reveal');
            } else if (state.turn !== prevTurn &&
                       state.round !== 'commit' && state.round !== 'reveal' &&
                       state.round !== 'waiting' && state.round !== 'finished') {
                self._startTurnTimer();
            }

            self.scheduleUpdate();
        });

        sql.getPlayers(this.tableId, function(players) {
            var oldCount = self.players ? self.players.length : -1;
            self.players = players;
            self.myPlayerIndex = -1;
            for (var i = 0; i < players.length; i++) {
                if (players[i].playerPubKey === window.myMaximaKey) { self.myPlayerIndex = i; break; }
            }
            if (oldCount !== players.length) { self._positionCache = null; self._markDirty('seats'); }
            self.scheduleUpdate();
        });
    },

    _markDirty: function(c) { this._dirtyComponents[c] = true; },

    scheduleUpdate: function() {
        if (this._updateScheduled) return;
        var self = this;
        this._updateScheduled = true;
        setTimeout(function() {
            self._updateScheduled = false;
            self.performUpdate();
        }, 16);
    },

    performUpdate: function() {
        var d = this._dirtyComponents;
        if (d.all || d.seats)      this.renderSeats();
        if (d.all || d.community)  this.renderCommunity();
        if (d.all || d.pot)        this.renderPot();
        if (d.all || d.phase)      this.renderPhaseControls();
        if (d.all || d.controls)   this.updateControls();
        this._dirtyComponents = {};
    },

    renderWaiting: function() {
        $('#seats').html('<div class="loading">Waiting for players to join...</div>');
    },

    renderPhaseControls: function() {
        if (!this.gameState) return;
        var html = '';
        if (this.gameState.round === 'commit') {
            html = this.myCommitHash
                ? '<div class="phase-controls"><p>Commit phase.</p><button id="commitBtn" class="primary">Send Commit</button></div>'
                : '<div class="phase-controls"><p>Generating commitment...</p></div>';
        } else if (this.gameState.round === 'reveal') {
            html = (this.gameState.reveals && this.gameState.reveals[window.myMaximaKey])
                ? '<div class="phase-controls"><p>Reveal sent. Waiting...</p></div>'
                : '<div class="phase-controls"><p>Reveal phase.</p><button id="revealBtn" class="primary">Send Reveal</button></div>';
        }
        if (html) {
            $('#phase-controls').html(html);
            $('#commitBtn').click(function() { tableUI.sendCommit(); });
            $('#revealBtn').click(function() { tableUI.sendReveal(); });
        }
    },

    renderChannelStatus: function() {
        var html;
        if (this.channelInfo) {
            var s = this.channelInfo.status || 'FUNDING';
            var color = s === 'OPEN' ? 'green' : (s === 'FUNDING' ? 'orange' : 'red');
            html = '<strong>Channel:</strong> <span style="color:' + color + ';">' + s + '</span>' +
                (s === 'OPEN' || s === 'DISPUTE' ? ' <button id="disputeBtn" class="danger">Dispute</button>' : '');
        } else {
            html = '<button id="createChannelBtn" class="primary">Create Channel</button>';
        }
        var el = document.getElementById('channel-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'channel-status';
            var game = document.getElementById('game');
            if (game) game.parentNode.insertBefore(el, game);
        }
        el.innerHTML = html;
        $('#createChannelBtn').click(function() { tableUI.createChannel(); });
        $('#disputeBtn').click(function() { tableUI.startDispute(); });
    },

    createChannel: function() {
        if (!this.players || this.players.length < 2) {
            pokerModal.alert('Need at least 2 players to create a channel', 'error');
            return;
        }
        if (this.players.length > 4) {
            pokerModal.alert('Channels support max 4 players', 'error');
            return;
        }
        var self = this;
        sql.getTableById(this.tableId, function(table) {
            if (!table) { pokerModal.alert('Table not found', 'error'); return; }
            var buyIn  = String(table.BUYIN  || table.buyIn  || '1000');
            var blinds = String(table.BLINDS || table.blinds || '10/20');
            var bb     = parseInt((blinds.split('/')[1]) || 20);
            var minBuyIn = bb * 20;
            if (parseInt(buyIn) < minBuyIn) {
                pokerModal.alert('Buy-in ' + buyIn + ' is below minimum ' + minBuyIn + ' (20 × ' + bb + ' BB). Edit the table.', 'error');
                return;
            }
            var participants = [];
            for (var i = 0; i < self.players.length; i++) {
                participants.push({ pubKey: self.players[i].playerPubKey, address: self.players[i].address, amount: buyIn });
            }
            var chan = new channel.Channel(self.tableId, participants, '0x00', 30);
            chan.status = 'FUNDING';
            sql.insertChannelFull(chan, function(res) {
                if (!res || !res.status) { pokerModal.alert('Failed to save channel to database', 'error'); return; }
                var msg = { type: 'REQUEST_NEW_CHANNEL', channelId: chan.id, tableId: self.tableId, participants: participants, tokenId: '0x00', timeout: 30 };
                for (var j = 0; j < self.players.length; j++) {
                    (function(p) {
                        if (p.playerPubKey !== window.myMaximaKey) maxima.sendWithAck(p.playerPubKey, msg, function() {});
                    })(self.players[j]);
                }
                channel.set(chan.id, chan);
                pokerModal.alert('Channel creation request sent', 'success');
                self.loadChannelInfo();
            });
        });
    },

    // Auto-triggered by enforcer when channel opens
    _autoStartGame: function() {
        var self = this;
        sql.getTableById(this.tableId, function(table) {
            if (!table) return;
            var parts  = (table.blinds || table.BLINDS || '10/20').split('/');
            var buyIn  = parseInt(table.buyIn || table.BUYIN || 1000);
            // Attach initialStack to each player from buyIn
            var playersWithStack = [];
            for (var i = 0; i < self.players.length; i++) {
                var p = self.players[i];
                playersWithStack.push({
                    pubKey:       p.playerPubKey,
                    name:         p.playerName || '',
                    address:      p.address,
                    initialStack: buyIn
                });
            }
            self._sendToAllPlayers({
                type: 'GAME_START',
                tableId: self.tableId,
                channelId: self.channelInfo.hashId || self.channelInfo.HASHID,
                players: playersWithStack,
                blinds: { small: parseInt(parts[0]), big: parseInt(parts[1]) }
            }, function(ok) {
                if (!ok) MDS.log('Auto-start game failed, will retry on next channel update');
            });
        });
    },

    startGame: function() {
        if (!this.channelInfo || (this.channelInfo.status || this.channelInfo.STATUS) !== 'OPEN') {
            pokerModal.alert('Channel not open yet', 'error');
            return;
        }
        this._autoStartGame();
    },

    renderSeats: function() {
        if (!this.players) return;
        var seatsEl = $('#seats');
        seatsEl.removeClass('seats-2 seats-4');
        var n = this.players.length;
        if (n === 2) seatsEl.addClass('seats-2');
        else seatsEl.addClass('seats-4');

        var positions = this.calculatePositions(n);
        var html = '';
        for (var i = 0; i < n; i++) {
            var p = this.players[i];
            var pos = positions[i];
            var isMe = (i === this.myPlayerIndex);
            var stack = (this.channelInfo && this.channelInfo.balances) ? (this.channelInfo.balances[p.playerPubKey] || '0') : '?';

            var playerGame = null;
            if (this.gameState && this.gameState.playerCards) {
                for (var pc = 0; pc < this.gameState.playerCards.length; pc++) {
                    if (this.gameState.playerCards[pc].pubKey === p.playerPubKey) { playerGame = this.gameState.playerCards[pc]; break; }
                }
            }
            var cards = playerGame ? playerGame.cards : [];
            var bet   = playerGame ? playerGame.bet   : 0;

            var posClass = '';
            var posTip   = '';
            if (this.gameState) {
                if (this.gameState.button     === i) { posClass = ' button-seat';      posTip = ' data-tooltip="Dealer button"'; }
                else if (this.gameState.smallBlind === i) { posClass = ' small-blind-seat'; posTip = ' data-tooltip="Small Blind"'; }
                else if (this.gameState.bigBlind   === i) { posClass = ' big-blind-seat';   posTip = ' data-tooltip="Big Blind"'; }
            }
            var turnClass = (this.gameState && this.gameState.turn === i) ? ' current-turn' : '';

            var cardsHtml = '';
            for (var ci = 0; ci < cards.length; ci++) {
                var c = cards[ci];
                var cls = 'card' + (c.indexOf('h') !== -1 || c.indexOf('d') !== -1 ? ' red' : '');
                var suit = c.length > 1 ? c[1] : '';
                cardsHtml += '<div class="' + cls + '" data-suit="' + suit + '" style="animation-delay:' + (ci * 0.1) + 's">' + c + '</div>';
            }

            html += '<div class="seat' + posClass + turnClass + '" data-pubkey="' + p.playerPubKey + '" style="top:' + pos.top + '%;left:' + pos.left + '%;"' + posTip + '>' +
                '<div class="name">' + p.playerName + (isMe ? ' (you)' : '') + '</div>' +
                '<div class="stack">' + stack + '</div>' +
                '<div class="cards">' + cardsHtml + '</div>' +
                '<div>Bet: ' + bet + '</div>';
            if (this.gameState && this.gameState.turn === i) {
                html += '<div class="turn-timer"><div class="turn-timer-bar"></div></div>';
            }
            html += '</div>';
        }
        seatsEl.html(html);

        // Animate turn timer
        if (this.gameState && this.gameState.turn === this.myPlayerIndex) {
            var bar = $('.current-turn .turn-timer-bar');
            if (bar.length) {
                bar.css({ width: '0%', transition: 'none' });
                setTimeout(function() { bar.css({ width: '100%', transition: 'width 30s linear' }); }, 50);
            }
        }
    },

    renderCommunity: function() {
        if (!this.gameState || !this.gameState.communityCards) return;
        var html = '';
        for (var i = 0; i < this.gameState.communityCards.length; i++) {
            var c = this.gameState.communityCards[i];
            var cls = 'card' + (c.indexOf('h') !== -1 || c.indexOf('d') !== -1 ? ' red' : '');
            var suit = c.length > 1 ? c[1] : '';
            html += '<div class="' + cls + '" data-suit="' + suit + '" style="animation-delay:' + (i * 0.1) + 's">' + c + '</div>';
        }
        $('#community').html(html);
    },

    renderPot: function() {
        $('#pot').text('Pot: ' + (this.gameState ? this.gameState.pot || '0' : '0'));
    },

    calculatePositions: function(n) {
        if (this._positionCache && this._lastPlayerCount === n) return this._positionCache;
        var positions = [];
        var step  = (2 * Math.PI) / n;
        var angle = Math.PI / 2;
        for (var i = 0; i < n; i++) {
            positions.push({ top: 50 + 35 * Math.sin(angle), left: 50 + 38 * Math.cos(angle) });
            angle -= step;
        }
        this._positionCache  = positions;
        this._lastPlayerCount = n;
        return positions;
    },

    // ---- Timeout enforcement (host only) ----

    _clearTimers: function() {
        if (this._turnTimer)  { clearTimeout(this._turnTimer);  this._turnTimer  = null; }
        if (this._phaseTimer) { clearTimeout(this._phaseTimer); this._phaseTimer = null; }
        if (this._disputePoller) { clearInterval(this._disputePoller); this._disputePoller = null; }
    },

    _startTurnTimer: function() {
        if (!this.gameState) return;
        this._clearTimers();
        var self = this;
        var timedOutIndex = this.gameState.turn;
        var timedOutKey   = this.players && this.players[timedOutIndex] && this.players[timedOutIndex].playerPubKey;

        // Visual timer bar (all players)
        var bar = $('.current-turn .turn-timer-bar');
        if (bar.length) {
            bar.css({ width: '0%', transition: 'none' });
            setTimeout(function() { bar.css({ width: '100%', transition: 'width ' + (self.TURN_TIMEOUT / 1000) + 's linear' }); }, 50);
        }

        // Enforcer auto-folds
        if (!this._isEnforcer()) return;
        this._turnTimer = setTimeout(function() {
            self._turnTimer = null;
            if (!self.gameState || self.gameState.turn !== timedOutIndex) return;
            MDS.log('Turn timeout: auto-folding ' + timedOutKey);
            self._notifyAutoAction(timedOutKey, 'fold');
            self._sendToAllPlayers({
                type: 'BET', tableId: self.tableId,
                player: timedOutKey, action: 'fold', amount: '0', autoFold: true
            }, function() {});
        }, self.TURN_TIMEOUT);
    },

    _startPhaseTimer: function(phase) {
        if (!this._isEnforcer() || !this.gameState) return;
        this._clearTimers();
        var self = this;
        this._phaseTimer = setTimeout(function() {
            self._phaseTimer = null;
            if (!self.gameState || self.gameState.round !== phase) return;
            if (!self.players) return;
            for (var i = 0; i < self.players.length; i++) {
                var pk = self.players[i].playerPubKey;
                var missing = (phase === 'commit')
                    ? !(self.gameState.commits && self.gameState.commits[pk])
                    : !(self.gameState.reveals && self.gameState.reveals[pk]);
                if (missing) {
                    MDS.log('Phase timeout: forcing ' + phase + ' for ' + pk);
                    self._notifyAutoAction(pk, phase + '-forced');
                    var msgType = (phase === 'commit') ? 'COMMIT' : 'REVEAL';
                    var zeroVal = '0000000000000000000000000000000000000000000000000000000000000000';
                    self._sendToAllPlayers({
                        type: msgType, tableId: self.tableId,
                        playerPubKey: pk,
                        commitHash: zeroVal, secret: zeroVal,
                        forced: true
                    }, function() {});
                }
            }
        }, self.PHASE_TIMEOUT);
    },

    // Show toast when a player is auto-acted
    _notifyAutoAction: function(pubKey, action) {
        var name = pubKey.substring(0, 8) + '...';
        if (this.players) {
            for (var i = 0; i < this.players.length; i++) {
                if (this.players[i].playerPubKey === pubKey) {
                    name = this.players[i].playerName || name;
                    break;
                }
            }
        }
        var msg = name + ' timed out';
        if (action === 'fold') msg += ' — auto-folded';
        else if (action === 'commit-forced') msg += ' — commit forced';
        else if (action === 'reveal-forced') msg += ' — reveal forced';
        pokerModal.alert(msg, 'warning');
    },

    // ---- Dispute & claim ----

    startDispute: function() {
        if (!this.channelInfo) { pokerModal.alert('No channel to dispute', 'error'); return; }
        var self = this;
        sql.getChannelByTable(this.tableId, function(row) {
            if (!row) { pokerModal.alert('Channel not found', 'error'); return; }
            var chan = channel.fromRow(row);
            if (!chan) { pokerModal.alert('Channel data unavailable', 'error'); return; }
            chan.startDispute(function(err) {
                if (err) { pokerModal.alert('Dispute failed: ' + err, 'error'); return; }
                pokerModal.alert('Dispute started. Settlement claimable in ~30 blocks (~30 min).', 'success');
                self._clearTimers();
                self.loadChannelInfo();
                self._startDisputePoller(chan);
            });
        });
    },

    _startDisputePoller: function(chan) {
        if (this._disputePoller) clearInterval(this._disputePoller);
        var self = this;
        // Poll every 60 seconds to check if timeout has passed
        this._disputePoller = setInterval(function() {
            MDS.cmd('block', function(resp) {
                if (!resp || !resp.response || !resp.response.block) return;
                var current = parseInt(resp.response.block);
                var start   = parseInt(chan.disputeStartBlock || 0);
                var timeout = parseInt(chan.timeoutBlocks || 30);
                var remaining = timeout - (current - start);
                MDS.log('Dispute poller: ' + remaining + ' blocks remaining');
                if (remaining <= 0) {
                    clearInterval(self._disputePoller);
                    self._disputePoller = null;
                    self._claimSettlement(chan);
                }
            });
        }, 60000);
    },

    _claimSettlement: function(chan) {
        var self = this;
        chan.claimSettlement(function(err, res) {
            if (err) {
                pokerModal.alert('Claim failed: ' + err, 'error');
                return;
            }
            pokerModal.alert('Settlement claimed! Funds distributed on-chain.', 'success');
            self.loadChannelInfo();
        });
    },

    // Determine if this client should enforce timeouts.
    // The player with the lexicographically smallest pubKey acts as enforcer.
    // This way if the host disconnects, another player takes over.
    _isEnforcer: function() {
        if (!this.players || this.players.length === 0) return this.isCreator;
        var minKey = null;
        for (var i = 0; i < this.players.length; i++) {
            var pk = this.players[i].playerPubKey;
            if (!minKey || pk < minKey) minKey = pk;
        }
        return window.myMaximaKey === minKey;
    },

    updateControls: function() {
        var isMyTurn   = this.gameState && this.gameState.turn === this.myPlayerIndex;
        var currentBet = this.gameState ? (this.gameState.currentBet || 0) : 0;
        $('#foldBtn').prop('disabled', !isMyTurn);
        $('#callBtn').prop('disabled', !(isMyTurn && currentBet > 0));
        $('#raiseBtn').prop('disabled', !isMyTurn);
        $('#checkBtn').prop('disabled', !(isMyTurn && currentBet === 0));
    },

    setupEventListeners: function() {
        $('#foldBtn').click(function() { tableUI.sendAction('fold'); });
        $('#callBtn').click(function() { tableUI.sendAction('call'); });
        $('#raiseBtn').click(function() {
            pokerModal.prompt('Enter raise amount:', '', function(amount) {
                if (amount) tableUI.sendAction('raise', amount);
            });
        });
        $('#checkBtn').click(function() { tableUI.sendAction('check'); });
    },

    sendAction: function(action, amount) {
        if (!this.tableId) return;
        var self = this;
        this._sendToAllPlayers({
            type: 'BET', tableId: this.tableId,
            player: window.myMaximaKey, action: action, amount: amount || '0'
        }, function(ok) {
            if (ok) { if (self.gameState) self.gameState.lastAction = action; self.updateControls(); }
            else pokerModal.alert('Failed to send action', 'error');
        });
    },

    sendCommit: function() {
        if (!this.myCommitHash) { pokerModal.alert('Commit hash not ready', 'error'); return; }
        this._sendToAllPlayers({ type: 'COMMIT', tableId: this.tableId, playerPubKey: window.myMaximaKey, commitHash: this.myCommitHash }, function(ok) {
            if (ok) $('#commitBtn').prop('disabled', true).text('Commit sent');
            else pokerModal.alert('Failed to send commit', 'error');
        });
    },

    sendReveal: function() {
        if (!this.mySecret) { pokerModal.alert('Secret not available', 'error'); return; }
        this._sendToAllPlayers({ type: 'REVEAL', tableId: this.tableId, playerPubKey: window.myMaximaKey, secret: this.mySecret }, function(ok) {
            if (ok) $('#revealBtn').prop('disabled', true).text('Reveal sent');
            else pokerModal.alert('Failed to send reveal', 'error');
        });
    },

    _sendToAllPlayers: function(message, callback) {
        if (!this.players || this.players.length === 0) { callback(false); return; }
        var recipients = [];
        for (var i = 0; i < this.players.length; i++) {
            var pk = this.players[i].playerPubKey || this.players[i].pubKey;
            if (pk && pk !== window.myMaximaKey) recipients.push(pk);
        }
        if (recipients.length === 0) { callback(true); return; }
        var sent = 0, failed = false;
        for (var j = 0; j < recipients.length; j++) {
            (function(key) {
                maxima.sendWithAck(key, message, function(ok) {
                    if (!ok) failed = true;
                    if (++sent === recipients.length) callback(!failed);
                });
            })(recipients[j]);
        }
    },

    handleServiceMessage: function(message) {
        this.loadChannelInfo();
        this.loadGameState();
    },

    setupMaximaHandlers: function() {
        var self = this;
        var reload = function(msg) { if (msg.tableId === self.tableId) self.loadGameState(); };
        var reloadCh = function(msg) { if (msg.tableId === self.tableId) { self.loadChannelInfo(); self.loadGameState(); } };
        maxima.registerHandler('BET',          reload);
        maxima.registerHandler('GAME_START',   reload);
        maxima.registerHandler('DEAL',         reload);
        maxima.registerHandler('REVEAL',       reload);
        maxima.registerHandler('COMMIT',       reload);
        maxima.registerHandler('CHANNEL_UPDATE', reloadCh);
        maxima.registerHandler('CHANNEL_CLOSE', function(msg) {
            if (msg.tableId === self.tableId) { self._clearTimers(); self.loadChannelInfo(); }
        });
    }
};

if (typeof window !== 'undefined') window.tableUI = tableUI;
