// channel.js – Multi-party payment channels for Minima Poker (eltoo-based)
// Adapted from Thunder project: https://github.com/minima-global/Thunder
// Supports N‑of‑N multisig with eltoo update/settlement mechanism
// Includes improved error handling and dispute tracking

// ==================== Imports & Globals ====================
/* global MDS, utils, Decimal, sql, maxima */

// In‑memory cache of active channels (key: channelId)
var channels = {};

// Helper: convert a number to a plain decimal string (no scientific notation)
// Minima's MiniNumber parser rejects "1e-8" style notation
function toMinimaAmount(val) {
    var d = new Decimal(val);
    // toFixed with enough precision to avoid scientific notation
    var s = d.toFixed(8);
    // Strip trailing zeros after decimal point but keep at least one decimal place
    s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
    return s;
}

// Helper: generate a random 16‑char hex string (used as temporary transaction id)
function randomString() {
    return utils.genRandomHexString(8);
}

// ==================== Script Builders ====================

/**
 * Build a N‑of‑N multisig funding script (no state).
 * @param {string} hashid - unique channel ID
 * @param {string[]} pubKeys - array of participant public keys (hex)
 * @returns {string} - KISSVM script (as a string)
 */
function buildFundingScript(hashid, pubKeys) {
    var multisig = 'MULTISIG(' + pubKeys.length + ' ' + pubKeys.join(' ') + ')';
    return 'LET randid=[' + hashid + '] ASSERT ' + multisig + ' RETURN TRUE';
}

/**
 * Build an eltoo script for N‑of‑N with update/settlement logic.
 * @param {string} hashid - unique channel ID
 * @param {string[]} pubKeys - array of participant public keys
 * @param {number} timeoutBlocks - settlement timeout in blocks
 * @returns {string} - KISSVM script
 */
function buildEltooScript(hashid, pubKeys, timeoutBlocks) {
    var multisig = 'MULTISIG(' + pubKeys.length + ' ' + pubKeys.join(' ') + ')';
    return 'LET randid=[' + hashid + '] '
        + 'LET settlement=STATE(100) LET sequence=STATE(101) LET prevsequence=PREVSTATE(101) '
        + 'ASSERT ' + multisig + ' '
        + 'IF settlement THEN '
        +   'IF sequence EQ prevsequence AND @COINAGE GTE ' + timeoutBlocks + ' THEN RETURN TRUE ENDIF '
        + 'ELSE '
        +   'IF sequence GT prevsequence THEN RETURN TRUE ENDIF '
        + 'ENDIF';
}

// ==================== Script Tracking (matching thunder) ====================

/**
 * Track a script so the node monitors coins at that address.
 * @param {string} script - the clean script text
 * @param {function} callback - optional
 */
function trackScript(script, callback) {
    MDS.cmd('newscript trackall:true script:"' + script + '"', function(resp) {
        if (callback) {
            callback(resp);
        }
    });
}

/**
 * Remove a tracked script by address (on channel close).
 * @param {string} address - the address to stop tracking
 * @param {function} callback - optional
 */
function removeScript(address, callback) {
    MDS.cmd('removescript address:' + address, function(resp) {
        if (callback) {
            callback(resp);
        }
    });
}

// ==================== Transaction Creation (MDS commands) ====================

/**
 * Create a funding transaction that sends total amount to the funding address.
 * @param {string} fundingAddress - multisig address from funding script
 * @param {string} addAmount - amount to add from user's wallet (will be combined with other inputs)
 * @param {string} totalAmount - total channel amount
 * @param {string} tokenId - token id (default '0x00')
 * @param {function} callback - called with (err, txHex). err is string or null.
 */
