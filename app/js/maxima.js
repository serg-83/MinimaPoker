/**
 * maxima.js – P2P communication layer for Minima Poker (ES5/Rhino compatible)
 * Handles sending/receiving messages via Maxima with ACK/SYNACK reliability.
 * Includes automatic cleanup of stale ACK requests.
 */

// Store pending ACK callbacks
var pendingAcks = {};

// Registered message handlers (by message type)
var messageHandlers = {};

/**
 * Register a handler for a specific Maxima message type.
 * @param {string} type - message type (e.g., "TABLE_CREATE")
 * @param {function} handler - function(message, fromPubKey)
 */
function registerHandler(type, handler) {
    messageHandlers[type] = handler;
}

/**
 * Send a message with ACK/SYNACK reliability.
 * @param {string} toPubKey - recipient's Maxima public key
 * @param {object} message - message object (will be JSON stringified and hex-encoded)
 * @param {function} callback - called with (success, response?) after SYNACK received
 */
function sendWithAck(toPubKey, message, callback) {
    var ackMsg = {
        type: "ACK_MESSAGE",
        randid: utils.genRandomHexString(16)
    };

    // Store callback to be called when SYNACK arrives
    pendingAcks[ackMsg.randid] = {
        callback: callback,
        originalMsg: message,
        toPubKey: toPubKey,
        timestamp: Date.now()
    };

    // Send the ACK message first
    sendRaw(toPubKey, ackMsg, function(sent) {
        if (!sent) {
            delete pendingAcks[ackMsg.randid];
            callback(false, "Failed to send ACK");
        }
        // Wait for SYNACK; actual message will be sent after SYNACK received
    });
}

/**
 * Send the actual message after SYNACK received (called internally).
 */
function _sendAfterSynack(randid) {
    var pending = pendingAcks[randid];
    if (!pending) return;

    sendRaw(pending.toPubKey, pending.originalMsg, function(sent) {
        if (sent) {
            // Success – we consider the message delivered after SYNACK and actual send
            pending.callback(true);
        } else {
            pending.callback(false, "Failed to send message after SYNACK");
        }
        delete pendingAcks[randid];
    });
}

/**
 * Low-level send of a message (converts to hex and calls MDS.cmd).
 * toPubKey can be a public key (0x...) or full MX address (pubkey@host:port).
 */
function sendRaw(toPubKey, message, callback) {
    var formattedKey = toPubKey;
    if (formattedKey.indexOf('0x') !== 0 && formattedKey.indexOf('Mx') !== 0) {
        formattedKey = '0x' + formattedKey;
    }

    // Convert message to hex with 0x prefix so Java treats it as raw hex (not text)
    var msgHex = '0x' + utils.objToHex(message).toUpperCase();

    // If it contains '@', it's a full address — use to: parameter
    // Otherwise it's a public key — use publickey: parameter (node resolves address from contacts)
    var addrParam;
    if (formattedKey.indexOf('@') !== -1) {
        addrParam = 'to:' + formattedKey;
    } else {
        addrParam = 'publickey:' + formattedKey;
    }

    var fullCmd = 'maxima action:send ' + addrParam + ' application:MinimaPoker data:' + msgHex;
    MDS.log("MAXIMA send: " + addrParam + " dataLen=" + msgHex.length);
    MDS.cmd(fullCmd, function(res) {
        MDS.log("MAXIMA send result: " + JSON.stringify(res).substring(0, 300));
        if (res && res.status) {
            // Check if actually delivered (Java API returns response.delivered)
            if (res.response && res.response.delivered === false) {
                var errorMsg = "Maxima send not delivered";
                if (res.response.error) {
                    errorMsg += ": " + res.response.error;
                }
                MDS.log(errorMsg);
                callback(false, errorMsg);
            } else {
                callback(true);
            }
        } else {
            var errorMsg = "Maxima send failed";
            if (res && res.error) {
                errorMsg += ": " + res.error;
            } else if (res) {
                errorMsg += ": " + JSON.stringify(res);
            }
            MDS.log(errorMsg);
            callback(false, errorMsg);
        }
    });
}

/**
 * Clean up stale ACK requests older than 30 seconds.
 * Called on each NEWBLOCK event in service, or periodically in browser.
 */
function cleanupStaleAcks() {
    var now = Date.now();
    for (var randid in pendingAcks) {
        if (pendingAcks.hasOwnProperty(randid)) {
            var pending = pendingAcks[randid];
            if (now - pending.timestamp > 30000) {
                MDS.log('ACK timeout for randid: ' + randid);
                pending.callback(false, 'ACK timeout');
                delete pendingAcks[randid];
            }
        }
    }
}

/**
 * Initialize Maxima listener.
 * In browser: starts periodic cleanup via setInterval.
 * In service (Rhino): cleanup is triggered by NEWBLOCK events.
 */
function initMaxima() {
    MDS.log('Maxima listener initialized');
    if (typeof setInterval !== 'undefined') {
        setInterval(cleanupStaleAcks, 10000);
    }
}

/**
 * Handle an incoming Maxima message (called from main MDS callback).
 * @param {object} msg - the full MDS event data
 */
function handleIncoming(msg) {
    if (msg.event !== "MAXIMA") return;
    MDS.log("MAXIMA incoming: application=" + msg.data.application + " from=" + msg.data.from);
    if (msg.data.application !== 'MinimaPoker') return;

    var fromPubKey = msg.data.from;
    var dataHex = msg.data.data;

    // Strip 0x prefix if present (Java's MiniData.to0xString() adds it)
    if (dataHex && dataHex.indexOf('0x') === 0) {
        dataHex = dataHex.substring(2);
    }

    try {
        var message = utils.hexToObj(dataHex);

        // Handle ACK/SYNACK protocol
        if (message.type === "ACK_MESSAGE") {
            // Respond with SYNACK
            var synack = {
                type: "SYNACK_MESSAGE",
                randid: message.randid
            };
            sendRaw(fromPubKey, synack, function() {});
            return;
        }

        if (message.type === "SYNACK_MESSAGE") {
            // If we have a pending ACK with this randid, send the original message
            _sendAfterSynack(message.randid);
            return;
        }

        // Regular message: dispatch to registered handler
        var handler = messageHandlers[message.type];
        if (handler) {
            handler(message, fromPubKey);
        } else {
            MDS.log("No handler for message type: " + message.type);
        }

    } catch (e) {
        MDS.log("Error parsing Maxima message: " + e + " dataHex(first100)=" + (dataHex ? dataHex.substring(0, 100) : 'null'));
    }
}

// Expose globally - for browser and service contexts
if (typeof window !== 'undefined') {
    window.maxima = {
        init: initMaxima,
        sendWithAck: sendWithAck,
        sendRaw: sendRaw,
        registerHandler: registerHandler,
        handleIncoming: handleIncoming,
        cleanupStaleAcks: cleanupStaleAcks
    };
}
if (typeof maxima === 'undefined') {
    maxima = {
        init: initMaxima,
        sendWithAck: sendWithAck,
        sendRaw: sendRaw,
        registerHandler: registerHandler,
        handleIncoming: handleIncoming,
        cleanupStaleAcks: cleanupStaleAcks
    };
}