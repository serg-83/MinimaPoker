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
    this.blinds = blinds; // { small: Decimal, big: Decimal }
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
    if (!this._pendingDbUpdate) {
        this._pendingDbUpdate = setTimeout(function() {
            self._flushDbUpdate();
        }, 500); // Batch writes within 500ms
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
        if (this._pendingDbUpdate) {
            clearTimeout(this._pendingDbUpdate);
            this._pendingDbUpdate = null;
        }
        this._flushDbUpdate();
    }
    return true;
};

PokerGame.prototype._flushDbUpdate = function() {
    this._pendingDbUpdate = null;
    var state = this.getChannelState();
    sql.setGameState({
        tableId: this.tableId,
        round: this.round,
        pot: this.pot.toString(),
        communityCards: this.communityCards,
        playerCards: (function(players) {
            var result = [];
            for (var i = 0; i < players.length; i++) {
                result.push({ pubKey: players[i].pubKey, cards: players[i].cards });
            }
            return result;
        })(this.players),
        turn: this.currentPlayer,
        lastAction: this.lastAction,
        commits: this.commits,
        reveals: this.reveals
    }, function() {});
};

PokerGame.prototype.receiveReveal = function(pubKey, secret) {
    if (this.round !== 'reveal') return false;
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
            MDS.log('Invalid reveal for ' + pubKey);
            return false;
        }
        self.reveals[pubKey] = secret;
        player.secret = secret;

        // Debounced database persistence
        if (!self._pendingDbUpdate) {
            self._pendingDbUpdate = setTimeout(function() {
                self._flushDbUpdate();
            }, 500);
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
                clearTimeout(self._pendingDbUpdate);
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

            // Broadcast the initial game state via channel update
            sendChannelUpdate(self, function(success) {
                if (!success) MDS.log('Failed to send initial channel update');
            });
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
    // Override commit so verification passes
    this.commits[pubKey] = zeroSeed;
    this.receiveReveal(pubKey, zeroSeed);
    if (callback) callback();
};

/**
 * Force-commit for a player who timed out during commit phase.
 */
PokerGame.prototype.forceCommit = function(pubKey) {
    var zeroHash = '0000000000000000000000000000000000000000000000000000000000000000';
    this.receiveCommit(pubKey, zeroHash);
};

PokerGame.prototype.combineSeeds = function() {
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
    // Derive dealer position deterministically from the combined seed
    this.dealer = parseInt(this.seed.substring(0, 8), 16) % this.players.length;
    this.smallBlindPos = (this.dealer + 1) % this.players.length;
    this.bigBlindPos   = (this.dealer + 2) % this.players.length;
    // Post blinds
    this.postBlind(this.smallBlindPos, this.blinds.small);
    this.postBlind(this.bigBlindPos, this.blinds.big);
    this.round = 'preflop';
    this.currentPlayer = (this.bigBlindPos + 1) % this.players.length;
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
        if (this.players[i].pubKey === playerPubKey) {
            playerIndex = i;
            break;
        }
    }
    if (playerIndex !== this.currentPlayer) return false;

    var player = this.players[playerIndex];
    if (player.folded) return false;

    switch (action) {
        case 'fold':
            player.folded = true;
            this.lastAction = 'fold';
            this.advanceTurn();
            break;
        case 'check':
            if (this.getCurrentBet().greaterThan(0)) return false;
            this.lastAction = 'check';
            this.advanceTurn();
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
            this.advanceTurn();
            break;
        case 'raise':
            if (amount === null) return false;
            var raiseAmount = new Decimal(amount);
            var minRaise = this.minRaise;
            if (raiseAmount.lessThan(minRaise)) return false;
            var totalBet = this.getCurrentBet().plus(raiseAmount);
            var additional = totalBet.minus(player.bet);
            if (additional.greaterThan(player.stack)) return false;
            player.stack = player.stack.minus(additional);
            player.bet = player.bet.plus(additional);
            this.pot = this.pot.plus(additional);
            this.minRaise = raiseAmount;
            this.lastAction = 'raise';
            this.advanceTurn();
            break;
        default:
            return false;
    }
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
    var next = (this.currentPlayer + 1) % this.players.length;
    while (next !== this.currentPlayer) {
        if (!this.players[next].folded) {
            this.currentPlayer = next;
            break;
        }
        next = (next + 1) % this.players.length;
    }
    if (this.isRoundComplete()) {
        this.nextRound();
    }
};

