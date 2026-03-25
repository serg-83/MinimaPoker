/**
 * poker.js – Full poker game logic with eltoo channel integration (Thunder-compatible)
 */

// In-memory game states (tableId -> game object)
var gamesMap = {};

/**
 * Poker game constructor (ES5 version)
 */
function PokerGame(tableId, players, blinds, channelId) {
    this.tableId = tableId;
    this.channelId = channelId;           // associated payment channel
    this.players = [];
    for (var i = 0; i < players.length; i++) {
        var p = players[i];
        this.players.push({
            pubKey: p.pubKey,
            name: p.name,
            stack: new Decimal(p.initialStack || 0),
            cards: [],
            bet: new Decimal(0),
            folded: false,
            acted: false,
            committed: false,
            secret: null
        });
    }
    this.blinds = { small: new Decimal(blinds.small), big: new Decimal(blinds.big) };
    this.dealer = 0;      // recalculated from seed in startGame()
    this.smallBlindPos = 1 % this.players.length;
    this.bigBlindPos = 2 % this.players.length;
    this.currentPlayer = this.bigBlindPos;
    this.pot = new Decimal(0);
    this.communityCards = [];
    this.round = 'waiting'; // waiting, commit, preflop, flop, turn, river, showdown
    this.lastAction = null;
    this.minRaise = this.blinds.big;
    this.seed = null;                      // final seed for deck
    this.commits = {};                      // commitments from players (by pubKey)
    this.reveals = {};                       // revealed secrets (by pubKey)
    this.remainingDeck = [];
    this.handRankCache = {};                 // cache for hand evaluation
    this._pendingDbUpdate = null;            // debounce timer
}

// ---------- Commit-reveal phase ----------
PokerGame.prototype.startCommitPhase = function() {
    this.round = 'commit';
    for (var i = 0; i < this.players.length; i++) {
        this.players[i].committed = false;
    }
};

PokerGame.prototype.receiveCommit = function(pubKey, commitHash) {
    if (this.round !== 'commit') return false;
    // Don't overwrite a real commit with a forced zero value
    if (this.commits[pubKey] && commitHash === '0000000000000000000000000000000000000000000000000000000000000000') return false;
    this.commits[pubKey] = commitHash;
    var player = null;
    for (var i = 0; i < this.players.length; i++) {
        if (this.players[i].pubKey === pubKey) {
            player = this.players[i];
            break;
        }
    }
    if (player) player.committed = true;

    // Debounced database persistence
    var self = this;
    if (typeof setTimeout !== 'undefined') {
        if (!this._pendingDbUpdate) {
            this._pendingDbUpdate = setTimeout(function() {
                self._flushDbUpdate();
            }, 500);
        }
    } else {
        this._flushDbUpdate();
    }

    // Check if all committed
    var allCommitted = true;
    for (var j = 0; j < this.players.length; j++) {
        if (!this.players[j].committed) {
            allCommitted = false;
            break;
        }
    }
    if (allCommitted) {
        this.round = 'reveal';
        // Schedule immediate flush for round change
        if (typeof clearTimeout !== 'undefined' && this._pendingDbUpdate) {
            clearTimeout(this._pendingDbUpdate);
        }
        this._pendingDbUpdate = null;
        this._flushDbUpdate();
    }
    return true;
};

PokerGame.prototype._flushDbUpdate = function() {
    this._pendingDbUpdate = null;
    var self = this;
    var bets = {};
    for (var b = 0; b < this.players.length; b++) {
        bets[this.players[b].pubKey] = this.players[b].bet.toNumber();
    }
    sql.setGameState({
        tableId: this.tableId,
        round: this.round,
        pot: this.pot.toString(),
        communityCards: this.communityCards,
        playerCards: (function(players) {
            var result = [];
            for (var i = 0; i < players.length; i++) {
                result.push({ pubKey: players[i].pubKey, cardCount: players[i].cards.length });
            }
            return result;
        })(this.players),
        players: (function(players) {
            return players.map(function(p) {
                return { pubKey: p.pubKey, name: p.name, stack: p.stack.toString(), folded: p.folded };
            });
        })(this.players),
        bets: bets,
        turn: this.currentPlayer,
        lastAction: this.round === 'finished' ? JSON.stringify(this.lastWinners || []) : this.lastAction,
        commits: this.commits,
        reveals: this.reveals
    }, function() {
        // After showdown, enforcer sends final channel update with redistributed balances
        if (self.round === 'finished') {
            var myMaxKey = (typeof getMyMaximaKey === 'function') ? getMyMaximaKey() :
                           (typeof window !== 'undefined' ? window.myMaximaKey : '');
            var isEnforcer = true;
            for (var i = 0; i < self.players.length; i++) {
                if (self.players[i].pubKey < myMaxKey) { isEnforcer = false; break; }
            }
            if (isEnforcer) {
                sendChannelUpdate(self, function(ok) {
                    if (!ok) MDS.log('showdown: sendChannelUpdate failed');
                });
            }
        }
    });
};

