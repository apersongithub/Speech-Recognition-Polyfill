/**
 * Google Provider — Full-Duplex Speech Recognition (v1_old backend)
 *
 * Implements the Web Speech API (SpeechRecognition) using Google's legacy
 * full-duplex speech API with paired /up and /down HTTP requests.
 *
 * Audio chunks are streamed incrementally to the background script,
 * which manages a streaming POST to /up and reads results from /down
 * in real-time — matching the streaming behavior of v1/v2 backends.
 *
 * Message flow:
 *   Page → content.js → background.js:
 *     FULLDUPLEX_START  → opens /up POST (streaming) + /down GET
 *     FULLDUPLEX_AUDIO  → pushes audio chunk to /up stream
 *     FULLDUPLEX_END    → closes /up stream
 *
 *   Background.js → content.js → Page:
 *     FULLDUPLEX_RESULT → real-time result line from /down
 *     FULLDUPLEX_DONE   → /down stream completed
 *     FULLDUPLEX_ERROR  → error from /up or /down
 */
(function () {
    'use strict';

    window.__GP = window.__GP || {};

    const config = JSON.parse(document.documentElement.getAttribute('data-gp-config') || '{}');

    const API_KEY = 'AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw';
    const BASE_URL = 'https://www.google.com/speech-api/full-duplex/v1';
    const SAMPLE_RATE = 16000;
    const DEV_MODE = !!config.debugMode;

    function dbg(...args) {
        if (!DEV_MODE) return;
        try { console.log('[FullDuplex]', ...args); } catch { }
    }

    function generatePairToken() {
        return Math.floor(Math.random() * Math.pow(2, 32)).toString(16);
    }

    // =========================================================================
    // Web Speech API Types
    // =========================================================================

    class SpeechRecognitionEvent extends Event {
        constructor(type, eventInitDict) {
            super(type, eventInitDict);
            this.resultIndex = eventInitDict?.resultIndex || 0;
            this.results = eventInitDict?.results || [];
            this.interpretation = eventInitDict?.interpretation || null;
            this.emma = eventInitDict?.emma || null;
        }
    }

    class SpeechRecognitionErrorEvent extends Event {
        constructor(type, eventInitDict) {
            super(type, eventInitDict);
            this.error = eventInitDict?.error || "unknown";
            this.message = eventInitDict?.message || "";
        }
    }

    class SpeechRecognitionAlternative {
        constructor(transcript, confidence) {
            this.transcript = transcript;
            this.confidence = confidence;
        }
    }

    class SpeechRecognitionResult {
        constructor(alternatives, isFinal) {
            this.isFinal = isFinal;
            this.length = alternatives.length;
            for (let i = 0; i < alternatives.length; i++) this[i] = alternatives[i];
        }
        item(index) { return this[index]; }
    }

    class SpeechRecognitionResultList {
        constructor(results) {
            this.length = results.length;
            for (let i = 0; i < results.length; i++) this[i] = results[i];
        }
        item(index) { return this[index]; }
    }

    class SpeechGrammar {
        constructor() { this.src = ""; this.weight = 1; }
    }

    class SpeechGrammarList {
        constructor() { this.length = 0; }
        addFromURI() { }
        addFromUri() { }
        addFromString() { }
        item() { return null; }
    }

    // =========================================================================
    // Full-Duplex SpeechRecognition Implementation (Streaming)
    // =========================================================================

    const BaseClass = typeof EventTarget !== 'undefined' ? EventTarget : class {
        constructor() { this.listeners = {}; }
        addEventListener(type, cb) { (this.listeners[type] = this.listeners[type] || []).push(cb); }
        removeEventListener(type, cb) { if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter(x => x !== cb); }
        dispatchEvent(event) { (this.listeners[event.type] || []).forEach(cb => cb.call(this, event)); return !event.defaultPrevented; }
    };

    class FullDuplexSpeechRecognition extends BaseClass {
        constructor() {
            super();

            this.continuous = false;
            this.interimResults = false;
            this.lang = 'en-US';
            this.maxAlternatives = 1;
            this.serviceURI = '';
            this.grammars = new SpeechGrammarList();

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

            this._running = false;
            this._stream = null;
            this._audioCtx = null;
            this._processor = null;
            this._finalResults = [];
            this._pair = null;
            this._speechDetected = false;
            this._confirmedText = '';     // committed text from completed batches
            this._currentBatchText = '';  // interim text from current batch
        }

        _dispatchEvent(name, eventObj) {
            const ev = eventObj || new Event(name);
            if (typeof this['on' + name] === 'function') {
                try { this['on' + name](ev); } catch { }
            }
            try { this.dispatchEvent(ev); } catch { }
        }

        _processResultLine(line) {
            try {
                const json = JSON.parse(line);
                if (!json.result || json.result.length === 0) return;

                for (const result of json.result) {
                    if (!result.alternative || result.alternative.length === 0) continue;

                    let transcript = '';
                    let bestConfidence = 0;
                    for (const alt of result.alternative) {
                        if (alt.transcript) transcript += alt.transcript;
                        if (alt.confidence && alt.confidence > bestConfidence) bestConfidence = alt.confidence;
                    }

                    if (!transcript.trim()) continue;

                    // Clean up and merge overlap
                    const mergedText = this._mergeOverlap(this._confirmedText, transcript);
                    this._currentBatchText = mergedText.substring(this._confirmedText.length);

                    this._emitResult(mergedText, bestConfidence || 0.5, false);
                }
            } catch (e) {
                if (line.trim() && !line.startsWith('<')) {
                    dbg('Failed to parse result line:', line, e);
                }
            }
        }

        _mergeOverlap(confirmed, batch) {
            if (!confirmed.trim()) return batch;
            if (!batch.trim()) return confirmed;

            // 1. WORD-BASED FUZZY ANCHOR MATCHING
            // Google's overlap batches often hallucinate or drop words in the middle.
            // By extracting the exact *new* words from the batch array and appending them 
            // to the confirmed string, we strictly preserve already-finalized text while 
            // completely avoiding duplication.
            
            const confWordsRaw = confirmed.trim().split(/\s+/);
            const batchWordsRaw = batch.trim().split(/\s+/);
            
            const confWords = confWordsRaw.map(w => w.toLowerCase().replace(/[^\w\s-]/g, ''));
            const batchWords = batchWordsRaw.map(w => w.toLowerCase().replace(/[^\w\s-]/g, ''));

            const tailCount = Math.min(15, confWords.length);
            const headCount = Math.min(15, batchWords.length);
            
            const tail = confWords.slice(-tailCount);
            const head = batchWords.slice(0, headCount);

            let bestMatch = { confIdx: -1, batchIdx: -1, len: 0 };

            for (let i = 0; i < tail.length; i++) {
                for (let j = 0; j < head.length; j++) {
                    // Only anchor on substantial words (length > 2) to prevent false positives on "is", "a", "of"
                    if (tail[i].length <= 2) continue;
                    
                    let len = 0;
                    while (
                        i + len < tail.length && 
                        j + len < head.length && 
                        tail[i + len] === head[j + len]
                    ) {
                        len++;
                    }
                    // Prefer longer matches, or matches that are closer to the END of confirmed
                    if (len > bestMatch.len || (len === bestMatch.len && len > 0 && i > bestMatch.confIdx)) {
                        bestMatch = { confIdx: i, batchIdx: j, len: len };
                    }
                }
            }

            if (bestMatch.len > 0) {
                // The overlap in the batch ends at index: bestMatch.batchIdx + bestMatch.len
                const overlapEndBatchIdx = bestMatch.batchIdx + bestMatch.len;
                
                // If there are new words in the batch AFTER the overlap:
                if (overlapEndBatchIdx < batchWordsRaw.length) {
                    const newWords = batchWordsRaw.slice(overlapEndBatchIdx).join(' ');
                    // We simply append the new words to the strictly preserved confirmed text!
                    return confirmed.replace(/\s+$/, '') + ' ' + newWords;
                } else {
                    // The batch has no new words, it is entirely subsumed by confirmed!
                    return confirmed;
                }
            }

            // 2. CHARACTER-BASED EXACT MATCHING (Fallback for tiny words or punctuation)
            const normConf = confirmed.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
            const normBatch = batch.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

            const maxOverlap = Math.min(100, normConf.length, normBatch.length);
            let bestOverlap = 0;

            for (let i = maxOverlap; i >= 1; i--) {
                if (normConf.slice(-i) === normBatch.slice(0, i)) {
                    bestOverlap = i;
                    break;
                }
            }

            if (bestOverlap > 0) {
                let charsToSkip = bestOverlap;
                let splitIdxConf = confirmed.length;
                for (let i = confirmed.length - 1; i >= 0; i--) {
                    if (/[a-zA-Z0-9]/.test(confirmed[i])) {
                        charsToSkip--;
                    }
                    if (charsToSkip <= 0) {
                        splitIdxConf = i;
                        break;
                    }
                }
                
                const baseConfirmed = confirmed.substring(0, splitIdxConf);
                if (!baseConfirmed.trim()) return batch.trim();
                return baseConfirmed.replace(/\s+$/, '') + ' ' + batch.trim();
            }

            // No overlap found, append with a space
            return confirmed.replace(/\s+$/, '') + ' ' + batch.trim();
        }

        _commitBatch() {
            if (this._currentBatchText.trim()) {
                this._confirmedText += this._currentBatchText + ' ';
                this._currentBatchText = '';
                dbg('Batch committed, confirmed:', this._confirmedText.trim());
            }
        }

        _emitResult(text, confidence, isFinal) {
            // If interim, slice off the previously finalized text
            let emitText = text;
            if (!isFinal) {
                emitText = text.substring(this._finalizedCursor);
                if (!emitText.trim()) return; // Ignore empty interim updates
            }

            const alt = new SpeechRecognitionAlternative(emitText, confidence);
            const srResult = new SpeechRecognitionResult([alt], isFinal);
            this._finalResults[this._resultIndex] = srResult;

            const resultList = new SpeechRecognitionResultList([...this._finalResults]);
            const event = new SpeechRecognitionEvent('result', {
                resultIndex: this._resultIndex,
                results: resultList
            });
            this._dispatchEvent('result', event);

            // Artificial Utterance Boundary Detection (VAD)
            // If the server doesn't send any new interim transcripts for 1.5s, 
            // we assume the user paused speaking and we commit the sentence.
            if (!isFinal) {
                clearTimeout(this._silenceTimer);
                this._silenceTimer = setTimeout(() => {
                    this._finalizeUtterance();
                }, 1500);
            }
        }

        _finalizeUtterance() {
            clearTimeout(this._silenceTimer);
            
            // Note: We deliberately do NOT call _commitBatch() here because artificially 
            // committing incomplete words forces a trailing space, which corrupts the overlap merge.
            const fullText = this._confirmedText + this._currentBatchText;
            const newText = fullText.substring(this._finalizedCursor);
            if (!newText.trim()) return;

            // Emit the sliced new string as a FINAL result
            this._emitResult(newText, 0.9, true);
            dbg('Utterance finalized:', newText);
            
            // Advance the index and cursor
            this._resultIndex++;
            this._finalizedCursor = fullText.length;

            // Natively support continuous = false (e.g., MDN Color Changer)
            if (!this.continuous) {
                this.stop();
            }
        }

        async start() {
            if (this._running) return;
            this._running = true;
            this._resultIndex = 0;
            this._finalizedCursor = 0;
            this._silenceTimer = null;
            this._finalResults = [];
            this._speechDetected = false;
            this._confirmedText = '';
            this._currentBatchText = '';

            try {
                this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                this._audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
                if (this._audioCtx.state === 'suspended') {
                    await this._audioCtx.resume();
                }
                const source = this._audioCtx.createMediaStreamSource(this._stream);

                this._processor = this._audioCtx.createScriptProcessor(4096, 1, 1);

                // Generate pair token and build URLs
                this._pair = generatePairToken();
                const lang = (this.lang || 'en-US').replace('_', '-').toLowerCase();

                const upParams = new URLSearchParams({
                    output: 'json', lang, pfilter: '2', key: API_KEY,
                    client: 'chromium', maxAlternatives: '1', pair: this._pair
                });
                const upUrl = `${BASE_URL}/up?${upParams.toString()}&continuous&interim`;
                const downParams = new URLSearchParams({ pair: this._pair });
                const downUrl = `${BASE_URL}/down?${downParams.toString()}`;

                // Listen for streaming results from background.js
                this._resultListener = (event) => {
                    if (!event.data || event.data.pair !== this._pair) return;

                    if (event.data.type === 'FULLDUPLEX_RESULT') {
                        this._processResultLine(event.data.line);
                    } else if (event.data.type === 'FULLDUPLEX_BATCH_DONE') {
                        this._commitBatch();
                    } else if (event.data.type === 'FULLDUPLEX_ERROR') {
                        dbg('Stream error:', event.data.error);
                        this._dispatchEvent('error', new SpeechRecognitionErrorEvent('error', {
                            error: 'network', message: event.data.error
                        }));
                    } else if (event.data.type === 'FULLDUPLEX_DONE') {
                        this._finalizeUtterance();

                        if (this._speechDetected) {
                            this._dispatchEvent('speechend');
                            this._dispatchEvent('soundend');
                        }
                        this._dispatchEvent('audioend');
                        this._cleanup();
                    }
                };
                window.addEventListener('message', this._resultListener);

                // Tell background.js to start the session
                window.postMessage({
                    type: 'FULLDUPLEX_START',
                    pair: this._pair,
                    lang: lang,
                    upUrl, downUrl,
                    contentType: `audio/l16; rate=${SAMPLE_RATE}`
                }, '*');

                // Stream audio chunks as they are captured
                this._processor.onaudioprocess = (e) => {
                    if (!this._running) return;
                    const input = e.inputBuffer.getChannelData(0);

                    // Convert Float32 to Int16 PCM
                    // Convert Float32 to Int16 PCM with dynamic Mic Gain
                    const pcm16 = new Int16Array(input.length);
                    const gainMultiplier = window.__googleProviderConfig?.micGainMultiplier || 1.0;
                    for (let i = 0; i < input.length; i++) {
                        const s = Math.max(-1, Math.min(1, input[i] * gainMultiplier));
                        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                    }

                    // Send chunk to background.js immediately
                    window.postMessage({
                        type: 'FULLDUPLEX_AUDIO',
                        pair: this._pair,
                        chunk: Array.from(new Uint8Array(pcm16.buffer))
                    }, '*');

                    // Simple VAD for soundstart/speechstart events
                    if (!this._speechDetected) {
                        for (let i = 0; i < input.length; i++) {
                            if (Math.abs(input[i]) > 0.01) {
                                this._speechDetected = true;
                                this._dispatchEvent('soundstart');
                                this._dispatchEvent('speechstart');
                                break;
                            }
                        }
                    }
                };

                source.connect(this._processor);
                this._processor.connect(this._audioCtx.destination);

                this._dispatchEvent('start');
                this._dispatchEvent('audiostart');

                dbg('Streaming started, pair:', this._pair);

            } catch (err) {
                dbg('Error:', err);
                this._dispatchEvent('error', new SpeechRecognitionErrorEvent('error', {
                    error: err.name === 'NotAllowedError' ? 'not-allowed' : 'network',
                    message: err.message
                }));
                this._cleanup();
            }
        }

        stop() {
            if (!this._running) return;
            this._running = false;

            // Stop mic capture
            if (this._processor) {
                try { this._processor.disconnect(); } catch { }
                this._processor = null;
            }

            // Tell background.js to close the /up stream
            if (this._pair) {
                window.postMessage({
                    type: 'FULLDUPLEX_END',
                    pair: this._pair
                }, '*');
            }

            // Don't cleanup yet — wait for FULLDUPLEX_DONE from /down
            // Set a safety timeout in case /down never completes
            setTimeout(() => {
                if (!this._running && this._pair) {
                    dbg('Safety cleanup timeout');
                    this._cleanup();
                }
            }, 5000);
        }

        abort() {
            this._running = false;
            if (this._pair) {
                window.postMessage({ type: 'FULLDUPLEX_END', pair: this._pair }, '*');
            }
            this._cleanup();
        }

        _cleanup() {
            this._running = false;
            if (this._resultListener) {
                window.removeEventListener('message', this._resultListener);
                this._resultListener = null;
            }
            if (this._processor) {
                try { this._processor.disconnect(); } catch { }
                this._processor = null;
            }
            if (this._audioCtx) {
                try { this._audioCtx.close(); } catch { }
                this._audioCtx = null;
            }
            if (this._stream) {
                this._stream.getTracks().forEach(t => t.stop());
                this._stream = null;
            }
            this._pair = null;
            this._dispatchEvent('end');
        }
    }

    // =========================================================================
    // Global Registration
    // =========================================================================

    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    const globals = {
        SpeechRecognition: FullDuplexSpeechRecognition,
        webkitSpeechRecognition: FullDuplexSpeechRecognition,
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

        try {
            Object.defineProperty(W, key, {
                get() { return val; },
                set() { },
                configurable: true,
                enumerable: true
            });
        } catch (e) {
            try { W[key] = val; } catch (e2) {
                console.warn(`[FullDuplex] Failed to polyfill ${key}:`, e2);
            }
        }
    }

    dbg('Full-Duplex Speech Recognition (v1_old) injected — streaming mode');
})();
