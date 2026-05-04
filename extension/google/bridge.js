/**
 * Google Provider — Extension Bridge Integration
 *
 * Handles communication between the extension's content script and the
 * Google SpeechRecognition class (set by either webchannel.js or fullduplex.js).
 *
 * Listens for postMessage events:
 *   - WHISPER_START_RECORDING → creates a SpeechRecognition instance and starts it
 *   - WHISPER_STOP_RECORDING / WHISPER_ABORT_RECORDING → stops the instance
 *   - WHISPER_UPDATE_GOOGLE_CONFIG → updates window.__googleProviderConfig
 *
 * Must be injected AFTER the provider script (webchannel.js or fullduplex.js)
 * which sets window.SpeechRecognition.
 */
(function () {
    'use strict';

    if (window.__googleProviderBridgeInstalled) return;
    window.__googleProviderBridgeInstalled = true;

    let __googleProviderActiveSessionId = null;
    let __googleProviderInstance = null;

    function __handleGoogleStartRecording(event) {
        const data = event.data;
        if (data.type !== 'WHISPER_START_RECORDING' || window.__googleProviderConfig?.provider !== 'google') return;
        
        // Ignore preliminary start events from hotkey/popup; only act on the one from startRecording()
        if (data.sessionId === undefined) return;

        if (__googleProviderInstance) {
            __googleProviderInstance.stop();
            __googleProviderInstance = null;
        }

        __googleProviderActiveSessionId = data.sessionId;
        const lang = data.language && data.language !== 'auto' ? data.language : (navigator.language || 'en');

        __googleProviderInstance = new window.SpeechRecognition();
        __googleProviderInstance.lang = lang;
        __googleProviderInstance.continuous = true;
        __googleProviderInstance.interimResults = true;

        __googleProviderInstance.onstart = () => {
            window.postMessage({ type: 'WHISPER_AUDIO_START' }, '*');
            window.postMessage({ type: 'WHISPER_SPEECH_START' }, '*');
        };

        __googleProviderInstance.onresult = (e) => {
            const result = e.results[e.results.length - 1];
            const isFinal = result.isFinal;
            const text = result[0].transcript;

            window.postMessage({
                type: 'WHISPER_RESULT_TO_PAGE',
                text: text,
                isFinal: isFinal,
                source: 'google-provider'
            }, '*');
        };

        __googleProviderInstance.onerror = (e) => {
            if (window.__googleProviderConfig?.debugMode) console.error('[Google Provider] Error:', e.error);
            if (e.error === 'network' || e.error === 'not-allowed') {
                 window.postMessage({
                    type: 'WHISPER_GOOGLE_STATUS',
                    level: 'error',
                    message: 'Google Provider Error: ' + e.error
                 }, '*');
            }
            window.postMessage({ type: 'WHISPER_SPEECH_END' }, '*');
        };

        __googleProviderInstance.onend = () => {
            window.postMessage({ type: 'WHISPER_SPEECH_END' }, '*');
            __googleProviderInstance = null;
        };

        __googleProviderInstance.start();
    }

    function __handleGoogleStopRecording(event) {
        if (event.data.type === 'WHISPER_STOP_RECORDING' || event.data.type === 'WHISPER_ABORT_RECORDING') {
            // If sessionId is undefined (e.g. from hotkey), allow it to stop the active instance
            if (__googleProviderInstance && (event.data.sessionId === undefined || __googleProviderActiveSessionId === event.data.sessionId)) {
                __googleProviderInstance.stop();
                __googleProviderInstance = null;
            }
        }
    }

    function __handleGoogleConfigUpdate(event) {
        if (event.data.type === 'WHISPER_UPDATE_GOOGLE_CONFIG' && event.data.config) {
            window.__googleProviderConfig = event.data.config;
            // Apply server mode change immediately so the next start() uses it
            if (event.data.config.serverMode && typeof window.__googleProviderSwitchBackend === 'function') {
                window.__googleProviderSwitchBackend(event.data.config.serverMode);
            }
        }
    }

    function __handleGoogleClear(event) {
        if (event.data.type === 'WHISPER_CLEAR_GOOGLE_PROVIDER') {
            if (__googleProviderInstance) {
                try { __googleProviderInstance.stop(); } catch (_) {}
                __googleProviderInstance = null;
            }
            delete window.__googleProviderConfig;
            
            // Note: We leave the global SpeechRecognition class as-is because 
            // polyfill.js will overwrite it when it gets injected immediately after this.
        }
    }

    window.addEventListener('message', __handleGoogleStartRecording);
    window.addEventListener('message', __handleGoogleStopRecording);
    window.addEventListener('message', __handleGoogleConfigUpdate);
    window.addEventListener('message', __handleGoogleClear);
})();