function createFundingTxn(fundingAddress, addAmount, totalAmount, tokenId, callback) {
    // First check if user has sufficient balance
    MDS.cmd('balance', function(balanceResp) {
        if (!balanceResp || !balanceResp.response) {
            callback('Failed to check balance', null);
            return;
        }

        // Find the token balance
        var tokenBalance = '0';
        var balances = balanceResp.response;
        for (var i = 0; i < balances.length; i++) {
            if (balances[i].tokenid === tokenId) {
                tokenBalance = balances[i].confirmed;
                break;
            }
        }

        // Convert to Decimal for comparison
        var userBalance = new Decimal(tokenBalance);
        var requiredAmount = new Decimal(addAmount);

        if (userBalance.lessThan(requiredAmount)) {
            callback('Insufficient balance: have ' + userBalance + ', need ' + requiredAmount, null);
            return;
        }

        var txid = randomString();
        var cmd = 'txncreate id:' + txid + ';' +
                    'txnoutput id:' + txid + ' amount:' + toMinimaAmount(totalAmount) + ' tokenid:' + tokenId + ' address:' + fundingAddress + ';' +
                    'txnaddamount id:' + txid + ' onlychange:true tokenid:' + tokenId + ' amount:' + toMinimaAmount(addAmount) + ';' +
                    'txnexport id:' + txid + ';' +
                    'txndelete id:' + txid + ';';

        MDS.cmd(cmd, function(resp) {
            if (!resp || !Array.isArray(resp)) {
                callback('MDS command failed', null);
                return;
            }

            // Check for errors in any response
            for (var j = 0; j < resp.length; j++) {
                if (resp[j] && resp[j].error) {
                    callback('Funding tx error: ' + resp[j].error, null);
                    return;
                }
            }

            // resp[2] is the result of txnaddamount
            if (!resp[2] || !resp[2].status) {
                var err = 'createFundingTxn: insufficient funds or other error';
                MDS.log(err + ' ' + JSON.stringify(resp));
                callback(err, null);
            } else {
                var txHex = null;
                if (resp[3] && resp[3].response && resp[3].response.data) {
                    txHex = resp[3].response.data;
                }
                if (!txHex) {
                    callback('Failed to export funding tx', null);
                } else {
                    callback(null, txHex);
                }
            }
        });
    });
}

/**
 * Add a participant's funds to an existing funding transaction.
 * Called by non-initiator participants when they receive CREATE_CHANNEL.
 */
function addToFundingTxn(txHex, addAmount, tokenId, callback) {
    if (new Decimal(addAmount).lessThanOrEqualTo(0)) { callback(null, txHex); return; }
    var txid = randomString();
    var cmd = 'txnimport id:' + txid + ' data:' + txHex + ';' +
              'txnaddamount id:' + txid + ' onlychange:true tokenid:' + tokenId + ' amount:' + toMinimaAmount(addAmount) + ';' +
              'txnexport id:' + txid + ';' +
              'txndelete id:' + txid + ';';
    MDS.cmd(cmd, function(resp) {
        if (!resp || !Array.isArray(resp) || !resp[1] || !resp[1].status) {
            callback('addToFundingTxn failed: insufficient funds', null);
            return;
        }
        callback(null, resp[2].response.data);
    });
}

/**
 * @param {string} fundingAddress - address of funding output
 * @param {string} eltooAddress - address of eltoo script
 * @param {string} tokenId
 * @param {function} callback - called with (err, txHex)
 */
function createTriggerTxn(amount, fundingAddress, eltooAddress, tokenId, callback) {
    var txid = randomString();
    var cmd = 'txncreate id:' + txid + ';' +
                'txninput id:' + txid + ' tokenid:' + tokenId + ' amount:' + toMinimaAmount(amount) + ' address:' + fundingAddress + ' floating:true;' +
                'txnoutput id:' + txid + ' tokenid:' + tokenId + ' storestate:true amount:' + toMinimaAmount(amount) + ' address:' + eltooAddress + ';' +
                'txnstate id:' + txid + ' port:101 value:0;' +
                'txnexport id:' + txid + ';' +
                'txndelete id:' + txid + ';';
    MDS.cmd(cmd, function(resp) {
        if (!resp || !Array.isArray(resp)) {
            callback('MDS command failed', null);
            return;
        }
        var txHex = null;
        if (resp[4] && resp[4].response && resp[4].response.data) {
            txHex = resp[4].response.data;
        }
        if (!txHex) {
            callback('Failed to create trigger tx', null);
        } else {
            callback(null, txHex);
        }
    });
}

