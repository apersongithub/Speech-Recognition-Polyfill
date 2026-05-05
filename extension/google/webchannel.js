/**
 * Google Provider — WebChannel Speech Recognition (v1 + v2 backends)
 *
 * Implements the Web Speech API (SpeechRecognition) using Google's WebChannel
 * streaming protocol. Supports two backends:
 *   - v1: Embedded Assistant API (JSON payloads, no punctuation)
 *   - v2: Cloud Speech v2 StreamingRecognize API (Binary Protobuf, punctuation)
 *
 * Dependencies (must be injected before this script):
 *   - google/ua-spoof.js (optional, for UA spoofing)
 *   - google/protobuf.js (required, exports to window.__GP.pb)
 *
 * Reads config from window.__GP.config (set by content.js before injection).
 */
(function () {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    window.__GP = window.__GP || {};

    (function initialization() {

        // =========================================================================
        // CONFIGURATION
        // =========================================================================

        // Read config from data attribute (CSP-safe, set by content.js)
        const config = JSON.parse(document.documentElement.getAttribute('data-gp-config') || '{}');
        const DEV_MODE = !!config.debugMode;
        let SERVER_MODE = config.serverMode || "v1";
        const MIC_IDLE_TIMEOUT_MS = config.micIdleTimeoutMs || 5000;

        const BACKEND_PROFILES = {
            v1: {
                name: "v1",
                apiKeys: [
                    "AIzaSyBm7NubC-Swn1nt2nhYfxb58eCdmL2vCVU",
                    "AIzaSyBU2xE_JHvB6wag3tMfhxXpg2Q_W8xnM-I"
                ],
                endpoints: [
                    {
                        url: "https://embeddedassistant-webchannel.googleapis.com/google.assistant.embedded.v1.EmbeddedAssistant/Assist/channel",
                        referrer: "https://www.google.com/"
                    },
                    {
                        url: "https://embeddedassistant-frontend-clients6.youtube.com/google.assistant.embedded.v1.EmbeddedAssistant/YTAssist/channel",
                        referrer: "https://www.youtube.com/"
                    }
                ]
            },
            v2: {
                name: "v2",
                apiKeys: [
                    "AIzaSyBm7NubC-Swn1nt2nhYfxb58eCdmL2vCVU",
                    "AIzaSyD6n9asBjvx1yBHfhFhfw_kpS9Faq0BZHM"
                ],
                endpoints: [
                    {
                        url: "https://speechs3proto2-pa.googleapis.com/s3web/prod/streaming/channel",
                        referrer: "https://gemini.google.com/"
                    }
                ]
            }
        };

        // =========================================================================
        // Import protobuf helpers from google/protobuf.js
        // =========================================================================
        const pb = window.__GP.pb;
        if (!pb) {
            console.error('[Google WebChannel] window.__GP.pb not found - google/protobuf.js must be loaded first');
            return;
        }
        const { buildStreamingConfigProto, buildAudioChunkProto, decodeStreamingResponse, uint8ToBase64 } = pb;




        let ACTIVE_BACKEND = BACKEND_PROFILES[SERVER_MODE] || BACKEND_PROFILES.v2;
        let API_KEYS = [...ACTIVE_BACKEND.apiKeys];
        let API_ENDPOINTS = [...ACTIVE_BACKEND.endpoints];

        let currentEndpointIndex = 0;
        let currentKeyIndex = 0;

        // Extension integration: switch backend at runtime based on config
        // passed via WHISPER_UPDATE_GOOGLE_CONFIG from content.js.
        function switchBackend(mode) {
            if (!mode || !BACKEND_PROFILES[mode]) return;
            if (ACTIVE_BACKEND.name === mode) return; // already on this backend
            SERVER_MODE = mode;
            ACTIVE_BACKEND = BACKEND_PROFILES[mode];
            API_KEYS = [...ACTIVE_BACKEND.apiKeys];
            API_ENDPOINTS = [...ACTIVE_BACKEND.endpoints];
            currentEndpointIndex = 0;
            currentKeyIndex = 0;
            preSession = null;
            preSessionPromise = null;
        }
        // Expose for the config update handler outside the IIFE
        W.__googleProviderSwitchBackend = switchBackend;

        const getBaseUrl = () => API_ENDPOINTS[currentEndpointIndex].url;
        const getFetchOpts = () => ({
            mode: "cors",
            credentials: "omit",
            referrer: API_ENDPOINTS[currentEndpointIndex].referrer
        });

        // =========================================================================
        // Proxy fetch infrastructure — routes fetch() through background script
        // to bypass strict page Content-Security-Policy connect-src rules.
        // =========================================================================
        let _proxyReqCounter = 0;
        const _proxyPending = new Map();

        window.addEventListener('message', (ev) => {
            if (!ev.data || !ev.data._wcProxyId) return;
            const id = ev.data._wcProxyId;
            const entry = _proxyPending.get(id);
            if (!entry) return;

            if (ev.data.type === 'WEBCHANNEL_FETCH_RESPONSE') {
                _proxyPending.delete(id);
                if (ev.data.error && ev.data.name === 'AbortError') {
                    entry.reject(new DOMException('Aborted', 'AbortError'));
                } else {
                    entry.resolve({
                        ok: ev.data.ok,
                        status: ev.data.status,
                        headers: { get: (name) => (ev.data.headers || {})[name.toLowerCase()] || null },
                        text: () => Promise.resolve(ev.data.body || '')
                    });
                }
            } else if (ev.data.type === 'WEBCHANNEL_STREAM_START') {
                entry.streamStarted = true;
                entry.resolve({
                    ok: ev.data.ok,
                    status: ev.data.status,
                    headers: { get: (name) => (ev.data.headers || {})[name.toLowerCase()] || null },
                    body: entry.body
                });
            } else if (ev.data.type === 'WEBCHANNEL_STREAM_CHUNK') {
                if (entry.controller) {
                    try { entry.controller.enqueue(new Uint8Array(ev.data.chunk)); } catch { }
                }
            } else if (ev.data.type === 'WEBCHANNEL_STREAM_END') {
                _proxyPending.delete(id);
                if (entry.controller) {
                    try { entry.controller.close(); } catch { }
                }
            } else if (ev.data.type === 'WEBCHANNEL_STREAM_ERROR') {
                _proxyPending.delete(id);
                const err = ev.data.name === 'AbortError'
                    ? new DOMException('Aborted', 'AbortError')
                    : new Error(ev.data.error || 'Proxy stream error');
                if (entry.streamStarted && entry.controller) {
                    try { entry.controller.error(err); } catch { }
                } else {
                    entry.reject(err);
                }
            }
        });

        function _proxyFetch(url, options = {}) {
            const id = ++_proxyReqCounter;
            return new Promise((resolve, reject) => {
                if (options.signal?.aborted) {
                    reject(new DOMException('Aborted', 'AbortError'));
                    return;
                }
                _proxyPending.set(id, { resolve, reject });
                if (options.signal) {
                    options.signal.addEventListener('abort', () => {
                        if (_proxyPending.has(id)) {
                            _proxyPending.delete(id);
                            reject(new DOMException('Aborted', 'AbortError'));
                            window.postMessage({ type: 'WEBCHANNEL_ABORT', _wcProxyId: id }, '*');
                        }
                    }, { once: true });
                }
                window.postMessage({
                    type: 'WEBCHANNEL_FETCH', _wcProxyId: id,
                    url, method: options.method || 'GET',
                    headers: options.headers || {},
                    body: options.body || null,
                    referrer: options.referrer || null,
                    stream: false
                }, '*');
            });
        }

        function _proxyFetchStream(url, options = {}) {
            const id = ++_proxyReqCounter;
            let streamController;
            const body = new ReadableStream({
                start(controller) { streamController = controller; }
            });
            return new Promise((resolve, reject) => {
                _proxyPending.set(id, {
                    resolve, reject,
                    controller: streamController,
                    body, streamStarted: false
                });
                window.postMessage({
                    type: 'WEBCHANNEL_FETCH', _wcProxyId: id,
                    url, method: options.method || 'GET',
                    headers: options.headers || {},
                    body: options.body || null,
                    referrer: options.referrer || null,
                    stream: true
                }, '*');
            });
        }

        function _proxyAbort(id) {
            window.postMessage({ type: 'WEBCHANNEL_ABORT', _wcProxyId: id }, '*');
            const entry = _proxyPending.get(id);
            if (entry) {
                _proxyPending.delete(id);
                if (entry.controller) {
                    try { entry.controller.error(new DOMException('Aborted', 'AbortError')); } catch { }
                }
            }
        }

        const getApiKey = () => API_KEYS[currentKeyIndex];

        let preSession = null;
        let preSessionPromise = null;

        // Attempts to scrape an active Google API key from the current page's scripts.
        function findApiKey() {
            if (window.location.hostname === "www.google.com" && window.location.pathname === "/") {
                for (const script of document.querySelectorAll("script")) {
                    const text = script.textContent || "";
                    const m = text.match(/"X-Goog-Api-Key"\s*:\s*"([^"]{33,})"/i);
                    if (m && m[1].startsWith("AIzaSyBm")) return m[1];
                }
            }
            return null;
        }

        const scrapedKey = findApiKey();
        if (scrapedKey) {
            const idx = API_KEYS.indexOf(scrapedKey);
            if (idx !== -1) API_KEYS.splice(idx, 1);
            API_KEYS.unshift(scrapedKey);
        }

        // Attempts to extract the active Google account index (AuthUser) from the page for authentication.
        function findAuthUser() {
            for (const script of document.querySelectorAll("script")) {
                const text = script.textContent || "";
                const m = text.match(/"X-Goog-AuthUser"\s*:\s*(?:[^"\n]+)?"([^"]+)"/i);
                if (m) return m[1];
            }
            const m2 = document.documentElement.innerHTML.match(/"X-Goog-AuthUser"\s*:\s*(?:[^"\n]+)?"([^"]+)"/i);
            return m2 ? m2[1] : "0";
        }

        const AUTH_USER = findAuthUser();
        const CURRENT_YEAR = String(new Date().getFullYear());
        let browserValidation = null;

        const _origXhrSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (h, v) {
            if (h.toLowerCase() === "x-browser-validation" && !browserValidation) browserValidation = v;
            return _origXhrSetHeader.apply(this, arguments);
        };

        if (!browserValidation) {
            const valMatch = document.documentElement.innerHTML.match(
                /x-browser-validation['":\s]+([A-Za-z0-9+/=]{20,44})/i
            );
            if (valMatch) browserValidation = valMatch[1];
        }

        if (ACTIVE_BACKEND.name === "v2" && !browserValidation) {
            browserValidation = "JmUDa+WXIcEmBPOq9TTt1Hr7mMI=";
        }

        // Constructs the specific HTTP headers required to initialize a new WebChannel session.
        function getSessionHeaders() {
            if (ACTIVE_BACKEND.name === "v2") {
                return {
                    accept: "*/*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    "x-browser-channel": "stable",
                    "x-browser-copyright": `Copyright ${CURRENT_YEAR} Google LLC. All Rights reserved.`,
                    "x-goog-api-key": getApiKey(),
                    ...(browserValidation ? { "x-browser-validation": browserValidation } : {}),
                    "x-browser-year": CURRENT_YEAR,
                    "x-webchannel-content-type": "application/x-protobuf"
                };
            }

            return {
                accept: "*/*",
                "accept-language": "en-US,en;q=0.9",
                "content-type": "application/x-www-form-urlencoded",
                "x-browser-channel": "stable",
                "x-browser-copyright": `Copyright ${CURRENT_YEAR} Google LLC. All Rights reserved.`,
                "x-goog-authuser": AUTH_USER,
                ...(browserValidation ? { "x-browser-validation": browserValidation } : {}),
                "x-browser-year": CURRENT_YEAR
            };
        }

        // Constructs the standard HTTP headers required for Google WebChannel requests.
        function getHeaders() {
            if (ACTIVE_BACKEND.name === "v2") {
                return {
                    accept: "*/*",
                    "accept-language": "en-US,en;q=0.9",
                    "content-type": "application/x-www-form-urlencoded",
                    "x-browser-channel": "stable",
                    "x-browser-copyright": `Copyright ${CURRENT_YEAR} Google LLC. All Rights reserved.`,
                    ...(browserValidation ? { "x-browser-validation": browserValidation } : {}),
                    "x-browser-year": CURRENT_YEAR
                };
            }

            return {
                accept: "*/*",
                "accept-language": "en-US,en;q=0.9",
                "content-type": "application/x-www-form-urlencoded",
                "x-browser-channel": "stable",
                "x-browser-copyright": `Copyright ${CURRENT_YEAR} Google LLC. All Rights reserved.`,
                "x-goog-authuser": AUTH_USER,
                ...(browserValidation ? { "x-browser-validation": browserValidation } : {}),
                "x-browser-year": CURRENT_YEAR
            };
        }

        function showPolyfillNotification(messageHtml) {
            const plainText = messageHtml.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[^>]+(>|$)/g, "");
            window.postMessage({ type: 'GOOGLE_PROVIDER_UI_ERROR', error: plainText }, '*');
            if (DEV_MODE) console.error("[Google Provider Error]", plainText);
        }

        let apiKeyInvalidCount = 0;
        let polyfillPermanentlyFailed = false;
        const rotateApiKey = () => {
            currentKeyIndex++;
            apiKeyInvalidCount++;
            if (currentKeyIndex >= API_KEYS.length) {
                currentKeyIndex = 0;
                currentEndpointIndex = (currentEndpointIndex + 1) % API_ENDPOINTS.length;
            }
        };

        // Establishes a new WebChannel session with Google servers, handling fallbacks through backup API keys and endpoints if the primary fails.
        async function createSession() {
            let attempts = 0;
            const maxAttempts = API_KEYS.length * API_ENDPOINTS.length;
            let lastError = null;

            while (attempts < maxAttempts) {
                const ridCounter = 62480 + Math.floor(Math.random() * 9000);
                const bindUrl =
                    ACTIVE_BACKEND.name === "v2"
                        ? `${getBaseUrl()}?VER=8&RID=${ridCounter}&CVER=22&X-HTTP-Session-Id=gsessionid&zx=${Date.now()}&t=1`
                        : `${getBaseUrl()}?VER=8&RID=${ridCounter}&CVER=22&X-HTTP-Session-Id=gsessionid&%24httpHeaders=x-goog-api-key%3A${getApiKey()}%0D%0A&zx=${Date.now()}&t=1`;

                try {
                    const bindRes = await _proxyFetch(bindUrl, {
                        method: "POST",
                        headers: getSessionHeaders(),
                        body: "count=0",
                        referrer: getFetchOpts().referrer
                    });

                    if (bindRes.ok) {
                        const bindText = await bindRes.text();
                        const jsonLines = bindText
                            .split("\n")
                            .filter((line) => line.trim() && !/^\d+$/.test(line.trim()));
                        const jsonStr = jsonLines.join("\n");

                        let parsed;
                        try {
                            parsed = JSON.parse(jsonStr);
                        } catch {
                            parsed = JSON.parse("[" + jsonStr.replace(/\]\s*\[/g, "],[") + "]");
                        }

                        let sid = null;
                        (function findSid(arr) {
                            if (!Array.isArray(arr)) return;
                            for (const item of arr) {
                                if (Array.isArray(item)) {
                                    if (item[0] === "c" && typeof item[1] === "string") sid = item[1];
                                    findSid(item);
                                }
                            }
                        })(parsed);

                        const gsessionid = bindRes.headers.get("x-http-session-id") || null;
                        if (sid) {
                            return { sid, gsessionid, ridCounter: ridCounter + 1 };
                        }
                    } else {
                        lastError = new Error(`Bind failed with status ${bindRes.status}`);
                    }
                } catch (err) {
                    lastError = err;
                }

                rotateApiKey();
                attempts++;
            }

            const errorMsg = `<strong>🎙️ Speech Recognition Userscript</strong><br><br><strong>Speech Recognition Error</strong><br>Unfortunately, the server backend cannot be reached.<br><br>This means either the server is down, Google disabled the ability to use the script natively, you are rate-limited, or blocked. Try the original extension.`;
            showPolyfillNotification(errorMsg);
            polyfillPermanentlyFailed = true;
            throw lastError || new Error("No SID or bind failed after trying all backups");
        }

        // Pre-emptively creates a session before recognition starts. This reduces latency when the user actually begins speaking.
        function warmSession() {
            if (preSessionPromise) return preSessionPromise;
            preSessionPromise = createSession()
                .then((s) => {
                    preSession = s;
                    return s;
                })
                .catch(() => {
                    preSession = null;
                    preSessionPromise = null;
                    return null;
                });
            return preSessionPromise;
        }

        const BaseClass =
            typeof EventTarget !== "undefined"
                ? EventTarget
                : class {
                    constructor() {
                        this.listeners = {};
                    }
                    addEventListener(type, callback) {
                        if (!(type in this.listeners)) this.listeners[type] = [];
                        this.listeners[type].push(callback);
                    }
                    removeEventListener(type, callback) {
                        if (!(type in this.listeners)) return;
                        this.listeners[type] = this.listeners[type].filter((cb) => cb !== callback);
                    }
                    dispatchEvent(event) {
                        if (!(event.type in this.listeners)) return true;
                        this.listeners[event.type].forEach((cb) => cb.call(this, event));
                        return !event.defaultPrevented;
                    }
                };

        /**
         * Main Polyfill Class.
         * Replaces the native SpeechRecognition object and orchestrates audio capture, 
         * WebChannel networking, audio chunk dispatching, and Web Speech API event handling.
         */
        class GoogleWebchannelSpeechRecognition extends BaseClass {
            constructor() {
                super();

                this._forcedFinalizeTimer = null;
                // W3C properties
                this.continuous = false;
                this.interimResults = false;
                this.lang = "en-US";
                this.maxAlternatives = 1;
                this.serviceURI = "";
                this.grammars = new SpeechGrammarList();

                // Event handlers
                this.onaudiostart = null;
                this.onaudioend = null;
                this.onend = null;
                this.onerror = null;
                this.onnomatch = null;
                this.onresult = null;
                this.onsoundstart = null;
                this.onsoundend = null;
                this.onspeechstart = null;
                this.onspeechend = null;
                this.onstart = null;

                // Runtime
                this._stream = null;
                this._audioCtx = null;
                this._processor = null;
                this._dummyAudio = null;
                this._recorder = null;

                this._aborting = false;
                this._cleanupCalled = false;
                this._switchingSession = false;
                this._stopRequested = false;
                this._abortController = null;

                this._bcDone = false;
                this._bcBuffer = "";

                this._latestHighStabilityTranscript = null;
                this._latestInterimTranscript = null;
                this._latestInterimStability = null;
                this._lastEmittedInterimTranscript = null;
                this._lastFinalTranscript = null;

                this._speechendFired = false;
                this._pendingFinal = false;
                this._finalizedThisUtterance = false;
                this._bestFinalCandidate = null;
                this._bestFinalStability = -1;

                this._finalResults = [];
                this._currentUtteranceId = 0;
                this._lastEmittedUtteranceId = -1;

                this._currentSid = null;
                this._currentGsessionid = null;
                this._currentRidCounter = 0;
                this._currentOfs = 1;

                this._vadSilenceFrames = 0;
                this._isVadSpeaking = false;

                this._preSessionBuffer = [];
                this._sendQueue = [];
                this._sendingChunks = false;
                this._consecutiveChunkFailures = 0;
                this._maxConsecutiveChunkFailures = 6;

                this._sessionGen = 0;
                this._activeBackchannelGen = 0;
                this._lastStartId = 0;

                this._sessionActive = false;
                this._micIdleTimer = null;
                this._restartPromise = null;
                this._suppressEndOnce = false;

                this._oggHeader = null;

                // s3 stall watchdog
                this._lastMeaningfulFrameTs = 0;
                this._noopFrameStreak = 0;

                this._permanentlyFailed = false;

                window.__polyfill_active_instances = window.__polyfill_active_instances || [];
                if (!window.__polyfill_active_instances.includes(this)) {
                    window.__polyfill_active_instances.push(this);
                }
                window._polyfillSR = this; // Debugging hook for console access
            }

            _dbg(...args) {
                if (!DEV_MODE) return;
                try { console.log("[polyfill dbg]", ...args); } catch { }
            }

            // Dispatches a standard SpeechRecognitionEvent to attached listeners and triggers corresponding 'on[event]' handlers.
            _dispatchEvent(name, eventObj) {
                const ev = eventObj || new Event(name);
                if (typeof this["on" + name] === "function") {
                    try { this["on" + name](ev); } catch { }
                }
                try { this.dispatchEvent(ev); } catch { }
            }

            _norm(t) { return (t || "").replace(/\s+/g, " ").trim(); }
            _stripXssiPrefix(text) { return text.replace(/^\)\]\}'\s*\n?/, ""); }

            // Reads and extracts a single complete payload frame from the raw incoming WebChannel stream buffer.
            _readFrameFromBuffer() {
                this._bcBuffer = this._stripXssiPrefix(this._bcBuffer).replace(/^\s+/, "");
                if (!this._bcBuffer.length) return null;

                const nl = this._bcBuffer.indexOf("\n");
                if (nl === -1) return null;

                const lenStr = this._bcBuffer.slice(0, nl).trim();
                if (!/^\d+$/.test(lenStr)) {
                    this._bcBuffer = this._bcBuffer.slice(nl + 1);
                    return null;
                }

                const len = Number(lenStr);
                const start = nl + 1;
                const end = start + len;
                if (this._bcBuffer.length < end) return null;

                const payload = this._bcBuffer.slice(start, end);
                this._bcBuffer = this._bcBuffer.slice(end);
                return payload;
            }

            // Extracts transcript and End-Of-Utterance signals from the v1 backend's JSON stream
            _extractFrameSignalsV1(frameObj) {
                let lastSpeechResults = null, sawEOU = false, sawClose = false, sawNoSpeech = false;

                const walk = (n) => {
                    if (n == null) return;
                    if (typeof n === "string") {
                        if (n === "close") sawClose = true;
                        if (n.includes("END_OF_UTTERANCE")) sawEOU = true;
                        return;
                    }
                    if (Array.isArray(n)) return void n.forEach(walk);
                    if (typeof n === "object") {
                        if (n.eventType === "END_OF_UTTERANCE") sawEOU = true;
                        if (n.noSpeech === true) sawNoSpeech = true;
                        if (Array.isArray(n.speechResults) && n.speechResults.length > 0) lastSpeechResults = n.speechResults;
                        for (const k of Object.keys(n)) {
                            if (k !== "speechResults" && k !== "transcript" && k !== "stability") walk(n[k]);
                        }
                    }
                };
                walk(frameObj);

                const STABILITY_THRESHOLD = 0.5;
                let highParts = [], lowParts = [], bestStability = null;

                if (lastSpeechResults) {
                    for (const sr of lastSpeechResults) {
                        if (sr.noSpeech === true) sawNoSpeech = true;
                        if (typeof sr.transcript === "string") {
                            const s = typeof sr.stability === "number" ? sr.stability : 0;
                            if (bestStability === null || s > bestStability) bestStability = s;
                            if (s < STABILITY_THRESHOLD) lowParts.push(sr.transcript);
                            else highParts.push(sr.transcript);
                        }
                    }
                }

                const highText = highParts.join(" ");
                const lowText = lowParts.join(" ");
                const fullText = (highText + (highText && lowText ? " " : "") + lowText).trim();

                return { fullText: fullText || null, highText: highText || null, bestStability, sawEOU, sawClose, sawNoSpeech };
            }

            // Extracts transcript and End-Of-Utterance signals from the v2 backend's binary protobuf stream (encoded in base64 arrays)
            _extractFrameSignalsS3(frameObj) {
                let sawEOU = false, sawClose = false, sawNoSpeech = false;

                if (Array.isArray(frameObj)) {
                    const flat = JSON.stringify(frameObj);
                    if (flat.includes('"close"')) sawClose = true;
                    if (flat.includes('"noop"') && !flat.includes('"__sm__"') && flat.length < 50) {
                        return { fullText: null, highText: null, bestStability: null, sawEOU: false, sawClose: false, sawNoSpeech: false };
                    }
                }

                let protoResponse = null;
                const findProtoData = (arr) => {
                    if (!Array.isArray(arr)) return null;
                    for (const item of arr) {
                        if (typeof item === "string" && item.length > 10 && /^[A-Za-z0-9+/=]+$/.test(item)) {
                            try {
                                const binary = atob(item);
                                const bytes = new Uint8Array(binary.length);
                                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                                const decoded = decodeStreamingResponse(bytes);
                                if (decoded.results.length > 0 || decoded.speechEventType > 0) return decoded;
                            } catch { }
                        }
                        if (Array.isArray(item)) {
                            const found = findProtoData(item);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                protoResponse = findProtoData(frameObj);

                if (!protoResponse) return { fullText: null, highText: null, bestStability: null, sawEOU, sawClose, sawNoSpeech };
                if (protoResponse.speechEventType === 1) sawEOU = true;

                const STABILITY_THRESHOLD = 0.5;
                let highParts = [], lowParts = [], bestStability = null;

                for (const result of protoResponse.results) {
                    if (result.isFinal) sawEOU = true;
                    const s = typeof result.stability === "number" ? result.stability : (result.isFinal ? 1 : 0);
                    if (bestStability === null || s > bestStability) bestStability = s;

                    for (const alt of result.alternatives) {
                        if (!alt.transcript) continue;
                        if (s < STABILITY_THRESHOLD) lowParts.push(alt.transcript);
                        else highParts.push(alt.transcript);
                    }
                    if (result.alternatives.length === 0) sawNoSpeech = true;
                }

                const highText = highParts.join("");
                const lowText = lowParts.join("");
                const fullText = (highText + (highText && lowText ? " " : "") + lowText).trim();

                return { fullText: fullText || null, highText: highText || null, bestStability, sawEOU, sawClose, sawNoSpeech };
            }

            _extractFrameSignals(frameObj) {
                return ACTIVE_BACKEND.name === "v1"
                    ? this._extractFrameSignalsV1(frameObj)
                    : this._extractFrameSignalsS3(frameObj);
            }

            // Evaluates an incoming interim transcript to determine if it should become the final settled result based on stability and length.
            _considerFinalCandidate(transcript, stability) {
                const t = this._norm(transcript);
                if (!t) return;

                if (t.length < 6 && /[.?!]$/.test(t)) return;

                const s = typeof stability === "number" ? stability : 0;
                const bestLen = this._bestFinalCandidate ? this._bestFinalCandidate.length : 0;
                if (!this._bestFinalCandidate || s > this._bestFinalStability || (s === this._bestFinalStability && t.length >= bestLen)) {
                    this._bestFinalCandidate = t;
                    this._bestFinalStability = s;
                }
            }

            // Commits the best current transcript as a final result and emits the 'result' event.
            _finalizeCurrentUtteranceOnce() {
                if (this._finalizedThisUtterance) return;

                const finalText = this._bestFinalCandidate || this._norm(this._latestInterimTranscript);
                if (!finalText) return;

                const finalStability = this._bestFinalStability >= 0 ? this._bestFinalStability : (this._latestInterimStability ?? 0.99);

                this._dbg("finalizeOnce", {
                    pending: this._pendingFinal,
                    finalized: this._finalizedThisUtterance,
                    best: this._bestFinalCandidate,
                    latest: this._latestInterimTranscript
                });

                this._emitResult(finalText, finalStability, true);
                this._lastFinalTranscript = finalText;
                this._finalizedThisUtterance = true;
                this._lastEmittedInterimTranscript = null;
                this._lastEmittedUtteranceId = -1;
            }

            // Continuously reads the active streaming response connection (backchannel) for incoming speech recognition results.
            async _consumeBackchannel(bcRes, gen, startId) {
                const reader = bcRes.body.getReader();
                const decoder = new TextDecoder();
                this._bcBuffer = "";

                while (!this._aborting) {
                    if (gen !== this._activeBackchannelGen || startId !== this._lastStartId) return;
                    const { done, value } = await reader.read();
                    if (done) break;

                    if (gen !== this._activeBackchannelGen || startId !== this._lastStartId) return;
                    this._bcBuffer += decoder.decode(value, { stream: true });

                    while (!this._aborting) {
                        if (gen !== this._activeBackchannelGen || startId !== this._lastStartId) return;
                        const payload = this._readFrameFromBuffer();
                        if (payload == null) break;

                        let frameObj;
                        try { frameObj = JSON.parse(payload); } catch { continue; }

                        this._dbg("raw frame", payload.length > 500 ? payload.substring(0, 500) + "..." : payload);

                        if (payload.includes("API_KEY_INVALID") || payload.includes("SERVICE_DISABLED")) {
                            this._dbg("API exhaustion detected in payload, rotating API key");
                            rotateApiKey();
                            if (apiKeyInvalidCount >= API_KEYS.length) {
                                const errorMsg = `<strong>🎙️ Speech Recognition Userscript</strong><br><br><strong>API Key Exhausted</strong><br>Unfortunately, none of the keys for <code>${ACTIVE_BACKEND.name}</code> worked.<br><br>The keys have likely been redistributed or no longer work with this service (SERVICE_DISABLED). You would need to supply new API keys by navigating google domains and extracting the keys from network traffic.`;
                                showPolyfillNotification(errorMsg);
                                polyfillPermanentlyFailed = true;
                                this._dispatchEvent("error", new SpeechRecognitionErrorEvent("error", { error: "not-allowed", message: "API keys exhausted" }));
                                this._cleanup("api keys exhausted");
                                return;
                            } else {
                                this._dbg("API auth failed during backchannel, silently restarting session with next key");
                                await this._restartSession(true);
                                return;
                            }
                        }

                        const { fullText, highText, bestStability, sawEOU, sawClose, sawNoSpeech } = this._extractFrameSignals(frameObj);

                        this._dbg("frame", {
                            backend: ACTIVE_BACKEND.name,
                            gen, activeGen: this._activeBackchannelGen,
                            startId, activeStart: this._lastStartId,
                            sawEOU, sawClose, fullText, bestStability
                        });

                        const hasMeaningfulText = !!fullText;
                        const hasBoundarySignal = sawEOU || sawClose || sawNoSpeech;
                        if (hasMeaningfulText || hasBoundarySignal) {
                            this._lastMeaningfulFrameTs = Date.now();
                            this._noopFrameStreak = 0;
                        } else {
                            this._noopFrameStreak++;
                        }

                        if (
                            ACTIVE_BACKEND.name === "v2" &&
                            !this._aborting &&
                            !this._stopRequested &&
                            this.continuous &&
                            this._currentSid &&
                            this._noopFrameStreak > 20 &&
                            (this._sendQueue.length > 0 || this._sendingChunks)
                        ) {
                            this._dbg("noop-stall detected; forcing restart");
                            await this._restartSession();
                            return;
                        }

                        if (sawNoSpeech) {
                            this._dispatchEvent("nomatch");
                            this._bcDone = true;
                            this._cleanup("no speech");
                            return;
                        }

                        if (sawEOU) {
                            this._pendingFinal = true;
                            if (fullText) {
                                this._considerFinalCandidate(fullText, bestStability);
                                this._latestInterimTranscript = fullText;

                                // Emit interim result immediately like v1.js does so UX feels fast
                                if (this.interimResults && !this._finalizedThisUtterance) {
                                    if (fullText !== this._lastEmittedInterimTranscript || this._currentUtteranceId !== this._lastEmittedUtteranceId) {
                                        this._lastEmittedInterimTranscript = fullText;
                                        this._lastEmittedUtteranceId = this._currentUtteranceId;
                                        this._emitResult(fullText, bestStability ?? 0.01, false);
                                    }
                                }
                            }
                            if (!this._speechendFired) {
                                this._speechendFired = true;
                                this._dispatchEvent("speechend");
                            }
                        } else if (this._pendingFinal) {
                            if (fullText) {
                                this._considerFinalCandidate(fullText, bestStability);
                                this._latestInterimTranscript = fullText;
                                if (this.interimResults) {
                                    this._lastEmittedInterimTranscript = fullText;
                                    this._lastEmittedUtteranceId = this._currentUtteranceId;
                                    this._emitResult(fullText, bestStability ?? 0.01, false);
                                }
                            } else {
                                this._finalizeCurrentUtteranceOnce();
                                this._pendingFinal = false;
                                this._finalizedThisUtterance = false;
                                this._bestFinalCandidate = null;
                                this._bestFinalStability = -1;
                                this._currentUtteranceId++;
                                this._lastEmittedInterimTranscript = null;
                                this._latestInterimTranscript = null;
                                this._latestInterimStability = null;
                                this._speechendFired = false;

                                if (!this.continuous || this._stopRequested) {
                                    this._dbg("ending session after final result (stop requested or non-continuous)");
                                    this._cleanup("post-final end");
                                    return;
                                }
                            }
                            // REPLACE WITH THIS EXACT BLOCK:

                        } else if (fullText && !sawClose) {
                            this._latestInterimTranscript = fullText;
                            if (highText) this._latestHighStabilityTranscript = highText;
                            if (bestStability !== null) this._latestInterimStability = bestStability;
                            this._considerFinalCandidate(fullText, bestStability);

                            if (this.interimResults) {
                                this._lastEmittedInterimTranscript = fullText;
                                this._lastEmittedUtteranceId = this._currentUtteranceId;
                                this._emitResult(fullText, bestStability ?? 0.01, false);
                            }

                            // v2 sometimes never sends explicit EOU/final.
                            // If user has gone silent and we already have interim text, force-finalize shortly.
                            if (ACTIVE_BACKEND.name === "v2") {
                                if (this._forcedFinalizeTimer) {
                                    clearTimeout(this._forcedFinalizeTimer);
                                    this._forcedFinalizeTimer = null;
                                }

                                if (!this._isVadSpeaking && !this._pendingFinal && !this._finalizedThisUtterance) {
                                    this._forcedFinalizeTimer = setTimeout(() => {
                                        if (this._aborting || !this._sessionActive) return;
                                        if (this._pendingFinal || this._finalizedThisUtterance) return;
                                        if (this._isVadSpeaking) return;
                                        if (!this._latestInterimTranscript) return;

                                        this._considerFinalCandidate(
                                            this._latestInterimTranscript,
                                            this._latestInterimStability ?? 0.99
                                        );
                                        this._finalizeCurrentUtteranceOnce();

                                        this._bestFinalCandidate = null;
                                        this._bestFinalStability = -1;
                                        this._currentUtteranceId++;
                                        this._lastEmittedInterimTranscript = null;
                                        this._latestInterimTranscript = null;
                                        this._latestInterimStability = null;
                                        this._finalizedThisUtterance = false;
                                        this._speechendFired = false;
                                    }, 700);
                                }
                            }
                        } else if (!fullText && !sawEOU && this._latestInterimTranscript) {
                            // Null-text without EOU = utterance boundary in continuous mode
                            this._finalizeCurrentUtteranceOnce();
                            this._bestFinalCandidate = null;
                            this._bestFinalStability = -1;
                            this._currentUtteranceId++;
                            this._lastEmittedInterimTranscript = null;
                            this._latestInterimTranscript = null;
                            this._latestInterimStability = null;
                            this._finalizedThisUtterance = false;
                            this._dbg("utterance boundary (no EOU), ready for next");

                            if (!this.continuous || this._stopRequested) {
                                this._dbg("ending session after final result (stop requested or non-continuous)");
                                this._cleanup("utterance boundary end");
                                return;
                            }
                        }

                        if (sawClose) {
                            if (!this._finalizedThisUtterance) this._finalizeCurrentUtteranceOnce();
                            this._bcDone = true;

                            if (this.continuous && !this._aborting && !this._stopRequested) await this._restartSession();
                            else this._cleanup("server close");
                            return;
                        }
                    }
                }

                if (this._pendingFinal) this._finalizeCurrentUtteranceOnce();

                this._bcDone = true;
                if (this.continuous && !this._aborting && !this._cleanupCalled && !this._stopRequested) {
                    if (this._latestInterimTranscript && !this._pendingFinal) {
                        this._considerFinalCandidate(this._latestInterimTranscript, this._latestInterimStability ?? 0.99);
                        this._finalizeCurrentUtteranceOnce();
                    }
                    this._dbg("backchannel ended naturally, restarting");
                    await this._restartSession();
                } else if (!this._aborting) {
                    if (this._latestInterimTranscript) this._finalizeCurrentUtteranceOnce();
                    this._cleanup("backchannel end cleanup");
                }
            }

            // Starts the speech recognition process: claims the microphone, connects audio graphs, and negotiates the server session.
            async start() {
                // Apply latest server mode from extension config before starting
                const configMode = W.__googleProviderConfig?.serverMode;
                if (configMode && BACKEND_PROFILES[configMode]) {
                    switchBackend(configMode);
                }

                if (polyfillPermanentlyFailed) {
                    this._dbg("start() rejected: polyfill permanently failed");
                    return;
                }
                if (this._sessionActive && !this._aborting) throw new Error("Already started");
                this._sessionActive = true;

                this._vadSilenceFrames = 0;
                this._isVadSpeaking = true;

                if (this._micIdleTimer) {
                    clearTimeout(this._micIdleTimer);
                    this._micIdleTimer = null;
                }

                this._lastStartId++;
                this._sessionGen++;
                this._activeBackchannelGen = this._sessionGen;

                this._dbg("start", {
                    backend: ACTIVE_BACKEND.name,
                    startId: this._lastStartId,
                    sessionGen: this._sessionGen,
                    continuous: this.continuous
                });

                this._aborting = false;
                this._cleanupCalled = false;
                this._switchingSession = false;
                this._bcDone = false;
                this._stopRequested = false;

                this._speechendFired = false;
                this._pendingFinal = false;
                this._finalizedThisUtterance = false;
                this._bestFinalCandidate = null;
                this._bestFinalStability = -1;

                this._latestInterimTranscript = null;
                this._latestInterimStability = null;
                this._lastEmittedInterimTranscript = null;
                this._lastFinalTranscript = null;
                this._finalResults = [];
                this._currentUtteranceId = 0;
                this._lastEmittedUtteranceId = -1;

                this._preSessionBuffer = [];
                this._sendQueue = [];
                this._sendingChunks = false;
                this._consecutiveChunkFailures = 0;

                this._abortController = new AbortController();

                try {
                    if (!this._stream) {
                        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                            throw new Error("getUserMedia not supported (requires HTTPS)");
                        }

                        this._stream = await navigator.mediaDevices.getUserMedia({
                            audio: {
                                echoCancellation: true,
                                noiseSuppression: true,
                                autoGainControl: true
                            }
                        });
                        const AudioContext = window.AudioContext || window.webkitAudioContext;
                        if (!AudioContext) throw new Error("AudioContext not supported");
                        this._audioCtx = new AudioContext();
                        if (this._audioCtx.state === 'suspended') {
                            await this._audioCtx.resume();
                        }

                        this._dummyAudio = new Audio();
                        this._dummyAudio.muted = true;
                        this._dummyAudio.srcObject = this._stream;
                        try { this._dummyAudio.play()?.catch?.(() => { }); } catch { }

                        const source = this._audioCtx.createMediaStreamSource(this._stream);

                        // --- NEW GAIN NODE (Enhanced Recognition) ---
                        this._gainNode = this._audioCtx.createGain();
                        // Google Speech works better with slightly amplified volume but not clipped.
                        // We also added noise suppression / echo cancellation constraints.
                        this._gainNode.gain.value = window.__googleProviderConfig?.micGainMultiplier || 1.25;
                        source.connect(this._gainNode);

                        // Destination for MediaRecorder (v2)
                        this._destinationNode = this._audioCtx.createMediaStreamDestination();
                        this._gainNode.connect(this._destinationNode);

                        this._processor = this._audioCtx.createScriptProcessor(8192, 1, 1);
                        this._gainNode.connect(this._processor);
                        this._processor.connect(this._audioCtx.destination);

                        if (this._audioCtx.state === "suspended") await this._audioCtx.resume();

                        this._processor.onaudioprocess = (e) => {
                            if (!this._sessionActive || this._aborting) return;

                            const float32 = e.inputBuffer.getChannelData(0);
                            let sumSquares = 0;
                            for (let i = 0; i < float32.length; i++) sumSquares += float32[i] ** 2;
                            const rms = Math.sqrt(sumSquares / float32.length);
                            const isSpeech = rms >= 0.01;
                            if (isSpeech) {
                                this._vadSilenceFrames = 0;
                                this._isVadSpeaking = true;
                            } else {
                                this._vadSilenceFrames++;
                            }

                            // If non-continuous dictation has an active transcript but trailing silence is detected (~2.5s), auto-stop.
                            if (!this.continuous && this._latestInterimTranscript && this._vadSilenceFrames > 15) {
                                this._dbg("VAD auto-endpointed non-continuous utterance");
                                this.stop();
                                return;
                            }

                            // The v1 and v1_old backends accept raw 16-bit PCM Audio generated via the ScriptProcessor
                            if (ACTIVE_BACKEND.name === "v1" || ACTIVE_BACKEND.name === "v1_old") {
                                if (this._aborting || this._cleanupCalled || this._switchingSession || this._bcDone) return;

                                // Keep sending a short tail of silence so the server can correctly endpoint/finalize
                                // ~8192 samples per frame; at 48kHz that's ~170ms/frame (~2 seconds max tail = 12 frames)
                                const shouldSend = isSpeech || (this._isVadSpeaking && this._vadSilenceFrames <= 12);
                                if (!shouldSend) {
                                    this._isVadSpeaking = false;
                                    return;
                                }

                                const originalSampleRate = this._audioCtx.sampleRate;
                                if (!originalSampleRate) return;

                                const ratio = originalSampleRate / 16000;
                                const targetLength = Math.round(float32.length / ratio);
                                const int16 = new Int16Array(targetLength);

                                for (let i = 0; i < targetLength; i++) {
                                    const srcIndex = Math.min(Math.floor(i * ratio), float32.length - 1);
                                    int16[i] = Math.max(-1, Math.min(1, float32[srcIndex])) * 0x7fff;
                                }

                                const uint8 = new Uint8Array(int16.buffer);
                                let binary = "";
                                for (let i = 0; i < uint8.length; i += 8192) {
                                    binary += String.fromCharCode(...uint8.subarray(i, i + 8192));
                                }
                                this._enqueueChunk(btoa(binary));
                            }
                        };
                    }

                    if (ACTIVE_BACKEND.name === "v2") this._setupMediaRecorder();

                    this._dispatchEvent("start");
                    this._dispatchEvent("audiostart");
                    window.postMessage({ type: 'GOOGLE_PROVIDER_UI_START' }, '*');

                    if (!preSession) await warmSession();

                    if (ACTIVE_BACKEND.name === "v2" && this._oggHeader) {
                        const headerProto = buildAudioChunkProto(this._oggHeader);
                        this._preSessionBuffer.unshift(uint8ToBase64(headerProto));
                    }

                    await this._setupSession(preSession);
                } catch (err) {
                    this._handleError("network", err?.message || "Unknown network error");
                }
            }

            // The v2 backend requires OGG/WebM Opus chunks. We use MediaRecorder exclusively for v2.
            _setupMediaRecorder() {
                if (ACTIVE_BACKEND.name !== "v2") return;
                if (this._recorder) {
                    if (this._recorder.state === "paused") {
                        try { this._recorder.resume(); } catch { }
                    }
                    return;
                }

                const mimeType = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
                    ? "audio/ogg;codecs=opus"
                    : MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                        ? "audio/webm;codecs=opus"
                        : "audio/webm";

                const streamToRecord = this._destinationNode ? this._destinationNode.stream : this._stream;
                const recorder = new MediaRecorder(streamToRecord, { mimeType, audioBitsPerSecond: 32000 });
                this._recorder = recorder;

                recorder.ondataavailable = async (e) => {
                    if (!this._sessionActive || this._aborting) return;
                    if (this._recorder !== recorder) return;
                    if (!e.data || e.data.size === 0) return;

                    const audioBytes = new Uint8Array(await e.data.arrayBuffer());

                    if (!this._oggHeader) {
                        this._oggHeader = audioBytes.slice();
                        this._dbg("saved Ogg header", this._oggHeader.length, "bytes");
                    } else if (this._oggHeader === audioBytes) {
                        // ignore if same reference somehow
                    }

                    if (!this._isVadSpeaking && !this._pendingFinal) return;

                    const audioProto = buildAudioChunkProto(audioBytes);
                    this._enqueueChunk(uint8ToBase64(audioProto));
                };

                recorder.onerror = (e) => this._dbg("MediaRecorder error", e.error?.name || e);
                recorder.start(160);
            }

            // Wires up the backchannel (download stream) and initial configuration payloads (upload stream) for a new session.
            async _setupSession(initialSession = null) {
                try {
                    let session = initialSession;
                    if (!session) {
                        if (preSessionPromise) await preSessionPromise;
                        session = preSession || (await createSession());
                    }
                    preSession = null;

                    const { sid, gsessionid } = session;
                    let { ridCounter } = session;

                    const backchannelUrl =
                        `${getBaseUrl()}?` +
                        (gsessionid ? `gsessionid=${gsessionid}&` : "") +
                        `VER=8&RID=rpc&SID=${sid}&AID=0&CI=0&TYPE=xmlhttp&zx=${Date.now()}&t=1`;

                    const myGen = ++this._sessionGen;
                    this._activeBackchannelGen = myGen;
                    const myStartId = this._lastStartId;

                    this._dbg("open backchannel", { backend: ACTIVE_BACKEND.name, myGen, myStartId, sid });

                    this._lastMeaningfulFrameTs = Date.now();
                    this._noopFrameStreak = 0;

                    this._backchannelProxyId = _proxyReqCounter + 1;
                    _proxyFetchStream(backchannelUrl, {
                        method: "GET",
                        headers: { ...getHeaders(), "content-type": undefined },
                        referrer: getFetchOpts().referrer,
                        signal: this._abortController.signal
                    })
                        .then(async (bcRes) => {
                            if (myGen !== this._activeBackchannelGen || myStartId !== this._lastStartId) return;
                            await this._consumeBackchannel(bcRes, myGen, myStartId);
                        })
                        .catch((e) => {
                            if (myGen !== this._activeBackchannelGen || myStartId !== this._lastStartId) return;
                            if (e.name !== "AbortError") {
                                if (this.continuous && !this._stopRequested) {
                                    this._dbg("backchannel network error in continuous mode, soft-restarting", e.name, e.message);
                                    this._restartSession();
                                } else {
                                    this._handleError("network", e.message);
                                }
                            }
                        });

                    const configRid = ridCounter++;
                    const configUrl =
                        `${getBaseUrl()}?VER=8` +
                        (gsessionid ? `&gsessionid=${gsessionid}` : "") +
                        `&SID=${sid}&RID=${configRid}&AID=0&zx=${Date.now()}&t=1`;

                    if (ACTIVE_BACKEND.name === "v1") {
                        const assistConfig = {
                            config: {
                                dialogStateIn: { languageCode: this.lang },
                                deviceConfig: { deviceId: "example", deviceModelId: "example" },
                                audioInConfig: { encoding: "LINEAR16", sampleRateHertz: 16000 },
                                audioOutConfig: { encoding: "MP3", sampleRateHertz: 22050, volumePercentage: 0 },
                                requestType: 4
                            }
                        };
                        const configPayload = `count=1&ofs=0&req0___data__=${encodeURIComponent(JSON.stringify(assistConfig))}`;
                        _proxyFetch(configUrl, { method: "POST", headers: getHeaders(), body: configPayload, referrer: getFetchOpts().referrer });
                    } else {
                        const configProto = buildStreamingConfigProto(this.lang, this.interimResults);
                        const configB64 = uint8ToBase64(configProto);

                        this._dbg("config proto b64", configB64);
                        this._dbg("api key", getApiKey());
                        this._dbg("browser validation", browserValidation || "(none)");
                        this._dbg("session headers", JSON.stringify(Object.keys(getSessionHeaders())));
                        this._dbg("data headers", JSON.stringify(Object.keys(getHeaders())));

                        const configPayload = `count=1&ofs=0&req0___data__=${encodeURIComponent(configB64)}`;
                        _proxyFetch(configUrl, { method: "POST", headers: getHeaders(), body: configPayload, referrer: getFetchOpts().referrer });
                    }

                    this._currentSid = sid;
                    this._currentGsessionid = gsessionid;
                    this._currentRidCounter = ridCounter;
                    this._currentOfs = 1;

                    if (ACTIVE_BACKEND.name === "v2" && this._recorder && this._recorder.state === "paused") {
                        try { this._recorder.resume(); } catch { }
                    }

                    if (this._preSessionBuffer.length > 0) {
                        this._dbg("flushing pre-session buffer", { chunks: this._preSessionBuffer.length });
                        this._sendQueue.push(...this._preSessionBuffer);
                        this._preSessionBuffer = [];
                        if (!this._sendingChunks) this._drainChunkQueue();
                    }
                } catch (err) {
                    this._handleError("network", err.message);
                }
            }

            // Adds a base64 encoded audio chunk to the send queue and triggers draining if not already active.
            _enqueueChunk(audioBase64) {
                if (this._aborting || this._cleanupCalled) return;

                if (!this._currentSid) {
                    this._preSessionBuffer.push(audioBase64);
                    this._dbg("buffered pre-session chunk", { buffered: this._preSessionBuffer.length });
                    return;
                }

                this._sendQueue.push(audioBase64);
                if (!this._sendingChunks) this._drainChunkQueue();
            }

            // Sequentially uploads all queued audio chunks to the server via POST requests, handling retries and failures.
            async _drainChunkQueue() {
                if (this._sendingChunks) return;
                this._sendingChunks = true;

                try {
                    while (this._sendQueue.length && !this._aborting && !this._cleanupCalled && !this._switchingSession) {
                        if (!this._currentSid || !this._abortController) break;

                        if (
                            ACTIVE_BACKEND.name === "v2" &&
                            !this._isVadSpeaking &&
                            !this._pendingFinal &&
                            this._sendQueue.length > 2
                        ) {
                            this._sendQueue.length = 0;
                            break;
                        }

                        const audioBase64 = this._sendQueue.shift();

                        const chunkRid = this._currentRidCounter++;
                        const cSid = this._currentSid;
                        const cGsessionid = this._currentGsessionid;
                        const cOfs = this._currentOfs++;

                        const chunkUrl =
                            `${getBaseUrl()}?VER=8` +
                            (cGsessionid ? `&gsessionid=${cGsessionid}` : "") +
                            `&SID=${cSid}&RID=${chunkRid}&AID=0&zx=${Date.now()}&t=1`;

                        const chunkPayload = ACTIVE_BACKEND.name === "v1"
                            ? `count=1&ofs=${cOfs}&req0___data__=${encodeURIComponent(JSON.stringify({ audioIn: audioBase64 }))}`
                            : `count=1&ofs=${cOfs}&req0___data__=${encodeURIComponent(audioBase64)}`;

                        try {
                            const res = await _proxyFetch(chunkUrl, {
                                method: "POST",
                                headers: getHeaders(),
                                body: chunkPayload,
                                referrer: getFetchOpts().referrer,
                                signal: this._abortController.signal
                            });

                            if (!res.ok) {
                                this._consecutiveChunkFailures++;
                                if (DEV_MODE) console.warn("[polyfill] chunk non-ok:", res.status);

                                if (this._consecutiveChunkFailures >= this._maxConsecutiveChunkFailures) {
                                    if (DEV_MODE) console.warn("[polyfill] too many chunk failures, soft-restarting session");
                                    await this._restartSession();
                                    this._consecutiveChunkFailures = 0;
                                }
                            } else {
                                this._consecutiveChunkFailures = 0;
                            }
                        } catch (err) {
                            if (err.name === "AbortError") break;

                            this._consecutiveChunkFailures++;
                            if (DEV_MODE) console.warn("[polyfill] chunk send error:", err.message);

                            if (this._consecutiveChunkFailures >= this._maxConsecutiveChunkFailures) {
                                if (DEV_MODE) console.warn("[polyfill] too many chunk exceptions, soft-restarting session");
                                await this._restartSession();
                                this._consecutiveChunkFailures = 0;
                            }
                        }
                    }
                } finally {
                    this._sendingChunks = false;
                }
            }

            // Soft-restarts the recording session without resetting completely to zero. 
            // In Continuous mode, the Google backend will close the stream after a period of time. 
            // This function creates a new connection but seamlessly carries over any 
            // buffered audio chunks so the user doesn't experience "interrupted" dictation.
            // To debug you can call window._polyfillSR.restartSession() from the console mid or end of a speech segment.
            async _restartSession(overrideContinuous = false) {
                if (polyfillPermanentlyFailed) return;
                if ((!this.continuous && !overrideContinuous) || this._aborting || this._cleanupCalled) return;
                if (this._restartPromise) return this._restartPromise;

                this._dbg("restart requested", {
                    backend: ACTIVE_BACKEND.name,
                    switching: this._switchingSession,
                    hasRestartPromise: !!this._restartPromise,
                    bcDone: this._bcDone
                });

                this._restartPromise = (async () => {
                    if (this._abortController) this._abortController.abort();
                    if (this._backchannelProxyId) { _proxyAbort(this._backchannelProxyId); this._backchannelProxyId = null; }
                    this._abortController = new AbortController();
                    this._switchingSession = true;

                    // Finalize any pending text before wiping state so it doesn't get lost
                    if (this._latestInterimTranscript && this._norm(this._latestInterimTranscript) !== this._lastFinalTranscript) {
                        this._considerFinalCandidate(this._latestInterimTranscript, this._latestInterimStability ?? 0.99);
                        this._finalizeCurrentUtteranceOnce();
                    } else if (this._pendingFinal) {
                        this._finalizeCurrentUtteranceOnce();
                    }

                    this._bcDone = false;
                    this._speechendFired = false;
                    this._pendingFinal = false;
                    this._finalizedThisUtterance = false;
                    this._bestFinalCandidate = null;
                    this._bestFinalStability = -1;

                    this._lastEmittedInterimTranscript = null;
                    this._latestInterimTranscript = null;
                    this._latestInterimStability = null;
                    this._currentUtteranceId++;
                    this._lastEmittedUtteranceId = -1;

                    const carryOver = ACTIVE_BACKEND.name === "v2" ? [] : [...this._sendQueue, ...this._preSessionBuffer];
                    this._sendQueue = [];
                    this._sendingChunks = false;
                    this._consecutiveChunkFailures = 0;

                    this._vadSilenceFrames = 0;
                    this._isVadSpeaking = true;

                    this._currentSid = null;
                    this._currentGsessionid = null;

                    this._preSessionBuffer = [];

                    if (ACTIVE_BACKEND.name === "v2") {
                        if (this._oggHeader) {
                            const headerProto = buildAudioChunkProto(this._oggHeader);
                            this._preSessionBuffer.unshift(uint8ToBase64(headerProto));
                        }
                    } else {
                        this._preSessionBuffer.push(...carryOver);
                    }

                    this._dbg("queued carry-over for restart", {
                        backend: ACTIVE_BACKEND.name,
                        carriedChunks: carryOver.length,
                        totalBuffered: this._preSessionBuffer.length
                    });

                    try {
                        preSession = null;
                        preSessionPromise = null;
                        const session = await createSession();
                        if (!session) throw new Error("Failed to create session");

                        await this._setupSession(session);

                        this._lastMeaningfulFrameTs = Date.now();
                        this._noopFrameStreak = 0;
                        this._switchingSession = false;
                    } catch (err) {
                        this._switchingSession = false;
                        this._handleError("network", err.message);
                    }
                })().finally(() => {
                    this._restartPromise = null;
                });

                return this._restartPromise;
            }

            // Requests the speech recognition to stop listening. It waits for pending server results to finalize before fully shutting down.
            stop() {
                if (this._aborting || !this._sessionActive || this._stopRequested) return;
                this._dbg("stop() called");

                // Soft Stop: leave audio pipeline intact but disable session and VAD
                this._isVadSpeaking = false;
                this._stopRequested = true;

                // For continuous: false requests, if the server has signaled an End-Of-Utterance but we are 
                // waiting for the final text refinement, we MUST let the backchannel finish naturally instead of killing it.
                if (this._pendingFinal) {
                    this._dbg("stop(): Pending final result exists. Waiting for server refinement.");
                    return;
                }

                if (ACTIVE_BACKEND.name === "v2" && this._recorder && this._recorder.state === "recording") {
                    try { this._recorder.pause(); } catch { }
                }

                if (this._latestInterimTranscript && this._norm(this._latestInterimTranscript) !== this._lastFinalTranscript) {
                    this._considerFinalCandidate(this._latestInterimTranscript, this._latestInterimStability ?? 0.99);
                    this._finalizeCurrentUtteranceOnce();
                }

                if (this._abortController) this._abortController.abort();
                if (this._backchannelProxyId) { _proxyAbort(this._backchannelProxyId); this._backchannelProxyId = null; }
                if (!this.continuous && this._latestInterimTranscript) this._suppressEndOnce = true;
                this._cleanup("stop() called");
            }

            // Immediately aborts the speech recognition session without waiting for final results from the server.
            abort() {
                if (this._aborting || !this._sessionActive) return;
                this._aborting = true;
                if (this._abortController) this._abortController.abort();
                if (this._backchannelProxyId) { _proxyAbort(this._backchannelProxyId); this._backchannelProxyId = null; }
                this._cleanup("abort() called");
            }

            // add this helper on the prototype (near other public methods like stop/abort)
            async restartSession() {
                // restart only makes sense when a session is active
                if (!this._sessionActive) {
                    // if not started yet, just start
                    return this.start();
                }
                // restarts are only wired for continuous mode; enforce it
                this.continuous = true;

                // trigger the internal async restart
                return this._restartSession();
            }

            // Cleans up runtime state, resets variables, and emits end events after a session terminates.
            _cleanup(reason = "unknown") {
                if (!this._sessionActive) return;
                this._sessionActive = false;
                this._dbg("CLEANUP called, reason:", reason);

                this._dispatchEvent("audioend");
                window.postMessage({ type: 'GOOGLE_PROVIDER_UI_STOP' }, '*');
                if (!this._suppressEndOnce) this._dispatchEvent("end");
                else this._suppressEndOnce = false;

                this._aborting = false;
                this._switchingSession = false;
                this._bcDone = false;
                this._stopRequested = false;

                this._speechendFired = false;
                this._pendingFinal = false;
                this._finalizedThisUtterance = false;
                this._bestFinalCandidate = null;
                this._bestFinalStability = -1;

                this._latestInterimTranscript = null;
                this._latestInterimStability = null;
                this._lastEmittedInterimTranscript = null;
                this._lastFinalTranscript = null;

                this._currentUtteranceId = 0;
                this._lastEmittedUtteranceId = -1;

                this._bcBuffer = "";

                this._currentSid = null;
                this._currentGsessionid = null;
                this._currentRidCounter = 0;
                this._currentOfs = 1;

                this._preSessionBuffer = [];
                this._sendQueue = [];
                this._sendingChunks = false;
                this._consecutiveChunkFailures = 0;

                if (this._micIdleTimer) clearTimeout(this._micIdleTimer);
                this._micIdleTimer = setTimeout(() => this._cleanupMic(), MIC_IDLE_TIMEOUT_MS);
            }

            // Hard shutdown of all local hardware audio resources (Microphone tracks, AudioContext, MediaRecorder).
            _cleanupMic() {
                this._dbg("TEARDOWN MIC hardware");
                if (this._processor) {
                    try { this._processor.onaudioprocess = null; } catch { }
                    try { this._processor.disconnect(); } catch { }
                    this._processor = null;
                }

                if (this._recorder) {
                    try { if (this._recorder.state !== "inactive") this._recorder.stop(); } catch { }
                    this._recorder = null;
                }

                if (this._dummyAudio) {
                    try { this._dummyAudio.pause(); } catch { }
                    this._dummyAudio.srcObject = null;
                    this._dummyAudio = null;
                }

                if (this._stream) {
                    this._stream.getTracks().forEach((t) => t.stop());
                    this._stream = null;
                }

                if (this._gainNode) { try { this._gainNode.disconnect(); } catch { } this._gainNode = null; }
                if (this._destinationNode) { try { this._destinationNode.disconnect(); } catch { } this._destinationNode = null; }

                if (this._audioCtx && this._audioCtx.state !== "closed") {
                    try { this._audioCtx.close(); } catch { }
                }
                this._audioCtx = null;
                this._oggHeader = null;
            }

            // Packages transcript text into standard SpeechRecognitionResult objects and dispatches the 'result' event to the user.
            _emitResult(transcript, stability, isFinal) {
                // guard only duplicate finals
                if (isFinal && transcript && transcript === this._lastFinalTranscript) return;

                // strip punctuation on interim (v2 behavior)
                if (!isFinal && transcript) {
                    transcript = transcript.replace(/[.,?!;:¿¡]/g, "");
                }

                // prepend space for utterances after first final
                if (transcript && this._currentUtteranceId > 0 && this._finalResults.length > 0) {
                    transcript = " " + transcript;
                }

                this._dbg("emit", { transcript, isFinal, utt: this._currentUtteranceId });

                const confidence = isFinal ? Math.max(stability ?? 0, 0.9) : (stability ?? 0);
                const alt = new SpeechRecognitionAlternative(transcript, confidence);
                const res = new SpeechRecognitionResult([alt], isFinal);

                const currentResults = [];
                for (let i = 0; i < this._finalResults.length; i++) currentResults.push(this._finalResults[i]);
                if (transcript) currentResults.push(res);

                const event = new SpeechRecognitionEvent("result", {
                    resultIndex: this._finalResults.length,
                    results: new SpeechRecognitionResultList(currentResults)
                });

                this._dispatchEvent("result", event);

                if (isFinal && transcript) this._finalResults.push(res);
            }

            // Dispatches an error event and initiates cleanup of the current session.
            _handleError(errorType, message) {
                this._dbg(`handling error: [${errorType}]`, message);
                const ev = new SpeechRecognitionErrorEvent("error", { error: errorType, message });
                this._dispatchEvent("error", ev);
                this._cleanup(`error: ${errorType}`);
            }

            getDebugState() {
                return {
                    backend: ACTIVE_BACKEND.name,
                    sessionActive: this._sessionActive,
                    aborting: this._aborting,
                    stopRequested: this._stopRequested,
                    continuous: this.continuous,
                    vadSpeaking: this._isVadSpeaking,
                    preSessionBufferLength: this._preSessionBuffer?.length || 0,
                    sendQueueLength: this._sendQueue?.length || 0,
                    consecutiveChunkFailures: this._consecutiveChunkFailures || 0,
                    noopFrameStreak: this._noopFrameStreak || 0,
                    latestInterimTranscript: this._latestInterimTranscript,
                    lastFinalTranscript: this._lastFinalTranscript || ""
                };
            }
        }

        /**
         * Extended Polyfill Classes.
         */

        class SpeechRecognitionEvent extends Event {
            /**
             * Represents a SpeechRecognitionEvent containing the updated results list.
             */
            constructor(type, eventInitDict) {
                super(type, eventInitDict);
                this.resultIndex = eventInitDict?.resultIndex || 0;
                this.results = eventInitDict?.results || [];
                this.interpretation = eventInitDict?.interpretation || null;
                this.emma = eventInitDict?.emma || null;
            }
        }

        class SpeechRecognitionErrorEvent extends Event {
            /**
             * Represents a SpeechRecognitionErrorEvent containing error details.
             */
            constructor(type, eventInitDict) {
                super(type, eventInitDict);
                this.error = eventInitDict?.error || "unknown";
                this.message = eventInitDict?.message || "";
            }
        }

        class SpeechRecognitionAlternative {
            /**
             * Represents an alternative transcript and its confidence score.
             */
            constructor(transcript, confidence) {
                this.transcript = transcript;
                this.confidence = confidence;
            }
        }

        class SpeechRecognitionResult {
            /**
             * Represents a single recognition result containing an array of alternatives.
             */
            constructor(alternatives, isFinal) {
                this.isFinal = isFinal;
                this.length = alternatives.length;
                for (let i = 0; i < alternatives.length; i++) this[i] = alternatives[i];
            }
            item(index) {
                return this[index];
            }
        }

        class SpeechRecognitionResultList {
            /**
             * Represents the list of results accumulated during the session.
             */
            constructor(results) {
                this.length = results.length;
                for (let i = 0; i < results.length; i++) this[i] = results[i];
            }
            item(index) {
                return this[index];
            }
        }

        class SpeechGrammar {
            /**
             * Dummy implementation of SpeechGrammar for compatibility with certain sites.
             */
            constructor() {
                this.src = "";
                this.weight = 1;
            }
        }

        class SpeechGrammarList {
            /**
             * Dummy implementation of SpeechGrammarList to prevent standard sites from throwing missing object errors.
             */
            constructor() {
                this.length = 0;
            }
            addFromURI() { }
            addFromUri() { }
            addFromString() { }
            item() {
                return null;
            }
        }

        const globals = {
            SpeechRecognition: GoogleWebchannelSpeechRecognition,
            webkitSpeechRecognition: GoogleWebchannelSpeechRecognition,
            SpeechRecognitionEvent,
            webkitSpeechRecognitionEvent: SpeechRecognitionEvent,
            SpeechRecognitionErrorEvent,
            webkitSpeechRecognitionErrorEvent: SpeechRecognitionErrorEvent,
            SpeechGrammar,
            webkitSpeechGrammar: SpeechGrammar,
            SpeechGrammarList,
            webkitSpeechGrammarList: SpeechGrammarList
        };

        for (const [key, val] of Object.entries(globals)) {
            try {
                if (Object.getOwnPropertyDescriptor(W, key)?.configurable) {
                    delete W[key];
                }
            } catch { }

            try { Object.defineProperty(W, key, { get() { return val; }, set() { }, configurable: true, enumerable: true }); } catch (e) { try { W[key] = val; } catch (e2) {} }
        }

        if (DEV_MODE) {
            console.log(`💉 Speech Recognition Polyfill has been successfully injected! BACKEND=${ACTIVE_BACKEND.name}, DEV_MODE=${DEV_MODE}`);
        }
    })();

})();