PokerGame.prototype.receiveReveal = function(pubKey, secret) {
    if (this.round !== 'reveal') return false;
    // Don't overwrite a real reveal with a forced zero value
    if (this.reveals[pubKey] && secret === '0000000000000000000000000000000000000000000000000000000000000000') return false;
    var player = null;
    for (var i = 0; i < this.players.length; i++) {
        if (this.players[i].pubKey === pubKey) {
            player = this.players[i];
            break;
        }
    }
    if (!player) return false;

    // Verify commitment (secret should be the original random string)
    var self = this;
    cryptoUtils.commit(secret, '', function(err, computedHash) {
        if (err) {
            MDS.log('Reveal verification error: ' + err);
            return false;
        }
        if (computedHash !== self.commits[pubKey]) {
            MDS.log('Invalid reveal for ' + pubKey + ' computed=' + computedHash + ' stored=' + self.commits[pubKey] + ' round=' + self.round);
            return false;
        }
        self.reveals[pubKey] = secret;
        player.secret = secret;

        // Debounced database persistence
        if (typeof setTimeout !== 'undefined') {
            if (!self._pendingDbUpdate) {
                self._pendingDbUpdate = setTimeout(function() {
                    self._flushDbUpdate();
                }, 500);
            }
        } else {
            self._flushDbUpdate();
        }

        // Check if all revealed
        var revealedCount = 0;
        for (var key in self.reveals) {
            if (self.reveals.hasOwnProperty(key)) revealedCount++;
        }

        // Only proceed if all players have revealed
        if (revealedCount === self.players.length) {
            // Verify all seeds are valid before combining
            var allSeedsValid = true;
            var seeds = [];
            for (var pKey in self.reveals) {
                if (self.reveals.hasOwnProperty(pKey)) {
                    var seed = self.reveals[pKey];
                    // Check seed is non-empty and valid hex
                    if (!seed || seed.length === 0) {
                        MDS.log('Invalid empty seed from ' + pKey);
                        allSeedsValid = false;
                        break;
                    }
                    // Check hex format (even length, valid chars)
                    if (seed.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(seed)) {
                        MDS.log('Invalid hex seed from ' + pKey + ': ' + seed);
                        allSeedsValid = false;
                        break;
                    }
                    seeds.push(seed);
                }
            }

            if (!allSeedsValid) {
                MDS.log('Seed validation failed - cannot start game');
                // Reset to commit phase
                self.round = 'commit';
                self.commits = {};
                self.reveals = {};
                for (var j = 0; j < self.players.length; j++) {
                    self.players[j].committed = false;
                    self.players[j].secret = null;
                }
                self._flushDbUpdate();
                return false;
            }

            // Clear pending update and force flush
            if (self._pendingDbUpdate) {
                if (typeof clearTimeout !== 'undefined') clearTimeout(self._pendingDbUpdate);
                self._pendingDbUpdate = null;
            }

            try {
                self.combineSeeds();
                self.dealCards();
                self.startGame();
            } catch (e) {
                MDS.log('Error starting game: ' + e);
                return false;
            }

            // Flush final state
            self._flushDbUpdate();
        }
        return true;
    });
    return true;
};

/**
 * Force-fold a player who timed out during betting.
 * Called by the host after turn timer expires.
 */
PokerGame.prototype.forceAct = function(pubKey) {
    return this.act(pubKey, 'fold');
};