/**
 * Create a settlement transaction: spends eltoo output and distributes to participants.
 * @param {string} hashid - channel ID
 * @param {number|string} sequence - current sequence number
 * @param {string} eltooAddress
 * @param {string} totalAmount
 * @param {Array} outputs - [{ address, amount }] for each participant (amount > 0)
 * @param {string} tokenId
 * @param {function} callback - called with (err, txHex)
 */
function createSettlementTxn(hashid, sequence, eltooAddress, totalAmount, outputs, tokenId, callback) {
    // Validate sequence is greater than current (should be checked before calling)
    if (sequence < 0) {
        callback('Sequence must be non-negative', null);
        return;
    }

    var txid = randomString();
    var cmd = 'txncreate id:' + txid + ';' +
              'txninput id:' + txid + ' amount:' + toMinimaAmount(totalAmount) + ' tokenid:' + tokenId + ' address:' + eltooAddress + ' floating:true;';

    var totalOutputAmount = new Decimal(0);
    for (var outIdx = 0; outIdx < outputs.length; outIdx++) {
        var out = outputs[outIdx];
        var amount = new Decimal(out.amount);
        if (amount.greaterThan(0)) {
            totalOutputAmount = totalOutputAmount.plus(amount);
            cmd += 'txnoutput id:' + txid + ' storestate:true amount:' + toMinimaAmount(out.amount) + ' tokenid:' + tokenId + ' address:' + out.address + ';';
        }
    }

    // Verify total output amount matches input amount
    if (!totalOutputAmount.equals(new Decimal(totalAmount))) {
        callback('Total output amount ' + totalOutputAmount + ' does not match input amount ' + totalAmount, null);
        return;
    }

    cmd += 'txnstate id:' + txid + ' port:100 value:TRUE;' +
           'txnstate id:' + txid + ' port:101 value:' + sequence + ';' +
           'txnstate id:' + txid + ' port:200 value:' + hashid + ';' +
           'txnexport id:' + txid + ';' +
           'txndelete id:' + txid + ';';

    MDS.cmd(cmd, function(resp) {
        if (!resp || !Array.isArray(resp)) {
            callback('MDS command failed', null);
            return;
        }

        // Check for errors
        for (var i = 0; i < resp.length; i++) {
            if (resp[i] && resp[i].error) {
                callback('Settlement tx error: ' + resp[i].error, null);
                return;
            }
        }

        // txnexport is second-to-last command (last is txndelete)
        var txHex = null;
        if (resp[resp.length-2] && resp[resp.length-2].response && resp[resp.length-2].response.data) {
            txHex = resp[resp.length-2].response.data;
        }
        if (!txHex) {
            callback('Failed to create settlement tx', null);
        } else {
            callback(null, txHex);
        }
    });
}

/**
 * Create an update transaction: spends eltoo output back to eltoo address with increased sequence.
 * @param {number|string} sequence - new sequence number (must be > previous)
 * @param {string} eltooAddress
 * @param {string} totalAmount
 * @param {string} tokenId
 * @param {function} callback - called with (err, txHex)
 */
