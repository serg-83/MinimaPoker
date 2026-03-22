/**
 * wallet.js - Minima wallet abstraction for Minima Poker (ES5/Rhino compatible)
 * All interactions with Minima node go through MDS.cmd
 */

// Current user details (populated by initWallet)
var currentUser = {
    maximaName: '',
    maximaPublicKey: '',
    minimaAddress: '',
    minimaPublicKey: ''
};

/**
 * Initialize wallet: fetch Maxima identity and Minima address
 * @param {Function} callback - called when ready
 */
function initWallet(callback) {
    MDS.cmd("maxima;getaddress", function(res) {
        if (res && res[0] && res[0].response) {
            currentUser.maximaName = res[0].response.name;
            currentUser.maximaPublicKey = res[0].response.publickey;
            currentUser.minimaAddress = res[1].response.miniaddress;
            currentUser.minimaPublicKey = res[1].response.publickey;
            MDS.log("Wallet initialized: " + currentUser.maximaName);
        } else {
            MDS.log("Failed to initialize wallet");
        }
        if (callback) callback(currentUser);
    });
}

/**
 * Get current user details
 */
function getUserDetails() {
    return {
        maximaName: currentUser.maximaName,
        maximaPublicKey: currentUser.maximaPublicKey,
        minimaAddress: currentUser.minimaAddress,
        minimaPublicKey: currentUser.minimaPublicKey
    };
}

/**
 * Get balance for a specific token (default Minima 0x00)
 * @param {string} tokenId - token ID (default "0x00")
 * @param {Function} callback - returns balance as string
 */
function getBalance(tokenId, callback) {
    if (tokenId === undefined) tokenId = "0x00";
    MDS.cmd("balance", function(res) {
        if (res && res.response) {
            // balance returns a JSONArray of {tokenid, confirmed, unconfirmed, sendable, coins, total}
            var balances = res.response;
            for (var i = 0; i < balances.length; i++) {
                if (balances[i].tokenid === tokenId) {
                    callback(balances[i].sendable || balances[i].confirmed || "0");
                    return;
                }
            }
        }
        callback("0");
    });
}

/**
 * Sign a transaction or message
 * @param {string} txnHex - transaction hex to sign
 * @param {string} publicKey - public key to sign with (default current user)
 * @param {Function} callback - returns signed transaction
 */
function signTxn(txnHex, publicKey, callback) {
    if (publicKey === undefined) publicKey = null;
    var key;
    if (publicKey) {
        key = publicKey;
    } else {
        key = currentUser.minimaPublicKey;
    }
    MDS.cmd("sign publickey:" + key + " data:" + txnHex, function(res) {
        if (res && res.response) {
            // sign returns the signature hex directly as res.response (string, not object)
            callback(res.response);
        } else {
            MDS.log("Signing failed: " + JSON.stringify(res));
            callback(null);
        }
    });
}

/**
 * Post a transaction to the network
 * @param {string} txnHex - signed transaction hex
 * @param {Function} callback - returns result
 */
function postTxn(txnHex, callback) {
    // posttxn doesn't exist; must import into temp txn, then post by id
    var txid = 'post_' + Math.random().toString(16).substring(2, 10);
    var cmd = 'txnimport id:' + txid + ' data:' + txnHex + ';' +
              'txnpost id:' + txid + ' auto:true;' +
              'txndelete id:' + txid;
    MDS.cmd(cmd, function(res) {
        if (res && Array.isArray(res)) {
            // res[1] is txnpost result
            if (res[1] && res[1].status) {
                callback(res[1]);
            } else {
                callback(res[1] || { status: false, error: 'txnpost failed' });
            }
        } else {
            callback(res);
        }
    });
}

/**
 * Check if a transaction is valid
 * @param {string} txnHex - transaction hex
 * @param {Function} callback - returns {valid, reason}
 */
function checkTxn(txnHex, callback) {
    // checktxn doesn't exist; import into temp txn, then txncheck by id
    var txid = 'chk_' + Math.random().toString(16).substring(2, 10);
    var cmd = 'txnimport id:' + txid + ' data:' + txnHex + ';' +
              'txncheck id:' + txid + ';' +
              'txndelete id:' + txid;
    MDS.cmd(cmd, function(res) {
        if (res && Array.isArray(res) && res[1]) {
            callback({ valid: res[1].status, reason: res[1].error || '' });
        } else {
            callback({ valid: false, reason: "Unknown error" });
        }
    });
}

/**
 * Import a token (if needed)
 * @param {string} tokenData - token data hex
 * @param {Function} callback
 */
function importToken(tokenData, callback) {
    MDS.cmd("tokens action:import data:" + tokenData, function(res) {
        callback(res);
    });
}

/**
 * Create a simple payment transaction (helper)
 * @param {string} to - destination address
 * @param {string} amount - amount as string
 * @param {string} tokenId - token ID
 * @param {Function} callback - returns unsigned txn hex
 */
function createPaymentTxn(to, amount, tokenId, callback) {
    if (tokenId === undefined) tokenId = "0x00";
    MDS.cmd("send address:" + to + " amount:" + amount + " tokenid:" + tokenId + " automation:", function(res) {
        if (res && res.response && res.response.txpow) {
            callback(res.response.txpow);
        } else {
            callback(null);
        }
    });
}

// Expose functions globally - for browser and service contexts
if (typeof window !== 'undefined') {
    window.wallet = {
        init: initWallet,
        getUser: getUserDetails,
        getBalance: getBalance,
        signTxn: signTxn,
        postTxn: postTxn,
        checkTxn: checkTxn,
        importToken: importToken,
        createPaymentTxn: createPaymentTxn
    };
}
// In service (no window), assign to global
if (typeof wallet === 'undefined') {
    var wallet = {
        init: initWallet,
        getUser: getUserDetails,
        getBalance: getBalance,
        signTxn: signTxn,
        postTxn: postTxn,
        checkTxn: checkTxn,
        importToken: importToken,
        createPaymentTxn: createPaymentTxn
    };
}