/**
 * Force-reveal for a player who timed out during reveal phase.
 * Uses a zero seed so the hand can proceed.
 */
PokerGame.prototype.forceReveal = function(pubKey, callback) {
    var zeroSeed = '0000000000000000000000000000000000000000000000000000000000000000';
    var self = this;
    // Compute SHA256(zeroSeed) to set as the commit, so verification in receiveReveal passes
    cryptoUtils.commit(zeroSeed, '', function(err, hash) {
        if (err || !hash) {
            MDS.log('forceReveal: failed to compute hash for zero seed: ' + err);
            if (callback) callback();
            return;
        }
        self.commits[pubKey] = hash;
        self.receiveReveal(pubKey, zeroSeed);
        if (callback) callback();
    });
};

/**
 * Force-commit for a player who timed out during commit phase.
 */
PokerGame.prototype.forceCommit = function(pubKey) {
    var zeroHash = '0000000000000000000000000000000000000000000000000000000000000000';
    this.receiveCommit(pubKey, zeroHash);
};

PokerGame.prototype.combineSeeds = function() {
    var seeds = [];
    for (var key in this.reveals) {
        if (this.reveals.hasOwnProperty(key)) {
            seeds.push(this.reveals[key]);
        }
    }
    this.seed = cryptoUtils.combineSeeds(seeds);
};

PokerGame.prototype.dealCards = function() {
    var deck = cryptoUtils.generateDeck();
    var shuffled = cryptoUtils.seededShuffle(deck, this.seed);
    var idx = 0;
    // Hole cards: 2 each
    for (var i = 0; i < this.players.length; i++) {
        this.players[i].cards = [shuffled[idx], shuffled[idx + 1]];
        idx += 2;
    }
    // Community cards will be dealt later, but we can pre-generate the deck order
    this.remainingDeck = shuffled.slice(idx);
};

// ---------- Game start ----------
PokerGame.prototype.startGame = function() {
    this.dealer = parseInt(this.seed.substring(0, 8), 16) % this.players.length;
    this.smallBlindPos = (this.dealer + 1) % this.players.length;
    this.bigBlindPos   = (this.dealer + 2) % this.players.length;
    this.postBlind(this.smallBlindPos, this.blinds.small);
    this.postBlind(this.bigBlindPos, this.blinds.big);
    this.round = 'preflop';
    // Preflop: action starts left of BB; BB gets option last
    this.currentPlayer = (this.bigBlindPos + 1) % this.players.length;
    // Skip folded/all-in players
    while (this.players[this.currentPlayer].folded || this.players[this.currentPlayer].stack.equals(0)) {
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
    }
    // BB has not acted yet (gets option)
    this.players[this.bigBlindPos].acted = false;
    this._lastAggressor = this.bigBlindPos; // BB is last to act preflop unless raised
};

PokerGame.prototype.postBlind = function(pos, amount) {
    var player = this.players[pos];
    var bet = Decimal.min(amount, player.stack);
    player.stack = player.stack.minus(bet);
    player.bet = player.bet.plus(bet);
    this.pot = this.pot.plus(bet);
};

// Process a player action
PokerGame.prototype.act = function(playerPubKey, action, amount) {
    if (amount === undefined) amount = null;
    var playerIndex = -1;
    for (var i = 0; i < this.players.length; i++) {
        if (this.players[i].pubKey === playerPubKey) { playerIndex = i; break; }
    }
    if (playerIndex !== this.currentPlayer) return false;
    var player = this.players[playerIndex];
    if (player.folded) return false;

    switch (action) {
        case 'fold':
            player.folded = true;
            this.lastAction = 'fold';
            break;
        case 'check':
            if (this.getCurrentBet().greaterThan(player.bet)) return false;
            this.lastAction = 'check';
            break;
        case 'call':
            var callAmount = this.getCurrentBet().minus(player.bet);
            if (callAmount.greaterThan(player.stack)) {
                // All-in
                this.pot = this.pot.plus(player.stack);
                player.bet = player.bet.plus(player.stack);
                player.stack = new Decimal(0);
            } else {
                player.stack = player.stack.minus(callAmount);
                player.bet = player.bet.plus(callAmount);
                this.pot = this.pot.plus(callAmount);
            }
            this.lastAction = 'call';
            break;
        case 'raise':
            if (amount === null) return false;
            var raiseAmount = new Decimal(amount);
            if (raiseAmount.lessThan(this.minRaise)) return false;
            var totalBet = this.getCurrentBet().plus(raiseAmount);
            var additional = totalBet.minus(player.bet);
            if (additional.greaterThan(player.stack)) return false;
            player.stack = player.stack.minus(additional);
            player.bet = player.bet.plus(additional);
            this.pot = this.pot.plus(additional);
            this.minRaise = raiseAmount;
            this._lastAggressor = playerIndex; // raise resets who acts last
            this.lastAction = 'raise';
            break;
        default:
            return false;
    }
    player.acted = true;
    this.advanceTurn();
    return true;
};