function createUpdateTxn(sequence, eltooAddress, totalAmount, tokenId, callback) {
    var txid = randomString();
    var cmd = 'txncreate id:' + txid + ';' +
                'txninput id:' + txid + ' tokenid:' + tokenId + ' amount:' + toMinimaAmount(totalAmount) + ' address:' + eltooAddress + ' floating:true;' +
                'txnoutput id:' + txid + ' tokenid:' + tokenId + ' amount:' + toMinimaAmount(totalAmount) + ' storestate:true address:' + eltooAddress + ';' +
                'txnstate id:' + txid + ' port:100 value:FALSE;' +
                'txnstate id:' + txid + ' port:101 value:' + sequence + ';' +
                'txnexport id:' + txid + ';' +
                'txndelete id:' + txid + ';';

    MDS.cmd(cmd, function(resp) {
        if (!resp || !Array.isArray(resp)) {
            callback('MDS command failed', null);
            return;
        }

        // Check for errors
        for (var i = 0; i < resp.length; i++) {
            if (resp[i] && resp[i].error) {
                callback('Update tx error: ' + resp[i].error, null);
                return;
            }
        }

        var txHex = null;
        if (resp[5] && resp[5].response && resp[5].response.data) {
            txHex = resp[5].response.data;
        }
        if (!txHex) {
            callback('Failed to create update tx', null);
        } else {
            callback(null, txHex);
        }
    });
}

/**
 * Sign a transaction with a given public key.
 * @param {string} txHex - transaction hex to sign
 * @param {string} pubKey - public key (use 'auto' for funding tx signing)
 * @param {function} callback - called with (err, signedTxHex)
 */
function signTxn(txHex, pubKey, callback) {
    // Validate public key format for Minima
    var formattedKey = pubKey;
    if (pubKey !== 'auto' && pubKey.indexOf('0x') !== 0 && pubKey.indexOf('Mx') !== 0) {
        formattedKey = '0x' + pubKey;
    }

    var txid = randomString();
    var cmd = 'txnimport id:' + txid + ' data:' + txHex + ';' +
                'txnsign id:' + txid + ' publickey:' + formattedKey + ';' +
                'txnexport id:' + txid + ';' +
                'txndelete id:' + txid + ';';

    MDS.cmd(cmd, function(resp) {
        if (!resp || !Array.isArray(resp)) {
            callback('MDS command failed', null);
            return;
        }

        // Check for errors in response
        for (var i = 0; i < resp.length; i++) {
            if (resp[i] && resp[i].error) {
                callback('Signing error: ' + resp[i].error, null);
                return;
            }
        }

        var signed = null;
        if (resp[2] && resp[2].response && resp[2].response.data) {
            signed = resp[2].response.data;
        }

        if (!signed) {
            callback('Signing failed - no signed transaction returned', null);
        } else {
            callback(null, signed);
        }
    });
}

/**
 * Post a fully signed transaction to the network.
 * @param {string} txHex
 * @param {function} callback - called with (err, result)
 */
/**
 * Prepare a transaction by adding local scripts and MMR proofs.
 * Each node should call this to inject its own scripts before posting.
 * @param {string} txHex - transaction hex
 * @param {function} callback - called with (err, preparedTxHex)
 */
function prepareTxn(txHex, callback) {
    var txid = 'prep_' + randomString();
    var cmd = 'txnimport id:' + txid + ' data:' + txHex + ';' +
              'txnscript id:' + txid + ' auto:true;' +
              'txnmmr id:' + txid + ';' +
              'txnexport id:' + txid + ';' +
              'txndelete id:' + txid;
    MDS.cmd(cmd, function(res) {
        if (!res || !Array.isArray(res)) {
            callback('Prepare failed: ' + JSON.stringify(res), null);
            return;
        }
        // [0]=import, [1]=script, [2]=mmr, [3]=export, [4]=delete
        var exported = (res[3] && res[3].response && res[3].response.data) ? res[3].response.data : null;
        if (!exported) {
            callback('Prepare failed: no export data', null);
        } else {
            callback(null, exported);
        }
    });
}

/**
 * Post a fully prepared transaction. Uses auto:false since scripts/MMR
 * should already be set via prepareTxn on all participating nodes.
 * @param {string} txHex
 * @param {function} callback - called with (err, result)
 */
