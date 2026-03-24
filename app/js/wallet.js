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

// Expose functions globally - for browser and service contexts
if (typeof window !== 'undefined') {
    window.wallet = {
        init: initWallet,
        getUser: getUserDetails,
        getBalance: getBalance
    };
}
// In service (no window), assign to global
if (typeof wallet === 'undefined') {
    var wallet = {
        init: initWallet,
        getUser: getUserDetails,
        getBalance: getBalance
    };
}