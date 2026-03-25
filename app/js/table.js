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
    _readyPlayers:   {},
    _prevChannelStatus: null,
    TURN_TIMEOUT:    60000,
    PHASE_TIMEOUT:   40000,

    init: function(tableId) {
        this.tableId = tableId;
        this.loadChannelInfo();
        this.loadGameState();
        this.setupMaximaHandlers();
        this.setupEventListeners();

        // Poll channel status every 3 seconds to detect OPEN status and trigger auto-start
        var self = this;
        this._channelPollInterval = setInterval(function() {
            self.loadChannelInfo();
        }, 3000);
    },

    loadChannelInfo: function() {
        var self = this;
        MDS.log('TABLE loadChannelInfo: tableId=' + this.tableId + ' prevStatus=' + this._prevChannelStatus);
        sql.getChannelByTable(this.tableId, function(ch) {
            self.channelInfo = ch;
            self.renderChannelStatus();
            var newStatus = ch ? (ch.status || ch.STATUS) : null;
            MDS.log('TABLE loadChannelInfo: newStatus=' + newStatus + ' prevStatus=' + self._prevChannelStatus + ' isEnforcer=' + self._isEnforcer());
            if (newStatus === 'OPEN' && self._prevChannelStatus !== 'OPEN' && self._isEnforcer()) {
                MDS.log('TABLE loadChannelInfo: triggering auto-start game');
                self._autoStartGame();
            } else {
                MDS.log('TABLE loadChannelInfo: auto-start conditions not met - newStatus=' + newStatus + ' prevStatus=' + self._prevChannelStatus + ' isEnforcer=' + self._isEnforcer());
            }
            // Update prevStatus for next check
            self._prevChannelStatus = newStatus;
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

            // Show winner notification and wait for ready
            if (state.round === 'finished' && (!oldState || oldState.round !== 'finished') && !self._nextHandScheduled) {
                self._nextHandScheduled = true;
                self._markDirty('phase');
                self._showHandResult(state);
            }
            if (state.round === 'commit') { self._nextHandScheduled = false; self._readyPlayers = {}; }

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

    renderPhaseControls: function() {
        if (!this.gameState) return;
        var round = this.gameState.round;
        $('#commitBtn').toggle(round === 'commit');
        $('#revealBtn').toggle(round === 'reveal');
        var msg = '';
        if (round === 'commit') {
            msg = 'Shuffling deck... (' + (this.myCommitHash ? 'committed' : 'generating...') + ')';
        } else if (round === 'reveal') {
            msg = 'Revealing secrets... (' + (this._revealSent ? 'revealed' : 'sending...') + ')';
        } else if (round === 'finished') {
            $('#closeChannelBtn').hide(); // Auto-close, no manual close needed
            $('#readyBtn').hide(); // No next hand in one-shot games
            // Show result if not already shown (e.g. after page reload)
            if (!$('#status').text()) {
                this._showHandResult(this.gameState);
            }
            // Show game completion message
            $('#phaseMsg').text('Game completed. Channel will close automatically...');
        } else {
            $('#closeChannelBtn').hide();
        }
        if (round !== 'commit' && round !== 'reveal') {
            $('#commitBtn').hide();
            $('#revealBtn').hide();
        }
        if (round !== 'finished') {
            $('#readyBtn').hide().prop('disabled', false).text('▶ Next Hand');
            $('#status').text('').css('color', '');
        }
        $('#phaseMsg').text(msg);
    },

    renderChannelStatus: function() {
        var s = this.channelInfo ? (this.channelInfo.status || 'FUNDING') : null;
        var color = !s ? '' : (s === 'OPEN' ? 'green' : (s === 'FUNDING' ? 'orange' : (s === 'CLOSED' ? 'gray' : 'red')));
        $('#channelStatusLabel').html(s ? '<strong>Channel:</strong> <span style="color:' + color + ';">' + s + '</span>' : '');
        $('#createChannelBtn').toggle(!s);
    },

    createChannel: function() {
        if (!this.players || this.players.length < 2) {
            pokerModal.alert('Need at least 2 players to create a channel', 'error');
            return;
        }
        if (this.players.length > 2) {
            pokerModal.alert('Channels support max 2 players', 'error');
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
            chan.blinds = blinds;
            chan.buyIn = buyIn;
            pokerModal.alert('Initializing channel scripts...', 'info');
            chan.init(function(err) {
                if (err) { pokerModal.alert('Failed to init channel: ' + err, 'error'); return; }
                sql.insertChannelFull(chan, function(res) {
                    if (!res || !res.status) { pokerModal.alert('Failed to save channel to database', 'error'); return; }
                    var msg = { type: 'REQUEST_NEW_CHANNEL', channelId: chan.id, tableId: self.tableId, participants: participants, tokenId: '0x00', timeout: 30, blinds: blinds, buyIn: buyIn };
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
        MDS.log('TABLE _autoStartGame: starting for tableId=' + this.tableId);
        MDS.log('TABLE _autoStartGame: players count=' + (this.players ? this.players.length : 0));
        MDS.log('TABLE _autoStartGame: channelInfo=' + JSON.stringify(this.channelInfo));

        // Check if players are loaded
        if (!this.players || this.players.length === 0) {
            MDS.log('TABLE _autoStartGame: players not loaded yet, aborting auto-start');
            return;
        }

        sql.getTableById(this.tableId, function(table) {
            if (!table) {
                MDS.log('TABLE _autoStartGame: table not found');
                return;
            }
            MDS.log('TABLE _autoStartGame: table found, blinds=' + (table.blinds || table.BLINDS));

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
            MDS.log('TABLE _autoStartGame: prepared players=' + JSON.stringify(playersWithStack));

            var gameMsg = {
                type: 'GAME_START',
                tableId: self.tableId,
                channelId: self.channelInfo.hashId || self.channelInfo.HASHID,
                players: playersWithStack,
                blinds: { small: parts[0], big: parts[1] },
                buyIn: buyIn
            };
            MDS.log('TABLE _autoStartGame: sending GAME_START message=' + JSON.stringify(gameMsg));

            // Send to service (enforcer's own node) via comms
            MDS.comms.solo(JSON.stringify(gameMsg));
            self._sendToAllPlayers(gameMsg, function(ok) {
                if (!ok) {
                    MDS.log('Auto-start game failed, will retry on next channel update');
                } else {
                    MDS.log('Auto-start game message sent successfully');
                }
            });
        });
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
            // During game: use stack from gameState if available (more current than channel balance)
            var gsPlayers = (state && state.players) ? (typeof state.players === 'string' ? JSON.parse(state.players) : state.players) : null;
            var gsPlayer = null;
            if (gsPlayers) {
                for (var gsi = 0; gsi < gsPlayers.length; gsi++) {
                    if (gsPlayers[gsi].pubKey === p.playerPubKey) { gsPlayer = gsPlayers[gsi]; break; }
                }
            }
            if (gsPlayer && gsPlayer.stack !== undefined) {
                stack = gsPlayer.stack;
            } else if (this.channelInfo && this.channelInfo.balances && this.channelInfo.balances[p.playerPubKey]) {
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

    createChannel: function() {
        if (!this.players || this.players.length < 2) {
            pokerModal.alert('Need at least 2 players to create a channel', 'error');
            return;
        }
        if (this.players.length > 2) {
            pokerModal.alert('Channels support max 2 players', 'error');
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
            chan.blinds = blinds;
            chan.buyIn = buyIn;
            pokerModal.alert('Initializing channel scripts...', 'info');
            chan.init(function(err) {
                if (err) { pokerModal.alert('Failed to init channel: ' + err, 'error'); return; }
                sql.insertChannelFull(chan, function(res) {
                    if (!res || !res.status) { pokerModal.alert('Failed to save channel to database', 'error'); return; }
                    var msg = { type: 'REQUEST_NEW_CHANNEL', channelId: chan.id, tableId: self.tableId, participants: participants, tokenId: '0x00', timeout: 30, blinds: blinds, buyIn: buyIn };
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

    // Determine if this client should enforce timeouts.
    // The player with the lexicographically smallest pubKey acts as enforcer.
    // This way if the host disconnects, another player takes over.
    _isEnforcer: function() {
        MDS.log('TABLE _isEnforcer: checking enforcer status');
        MDS.log('TABLE _isEnforcer: players=' + JSON.stringify(this.players));
        MDS.log('TABLE _isEnforcer: myMaximaKey=' + window.myMaximaKey);
        MDS.log('TABLE _isEnforcer: isCreator=' + this.isCreator);

        if (!this.players || this.players.length === 0) {
            MDS.log('TABLE _isEnforcer: no players, using isCreator=' + this.isCreator);
            return this.isCreator;
        }

        var minKey = null;
        for (var i = 0; i < this.players.length; i++) {
            var pk = this.players[i].playerPubKey;
            MDS.log('TABLE _isEnforcer: checking player ' + i + ' pubKey=' + pk);
            if (!minKey || pk < minKey) {
                minKey = pk;
                MDS.log('TABLE _isEnforcer: new minKey=' + minKey);
            }
        }

        var isEnforcer = window.myMaximaKey === minKey;
        MDS.log('TABLE _isEnforcer: final result - minKey=' + minKey + ' myKey=' + window.myMaximaKey + ' isEnforcer=' + isEnforcer);
        return isEnforcer;
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
        this._actionPending = false;
        $('#foldBtn').prop('disabled', !isMyTurn).css('opacity', isMyTurn ? '1' : '');
        $('#callBtn').prop('disabled', !(isMyTurn && needToCall)).css('opacity', (isMyTurn && needToCall) ? '1' : '');
        $('#raiseBtn').prop('disabled', !isMyTurn).css('opacity', isMyTurn ? '1' : '');
        $('#checkBtn').prop('disabled', !(isMyTurn && !needToCall)).css('opacity', (isMyTurn && !needToCall) ? '1' : '');
    },

    setupEventListeners: function() {
        $('#foldBtn').click(function() { tableUI.sendAction('fold'); });
        $('#callBtn').click(function() { tableUI.sendAction('call'); });
        $('#raiseBtn').click(function() {
            var gs = tableUI.gameState;
            var buyIn = tableUI.channelInfo ? (tableUI.channelInfo.buyIn || tableUI.channelInfo.BUYIN) : null;
            var blinds = tableUI.channelInfo ? (tableUI.channelInfo.blinds || tableUI.channelInfo.BLINDS || '10/20') : '10/20';
            var bb = parseInt(blinds.split('/')[1] || 20);
            var minRaise = buyIn ? parseInt(buyIn) : bb;  // minRaise equals buyIn
            // Calculate max raise (stack - amount needed to call)
            var currentBet = gs ? parseInt(gs.currentbet || gs.currentBet || 0) : 0;
            var myBet = 0;
            var myStack = 0;
            if (gs && tableUI.players && tableUI.players[tableUI.myPlayerIndex]) {
                var bets = gs.bets || {};
                if (typeof bets === 'string') { try { bets = JSON.parse(bets); } catch(e) { bets = {}; } }
                var myPk = tableUI.players[tableUI.myPlayerIndex].playerPubKey;
                myBet = parseInt(bets[myPk] || 0);
                // Get stack from players array in game state
                var plArr = gs.players || [];
                for (var pi = 0; pi < plArr.length; pi++) {
                    if ((plArr[pi].pubKey || plArr[pi].PUBKEY) === myPk) { myStack = parseInt(plArr[pi].stack || 0); break; }
                }
            }
            var callCost = currentBet - myBet;
            if (callCost < 0) callCost = 0;
            var maxRaise = myStack - callCost;
            if (maxRaise < minRaise) {
                pokerModal.alert('Not enough chips to raise (need at least ' + (callCost + minRaise) + ')', 'error');
                return;
            }
            pokerModal.prompt('Raise amount (min ' + minRaise + ', max ' + maxRaise + '):', String(minRaise), function(amount) {
                if (!amount) return;
                var val = parseInt(amount);
                if (isNaN(val) || val < minRaise) {
                    pokerModal.alert('Minimum raise is ' + minRaise, 'error');
                    return;
                }
                if (val > maxRaise) {
                    pokerModal.alert('Maximum raise is ' + maxRaise, 'error');
                    return;
                }
                tableUI.sendAction('raise', String(val));
            });
        });
        $('#checkBtn').click(function() { tableUI.sendAction('check'); });
        $('#commitBtn').click(function() { tableUI.sendCommit(); });
        $('#revealBtn').click(function() { tableUI.sendReveal(); });
        $('#createChannelBtn').click(function() { tableUI.createChannel(); });
    },

    sendAction: function(action, amount) {
        if (!this.tableId || this._actionPending) return;
        this._actionPending = true;
        this._disableActionButtons();
        var self = this;
        var msg = { type: 'BET', tableId: this.tableId, player: window.myMaximaKey, action: action, amount: amount || '0' };
        MDS.comms.solo(JSON.stringify(msg));
        this._sendToAllPlayers(msg, function(ok) {
            if (!ok) {
                pokerModal.alert('Failed to send action', 'error');
                self._actionPending = false;
                self._markDirty('controls');
                self.scheduleUpdate();
            }
        });
        // Safety timeout — re-enable buttons if no state update received
        setTimeout(function() {
            if (self._actionPending) {
                self._actionPending = false;
                self._markDirty('controls');
                self.scheduleUpdate();
            }
        }, 5000);
    },

    _showHandResult: function(state) {
        var winners = [];
        try { winners = JSON.parse(state.lastaction || state.lastAction || '[]'); } catch(e) {}
        var myKey = window.myMaximaKey;
        var iWon = false;
        var myAmount = 0;
        for (var i = 0; i < winners.length; i++) {
            if (winners[i].pubKey === myKey) { iWon = true; myAmount = winners[i].amount; break; }
        }
        var msg = iWon
            ? '🏆 You won ' + myAmount + '!'
            : (winners.length > 0
                ? '😔 You lost. ' + (winners[0].name || winners[0].pubKey.slice(0,8)) + ' wins ' + winners[0].amount
                : 'Hand finished');
        $('#status').text(msg).css('color', iWon ? '#4caf50' : '#f39c12');
        // No Ready button in one-shot games - game will auto-close
    },

    sendReady: function() {
        $('#readyBtn').prop('disabled', true).text('Waiting...');
        var msg = { type: 'PLAYER_READY', tableId: this.tableId, pubKey: window.myMaximaKey };
        MDS.comms.solo(JSON.stringify(msg));
        this._sendToAllPlayers(msg, function() {});
    },

    _disableActionButtons: function() {
        $('#foldBtn, #callBtn, #raiseBtn, #checkBtn').prop('disabled', true).css('opacity', '0.5');
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
        MDS.log('TABLE handleServiceMessage: type=' + message.type + ' tableId=' + (message.tableId || 'none'));

        if (message.type === 'REFRESH_TABLE') {
            if (!message.tableId || message.tableId === this.tableId) {
                MDS.log('TABLE handleServiceMessage: processing REFRESH_TABLE for tableId=' + this.tableId);
                this.loadChannelInfo();
                this.loadGameState();
                this._markDirty('all');
            }
            return;
        }

        if (message.type === 'CHANNEL_REQUEST') { handleChannelRequest(message); return; }
        if (message.type === 'CHANNEL_DENIED') { pokerModal.alert('Channel request denied', 'error'); return; }
        if (message.type === 'PLAYER_BUST' && message.tableId === this.tableId) {
            $('#readyBtn').hide();
            $('#status').text('⚠️ A player is out of chips! Close the channel to collect funds.').css('color', '#f39c12');
            $('#closeChannelBtn').show();
            return;
        }
        if (message.type === 'CLOSE_REQUEST_UI' && message.tableId === this.tableId) {
            var self = this;
            var round = self.gameState ? self.gameState.round : 'waiting';
            var duringGame = round && round !== 'waiting' && round !== 'finished';
            var promptMsg = duringGame
                ? '⚠️ Opponent wants to close the channel DURING the game. Agree (funds split by last settlement) or Reject?'
                : 'Opponent wants to close the channel cooperatively. Agree?';
            pokerModal.choice('Close Channel Request', promptMsg,
                [{ label: '✅ Agree', value: 'agree' }, { label: '❌ Reject', value: 'reject' }],
                function(choice) {
                    if (choice === 'agree') {
                        MDS.comms.solo(JSON.stringify({ type: 'CLOSE_REQUEST_CONFIRM', channelId: message.channelId, spendTx: message.spendTx, fromPubKey: message.fromPubKey }));
                    } else {
                        MDS.comms.solo(JSON.stringify({ type: 'CLOSE_REQUEST_REJECT', channelId: message.channelId, fromPubKey: message.fromPubKey }));
                    }
                }
            );
            return;
        }
        if (message.type === 'CLOSE_REJECTED' && message.tableId === this.tableId) {
            pokerModal.alert('Close rejected by opponent.', 'warning');
            this.loadChannelInfo();
            return;
        }
        if (message.type === 'CLOSE_BLOCKED' && message.channelId === this.channelInfo.hashId) {
            pokerModal.alert(message.reason || 'Channel close blocked. Please wait and try again.', 'warning');
            return;
        }
        if (message.type === 'GAME_ENDED' && message.tableId === this.tableId) {
            pokerModal.alert(message.message || 'Game completed. Returning to lobby...', 'success');
            setTimeout(function() { goBackToLobby(); }, 2000);
            return;
        }
        if (message.type === 'GAME_ENDED_RETURN_LOBBY' && message.tableId === this.tableId) {
            pokerModal.alert('Game completed. Channel closed. Returning to lobby...', 'success');
            setTimeout(function() { goBackToLobby(); }, 2000);
            return;
        }
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
        chan.blinds = data.blinds || '10/20';
        chan.buyIn = data.buyIn || '200';
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