function postTxn(txHex, callback) {
    var txid = 'post_' + randomString();
    var cmd = 'txnimport id:' + txid + ' data:' + txHex + ';' +
              'txnpost id:' + txid + ' auto:true;' +
              'txndelete id:' + txid;
    MDS.cmd(cmd, function(res) {
        if (!res || !Array.isArray(res)) {
            callback('Post failed: ' + JSON.stringify(res), null);
            return;
        }
        var postRes = res[1];
        if (!postRes || !postRes.status) {
            callback('Post failed: ' + JSON.stringify(postRes), null);
        } else {
            callback(null, postRes);
        }
    });
}

// ==================== Channel Class ====================

var Channel = function(tableId, participants, tokenId, timeoutBlocks) {
    if (tokenId === undefined) tokenId = '0x00';
    if (timeoutBlocks === undefined) timeoutBlocks = 30;
    this.id = utils.genChannelHashId();
    this.tableId = tableId;
    this.participants = participants;
    this.tokenId = tokenId;
    this.timeoutBlocks = timeoutBlocks;
    this.fundingTx = null;
    this.triggerTx = null;
    this.settlementTx = null;
    this.updateTx = null;
    this.fundingAddress = null;
    this.eltooAddress = null;
    this.sequence = 0;
    this.balances = {};
    this.status = 'FUNDING';
    this.disputeStartBlock = null;
    this.signatures = {
        funding: {},
        trigger: {},
        settlement: {}
    };
};

Channel.prototype.init = function(callback) {
    var self = this;
    var pubKeys = [];
    for (var i = 0; i < self.participants.length; i++) {
        // Use walletKey for scripts (txnsign needs wallet key), fall back to pubKey
        pubKeys.push(self.participants[i].walletKey || self.participants[i].pubKey);
    }
    var totalSum = new Decimal(0);
    for (var j = 0; j < self.participants.length; j++) {
        totalSum = totalSum.plus(self.participants[j].amount);
    }
    var total = totalSum.toString();

    // Create funding script and address
    var fundingScript = buildFundingScript(self.id, pubKeys);
    MDS.cmd('runscript script:"' + fundingScript + '"', function(resp) {
        if (!resp || !resp.response || !resp.response.clean || !resp.response.clean.mxaddress) {
            callback('Failed to create funding address');
            return;
        }
        self.fundingAddress = resp.response.clean.mxaddress;
        self.fundingScript = resp.response.clean.script;

        // Create eltoo script and address
        var eltooSscript = buildEltooScript(self.id, pubKeys, self.timeoutBlocks);
        MDS.cmd('runscript script:"' + eltooSscript + '"', function(resp2) {
            if (!resp2 || !resp2.response || !resp2.response.clean || !resp2.response.clean.mxaddress) {
                callback('Failed to create eltoo address');
                return;
            }
            self.eltooAddress = resp2.response.clean.mxaddress;
            self.eltooScript = resp2.response.clean.script;

            // Track both scripts so the node monitors coins at these addresses
            trackScript(self.fundingScript, function() {
                trackScript(self.eltooScript, function() {
                    // Create initial trigger and settlement (sequence 0)
                    var outputs = [];
                    for (var k = 0; k < self.participants.length; k++) {
                        outputs.push({
                            address: self.participants[k].address,
                            amount: self.participants[k].amount
                        });
                    }
                    createTriggerTxn(total, self.fundingAddress, self.eltooAddress, self.tokenId, function(err, triggerHex) {
                        if (err) {
                            callback(err);
                            return;
                        }
                        self.triggerTx = triggerHex;

                        createSettlementTxn(self.id, 0, self.eltooAddress, total, outputs, self.tokenId, function(err, settleHex) {
                            if (err) {
                                callback(err);
                                return;
                            }
                            self.settlementTx = settleHex;
                            callback(null, self);
                        });
                    });
                });
            });
        });
    });
};

/**
 * Sign the initial trigger and settlement with our own key (called by each participant).
 * @param {string} pubKey - our public key
 * @param {function} callback - called with (err, signedTrigger, signedSettlement)
 */
