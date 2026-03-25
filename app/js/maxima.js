/**
 * maxima.js – P2P communication layer for Minima Poker (ES5/Rhino compatible)
 */

var maximaMessageHandlers = {};

function registerHandler(type, handler) {
    maximaMessageHandlers[type] = handler;
}

// sendWithAck = sendRaw (ACK/SYNACK removed — caused cross-context issues)
function sendWithAck(toPubKey, message, callback) {
    sendRaw(toPubKey, message, function(sent) {
        if (callback) callback(sent);
    });
}


function sendRaw(toPubKey, message, callback) {
    var formattedKey = toPubKey;
    if (formattedKey.indexOf('0x') !== 0 && formattedKey.indexOf('Mx') !== 0) {
        formattedKey = '0x' + formattedKey;
    }

    var safestring = encodeURIComponent(JSON.stringify(message)).split("'").join("%27");

    MDS.cmd("convert from:string to:hex data:" + safestring, function(conv) {
        if (!conv || !conv.status || !conv.response || !conv.response.conversion) {
            MDS.log("MAXIMA send: convert failed");
            if (callback) callback(false, "convert failed");
            return;
        }
        var msgHex = conv.response.conversion;

        var addrParam;
        if (formattedKey.indexOf('@') !== -1) {
            addrParam = 'to:' + formattedKey;
        } else {
            addrParam = 'publickey:' + formattedKey;
        }

        var fullCmd = 'maxima action:send ' + addrParam + ' application:MinimaPoker data:' + msgHex;
        MDS.log("MAXIMA send: " + addrParam + " dataLen=" + msgHex.length);
        MDS.cmd(fullCmd, function(res) {
            var errMsg;
            if (res && res.status) {
                if (res.response && res.response.delivered === false) {
                    errMsg = "Maxima send not delivered";
                    if (res.response.error) errMsg += ": " + res.response.error;
                    MDS.log(errMsg);
                    if (callback) callback(false, errMsg);
                } else {
                    if (callback) callback(true);
                }
            } else {
                errMsg = "Maxima send failed";
                if (res && res.error) errMsg += ": " + res.error;
                else if (res) errMsg += ": " + JSON.stringify(res);
                MDS.log(errMsg);
                if (callback) callback(false, errMsg);
            }
        });
    });
}

function initMaxima() {
    MDS.log('Maxima listener initialized');
    // Note: messageHandlers from service.js will be registered separately
}

function handleIncoming(msg) {
    if (msg.event !== "MAXIMA") return;
    MDS.log("MAXIMA incoming: application=" + msg.data.application + " from=" + msg.data.from);
    if (msg.data.application !== 'MinimaPoker') return;

    var fromPubKey = msg.data.from;
    var dataHex = msg.data.data;

    MDS.cmd("convert from:hex to:string data:" + dataHex, function(conv) {
        try {
            if (!conv || !conv.status || !conv.response || !conv.response.conversion) {
                MDS.log("MAXIMA convert failed for type=unknown dataLen=" + (dataHex ? dataHex.length : 0));
                return;
            }
            var jsonstr = decodeURIComponent(conv.response.conversion.split("%27").join("'"));
            var message = JSON.parse(jsonstr);
            MDS.log("MAXIMA dispatch: type=" + message.type);
            var handler = maximaMessageHandlers[message.type] || maximaMessageHandlers['*'];
            if (handler) {
                handler(message, fromPubKey);
            } else {
                MDS.log("No handler for message type: " + message.type);
            }
        } catch (e) {
            MDS.log("Error parsing Maxima message: " + e + " dataHex(first100)=" + (dataHex ? dataHex.substring(0, 100) : 'null'));
        }
    });
}

var _maximaExport = {
    init: initMaxima,
    sendWithAck: sendWithAck,
    sendRaw: sendRaw,
    registerHandler: registerHandler,
    handleIncoming: handleIncoming
};

if (typeof window !== 'undefined') window.maxima = _maximaExport;
if (typeof maxima === 'undefined') var maxima = _maximaExport;
