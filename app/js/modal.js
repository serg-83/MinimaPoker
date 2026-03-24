/**
 * modal.js – Custom modal system for Minima Poker (ES5/Rhino compatible)
 * Replaces native alert(), confirm(), prompt() with styled casino-themed dialogs.
 * Include this script before any module that calls pokerModal.
 */

var pokerModal = {
    _overlay: null,

    _ensureOverlay: function() {
        if (this._overlay) return;
        if (typeof document === 'undefined') return; // service context — no DOM
        var overlay = document.createElement('div');
        overlay.className = 'poker-modal-overlay';
        overlay.id = 'poker-modal-overlay';
        document.body.appendChild(overlay);
        this._overlay = overlay;
    },

    /**
     * Show an alert-style modal.
     * @param {string} message
     * @param {string} [type] - 'error', 'success', or '' (default)
     * @param {function} [onClose]
     */
    alert: function(message, type, onClose) {
        if (typeof document === 'undefined') return; // service context
        this._ensureOverlay();
        var typeClass = type ? ' ' + type : '';
        var title = type === 'error' ? 'Error' : (type === 'success' ? 'Success' : 'Notice');
        this._overlay.innerHTML =
            '<div class="poker-modal' + typeClass + '">' +
                '<div class="poker-modal-title">' + title + '</div>' +
                '<div class="poker-modal-message">' + message + '</div>' +
                '<div class="poker-modal-buttons">' +
                    '<button class="poker-modal-btn primary" id="pm-ok">OK</button>' +
                '</div>' +
            '</div>';
        this._overlay.classList.add('active');
        var self = this;
        document.getElementById('pm-ok').onclick = function() {
            self._overlay.classList.remove('active');
            if (onClose) onClose();
        };
        this._overlay.onclick = function(e) {
            if (e.target === self._overlay) {
                self._overlay.classList.remove('active');
                if (onClose) onClose();
            }
        };
    },

    /**
     * Show a confirm-style modal.
     * @param {string} message
     * @param {function} onResult - called with true (OK) or false (Cancel)
     */
    confirm: function(message, onResult) {
        if (typeof document === 'undefined') return;
        this._ensureOverlay();
        this._overlay.innerHTML =
            '<div class="poker-modal">' +
                '<div class="poker-modal-title">Confirm</div>' +
                '<div class="poker-modal-message">' + message + '</div>' +
                '<div class="poker-modal-buttons">' +
                    '<button class="poker-modal-btn secondary" id="pm-cancel">Cancel</button>' +
                    '<button class="poker-modal-btn primary" id="pm-ok">OK</button>' +
                '</div>' +
            '</div>';
        this._overlay.classList.add('active');
        var self = this;
        document.getElementById('pm-ok').onclick = function() {
            self._overlay.classList.remove('active');
            if (onResult) onResult(true);
        };
        document.getElementById('pm-cancel').onclick = function() {
            self._overlay.classList.remove('active');
            if (onResult) onResult(false);
        };
        this._overlay.onclick = function(e) {
            if (e.target === self._overlay) {
                self._overlay.classList.remove('active');
                if (onResult) onResult(false);
            }
        };
    },

    /**
     * Show a prompt-style modal with input field.
     * @param {string} message
     * @param {string} [defaultValue]
     * @param {function} callback - called with value (string) or null if cancelled
     */
    prompt: function(message, defaultValue, callback) {
        if (typeof document === 'undefined') return;
        this._ensureOverlay();
        this._overlay.innerHTML =
            '<div class="poker-modal">' +
                '<div class="poker-modal-title">Input</div>' +
                '<div class="poker-modal-message">' + message + '</div>' +
                '<input type="text" class="poker-modal-input" id="pm-input" value="' + (defaultValue || '') + '" />' +
                '<div class="poker-modal-buttons">' +
                    '<button class="poker-modal-btn secondary" id="pm-cancel">Cancel</button>' +
                    '<button class="poker-modal-btn primary" id="pm-ok">OK</button>' +
                '</div>' +
            '</div>';
        this._overlay.classList.add('active');
        var input = document.getElementById('pm-input');
        if (input) {
            setTimeout(function() { input.focus(); input.select(); }, 100);
        }
        var self = this;
        document.getElementById('pm-ok').onclick = function() {
            var val = input ? input.value : '';
            self._overlay.classList.remove('active');
            if (callback) callback(val);
        };
        document.getElementById('pm-cancel').onclick = function() {
            self._overlay.classList.remove('active');
            if (callback) callback(null);
        };
        this._overlay.onclick = function(e) {
            if (e.target === self._overlay) {
                self._overlay.classList.remove('active');
                if (callback) callback(null);
            }
        };
        if (input) {
            input.onkeydown = function(e) {
                if (e.key === 'Enter' || e.keyCode === 13) {
                    document.getElementById('pm-ok').onclick();
                }
            };
        }
    }
};

// Expose globally
if (typeof window !== 'undefined') {
    window.pokerModal = pokerModal;
}

pokerModal.choice = function(title, message, options, callback) {
    if (typeof document === 'undefined') return;
    this._ensureOverlay();
    var btns = '';
    for (var i = 0; i < options.length; i++) {
        btns += '<button class="poker-modal-btn primary" data-value="' + options[i].value + '">' + options[i].label + '</button>';
    }
    btns += '<button class="poker-modal-btn secondary" id="pm-cancel">Cancel</button>';
    this._overlay.innerHTML =
        '<div class="poker-modal">' +
            '<div class="poker-modal-title">' + title + '</div>' +
            '<div class="poker-modal-message">' + message + '</div>' +
            '<div class="poker-modal-buttons" style="flex-direction:column;gap:8px">' + btns + '</div>' +
        '</div>';
    this._overlay.classList.add('active');
    var self = this;
    var close = function(val) {
        self._overlay.classList.remove('active');
        if (callback) callback(val);
    };
    var buttons = self._overlay.querySelectorAll('[data-value]');
    for (var j = 0; j < buttons.length; j++) {
        (function(btn) {
            btn.onclick = function() { close(btn.getAttribute('data-value')); };
        })(buttons[j]);
    }
    document.getElementById('pm-cancel').onclick = function() { close(null); };
    this._overlay.onclick = function(e) { if (e.target === self._overlay) close(null); };
};
