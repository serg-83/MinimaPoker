/**
 * tooltips.js – Interactive poker help system for Minima Poker (ES5/Rhino compatible)
 * Provides hover tooltips and a comprehensive help modal with poker rules
 */

var pokerHelp = {
    tooltips: {
        button: 'The dealer button rotates clockwise each hand. The player with the button acts last in post-flop betting rounds.',
        smallBlind: 'Small Blind - forced bet posted by the player to the left of the button. Usually half the minimum bet.',
        bigBlind: 'Big Blind - forced bet posted by the player to the left of the small blind. Usually equal to the minimum bet.',
        fold: 'Fold - Discard your hand and forfeit the current pot. You cannot win if you fold.',
        check: 'Check - Decline to bet, passing the action to the next player. Only available if no bet has been made.',
        call: 'Call - Match the current bet to stay in the hand.',
        raise: 'Raise - Increase the current bet, forcing others to match your raise to continue.',
        pot: 'Pot - Total chips wagered in the current hand. Winner takes all.',
        communityCards: 'Community cards - Shared cards that all players can use to make their best 5-card hand.',
        preflop: 'Pre-flop - First betting round. Players receive two private cards. Action starts to the left of the big blind.',
        flop: 'Flop - Second betting round. Three community cards are dealt face up.',
        turn: 'Turn - Third betting round. A fourth community card is dealt face up.',
        river: 'River - Final betting round. A fifth community card is dealt face up.',
        showdown: 'Showdown - If multiple players remain after the final bet, they reveal their cards. The best 5-card hand wins.',
        channel: 'Payment Channel - Eltoo-based channel that enables secure off-chain transactions between players.',
        balance: 'Your current stack - Chips available for betting in this game.'
    },

    handRankings: [
        { name: 'Royal Flush', rank: 1, description: 'Ace-high straight flush - the best possible hand.', example: 'A K Q J 10 (same suit)', odds: '649,739:1' },
        { name: 'Straight Flush', rank: 2, description: 'Five consecutive cards of the same suit.', example: '9 8 7 6 5 (same suit)', odds: '72,192:1' },
        { name: 'Four of a Kind', rank: 3, description: 'Four cards of the same rank.', example: 'Q Q Q Q 2', odds: '4,164:1' },
        { name: 'Full House', rank: 4, description: 'Three of a kind combined with a pair.', example: 'J J J 4 4', odds: '693:1' },
        { name: 'Flush', rank: 5, description: 'Five cards of the same suit, not in sequence.', example: 'A J 9 6 3 (same suit)', odds: '508:1' },
        { name: 'Straight', rank: 6, description: 'Five consecutive cards of mixed suits.', example: '10 9 8 7 6', odds: '254:1' },
        { name: 'Three of a Kind', rank: 7, description: 'Three cards of the same rank.', example: '8 8 8 K 2', odds: '46:1' },
        { name: 'Two Pair', rank: 8, description: 'Two different pairs.', example: 'A A 7 7 Q', odds: '20:1' },
        { name: 'One Pair', rank: 9, description: 'Two cards of the same rank.', example: 'K K 9 5 2', odds: '1.36:1' },
        { name: 'High Card', rank: 10, description: 'No pair, no straight, no flush - the highest card plays.', example: 'A 10 8 4 2', odds: '1:1 (most common hand)' }
    ],

    init: function() {
        this.createTooltipStyles();
        this.setupTooltipListeners();
        this.createHelpButton();
    },

    createTooltipStyles: function() {
        var style = document.createElement('style');
        style.textContent =
            '[data-tooltip] { position: relative; cursor: help; }' +
            '[data-tooltip]:before { content: attr(data-tooltip); position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%) translateY(-10px); background: linear-gradient(145deg, #1e2b3a, #0f1a24); color: #f1e2b0; padding: 12px 20px; border-radius: 10px; font-size: 14px; font-weight: normal; white-space: nowrap; z-index: 1000; opacity: 0; visibility: hidden; transition: all 0.3s; box-shadow: 0 10px 25px rgba(0,0,0,0.5), 0 0 0 2px #d4af37; border: 1px solid #b38b2d; pointer-events: none; line-height: 1.4; text-shadow: none; letter-spacing: normal; text-transform: none; }' +
            '[data-tooltip]:after { content: ""; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%) translateY(5px); border-width: 8px; border-style: solid; border-color: #d4af37 transparent transparent transparent; opacity: 0; visibility: hidden; transition: all 0.3s; pointer-events: none; z-index: 1000; }' +
            '[data-tooltip]:hover:before, [data-tooltip]:hover:after { opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0); }' +
            '[data-tooltip-position="bottom"]:before { bottom: auto; top: 100%; transform: translateX(-50%) translateY(10px); }' +
            '[data-tooltip-position="bottom"]:after { bottom: auto; top: 100%; transform: translateX(-50%) translateY(-13px); border-color: transparent transparent #d4af37 transparent; }' +
            '[data-tooltip-position="bottom"]:hover:before, [data-tooltip-position="bottom"]:hover:after { transform: translateX(-50%) translateY(0); }' +
            '[data-tooltip-position="right"]:before { bottom: auto; left: 100%; top: 50%; transform: translateY(-50%) translateX(10px); }' +
            '[data-tooltip-position="right"]:after { bottom: auto; left: 100%; top: 50%; transform: translateY(-50%) translateX(-13px); border-color: transparent #d4af37 transparent transparent; }' +
            '[data-tooltip-position="right"]:hover:before, [data-tooltip-position="right"]:hover:after { transform: translateY(-50%) translateX(0); }' +
            '#help-button { position: fixed; bottom: 30px; right: 30px; width: 60px; height: 60px; border-radius: 50%; background: linear-gradient(145deg, #d4af37, #b38b2d); border: none; color: #000; font-size: 30px; font-weight: bold; cursor: pointer; box-shadow: 0 8px 0 #7a4f1a, 0 10px 25px rgba(0,0,0,0.5); transition: all 0.2s; z-index: 999; display: flex; align-items: center; justify-content: center; }' +
            '#help-button:hover { transform: translateY(-2px); box-shadow: 0 10px 0 #7a4f1a, 0 15px 30px rgba(0,0,0,0.6); }' +
            '#help-button:active { transform: translateY(5px); box-shadow: 0 3px 0 #7a4f1a; }' +
            '#help-modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 10000; align-items: center; justify-content: center; padding: 20px; }' +
            '#help-modal.active { display: flex; }' +
            '.modal-content { background: linear-gradient(145deg, #1e2b3a, #0f1a24); border: 3px solid #d4af37; border-radius: 30px; padding: 30px; max-width: 800px; max-height: 80vh; overflow-y: auto; position: relative; box-shadow: 0 30px 50px rgba(0,0,0,0.7); color: #f0f0e0; width: 90%; }' +
            '.modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; border-bottom: 2px solid #d4af37; padding-bottom: 10px; }' +
            '.modal-header h2 { font-size: 2.5rem; color: #d4af37; margin: 0; }' +
            '.close-modal { background: none; border: none; color: #d4af37; font-size: 2.5rem; cursor: pointer; line-height: 1; padding: 0 10px; }' +
            '.close-modal:hover { color: #f1e2b0; }' +
            '.modal-section { margin-bottom: 30px; }' +
            '.modal-section h3 { font-size: 1.8rem; color: #d4af37; margin-bottom: 15px; border-left: 5px solid #d4af37; padding-left: 15px; }' +
            '.hand-rankings-table { width: 100%; border-collapse: collapse; }' +
            '.hand-rankings-table th { text-align: left; padding: 10px; background: rgba(212, 175, 55, 0.2); color: #d4af37; font-weight: 600; }' +
            '.hand-rankings-table td { padding: 10px; border-bottom: 1px solid rgba(212, 175, 55, 0.2); }' +
            '.hand-rankings-table tr:hover { background: rgba(212, 175, 55, 0.1); }' +
            '.hand-example { font-family: monospace; background: rgba(0,0,0,0.3); padding: 2px 5px; border-radius: 3px; }' +
            '.betting-rounds { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }' +
            '.round-card { background: rgba(0,0,0,0.3); border: 1px solid #d4af37; border-radius: 10px; padding: 15px; }' +
            '.round-card h4 { color: #d4af37; font-size: 1.3rem; margin-bottom: 8px; }' +
            '.round-card p { font-size: 0.9rem; opacity: 0.9; }' +
            '@media (max-width: 600px) { [data-tooltip]:before { white-space: normal; max-width: 200px; font-size: 12px; } #help-button { width: 50px; height: 50px; font-size: 25px; bottom: 20px; right: 20px; } .modal-content { padding: 20px; } .hand-rankings-table { font-size: 0.9rem; } }';
        document.head.appendChild(style);
    },

    setupTooltipListeners: function() {
        var self = this;
        if (typeof MutationObserver !== 'undefined') {
            var observer = new MutationObserver(function(mutations) {
                for (var m = 0; m < mutations.length; m++) {
                    var addedNodes = mutations[m].addedNodes;
                    for (var n = 0; n < addedNodes.length; n++) {
                        if (addedNodes[n].nodeType === 1) {
                            self.addTooltipsToElement(addedNodes[n]);
                        }
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        this.addTooltipsToElement(document.body);
    },

    addTooltipsToElement: function(root) {
        var foldBtn = root.querySelector ? root.querySelector('#foldBtn') : null;
        if (foldBtn && !foldBtn.hasAttribute('data-tooltip')) {
            foldBtn.setAttribute('data-tooltip', this.tooltips.fold);
        }
        var checkBtn = root.querySelector ? root.querySelector('#checkBtn') : null;
        if (checkBtn && !checkBtn.hasAttribute('data-tooltip')) {
            checkBtn.setAttribute('data-tooltip', this.tooltips.check);
        }
        var callBtn = root.querySelector ? root.querySelector('#callBtn') : null;
        if (callBtn && !callBtn.hasAttribute('data-tooltip')) {
            callBtn.setAttribute('data-tooltip', this.tooltips.call);
        }
        var raiseBtn = root.querySelector ? root.querySelector('#raiseBtn') : null;
        if (raiseBtn && !raiseBtn.hasAttribute('data-tooltip')) {
            raiseBtn.setAttribute('data-tooltip', this.tooltips.raise);
        }
        var pot = root.querySelector ? root.querySelector('#pot') : null;
        if (pot && !pot.hasAttribute('data-tooltip')) {
            pot.setAttribute('data-tooltip', this.tooltips.pot);
            pot.setAttribute('data-tooltip-position', 'bottom');
        }
        var community = root.querySelector ? root.querySelector('#community') : null;
        if (community && !community.hasAttribute('data-tooltip')) {
            community.setAttribute('data-tooltip', this.tooltips.communityCards);
            community.setAttribute('data-tooltip-position', 'bottom');
        }
        var channelStatus = root.querySelector ? root.querySelector('#channel-status') : null;
        if (channelStatus && !channelStatus.hasAttribute('data-tooltip')) {
            channelStatus.setAttribute('data-tooltip', this.tooltips.channel);
        }
        var seats = root.querySelectorAll ? root.querySelectorAll('.seat') : [];
        for (var i = 0; i < seats.length; i++) {
            var seat = seats[i];
            if (!seat.hasAttribute('data-tooltip')) {
                var stackEl = seat.querySelector('.stack');
                if (stackEl && !stackEl.hasAttribute('data-tooltip')) {
                    stackEl.setAttribute('data-tooltip', this.tooltips.balance);
                    stackEl.setAttribute('data-tooltip-position', 'right');
                }
                var nameEl = seat.querySelector('.name');
                if (nameEl && nameEl.textContent.indexOf('(you)') !== -1) {
                    seat.setAttribute('data-tooltip', 'Your seat');
                }
            }
        }
    },

    createHelpButton: function() {
        var button = document.createElement('button');
        button.id = 'help-button';
        button.innerHTML = '?';
        button.setAttribute('aria-label', 'Poker help');
        document.body.appendChild(button);

        var modal = document.createElement('div');
        modal.id = 'help-modal';
        modal.innerHTML = this.generateModalHTML();
        document.body.appendChild(modal);

        button.addEventListener('click', function() {
            modal.classList.add('active');
        });

        var closeBtn = modal.querySelector('.close-modal');
        if (closeBtn) {
            closeBtn.addEventListener('click', function() {
                modal.classList.remove('active');
            });
        }

        modal.addEventListener('click', function(e) {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && modal.classList.contains('active')) {
                modal.classList.remove('active');
            }
        });
    },

    generateModalHTML: function() {
        var handRows = '';
        for (var i = 0; i < this.handRankings.length; i++) {
            var hand = this.handRankings[i];
            handRows += '<tr><td><strong>' + hand.name + '</strong></td><td>' + hand.description + '</td><td><span class="hand-example">' + hand.example + '</span></td><td>' + hand.odds + '</td></tr>';
        }

        return '<div class="modal-content">' +
            '<div class="modal-header">' +
                '<h2>Poker Rules &amp; Help</h2>' +
                '<button class="close-modal">&times;</button>' +
            '</div>' +
            '<div class="modal-section">' +
                '<h3>Hand Rankings (highest to lowest)</h3>' +
                '<table class="hand-rankings-table">' +
                    '<thead><tr><th>Hand</th><th>Description</th><th>Example</th><th>Odds</th></tr></thead>' +
                    '<tbody>' + handRows + '</tbody>' +
                '</table>' +
            '</div>' +
            '<div class="modal-section">' +
                '<h3>Betting Rounds</h3>' +
                '<div class="betting-rounds">' +
                    '<div class="round-card"><h4>Pre-flop</h4><p>' + this.tooltips.preflop + '</p></div>' +
                    '<div class="round-card"><h4>Flop</h4><p>' + this.tooltips.flop + '</p></div>' +
                    '<div class="round-card"><h4>Turn</h4><p>' + this.tooltips.turn + '</p></div>' +
                    '<div class="round-card"><h4>River</h4><p>' + this.tooltips.river + '</p></div>' +
                    '<div class="round-card"><h4>Showdown</h4><p>' + this.tooltips.showdown + '</p></div>' +
                '</div>' +
            '</div>' +
            '<div class="modal-section">' +
                '<h3>Player Actions</h3>' +
                '<ul style="list-style: none; padding: 0;">' +
                    '<li style="margin-bottom: 10px;"><strong style="color: #d4af37;">Fold</strong> - ' + this.tooltips.fold + '</li>' +
                    '<li style="margin-bottom: 10px;"><strong style="color: #d4af37;">Check</strong> - ' + this.tooltips.check + '</li>' +
                    '<li style="margin-bottom: 10px;"><strong style="color: #d4af37;">Call</strong> - ' + this.tooltips.call + '</li>' +
                    '<li style="margin-bottom: 10px;"><strong style="color: #d4af37;">Raise</strong> - ' + this.tooltips.raise + '</li>' +
                '</ul>' +
            '</div>' +
            '<div class="modal-section">' +
                '<h3>Game Elements</h3>' +
                '<p><strong style="color: #d4af37;">Pot</strong> - ' + this.tooltips.pot + '</p>' +
                '<p><strong style="color: #d4af37;">Community Cards</strong> - ' + this.tooltips.communityCards + '</p>' +
                '<p><strong style="color: #d4af37;">Small Blind</strong> - ' + this.tooltips.smallBlind + '</p>' +
                '<p><strong style="color: #d4af37;">Big Blind</strong> - ' + this.tooltips.bigBlind + '</p>' +
                '<p><strong style="color: #d4af37;">Button</strong> - ' + this.tooltips.button + '</p>' +
                '<p><strong style="color: #d4af37;">Payment Channel</strong> - ' + this.tooltips.channel + '</p>' +
            '</div>' +
            '<div class="modal-section">' +
                '<p style="text-align: center; font-style: italic; color: #d4af37;">Hover over any button or element for quick help!</p>' +
            '</div>' +
        '</div>';
    },

    addTooltip: function(element, text, position) {
        if (position === undefined) position = 'top';
        if (element && !element.hasAttribute('data-tooltip')) {
            element.setAttribute('data-tooltip', text);
            if (position !== 'top') {
                element.setAttribute('data-tooltip-position', position);
            }
        }
    }
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { pokerHelp.init(); });
} else {
    pokerHelp.init();
}

// Make available globally
if (typeof window !== 'undefined') {
    window.pokerHelp = pokerHelp;
}
