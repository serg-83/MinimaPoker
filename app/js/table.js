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
    TURN_TIMEOUT:    60000,
    PHASE_TIMEOUT:   40000,

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
            var newStatus = ch ? (ch.status || ch.STATUS) : null;
            if (newStatus === 'OPEN' && prevStatus !== 'OPEN' && self._isEnforcer()) {
                self._autoStartGame();
            }
            // Restore dispute poller if channel is in DISPUTE state
            if (newStatus === 'DISPUTE' && !self._disputePoller && ch) {
                var chan = channel.fromRow(ch);
                if (chan) self._startDisputePoller(chan);
            }
        });
    },

    loadGameState: function() {
        var self = this;
        var oldState = this.gameState;

        sql.getGameState(this.tableId, function(state) {
            if (!state) {
                // No game yet — render seats (players may already be loaded)
                self._markDirty('seats');
                self.scheduleUpdate();
                return;
            }
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

            // Generate commit secret and auto-send
            if (state.round === 'commit') {
                // Only reset secret if our reveal was already accepted (appears in state.reveals)
                var ourRevealAccepted = state.reveals && window.myMaximaKey && state.reveals[window.myMaximaKey];
                if (!oldState || oldState.round !== 'commit') {
                    if (ourRevealAccepted || !self.mySecret) {
                        self.mySecret = null;
                        self.myCommitHash = null;
                    }
                    self._revealSent = false;
                }
                if (!self.mySecret && self.myPlayerIndex !== -1) {
                    self.mySecret = utils.genRandomHexString(64);
                    if (window.cryptoUtils && window.cryptoUtils.commit) {
                        window.cryptoUtils.commit(self.mySecret, '', function(err, hash) {
                            if (!err && hash) { self.myCommitHash = hash; self.sendCommit(); }
                        });
                    } else {
                        self.myCommitHash = btoa(self.mySecret);
                        self.sendCommit();
                    }
                }
            }
            // Auto-send reveal when round changes to reveal
            if (state.round === 'reveal' && self.mySecret && !self._revealSent) {
                self._revealSent = true;
                self.sendReveal();
            }
            if (state.round !== 'reveal' && state.round !== 'commit') { self._revealSent = false; }

            // Show winner and auto-start next hand
            if (state.round === 'finished' && (!oldState || oldState.round !== 'finished') && !self._nextHandScheduled) {
                self._nextHandScheduled = true;
                self._markDirty('phase');
                if (self._isEnforcer()) {
                    setTimeout(function() {
                        self._nextHandScheduled = false;
                        // Don't start new hand if channel is closed
                        var status = self.channelInfo ? (self.channelInfo.status || self.channelInfo.STATUS) : null;
                        if (status === 'CLOSED') return;
                        self._autoStartGame();
                    }, 4000);
                }
            }
            if (state.round === 'commit') { self._nextHandScheduled = false; }

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
            self._positionCache = null;
            self._markDirty('seats');
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
            html = '<div class="phase-controls"><p>Shuffling deck... (' +
                (this.myCommitHash ? 'committed' : 'generating...') + ')</p></div>';
        } else if (this.gameState.round === 'reveal') {
            html = '<div class="phase-controls"><p>Revealing secrets... (' +
                (this._revealSent ? 'revealed' : 'sending...') + ')</p></div>';
        } else if (this.gameState.round === 'finished') {
            var winners = [];
            try { winners = JSON.parse(this.gameState.lastaction || this.gameState.lastAction || '[]'); } catch(e) {}
            var winText = '';
            if (Array.isArray(winners) && winners.length > 0) {
                for (var wi = 0; wi < winners.length; wi++) {
                    var wn = winners[wi];
                    var name = wn.name || (wn.pubKey ? wn.pubKey.substring(0, 8) + '...' : '?');
                    winText += name + ' wins ' + wn.amount + ' (' + wn.desc + ') ';
                }
            } else {
                winText = 'Hand finished';
            }
            // Check if any player is bust (stack <= big blind)
            var bb = this.channelInfo ? parseInt((this.channelInfo.blinds || '10/20').split('/')[1] || 20) : 20;
            var bustPlayer = null;
            if (this.channelInfo && this.channelInfo.balances) {
                for (var bi = 0; bi < (this.players || []).length; bi++) {
                    var pk = this.players[bi].playerPubKey;
                    if (parseInt(this.channelInfo.balances[pk] || 0) <= bb) {
                        bustPlayer = this.players[bi].playerName || pk.substring(0,8) + '...';
                        break;
                    }
                }
            }
            var nextLine = bustPlayer
                ? '<p style="color:#f39c12">⚠️ ' + bustPlayer + ' is out of chips!</p><button id="closeChannelBtn" class="primary" style="margin-top:6px">Close Channel</button>'
                : '<p style="font-size:0.8em;opacity:0.7">Next hand starting...</p>';
            html = '<div class="phase-controls"><p>🏆 ' + winText.trim() + '</p>' + nextLine + '</div>';
        }
        if (html) {
            $('#phase-controls').html(html);
            $('#commitBtn').click(function() { tableUI.sendCommit(); });
            $('#revealBtn').click(function() { tableUI.sendReveal(); });
            $('#closeChannelBtn').click(function() { tableUI.closeChannelCooperative(); });
        }
    },

    renderChannelStatus: function() {
        var html;
        if (this.channelInfo) {
            var s = this.channelInfo.status || 'FUNDING';
            var color = s === 'OPEN' ? 'green' : (s === 'FUNDING' ? 'orange' : (s === 'CLOSED' ? 'gray' : 'red'));
            html = '<strong>Channel:</strong> <span style="color:' + color + ';">' + s + '</span>';
            if (s === 'OPEN') {
                html += ' <button id="closeChannelBtn2" class="primary" style="font-size:0.75rem;padding:3px 10px">Close Channel</button>';
            }
        } else {
            html = '<button id="createChannelBtn" class="primary">Create Channel</button>';
        }
        var el = document.getElementById('channel-status');
        if (!el) return;
        el.innerHTML = html;
        $('#createChannelBtn').click(function() { tableUI.createChannel(); });
        $('#closeChannelBtn2').click(function() { tableUI.showCloseChannelDialog(); });
    },

    showCloseChannelDialog: function() {
        var self = this;
        pokerModal.choice(
            'Close Channel',
            'How do you want to close the channel?',
            [
                { label: 'Cooperative (instant)', value: 'coop' },
                { label: 'Dispute (on-chain, ~30 min)', value: 'dispute' }
            ],
            function(choice) {
                if (choice === 'coop') self.closeChannelCooperative();
                else if (choice === 'dispute') self.startDispute();
            }
        );
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
                participants.push({ pubKey: self.players[i].playerPubKey, walletKey: self.players[i].walletKey || '', address: self.players[i].address, amount: buyIn });
            }
            var chan = new channel.Channel(self.tableId, participants, '0x00', 30);
            chan.status = 'FUNDING';
            pokerModal.alert('Initializing channel scripts...', 'info');
            chan.init(function(err) {
                if (err) { pokerModal.alert('Failed to init channel: ' + err, 'error'); return; }
                sql.insertChannelFull(chan, function(res) {
                    if (!res || !res.status) { pokerModal.alert('Failed to save channel to database', 'error'); return; }
                    var msg = { type: 'REQUEST_NEW_CHANNEL', channelId: chan.id, tableId: self.tableId, participants: participants, tokenId: '0x00', timeout: 30 };
                    for (var j = 0; j < self.players.length; j++) {
                        (function(p) {
                            if (p.playerPubKey !== window.myMaximaKey) maxima.sendRaw(p.playerPubKey, msg, function() {});
                        })(self.players[j]);
                    }
                    channel.set(chan.id, chan);
                    pokerModal.alert('Channel request sent, waiting for acceptance...', 'success');
                    self.loadChannelInfo();
                });
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
            var gameMsg = {
                type: 'GAME_START',
                tableId: self.tableId,
                channelId: self.channelInfo.hashId || self.channelInfo.HASHID,
                players: playersWithStack,
                blinds: { small: parts[0], big: parts[1] }
            };
            // Send to service (enforcer's own node) via comms
            MDS.comms.solo(JSON.stringify(gameMsg));
            self._sendToAllPlayers(gameMsg, function(ok) {
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
        if (this.players.length === 0) { $('#seats').html('<div class="loading">Waiting for players to join...</div>'); return; }
        var seatsEl = $('#seats');
        seatsEl.removeClass('seats-2 seats-4');
        var n = this.players.length;
        if (n === 2) seatsEl.addClass('seats-2');
        else seatsEl.addClass('seats-4');

        var positions = this.calculatePositions(n);

        // Derive own cards from seed (never stored in DB)
        var myCards = [];
        var state = this.gameState;
        if (state && state.reveals && state.round !== 'commit' && state.round !== 'reveal' && state.round !== 'waiting') {
            var seeds = [];
            for (var rk in state.reveals) { if (state.reveals.hasOwnProperty(rk)) seeds.push(state.reveals[rk]); }
            if (seeds.length > 0 && this.myPlayerIndex >= 0) {
                try {
                    var combinedSeed = cryptoUtils.combineSeeds(seeds);
                    var deck = cryptoUtils.generateDeck();
                    var shuffled = cryptoUtils.seededShuffle(deck, combinedSeed);
                    myCards = [shuffled[this.myPlayerIndex * 2], shuffled[this.myPlayerIndex * 2 + 1]];
                } catch(e) {}
            }
        }

        var html = '';
        for (var i = 0; i < n; i++) {
            var p = this.players[i];
            var pos = positions[i];
            var isMe = (i === this.myPlayerIndex);
            var stack;
            if (this.channelInfo && this.channelInfo.balances && this.channelInfo.balances[p.playerPubKey]) {
                stack = this.channelInfo.balances[p.playerPubKey];
            } else {
                stack = '?';
            }

            // Determine card count for this player from playerCards metadata
            var cardCount = 0;
            if (state && state.playerCards) {
                for (var pc = 0; pc < state.playerCards.length; pc++) {
                    if (state.playerCards[pc].pubKey === p.playerPubKey) {
                        cardCount = state.playerCards[pc].cardCount || (state.playerCards[pc].cards ? state.playerCards[pc].cards.length : 0);
                        break;
                    }
                }
            }

            var bets  = (state && state.bets) ? (typeof state.bets === 'string' ? JSON.parse(state.bets) : state.bets) : {};
            var bet   = bets[p.playerPubKey] || 0;

            var posClass = '';
            if (state) {
                if (state.button     === i) posClass = ' button-seat';
                else if (state.smallBlind === i) posClass = ' small-blind-seat';
                else if (state.bigBlind   === i) posClass = ' big-blind-seat';
            }
            var turnClass = (state && parseInt(state.turn) === i) ? ' current-turn' : '';

            var cardsHtml = '';
            if (isMe && myCards.length > 0) {
                for (var ci = 0; ci < myCards.length; ci++) {
                    var c = myCards[ci];
                    var isRed = c.indexOf('h') !== -1 || c.indexOf('d') !== -1;
                    var suitChar = {'h':'♥','d':'♦','c':'♣','s':'♠'}[c[c.length-1]] || c[c.length-1];
                    var rank = c.slice(0, c.length - 1);
                    cardsHtml += '<div class="card' + (isRed ? ' red' : '') + '" data-suit="' + suitChar + '">' +
                        '<span class="card-rank">' + rank + '</span>' +
                        '<span class="card-suit">' + suitChar + '</span>' +
                        '</div>';
                }
            } else if (!isMe && cardCount > 0) {
                for (var ci2 = 0; ci2 < cardCount; ci2++) {
                    cardsHtml += '<div class="card card-back"></div>';
                }
            }

            html += '<div class="seat' + posClass + turnClass + '" data-pubkey="' + p.playerPubKey + '" style="top:' + pos.top + '%;left:' + pos.left + '%;">' +
                '<div class="name">' + p.playerName + (isMe ? ' (you)' : '') + '</div>' +
                '<div class="stack">' + stack + '</div>' +
                '<div class="cards">' + cardsHtml + '</div>' +
                '<div>Bet: ' + bet + '</div>';
            if (state && parseInt(state.turn) === i) {
                html += '<div class="turn-timer"><div class="turn-timer-bar"></div></div>';
            }
            html += '</div>';
        }
        seatsEl.html(html);

        if (state && parseInt(state.turn) === this.myPlayerIndex) {
            var bar = $('.current-turn .turn-timer-bar');
            if (bar.length) {
                bar.css({ width: '0%', transition: 'none' });
                setTimeout(function() { bar.css({ width: '100%', transition: 'width 60s linear' }); }, 50);
            }
        }
    },

    renderCommunity: function() {
        if (!this.gameState || !this.gameState.communityCards) return;
        var html = '';
        for (var i = 0; i < this.gameState.communityCards.length; i++) {
            var c = this.gameState.communityCards[i];
            var isRed = c.indexOf('h') !== -1 || c.indexOf('d') !== -1;
            var suitChar = c.length > 1 ? {'h':'♥','d':'♦','c':'♣','s':'♠'}[c[c.length-1]] || c[c.length-1] : '';
            var rank = c.length > 1 ? c.slice(0, c.length-1) : c;
            html += '<div class="card' + (isRed ? ' red' : '') + '" data-suit="' + suitChar + '">' +
                '<span class="card-rank">' + rank + '</span>' +
                '<span class="card-suit">' + suitChar + '</span>' +
                '</div>';
        }
        $('#community').html(html);
    },

    renderPot: function() {
        $('#pot').text('Pot: ' + (this.gameState ? this.gameState.pot || '0' : '0'));
    },

    calculatePositions: function(n) {
        var myIdx = this.myPlayerIndex < 0 ? 0 : this.myPlayerIndex;
        var cacheKey = n + '_' + myIdx;
        if (this._positionCache && this._lastPlayerCount === cacheKey) return this._positionCache;
        var positions = new Array(n);
        var step  = (2 * Math.PI) / n;
        // myIdx always at bottom (angle = -π/2 = 270°)
        var baseAngle = -Math.PI / 2;
        for (var i = 0; i < n; i++) {
            var angle = baseAngle + step * ((i - myIdx + n) % n);
            positions[i] = { top: 50 + 38 * Math.sin(angle), left: 50 + 42 * Math.cos(angle) };
        }
        this._positionCache   = positions;
        this._lastPlayerCount = cacheKey;
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

    closeChannelCooperative: function() {
        if (!this.channelInfo) { pokerModal.alert('No channel to close', 'error'); return; }
        var self = this;
        sql.getChannelByTable(self.tableId, function(row) {
            if (!row) { pokerModal.alert('Channel not found', 'error'); return; }
            var chan = channel.fromRow(row);
            if (!chan) { pokerModal.alert('Channel data unavailable', 'error'); return; }
            chan.closeCooperative(function(err) {
                if (err) { pokerModal.alert('Close failed: ' + err, 'error'); return; }
                self._clearTimers();
                self.loadChannelInfo();
            });
        });
    },

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
                // Notify other players
                self._sendToAllPlayers({ type: 'DISPUTE_NOTIFY', tableId: self.tableId, channelId: chan.id }, function() {});
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
        var isMyTurn   = this.gameState && parseInt(this.gameState.turn) === this.myPlayerIndex;
        var currentBet = this.gameState ? parseInt(this.gameState.currentbet || this.gameState.currentBet || 0) : 0;
        var myBet = 0;
        if (isMyTurn && this.gameState && this.players && this.players[this.myPlayerIndex]) {
            var bets = this.gameState.bets || {};
            if (typeof bets === 'string') { try { bets = JSON.parse(bets); } catch(e) { bets = {}; } }
            myBet = parseInt(bets[this.players[this.myPlayerIndex].playerPubKey] || 0);
        }
        var needToCall = currentBet > myBet;
        $('#foldBtn').prop('disabled', !isMyTurn);
        $('#callBtn').prop('disabled', !(isMyTurn && needToCall));
        $('#raiseBtn').prop('disabled', !isMyTurn);
        $('#checkBtn').prop('disabled', !(isMyTurn && !needToCall));
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
        var msg = { type: 'BET', tableId: this.tableId, player: window.myMaximaKey, action: action, amount: amount || '0' };
        MDS.comms.solo(JSON.stringify(msg));
        this._sendToAllPlayers(msg, function(ok) {
            if (!ok) pokerModal.alert('Failed to send action', 'error');
        });
    },

    sendCommit: function() {
        if (!this.myCommitHash) { pokerModal.alert('Commit hash not ready', 'error'); return; }
        if (!this.players || this.players.length === 0) { pokerModal.alert('Players not loaded', 'error'); return; }
        var msg = { type: 'COMMIT', tableId: this.tableId, playerPubKey: window.myMaximaKey, commitHash: this.myCommitHash };
        MDS.comms.solo(JSON.stringify(msg));
        this._sendToAllPlayers(msg, function(ok) {
            if (ok) $('#commitBtn').prop('disabled', true).text('Commit sent');
            else pokerModal.alert('Failed to send commit', 'error');
        });
    },

    sendReveal: function() {
        if (!this.mySecret) { pokerModal.alert('Secret not available', 'error'); return; }
        var msg = { type: 'REVEAL', tableId: this.tableId, playerPubKey: window.myMaximaKey, secret: this.mySecret };
        MDS.comms.solo(JSON.stringify(msg));
        this._sendToAllPlayers(msg, function(ok) {
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
        if (message.type === 'CHANNEL_REQUEST') { handleChannelRequest(message); return; }
        if (message.type === 'CHANNEL_DENIED') { pokerModal.alert('Channel request denied', 'error'); return; }
        if (message.type === 'TABLE_DELETED' && message.tableId === this.tableId) {
            pokerModal.alert('Table was deleted', 'warning');
            setTimeout(function() { goBackToLobby(); }, 1500);
            return;
        }
        if (message.type === 'CHANNEL_CLOSED' && message.tableId === this.tableId) {
            this._clearTimers();
            var tid = this.tableId;
            // Delete table and go to lobby
            sql.deleteTable(tid, function() {
                MDS.cmd('maxcontacts action:list', function(res) {
                    var contacts = (res && res.response && res.response.contacts) ? res.response.contacts : [];
                    for (var i = 0; i < contacts.length; i++) {
                        var key = contacts[i].publickey || '';
                        if (key) maxima.sendRaw(key, { type: 'TABLE_DELETE', tableId: tid }, function() {});
                    }
                });
            });
            setTimeout(function() { goBackToLobby(); }, 500);
            return;
        }
        if (message.type === 'DISPUTE_NOTIFY' && message.tableId === this.tableId) {
            var self = this;
            pokerModal.confirm('Opponent started a dispute! Start your own dispute to protect your funds?', function(ok) {
                if (ok) self.startDispute();
            });
            return;
        }
        if (message.tableId && message.tableId !== this.tableId) return;
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
        maxima.registerHandler('DISPUTE_NOTIFY', function(msg) {
            if (msg.tableId === self.tableId) self.handleServiceMessage(msg);
        });
    }
};

if (typeof window !== 'undefined') window.tableUI = tableUI;

function handleChannelRequest(data) {
    var shortFrom = data.from ? data.from.substring(0, 12) + '...' : 'unknown';
    pokerModal.confirm('Channel request from ' + shortFrom + '. Accept?', function(accepted) {
        if (!accepted) {
            maxima.sendRaw(data.from, { type: 'REQUEST_DENIED', tableId: data.tableId }, function() {});
            return;
        }
        var chan = new channel.Channel(data.tableId, data.participants, data.tokenId || '0x00', data.timeout || 30);
        chan.id = data.channelId;
        chan.status = 'FUNDING';
        chan.init(function(err) {
            if (err) { pokerModal.alert('Failed to init channel: ' + err, 'error'); return; }
            sql.insertChannelFull(chan, function(res) {
                if (!res || !res.status) { pokerModal.alert('Failed to save channel', 'error'); return; }
                channel.set(chan.id, chan);
                maxima.sendRaw(data.from, { type: 'REQUEST_ACCEPTED', channelId: data.channelId, tableId: data.tableId, participants: data.participants }, function() {
                    pokerModal.alert('Channel accepted, waiting for funding...', 'success');
                });
            });
        });
    });
}