PokerGame.prototype.getCurrentBet = function() {
    var maxBet = new Decimal(0);
    for (var i = 0; i < this.players.length; i++) {
        var p = this.players[i];
        if (!p.folded && p.bet.greaterThan(maxBet)) maxBet = p.bet;
    }
    return maxBet;
};

PokerGame.prototype.advanceTurn = function() {
    // Find next player who can act (not folded, not all-in)
    var n = this.players.length;
    var next = (this.currentPlayer + 1) % n;
    var checked = 0;
    while (checked < n) {
        var p = this.players[next];
        if (!p.folded && p.stack.greaterThan(0)) break;
        next = (next + 1) % n;
        checked++;
    }

    if (this.isRoundComplete()) {
        this.nextRound();
        return;
    }
    this.currentPlayer = next;
};

PokerGame.prototype.isRoundComplete = function() {
    var active = [];
    for (var i = 0; i < this.players.length; i++) {
        if (!this.players[i].folded) active.push(this.players[i]);
    }
    // Only one player left
    if (active.length === 1) return true;

    var currentBet = this.getCurrentBet();
    for (var j = 0; j < active.length; j++) {
        var p = active[j];
        // Skip all-in players — they can't act but round isn't over because of them
        if (p.stack.equals(0)) continue;
        // Player hasn't acted yet
        if (!p.acted) return false;
        // Player hasn't matched the current bet (and isn't all-in)
        if (!p.bet.equals(currentBet)) return false;
    }
    return true;
};

PokerGame.prototype.nextRound = function() {
    for (var i = 0; i < this.players.length; i++) {
        this.players[i].bet = new Decimal(0);
        this.players[i].acted = false;
    }
    this.minRaise = this.blinds.big;

    if (this.round === 'preflop') {
        this.round = 'flop';
        this.dealCommunity(3);
    } else if (this.round === 'flop') {
        this.round = 'turn';
        this.dealCommunity(1);
    } else if (this.round === 'turn') {
        this.round = 'river';
        this.dealCommunity(1);
    } else if (this.round === 'river') {
        this.round = 'showdown';
        this.showdown();
        return;
    }

    // Check if only one active player
    var canAct = [];
    for (var sa = 0; sa < this.players.length; sa++) {
        if (!this.players[sa].folded && this.players[sa].stack.greaterThan(0)) canAct.push(sa);
    }
    if (canAct.length <= 1) {
        // All remaining players are all-in or only one left — run out the board
        if (this.round === 'flop') { this.dealCommunity(1); this.round = 'turn'; }
        if (this.round === 'turn') { this.dealCommunity(1); this.round = 'river'; }
        if (this.round === 'river') { this.round = 'showdown'; this.showdown(); }
        return;
    }

    // Post-flop: action starts left of dealer (SB position), skip folded/all-in
    this.currentPlayer = (this.dealer + 1) % this.players.length;
    var tries = 0;
    while ((this.players[this.currentPlayer].folded || this.players[this.currentPlayer].stack.equals(0)) && tries < this.players.length) {
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
        tries++;
    }
};

PokerGame.prototype.dealCommunity = function(count) {
    for (var i = 0; i < count; i++) {
        this.communityCards.push(this.remainingDeck.shift());
    }
};