PokerGame.prototype.isRoundComplete = function() {
    var active = [];
    for (var i = 0; i < this.players.length; i++) {
        if (!this.players[i].folded) {
            active.push(this.players[i]);
        }
    }
    if (active.length === 1) return true;
    var currentBet = this.getCurrentBet();
    for (var j = 0; j < active.length; j++) {
        var p = active[j];
        if (!p.bet.equals(currentBet) && p.stack.greaterThan(0)) return false;
    }
    return true;
};

PokerGame.prototype.nextRound = function() {
    // Move bets to pot
    for (var i = 0; i < this.players.length; i++) {
        this.players[i].bet = new Decimal(0);
    }
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
    this.currentPlayer = (this.dealer + 1) % this.players.length;
    while (this.players[this.currentPlayer].folded) {
        this.currentPlayer = (this.currentPlayer + 1) % this.players.length;
    }
    this.minRaise = this.blinds.big;
};

PokerGame.prototype.dealCommunity = function(count) {
    for (var i = 0; i < count; i++) {
        this.communityCards.push(this.remainingDeck.shift());
    }
};

PokerGame.prototype.showdown = function() {
    var active = [];
    for (var i = 0; i < this.players.length; i++) {
        if (!this.players[i].folded) {
            active.push(this.players[i]);
        }
    }
    if (active.length === 1) {
        active[0].stack = active[0].stack.plus(this.pot);
    } else {
        var evaluations = [];
        for (var j = 0; j < active.length; j++) {
            var p = active[j];
            evaluations.push({
                player: p,
                hand: this.evaluateHand(p.cards, this.communityCards)
            });
        }

        // Sort by rank first, then by high cards for tie-breaking
        evaluations.sort(function(a, b) {
            if (a.hand.rank !== b.hand.rank) {
                return b.hand.rank - a.hand.rank;
            }
            // Same rank - compare high cards (kickers)
            for (var hc = 0; hc < a.hand.highCards.length && hc < b.hand.highCards.length; hc++) {
                if (a.hand.highCards[hc] !== b.hand.highCards[hc]) {
                    return b.hand.highCards[hc] - a.hand.highCards[hc];
                }
            }
            // If still equal, compare next cards (if any)
            return 0;
        });

        var bestRank = evaluations[0].hand.rank;
        var bestHighCards = evaluations[0].hand.highCards;
        var winners = [];

        for (var k = 0; k < evaluations.length; k++) {
            var eval = evaluations[k];
            if (eval.hand.rank === bestRank) {
                // Check if high cards match exactly
                var isEqual = true;
                for (var hc2 = 0; hc2 < bestHighCards.length && hc2 < eval.hand.highCards.length; hc2++) {
                    if (bestHighCards[hc2] !== eval.hand.highCards[hc2]) {
                        isEqual = false;
                        break;
                    }
                }
                if (isEqual) {
                    winners.push(eval.player);
                }
            }
        }

        var share = this.pot.dividedBy(winners.length);
        for (var w = 0; w < winners.length; w++) {
            winners[w].stack = winners[w].stack.plus(share);
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
    // Fast hand evaluation using bit masks
    // This is a simplified version - for production use a pre-computed lookup table
    var rankCounts = [0,0,0,0,0,0,0,0,0,0,0,0,0];
    var suitCounts = [0,0,0,0];

    for (var i = 0; i < cards.length; i++) {
        var c = cards[i];
        var rank = this.cardRank(c[0]);
        var suit = c[1];
        rankCounts[rank-2]++;
        var suitIdx = 'shdc'.indexOf(suit);
        if (suitIdx >= 0) {
            suitCounts[suitIdx]++;
        }
    }

    var isFlush = false;
    for (var s = 0; s < suitCounts.length; s++) {
        if (suitCounts[s] >= 5) {
            isFlush = true;
            break;
        }
    }

    var ranks = [];
    for (var r = 0; r < cards.length; r++) {
        ranks.push(this.cardRank(cards[r][0]));
    }
    ranks.sort(function(a, b) { return b - a; });

    var isStraight = this.isStraightFast(ranks);

    // Check for straight flush
    if (isFlush && isStraight) {
        if (ranks[0] === 14 && ranks[1] === 5) return { rank: 9, description: 'Straight Flush', highCards: [5] };
        return { rank: 9, description: 'Straight Flush', highCards: [ranks[0]] };
    }

    // Check for four of a kind
    var fourRank = -1;
    for (var fr = 0; fr < rankCounts.length; fr++) {
        if (rankCounts[fr] === 4) {
            fourRank = fr;
            break;
        }
    }
    if (fourRank >= 0) {
        var kicker = -1;
        for (var kr = 0; kr < rankCounts.length; kr++) {
            if (rankCounts[kr] === 1) {
                kicker = kr;
                break;
            }
        }
        return { rank: 8, description: 'Four of a Kind', highCards: [fourRank+2, kicker+2] };
    }

    // Check for full house
    var threeRank = -1;
    for (var tr = 0; tr < rankCounts.length; tr++) {
        if (rankCounts[tr] === 3) {
            threeRank = tr;
            break;
        }
    }
    var pairRank = -1;
    for (var pr = 0; pr < rankCounts.length; pr++) {
        if (rankCounts[pr] === 2) {
            pairRank = pr;
            break;
        }
    }
    if (threeRank >= 0 && pairRank >= 0) {
        return { rank: 7, description: 'Full House', highCards: [threeRank+2, pairRank+2] };
    }

    // Flush
    if (isFlush) {
        var sortedRanks = [];
        for (var sr = 0; sr < rankCounts.length; sr++) {
            if (rankCounts[sr] > 0) {
                sortedRanks.push(sr+2);
            }
        }
        sortedRanks.sort(function(a, b) { return b - a; });
        return { rank: 6, description: 'Flush', highCards: sortedRanks };
    }

    // Straight
    if (isStraight) {
        if (ranks[0] === 14 && ranks[1] === 5) return { rank: 5, description: 'Straight', highCards: [5] };
        return { rank: 5, description: 'Straight', highCards: [ranks[0]] };
    }

    // Three of a kind
    if (threeRank >= 0) {
        var kickers2 = [];
        for (var kr2 = 0; kr2 < rankCounts.length; kr2++) {
            if (rankCounts[kr2] === 1) {
                kickers2.push(kr2+2);
            }
        }
        kickers2.sort(function(a, b) { return b - a; });
        var result = [threeRank+2];
        for (var kk = 0; kk < kickers2.length; kk++) {
            result.push(kickers2[kk]);
        }
        return { rank: 4, description: 'Three of a Kind', highCards: result };
    }

    // Two pair
    var pairs = [];
    for (var pr2 = 0; pr2 < rankCounts.length; pr2++) {
        if (rankCounts[pr2] === 2) {
            pairs.push(pr2+2);
        }
    }
    pairs.sort(function(a, b) { return b - a; });
    if (pairs.length >= 2) {
        var kicker3 = -1;
        for (var kr3 = 0; kr3 < rankCounts.length; kr3++) {
            if (rankCounts[kr3] === 1) {
                kicker3 = kr3;
                break;
            }
        }
        return { rank: 3, description: 'Two Pair', highCards: [pairs[0], pairs[1], kicker3+2] };
    }

    // One pair
    if (pairs.length === 1) {
        var kickers4 = [];
        for (var kr4 = 0; kr4 < rankCounts.length; kr4++) {
            if (rankCounts[kr4] === 1) {
                kickers4.push(kr4+2);
            }
        }
        kickers4.sort(function(a, b) { return b - a; });
        var result2 = [pairs[0]];
        for (var kk2 = 0; kk2 < kickers4.length; kk2++) {
            result2.push(kickers4[kk2]);
        }
        return { rank: 2, description: 'One Pair', highCards: result2 };
    }

    // High card
    var highCards = [];
    for (var hc = 0; hc < rankCounts.length; hc++) {
        if (rankCounts[hc] > 0) {
            highCards.push(hc+2);
        }
    }
    highCards.sort(function(a, b) { return b - a; });
    highCards = highCards.slice(0,5);
    return { rank: 1, description: 'High Card', highCards: highCards };
};

PokerGame.prototype.isStraightFast = function(ranks) {
    // Remove duplicates
    var uniqueRanks = [];
    for (var i = 0; i < ranks.length; i++) {
        if (uniqueRanks.indexOf(ranks[i]) === -1) {
            uniqueRanks.push(ranks[i]);
        }
    }
    uniqueRanks.sort(function(a, b) { return b - a; });
    if (uniqueRanks.length < 5) return false;

    // Check for Ace-low straight
    if (uniqueRanks[0] === 14 && uniqueRanks[1] === 5 && uniqueRanks[2] === 4 &&
        uniqueRanks[3] === 3 && uniqueRanks[4] === 2) {
        return true;
    }

    // Check consecutive
    for (var j = 0; j < uniqueRanks.length - 4; j++) {
        if (uniqueRanks[j] - uniqueRanks[j+4] === 4) {
            return true;
        }
    }
    return false;
};

PokerGame.prototype.cardRank = function(char) {
    var map = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, 'T':10, 'J':11, 'Q':12, 'K':13, 'A':14 };
    return map[char] || 0;
};

// Get state for channel update
PokerGame.prototype.getChannelState = function() {
    var balances = {};
    for (var i = 0; i < this.players.length; i++) {
        var p = this.players[i];
        balances[p.pubKey] = p.stack.toString();
    }
    var playerCards = [];
    for (var j = 0; j < this.players.length; j++) {
        var p2 = this.players[j];
        playerCards.push({ pubKey: p2.pubKey, cards: p2.cards });
    }
    return {
        balances: balances,
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
                result.push({ pubKey: players[i].pubKey, cards: players[i].cards });
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
    if (!chan) {
        MDS.log('Channel not found: ' + game.channelId);
        callback(false);
        return;
    }
    var myKey = (typeof getMyMaximaKey === 'function') ? getMyMaximaKey() :
                (typeof window !== 'undefined' ? window.myMaximaKey : '');
    var _pendingUpdates = (typeof pendingUpdates !== 'undefined') ? pendingUpdates :
                          (typeof window !== 'undefined' ? window.pendingUpdates : {});
    if (!_pendingUpdates) _pendingUpdates = {};

    var state = game.getChannelState();
    chan.createUpdateAsync(state.balances, state.gameState, function(err, update) {
        if (err) {
            MDS.log('createUpdateAsync error: ' + err);
            callback(false);
            return;
        }

        channel.signTxn(update.settlementTx, myKey, function(err1, signedSettle) {
            if (err1) {
                MDS.log('signTxn settlement error: ' + err1);
                callback(false);
                return;
            }
            channel.signTxn(update.updateTx, myKey, function(err2, signedUpdate) {
                if (err2) {
                    MDS.log('signTxn update error: ' + err2);
                    callback(false);
                    return;
                }

                _pendingUpdates[game.channelId] = {
                    balances: update.balances,
                    gameState: update.gameState,
                    sequence: update.sequence
                };

                // Send to each participant (except ourselves)
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
                var sentCount = 0;
                var totalToSend = 0;
                var anyFailed = false;
                for (var pi = 0; pi < participants.length; pi++) {
                    if (participants[pi].pubKey !== myKey) {
                        totalToSend++;
                    }
                }
                if (totalToSend === 0) {
                    callback(true);
                    return;
                }
                for (var pj = 0; pj < participants.length; pj++) {
                    if (participants[pj].pubKey !== myKey) {
                        (function(pubKey) {
                            maxima.sendWithAck(pubKey, sendMsg, function(success) {
                                sentCount++;
                                if (!success) anyFailed = true;
                                if (sentCount === totalToSend) {
                                    if (anyFailed) {
                                        delete _pendingUpdates[game.channelId];
                                        callback(false);
                                    } else {
                                        callback(true);
                                    }
                                }
                            });
                        })(participants[pj].pubKey);
                    }
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