Channel.prototype.signInitial = function(pubKey, callback) {
    var self = this;
    signTxn(self.triggerTx, pubKey, function(err1, signedTrigger) {
        if (err1) {
            callback(err1, null, null);
            return;
        }
        signTxn(self.settlementTx, pubKey, function(err2, signedSettlement) {
            if (err2) {
                callback(err2, null, null);
            } else {
                callback(null, signedTrigger, signedSettlement);
            }
        });
    });
};

/**
 * Sign the funding transaction with 'auto' (uses wallet's key).
 * @param {string} fundingHex - unsigned funding tx
 * @param {function} callback - called with (err, signedFundingTx)
 */
Channel.signFunding = function(fundingHex, callback) {
    signTxn(fundingHex, 'auto', callback);
};

// --- State updates (off‑chain payments) ---

/**
 * Async version of createUpdate.
 */
Channel.prototype.createUpdateAsync = function(newBalances, gameState, callback) {
    var self = this;
    var newSeq = self.sequence + 1;
    var totalSum = new Decimal(0);
    for (var i = 0; i < self.participants.length; i++) {
        totalSum = totalSum.plus(self.participants[i].amount);
    }
    var total = totalSum.toString();

    // Validate that total of new balances matches channel total
    var balanceSum = new Decimal(0);
    var outputs = [];
    for (var j = 0; j < self.participants.length; j++) {
        var p = self.participants[j];
        var amount = newBalances[p.pubKey] || '0';
        balanceSum = balanceSum.plus(new Decimal(amount));
        outputs.push({
            address: p.address,
            amount: amount
        });
    }

    if (!balanceSum.equals(new Decimal(total))) {
        callback(new Error('Balance sum ' + balanceSum + ' does not match channel total ' + total), null);
        return;
    }

    createSettlementTxn(self.id, newSeq, self.eltooAddress, total, outputs, self.tokenId, function(err1, settleHex) {
        if (err1) {
            callback(err1, null);
            return;
        }
        createUpdateTxn(newSeq, self.eltooAddress, total, self.tokenId, function(err2, updateHex) {
            if (err2) {
                callback(err2, null);
            } else {
                callback(null, {
                    settlementTx: settleHex,
                    updateTx: updateHex,
                    sequence: newSeq,
                    balances: newBalances,
                    gameState: gameState
                });
            }
        });
    });
};

/**
 * Apply a signed update after collecting signatures.
 * @param {Object} update - { settlementTx, updateTx, sequence, balances, signatures }
 */
Channel.prototype.applyUpdate = function(update) {
    this.settlementTx = update.settlementTx;
    this.updateTx = update.updateTx;
    this.sequence = update.sequence;
    this.balances = update.balances;
    this.signatures.lastUpdate = update.signatures;
    // Save to DB
    sql.updateChannelStateWithSignatures(this.id, this.balances, update.gameState || {}, this.sequence, this.signatures, function() {});
};

// --- Closing ---

/**
 * Cooperative close: create a final spend transaction (spend funding output directly)
 * with current balances. All participants sign, then post.
 * @param {function} callback - called with (err, txid)
 */
