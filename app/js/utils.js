/**
 * utils.js – common helper functions for Minima Poker (ES5/Rhino compatible)
 */

/**
 * Generate a random hex string of given length (in bytes).
 * @param {number} len - number of bytes (default 32, yields 64 hex chars)
 */
function genRandomHexString(len) {
    if (len === undefined) len = 32;
    var hex = '';
    for (var i = 0; i < len * 2; i++) {
        hex += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
    }
    return hex;
}

/**
 * Convert a string to hex (UTF-8 safe via encodeURIComponent)
 */
function stringToHex(str) {
    var encoded = encodeURIComponent(str);
    var hex = '';
    for (var i = 0; i < encoded.length; i++) {
        var c = encoded.charAt(i);
        if (c === '%') {
            hex += encoded.charAt(i + 1) + encoded.charAt(i + 2);
            i += 2;
        } else {
            var code = encoded.charCodeAt(i).toString(16);
            if (code.length < 2) code = '0' + code;
            hex += code;
        }
    }
    return hex;
}

/**
 * Convert hex to string (UTF-8 safe)
 */
function hexToString(hex) {
    var pct = '';
    for (var i = 0; i < hex.length; i += 2) {
        var byte = hex.substr(i, 2);
        pct += '%' + byte;
    }
    return decodeURIComponent(pct);
}

/**
 * Convert object to hex (via JSON)
 */
function objToHex(obj) {
    return stringToHex(JSON.stringify(obj));
}

/**
 * Convert hex to object
 */
function hexToObj(hex) {
    return JSON.parse(hexToString(hex));
}

/**
 * Trim a string to a maximum length with ellipsis
 */
function trimToSize(str, max) {
    if (max === undefined) max = 20;
    if (str.length <= max) return str;
    return str.substr(0, max-3) + '...';
}

/**
 * Log a JSON object with a prefix (for debugging)
 */
function logJSON(obj, prefix) {
    if (prefix === undefined) prefix = '';
    if (typeof window !== 'undefined' && window.DEBUG) {
        // Rhino may not have console.log, use MDS.log
        MDS.log(prefix + ' ' + JSON.stringify(obj, null, 2));
    }
}

/**
 * Safe decimal parsing using Decimal.js (must be loaded)
 */
function getValidDecimalNumber(numStr) {
    try {
        return new Decimal(numStr);
    } catch (e) {
        MDS.log('Invalid decimal: ' + numStr);
        return new Decimal(0);
    }
}

/**
 * Check if a hash ID is safe (alphanumeric hex)
 */
function checkSafeHashID(hashid) {
    return /^[0-9a-fA-F]+$/.test(hashid);
}

/**
 * Generate a unique table ID (random hex)
 */
function genTableId() {
    return 'table_' + genRandomHexString(8);
}

/**
 * Generate a unique channel hash ID
 */
function genChannelHashId() {
    return '0x' + genRandomHexString(16);
}

// ==================== Additional ES5 utilities ====================

/**
 * Pad a string to specified length with a character.
 */
function padString(str, len, char, left) {
    if (str.length >= len) return str;
    var padding = '';
    var padLen = len - str.length;
    for (var i = 0; i < padLen; i++) {
        padding += char;
    }
    return left ? padding + str : str + padding;
}

/**
 * Simple debounce function.
 */
function debounce(func, wait) {
    var timeout;
    return function() {
        var context = this;
        var args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(function() {
            func.apply(context, args);
        }, wait);
    };
}

/**
 * Simple throttle function.
 */
function throttle(func, limit) {
    var inThrottle;
    return function() {
        var context = this;
        var args = arguments;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(function() {
                inThrottle = false;
            }, limit);
        }
    };
}

/**
 * Parse blinds string from DB.
 */
function parseBlinds(blindsStr) {
    var parts = blindsStr.split(',');
    return {
        small: new Decimal(parts[0] || '0.001'),
        big: new Decimal(parts[1] || '0.002')
    };
}

/**
 * Format blinds for DB storage.
 */
function formatBlinds(small, big) {
    return small.toString() + ',' + big.toString();
}

/**
 * Generate a random player name.
 */
function randomPlayerName() {
    var adjectives = ['Happy', 'Lucky', 'Clever', 'Brave', 'Swift', 'Mighty', 'Silent', 'Wild'];
    var nouns = ['Panda', 'Tiger', 'Eagle', 'Shark', 'Wolf', 'Hawk', 'Lion', 'Falcon'];
    var adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    var noun = nouns[Math.floor(Math.random() * nouns.length)];
    return adj + noun + Math.floor(Math.random() * 100);
}

/**
 * Convert Decimal to string for DB storage.
 */
function decimalToString(d) {
    return d.toString();
}

/**
 * Convert string from DB to Decimal.
 */
function stringToDecimal(s) {
    return new Decimal(s || '0');
}

/**
 * Simple shallow extend.
 */
function extend(target, source) {
    for (var key in source) {
        if (source.hasOwnProperty(key)) {
            target[key] = source[key];
        }
    }
    return target;
}

/**
 * Simple clone (shallow).
 */
function clone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    var copy = obj.constructor ? new obj.constructor() : {};
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            copy[key] = obj[key];
        }
    }
    return copy;
}

// Expose globally - with safety check for window
var _utilsExport = {
    genRandomHexString: genRandomHexString,
    stringToHex: stringToHex,
    hexToString: hexToString,
    objToHex: objToHex,
    hexToObj: hexToObj,
    trimToSize: trimToSize,
    logJSON: logJSON,
    getValidDecimalNumber: getValidDecimalNumber,
    checkSafeHashID: checkSafeHashID,
    genTableId: genTableId,
    genChannelHashId: genChannelHashId,
    padString: padString,
    debounce: debounce,
    throttle: throttle,
    parseBlinds: parseBlinds,
    formatBlinds: formatBlinds,
    randomPlayerName: randomPlayerName,
    decimalToString: decimalToString,
    stringToDecimal: stringToDecimal,
    extend: extend,
    clone: clone
};
if (typeof window !== 'undefined') {
    window.utils = _utilsExport;
}
// In service (no window), assign to global
if (typeof utils === 'undefined') {
    var utils = _utilsExport;
}