PokerGame.prototype.showdown = function() {
    var active = [];
    for (var i = 0; i < this.players.length; i++) {
        if (!this.players[i].folded) active.push(this.players[i]);
    }
    var potAmount = this.pot;
    if (active.length === 1) {
        active[0].stack = active[0].stack.plus(this.pot);
        this.lastWinners = [{ pubKey: active[0].pubKey, name: active[0].name, amount: potAmount.toString(), desc: 'wins (others folded)' }];
    } else {
        var evaluations = [];
        for (var j = 0; j < active.length; j++) {
            var p = active[j];
            evaluations.push({ player: p, hand: this.evaluateHand(p.cards, this.communityCards) });
        }
        evaluations.sort(function(a, b) {
            if (a.hand.rank !== b.hand.rank) return b.hand.rank - a.hand.rank;
            for (var hc = 0; hc < a.hand.highCards.length && hc < b.hand.highCards.length; hc++) {
                if (a.hand.highCards[hc] !== b.hand.highCards[hc]) return b.hand.highCards[hc] - a.hand.highCards[hc];
            }
            return 0;
        });
        var bestRank = evaluations[0].hand.rank;
        var bestHighCards = evaluations[0].hand.highCards;
        var winners = [];
        for (var k = 0; k < evaluations.length; k++) {
            var ev = evaluations[k];
            if (ev.hand.rank === bestRank) {
                var isEqual = true;
                for (var hc2 = 0; hc2 < bestHighCards.length && hc2 < ev.hand.highCards.length; hc2++) {
                    if (bestHighCards[hc2] !== ev.hand.highCards[hc2]) { isEqual = false; break; }
                }
                if (isEqual) winners.push(ev);
            }
        }
        var share = this.pot.dividedToIntegerBy(winners.length);
        var remainder = this.pot.minus(share.times(winners.length));
        this.lastWinners = [];
        for (var w = 0; w < winners.length; w++) {
            var winAmount = w === 0 ? share.plus(remainder) : share;
            winners[w].player.stack = winners[w].player.stack.plus(winAmount);
            this.lastWinners.push({ pubKey: winners[w].player.pubKey, name: winners[w].player.name, amount: winAmount.toString(), desc: winners[w].hand.description });
        }
    }
    this.pot = new Decimal(0);
    this.round = 'finished';
};

PokerGame.prototype.evaluateHand = function(hole, community) {
    // Combine hole and community cards
    var allCards = hole.concat(community);

    // Generate cache key from sorted card indices
    var cardIndices = [];
    for (var i = 0; i < allCards.length; i++) {
        cardIndices.push(this.getCardIndex(allCards[i]));
    }
    cardIndices.sort(function(a, b) { return a - b; });
    var cacheKey = cardIndices.join(',');

    if (this.handRankCache[cacheKey] !== undefined) {
        return this.handRankCache[cacheKey];
    }

    // Optimized hand evaluation using bit manipulation
    var best = this.evaluateHandFast(allCards);

    this.handRankCache[cacheKey] = best;
    return best;
};

PokerGame.prototype.getCardIndex = function(card) {
    // Convert card to unique index (0-51)
    var suits = { 's': 0, 'h': 1, 'd': 2, 'c': 3 };
    var ranks = { '2':0, '3':1, '4':2, '5':3, '6':4, '7':5, '8':6, '9':7, 'T':8, 'J':9, 'Q':10, 'K':11, 'A':12 };
    return suits[card[1]] * 13 + ranks[card[0]];
};

