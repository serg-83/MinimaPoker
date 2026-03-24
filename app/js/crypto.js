/**
 * crypto.js – Cryptographic utilities for Minima Poker
 * Provides commit-reveal, distributed randomness, and signature verification.
 */

/**
 * Generate a random secret (hex string)
 */
function generateSecret() {
    return utils.genRandomHexString(64);
}

/**
 * Create a commitment: hash(secret + data)
 * Uses SHA-256 via MDS.cmd (sync version for Rhino).
 */
// Custom UTF-8 conversion for Rhino (no TextEncoder)
function stringToUtf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
        var charCode = str.charCodeAt(i);
        if (charCode < 0x80) {
            bytes.push(charCode);
        } else if (charCode < 0x800) {
            bytes.push(0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f));
        } else if (charCode < 0xd800 || charCode >= 0xe000) {
            bytes.push(0xe0 | (charCode >> 12), 0x80 | ((charCode >> 6) & 0x3f), 0x80 | (charCode & 0x3f));
        } else {
            // Surrogate pair
            i++;
            charCode = 0x10000 + (((charCode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
            bytes.push(0xf0 | (charCode >> 18), 0x80 | ((charCode >> 12) & 0x3f), 0x80 | ((charCode >> 6) & 0x3f), 0x80 | (charCode & 0x3f));
        }
    }
    return bytes;
}

function commit(secret, data, callback) {
    var input = secret + data;
    var bytes = stringToUtf8Bytes(input);
    var hexInput = '';
    for (var i = 0; i < bytes.length; i++) {
        var byteHex = bytes[i].toString(16);
        if (byteHex.length < 2) byteHex = '0' + byteHex;
        hexInput += byteHex;
    }

    MDS.cmd('hash data:0x' + hexInput, function(resp) {
        if (!resp || !resp.response || !resp.response.hash) {
            MDS.log('Commit error: ' + (resp ? JSON.stringify(resp) : 'no response'));
            callback('Commit hash failed', null);
            return;
        }
        callback(null, resp.response.hash);
    });
}

/**
 * Verify a commitment.
 */
function verifyCommitment(secret, data, commitment, callback) {
    commit(secret, data, function(err, calculated) {
        if (err || calculated === null) {
            callback(false);
            return;
        }
        callback(calculated === commitment);
    });
}

/**
 * Combine multiple hex strings (e.g., XOR them) to produce a final seed.
 * All inputs must be same length hex strings.
 */
function combineSeeds(seeds) {
    if (seeds.length === 0) return '';

    // Validate all seeds have same length
    var expectedLen = seeds[0].length;
    for (var i = 1; i < seeds.length; i++) {
        if (seeds[i].length !== expectedLen) {
            MDS.log("Seed length mismatch: expected " + expectedLen + ", got " + seeds[i].length + " for seed " + i);
            throw new Error('Seed length mismatch');
        }
    }

    var len = seeds[0].length;
    var resultLength = len / 2;
    var result = [];
    for (var i = 0; i < resultLength; i++) result[i] = 0;

    // XOR all arrays
    for (var s = 0; s < seeds.length; s++) {
        var seed = seeds[s];
        for (var i2 = 0; i2 < resultLength; i2++) {
            var byteVal = parseInt(seed.substr(i2 * 2, 2), 16);
            if (isNaN(byteVal)) {
                MDS.log("Invalid hex byte at position " + i2 + " in seed " + s);
                throw new Error('Invalid hex in seed');
            }
            result[i2] ^= byteVal;
        }
    }

    // Convert to hex
    var hexChars = [];
    for (var i3 = 0; i3 < resultLength; i3++) {
        var byte = result[i3];
        var high = (byte >> 4).toString(16);
        var low = (byte & 0x0f).toString(16);
        hexChars.push(high);
        hexChars.push(low);
    }
    return hexChars.join('');
}

/**
 * Simple PRNG based on seed (hex string).
 * Returns a random integer between 0 and max-1.
 */
function seededRandom(seed, max) {
    // FNV-1a hash over ALL bytes of seed hex string
    var state = 0x811c9dc5;
    for (var i = 0; i < seed.length - 1; i += 2) {
        var byte = parseInt(seed.substr(i, 2), 16) || 0;
        state = state ^ byte;
        state = (state * 0x01000193) >>> 0;
    }

    // SplitMix32 PRNG
    function splitMix(x) {
        x = (x + 0x9e3779b9) >>> 0;
        var z = x;
        z = ((z ^ (z >>> 16)) * 0x85ebca6b) >>> 0;
        z = ((z ^ (z >>> 13)) * 0xc2b2ae35) >>> 0;
        return (z ^ (z >>> 16)) >>> 0;
    }

    var rand = splitMix(state);
    var limit = Math.floor(4294967295 / max) * max;
    var result = rand;
    while (result >= limit) {
        state = state + 1;
        result = splitMix(state);
    }
    return result % max;
}

/**
 * Shuffle an array deterministically using a seed.
 */
function seededShuffle(array, seed) {
    var shuffled = [];
    for (var k = 0; k < array.length; k++) {
        shuffled.push(array[k]);
    }
    for (var i = shuffled.length - 1; i > 0; i--) {
        // Convert index to 4-char zero-padded hex to ensure even length and unique per-iteration input
        var idxHex = ('0000' + i.toString(16)).slice(-4);
        var j = seededRandom(seed + idxHex, i + 1);
        var temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
    }
    return shuffled;
}

/**
 * Generate a deck of cards (52 standard playing cards).
 * Returns array of strings like "As", "Kd", "Qh", "Jc" etc.
 */
function generateDeck() {
    var suits = ['s', 'h', 'd', 'c'];
    var ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
    var deck = [];
    for (var s = 0; s < suits.length; s++) {
        for (var r = 0; r < ranks.length; r++) {
            deck.push(ranks[r] + suits[s]);
        }
    }
    return deck;
}

/**
 * Commit to a card value (rank+suit) using a secret.
 */
function commitCard(card, secret, callback) {
    commit(secret, card, callback);
}

/**
 * Reveal a card and verify against commitment.
 */
function revealCard(card, secret, commitment, callback) {
    verifyCommitment(secret, card, commitment, callback);
}

// Expose globally - for browser and service contexts
if (typeof window !== 'undefined') {
    window.cryptoUtils = {
        generateSecret: generateSecret,
        commit: commit,
        verifyCommitment: verifyCommitment,
        combineSeeds: combineSeeds,
        seededRandom: seededRandom,
        seededShuffle: seededShuffle,
        generateDeck: generateDeck,
        commitCard: commitCard,
        revealCard: revealCard
    };
}
// In service (no window), assign to global
if (typeof cryptoUtils === 'undefined') {
    var cryptoUtils = {
        generateSecret: generateSecret,
        commit: commit,
        verifyCommitment: verifyCommitment,
        combineSeeds: combineSeeds,
        seededRandom: seededRandom,
        seededShuffle: seededShuffle,
        generateDeck: generateDeck,
        commitCard: commitCard,
        revealCard: revealCard
    };
}