Channel.prototype.closeCooperative = function(callback) {
    var self = this;
    var totalSum = new Decimal(0);
    for (var i = 0; i < self.participants.length; i++) {
        totalSum = totalSum.plus(self.participants[i].amount);
    }
    var total = totalSum.toString();

    var outputs = [];
    var balanceSum = new Decimal(0);
    for (var j = 0; j < self.participants.length; j++) {
        var p = self.participants[j];
        var amt = (self.balances && self.balances[p.pubKey]) ? self.balances[p.pubKey] : '0';
        balanceSum = balanceSum.plus(amt);
        outputs.push({ address: p.address, amount: amt });
    }
    // If balances don't add up to total, fall back to initial deposits
    if (!balanceSum.equals(new Decimal(total))) {
        outputs = [];
        for (var fb = 0; fb < self.participants.length; fb++) {
            outputs.push({ address: self.participants[fb].address, amount: self.participants[fb].amount });
        }
    }

    self._createSpendFundingTxn(total, outputs, function(err, spendTx) {
        if (err) { callback(err); return; }
        // Sign with our wallet key
        var myWalletKey = (typeof getMyWalletKey === 'function') ? getMyWalletKey() :
                          (typeof window !== 'undefined' ? window.myMinimaPublicKey : '');
        signTxn(spendTx, myWalletKey, function(err2, signed) {
            if (err2) { callback(err2); return; }
            // Send to other participants to co-sign and post
            var myMaxKey = (typeof getMyMaximaKey === 'function') ? getMyMaximaKey() :
                           (typeof window !== 'undefined' ? window.myMaximaKey : '');
            var others = [];
            for (var k = 0; k < self.participants.length; k++) {
                if (self.participants[k].pubKey !== myMaxKey) others.push(self.participants[k].pubKey);
            }
            if (others.length === 0) {
                // Solo — just post (auto:true adds MMR proofs)
                postTxn(signed, function(e, res) {
                    if (e) { callback(e); return; }
                    callback(null, res && res.response ? res.response.txid : null);
                });
                return;            }
            var sent = 0;
            for (var oi = 0; oi < others.length; oi++) {
                (function(pk) {
                    maxima.sendRaw(pk, { type: 'CLOSE_REQUEST', channelId: self.id, tableId: self.tableId, spendTx: signed }, function() {
                        if (++sent === others.length) callback(null, 'pending');
                    });
                })(others[oi]);
            }
        });
    });
};

Channel.prototype._createSpendFundingTxn = function(total, outputs, callback) {
    var self = this;
    var txid = randomString();
    var cmd = 'txncreate id:' + txid + ';' +
              'txninput id:' + txid + ' amount:' + toMinimaAmount(total) + ' tokenid:' + self.tokenId + ' address:' + self.fundingAddress + ' floating:true;';

    for (var i = 0; i < outputs.length; i++) {
        var out = outputs[i];
        if (new Decimal(out.amount).greaterThan(0)) {
            cmd += 'txnoutput id:' + txid + ' storestate:true amount:' + toMinimaAmount(out.amount) + ' tokenid:' + self.tokenId + ' address:' + out.address + ';';
        }
    }
    cmd += 'txnstate id:' + txid + ' port:200 value:' + self.id + ';' +
           'txnexport id:' + txid + ';' +
           'txndelete id:' + txid + ';';

    MDS.cmd(cmd, function(resp) {
        if (!resp || !Array.isArray(resp)) {
            callback('MDS command failed', null);
            return;
        }
        var txHex = null;
        if (resp[resp.length-2] && resp[resp.length-2].response && resp[resp.length-2].response.data) {
            txHex = resp[resp.length-2].response.data;
        }
        if (!txHex) {
            callback('Failed to create spend tx', null);
        } else {
            callback(null, txHex);
        }
    });
};

/**
 * Start dispute: publish last trigger transaction and record dispute start block.
 * @param {function} callback - called with (err, result)
 */
Channel.prototype.startDispute = function(callback) {
    var self = this;
    if (!self.triggerTx || !self.settlementTx) {
        callback('No trigger/settlement available', null);
        return;
    }
    // Get current block height
    MDS.cmd('block', function(resp) {
        if (!resp || !resp.response || !resp.response.block) {
            callback('Failed to get current block', null);
            return;
        }
        var currentBlock = resp.response.block;
        self.disputeStartBlock = currentBlock;
        self.status = 'DISPUTE';

        // Post the trigger transaction (auto:true adds MMR proofs automatically)
        postTxn(self.triggerTx, function(err, res) {
            if (err) { callback(err, null); return; }
            sql.updateChannelAfterFunding(self.id, null, 'DISPUTE', currentBlock, function() {});
            callback(null, { triggerPosted: true, startBlock: currentBlock });
        });
    });
};

/**
 * Claim settlement after dispute timeout has passed.
 * Posts the last signed settlementTx on-chain.
 */