PokerGame.prototype.evaluateHandFast = function(cards) {
    var suits = 'shdc';
    var rankCounts = [0,0,0,0,0,0,0,0,0,0,0,0,0]; // index 0=rank2 .. 12=rankA
    var suitCards = [[], [], [], []]; // cards grouped by suit

    for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var rank = this.cardRank(c[0]);
        var suitIdx = suits.indexOf(c[c.length - 1]);
        rankCounts[rank - 2]++;
        if (suitIdx >= 0) suitCards[suitIdx].push(rank);
    }

    // Check for flush and straight flush
    var flushSuit = -1;
    for (var s = 0; s < 4; s++) {
        if (suitCards[s].length >= 5) { flushSuit = s; break; }
    }

    if (flushSuit >= 0) {
        var flushRanks = suitCards[flushSuit].slice();
        flushRanks.sort(function(a, b) { return b - a; });
        // Check straight flush within flush suit
        var sfHigh = this._findStraightHigh(flushRanks);
        if (sfHigh > 0) {
            var desc = sfHigh === 14 ? 'Royal Flush' : 'Straight Flush';
            return { rank: 9, description: desc, highCards: [sfHigh] };
        }
    }

    // Four of a kind (search from high to low)
    var fourRank = -1;
    for (var fr = 12; fr >= 0; fr--) {
        if (rankCounts[fr] === 4) { fourRank = fr; break; }
    }
    if (fourRank >= 0) {
        // Highest kicker not part of the four
        var kicker = -1;
        for (var kr = 12; kr >= 0; kr--) {
            if (kr !== fourRank && rankCounts[kr] > 0) { kicker = kr; break; }
        }
        return { rank: 8, description: 'Four of a Kind', highCards: [fourRank + 2, kicker + 2] };
    }

    // Full house: find highest three, then highest pair (could be another three)
    var threeRank = -1;
    for (var t3 = 12; t3 >= 0; t3--) {
        if (rankCounts[t3] >= 3) { threeRank = t3; break; }
    }
    if (threeRank >= 0) {
        var pairRank = -1;
        for (var p2 = 12; p2 >= 0; p2--) {
            if (p2 !== threeRank && rankCounts[p2] >= 2) { pairRank = p2; break; }
        }
        if (pairRank >= 0) {
            return { rank: 7, description: 'Full House', highCards: [threeRank + 2, pairRank + 2] };
        }
    }

    // Flush (not straight flush — already checked above)
    if (flushSuit >= 0) {
        var flushHigh = suitCards[flushSuit].slice();
        flushHigh.sort(function(a, b) { return b - a; });
        return { rank: 6, description: 'Flush', highCards: flushHigh.slice(0, 5) };
    }

    // Straight
    var allRanks = [];
    for (var ar = 0; ar < cards.length; ar++) {
        allRanks.push(this.cardRank(cards[ar][0]));
    }
    allRanks.sort(function(a, b) { return b - a; });
    var straightHigh = this._findStraightHigh(allRanks);
    if (straightHigh > 0) {
        return { rank: 5, description: 'Straight', highCards: [straightHigh] };
    }

    // Three of a kind
    if (threeRank >= 0) {
        var kickers3 = [];
        for (var k3 = 12; k3 >= 0; k3--) {
            if (k3 !== threeRank && rankCounts[k3] > 0) kickers3.push(k3 + 2);
            if (kickers3.length === 2) break;
        }
        return { rank: 4, description: 'Three of a Kind', highCards: [threeRank + 2].concat(kickers3) };
    }

    // Pairs
    var pairs = [];
    for (var pp = 12; pp >= 0; pp--) {
        if (rankCounts[pp] === 2) pairs.push(pp);
    }

    if (pairs.length >= 2) {
        // Two pair — take best two pairs + best kicker
        var kicker2p = -1;
        for (var k2p = 12; k2p >= 0; k2p--) {
            if (k2p !== pairs[0] && k2p !== pairs[1] && rankCounts[k2p] > 0) { kicker2p = k2p; break; }
        }
        return { rank: 3, description: 'Two Pair', highCards: [pairs[0] + 2, pairs[1] + 2, kicker2p + 2] };
    }

    if (pairs.length === 1) {
        // One pair
        var kickers1p = [];
        for (var k1p = 12; k1p >= 0; k1p--) {
            if (k1p !== pairs[0] && rankCounts[k1p] > 0) kickers1p.push(k1p + 2);
            if (kickers1p.length === 3) break;
        }
        return { rank: 2, description: 'One Pair', highCards: [pairs[0] + 2].concat(kickers1p) };
    }

    // High card
    var highCards = [];
    for (var hc = 12; hc >= 0; hc--) {
        if (rankCounts[hc] > 0) highCards.push(hc + 2);
        if (highCards.length === 5) break;
    }
    return { rank: 1, description: 'High Card', highCards: highCards };
};