Channel.prototype.claimSettlement = function(callback) {
    var self = this;
    if (!self.settlementTx) { callback('No settlement tx available', null); return; }
    MDS.cmd('block', function(resp) {
        if (!resp || !resp.response || !resp.response.block) { callback('Failed to get block', null); return; }
        var currentBlock = parseInt(resp.response.block);
        var startBlock   = parseInt(self.disputeStartBlock || 0);
        if (currentBlock - startBlock < self.timeoutBlocks) {
            callback('Timeout not reached. Blocks remaining: ' + (self.timeoutBlocks - (currentBlock - startBlock)), null);
            return;
        }
        postTxn(self.settlementTx, function(err, res) {
            if (err) { callback(err, null); return; }
            self.status = 'CLOSED';
            sql.updateChannelAfterFunding(self.id, null, 'CLOSED', null, function() {});
            callback(null, { settled: true });
        });
    });
};

Channel.fromRow = function(row) {
    var participants = [];
    if (row.participants) {
        if (Array.isArray(row.participants)) {
            participants = row.participants;
        } else {
            try { participants = JSON.parse(row.participants); } catch (e) { participants = []; }
        }
    }
    var balances = {};
    if (row.balances) {
        if (typeof row.balances === 'object' && !Array.isArray(row.balances)) {
            balances = row.balances;
        } else {
            try { balances = JSON.parse(row.balances); } catch (e) { balances = {}; }
        }
    }
    var signatures = { funding: {}, trigger: {}, settlement: {} };
    if (row.signatures) {
        if (typeof row.signatures === 'object' && !Array.isArray(row.signatures)) {
            signatures = row.signatures;
        } else {
            try { signatures = JSON.parse(row.signatures); } catch (e) {}
        }
    }
    var chan = new Channel(row.tableId || row.tableid, participants, row.tokenId || row.tokenid || '0x00', row.timeout);
    chan.id = row.hashId || row.hashid;
    chan.fundingAddress = row.fundingAddress || row.fundingaddress;
    chan.eltooAddress   = row.eltooAddress   || row.eltooaddress;
    chan.fundingTx  = row.fundingTx  || row.fundingtx;
    chan.triggerTx  = row.triggerTx  || row.triggertx;
    chan.settlementTx = row.settlementTx || row.settlementtx;
    chan.updateTx   = row.updateTx   || row.updatetx;
    chan.sequence   = row.sequence   || 0;
    chan.balances   = balances;
    chan.status     = row.status;
    chan.disputeStartBlock = row.disputeStartBlock || row.disputestartblock;
    chan.signatures = signatures;
    // Rebuild scripts from stored data so trackScript/dispute works after restart
    if (chan.id && participants.length > 0) {
        var pubKeys = [];
        for (var pk = 0; pk < participants.length; pk++) {
            pubKeys.push(participants[pk].walletKey || participants[pk].pubKey);
        }
        chan.fundingScript = buildFundingScript(chan.id, pubKeys);
        chan.eltooScript = buildEltooScript(chan.id, pubKeys, chan.timeoutBlocks);
    }
    return chan;
};

// ==================== Public API ====================

var _channelExport = {
    Channel: Channel,
    createFundingTxn: createFundingTxn,
    addToFundingTxn: addToFundingTxn,
    createTriggerTxn: createTriggerTxn,
    createSettlementTxn: createSettlementTxn,
    createUpdateTxn: createUpdateTxn,
    signTxn: signTxn,
    prepareTxn: prepareTxn,
    postTxn: postTxn,
    trackScript: trackScript,
    removeScript: removeScript,
    buildFundingScript: buildFundingScript,
    buildEltooScript: buildEltooScript,
    fromRow: Channel.fromRow,
    get: function(id) { return channels[id] || null; },
    set: function(id, chan) { channels[id] = chan; },
    remove: function(id) { delete channels[id]; }
};
if (typeof window !== 'undefined') {
    window.channel = _channelExport;
}
// In service (no window), assign to global
if (typeof channel === 'undefined') {
    var channel = _channelExport;
}