// Find the highest card of a straight in the given sorted (desc) ranks, or 0 if no straight
PokerGame.prototype._findStraightHigh = function(sortedRanks) {
    // Remove duplicates
    var unique = [];
    for (var i = 0; i < sortedRanks.length; i++) {
        if (unique.length === 0 || unique[unique.length - 1] !== sortedRanks[i]) {
            unique.push(sortedRanks[i]);
        }
    }
    if (unique.length < 5) return 0;
    // Check consecutive sequences
    for (var j = 0; j <= unique.length - 5; j++) {
        if (unique[j] - unique[j + 4] === 4) return unique[j];
    }
    // Ace-low straight: A-2-3-4-5
    if (unique[0] === 14) {
        var low = unique.slice(-4);
        if (low.length === 4 && low[0] === 5 && low[1] === 4 && low[2] === 3 && low[3] === 2) return 5;
    }
    return 0;
};

PokerGame.prototype.cardRank = function(char) {
    var map = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, 'T':10, 'J':11, 'Q':12, 'K':13, 'A':14 };
    return map[char] || 0;
};

// Get state for channel update
PokerGame.prototype.getChannelState = function() {
    var balances = {};
    // Start with stacks (stack + pot = total channel money always, since bets are taken from stack and added to pot)
    for (var i = 0; i < this.players.length; i++) {
        balances[this.players[i].pubKey] = new Decimal(this.players[i].stack);
    }
    // Distribute unresolved pot evenly among non-folded players; folded players keep only their stack
    if (this.pot.greaterThan(0) && this.players.length > 0) {
        var activePlayers = [];
        for (var a = 0; a < this.players.length; a++) {
            if (!this.players[a].folded) activePlayers.push(this.players[a]);
        }
        var recipients = activePlayers.length > 0 ? activePlayers : this.players;
        var share = this.pot.dividedToIntegerBy(recipients.length);
        var remainder = this.pot.minus(share.times(recipients.length));
        for (var p = 0; p < recipients.length; p++) {
            balances[recipients[p].pubKey] = balances[recipients[p].pubKey].plus(share);
        }
        balances[recipients[0].pubKey] = balances[recipients[0].pubKey].plus(remainder);
    }
    // Convert to strings
    var result = {};
    for (var k in balances) { if (balances.hasOwnProperty(k)) result[k] = balances[k].toString(); }
    var playerCards = [];
    for (var j = 0; j < this.players.length; j++) {
        playerCards.push({ pubKey: this.players[j].pubKey, cards: this.players[j].cards });
    }
    return {
        balances: result,
        gameState: {
            round: this.round,
            pot: this.pot.toString(),
            communityCards: this.communityCards,
            playerCards: playerCards,
            turn: this.currentPlayer,
            lastAction: this.lastAction
        }
    };
};

// ==================== Exported functions ====================

/**
 * Initialize a new poker game for a table.
 * This should be called after channel is created.
 */
function initGame(tableId, channelId, players, blinds, callback) {
    var game = new PokerGame(tableId, players, blinds, channelId);
    gamesMap[tableId] = game;
    // Start commit phase
    game.startCommitPhase();
    // Save initial game state to database
    var state = game.getChannelState();
    sql.setGameState({
        tableId: tableId,
        round: game.round,
        pot: game.pot.toString(),
        communityCards: game.communityCards,
        playerCards: (function(players) {
            var result = [];
            for (var i = 0; i < players.length; i++) {
                result.push({ pubKey: players[i].pubKey, cardCount: players[i].cards.length });
            }
            return result;
        })(game.players),
        turn: game.currentPlayer,
        lastAction: game.lastAction,
        commits: game.commits,
        reveals: game.reveals
    }, function() {});
    callback(game);
}

/**
 * Handle a commit message from a player.
 */
function handleCommit(tableId, playerPubKey, commitHash) {
    var game = gamesMap[tableId];
    if (!game) return false;
    return game.receiveCommit(playerPubKey, commitHash);
}

/**
 * Handle a reveal message from a player.
 */
function handleReveal(tableId, playerPubKey, secret) {
    var game = gamesMap[tableId];
    if (!game) return false;
    return game.receiveReveal(playerPubKey, secret);
}

/**
 * Send a channel update for the current game state (callback version).
 * @param {PokerGame} game
 * @param {function} callback - called with success boolean
 */
function sendChannelUpdate(game, callback) {
    var chan = channel.get(game.channelId);
    if (!chan) { MDS.log('Channel not found: ' + game.channelId); callback(false); return; }

    var myWalletKey = (typeof getMyWalletKey === 'function') ? getMyWalletKey() :
                      (typeof window !== 'undefined' ? window.myMinimaPublicKey : '');
    var myMaxKey    = (typeof getMyMaximaKey === 'function') ? getMyMaximaKey() :
                      (typeof window !== 'undefined' ? window.myMaximaKey : '');

    var state = game.getChannelState();
    chan.createUpdateAsync(state.balances, state.gameState, function(err, update) {
        if (err) { MDS.log('createUpdateAsync error: ' + err); callback(false); return; }

        channel.signTxn(update.settlementTx, myWalletKey, function(err1, signedSettle) {
            if (err1) { MDS.log('signTxn settlement error: ' + err1); callback(false); return; }
            channel.signTxn(update.updateTx, myWalletKey, function(err2, signedUpdate) {
                if (err2) { MDS.log('signTxn update error: ' + err2); callback(false); return; }

                var sendMsg = {
                    type: 'SEND_FUNDS',
                    channelId: game.channelId,
                    settlementTx: signedSettle,
                    updateTx: signedUpdate,
                    sequence: update.sequence,
                    balances: update.balances,
                    gameState: update.gameState
                };
                var participants = chan.participants || [];
                var others = [];
                for (var pi = 0; pi < participants.length; pi++) {
                    if (participants[pi].pubKey !== myMaxKey) others.push(participants[pi].pubKey);
                }
                if (others.length === 0) { callback(true); return; }
                var done = 0, anyFailed = false;
                for (var oi = 0; oi < others.length; oi++) {
                    (function(pk) {
                        maxima.sendWithAck(pk, sendMsg, function(ok) {
                            if (!ok) anyFailed = true;
                            if (++done === others.length) callback(!anyFailed);
                        });
                    })(others[oi]);
                }
            });
        });
    });
}

/**
 * Process a bet action and trigger channel update.
 */
function handleBet(tableId, playerPubKey, action, amount, callback) {
    var game = gamesMap[tableId];
    if (!game) {
        callback(false);
        return;
    }

    var success = game.act(playerPubKey, action, amount);
    if (success) {
        sendChannelUpdate(game, callback);
    } else {
        callback(false);
    }
}

/**
 * Apply a state update (called from service.js after all signatures collected).
 */
function applyStateUpdate(tableId, state, signatures, callback) {
    var game = gamesMap[tableId];
    if (!game) {
        if (callback) callback(false);
        return false;
    }
    // Update game state from the state object
    game.round = state.gameState.round;
    game.pot = new Decimal(state.gameState.pot);
    game.communityCards = state.gameState.communityCards;
    game.currentPlayer = state.gameState.turn;
    game.lastAction = state.gameState.lastAction;
    // Update player stacks
    for (var pubKey in state.balances) {
        if (state.balances.hasOwnProperty(pubKey)) {
            var player = null;
            for (var i = 0; i < game.players.length; i++) {
                if (game.players[i].pubKey === pubKey) {
                    player = game.players[i];
                    break;
                }
            }
            if (player) player.stack = new Decimal(state.balances[pubKey]);
        }
    }
    if (callback) callback(true);
    return true;
}

/**
 * Start the actual game after commit-reveal phase.
 */
function startGameAfterCommit(tableId) {
    var game = gamesMap[tableId];
    if (!game) return;
    game.startGame();
    // Create initial channel state update
    sendChannelUpdate(game, function() {});
}

// Expose globally - for browser and service contexts
if (typeof window !== 'undefined') {
    window.poker = {
        initGame: initGame,
        handleCommit: handleCommit,
        handleReveal: handleReveal,
        handleBet: handleBet,
        applyStateUpdate: applyStateUpdate,
        startGameAfterCommit: startGameAfterCommit,
        getGame: function(tableId) { return gamesMap[tableId] || null; }
    };
}
// In service (no window), assign to global
if (typeof poker === 'undefined') {
    var poker = {
        initGame: initGame,
        handleCommit: handleCommit,
        handleReveal: handleReveal,
        handleBet: handleBet,
        applyStateUpdate: applyStateUpdate,
        startGameAfterCommit: startGameAfterCommit,
        getGame: function(tableId) { return gamesMap[tableId] || null; }
    };
}