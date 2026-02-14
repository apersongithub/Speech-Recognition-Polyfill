(function () {
  console.log(" >>> GTranslate Polyfill: Initializing...");

  const isDocsOrSlides = /(^|\.)docs\.google\.com$|(^|\.)slides\.google\.com$/i.test(location.hostname);

  try {
    if (!isDocsOrSlides) {
      const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
      Object.defineProperty(navigator, 'userAgent', { get: () => CHROME_UA });
      Object.defineProperty(navigator, 'vendor', { get: () => "Google Inc." });
      if (!navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', {
          get: () => ({ brands: [{ brand: "Chromium", version: "120" }], mobile: false, platform: "Windows" })
        });
      }
    }
  } catch (e) { }

  if (window.webkitSpeechRecognition) return;

  window.webkitSpeechRecognitionEvent = class SpeechRecognitionEvent extends Event {
    constructor(type, options) {
      super(type, options);
      this.results = options ? options.results : [];
      this.resultIndex = options ? options.resultIndex : 0;
    }
  };

  window.webkitSpeechRecognition = class SpeechRecognition {
    constructor() {
      this.continuous = false;
      this.interimResults = false;
      this.lang = 'en-US';
      this.onresult = null;
      this.onend = null;
      this.onstart = null;
      this.onaudiostart = null;
      this.onaudioend = null;
      this.onspeechstart = null;
      this.onspeechend = null;
      this.onsoundstart = null;
      this.onsoundend = null;
      this.isRecording = false;

      this._results = [];
      this._interimActive = false;
      this._disableSpaceNormalization = false;
      this._streamingActive = false;

      window.addEventListener("message", (e) => {
        if (e.data && e.data.type === 'WHISPER_CONFIG') {
          this._disableSpaceNormalization = !!e.data.disableSpaceNormalization;
          this._streamingActive = !!e.data.streamingActive;
        }

        if (e.data && e.data.type === 'WHISPER_RESULT_TO_PAGE') {
          if (!this.onresult) return;

          const isFinal = e.data.isFinal !== false;

          const rawText = e.data.text || '';
          const prevIndex = this._interimActive ? (this._results.length - 2) : (this._results.length - 1);
          const prev = (prevIndex >= 0 && this._results[prevIndex]) ? this._results[prevIndex].transcript : '';
          const needsSpace = !this._disableSpaceNormalization && !!prev &&
            !/[\\s\\(\\[\\{'"“‘]$/.test(prev) &&
            !/^[\\s\\.,!?;:\\)\\]\\}'"”’]/.test(rawText);

          const text = needsSpace ? (' ' + rawText) : rawText;

          const resultObj = { transcript: text, confidence: 0.98, isFinal };

          if (isFinal) {
            if (this._interimActive) {
              this._results[this._results.length - 1] = resultObj;
            } else {
              this._results.push(resultObj);
            }
            this._interimActive = false;
          } else {
            if (this._interimActive) {
              this._results[this._results.length - 1] = resultObj;
            } else {
              this._results.push(resultObj);
            }
            this._interimActive = true;
          }

          const resultsList = this._results.map(r => {
            const arr = [r];
            arr.isFinal = r.isFinal;
            return arr;
          });

          const resultEvent = new window.webkitSpeechRecognitionEvent('result', {
            results: resultsList,
            resultIndex: resultsList.length - 1
          });

          resultEvent.results[resultEvent.resultIndex].isFinal = isFinal;
          this.onresult?.(resultEvent);

          if (isFinal) {
            if (!e.data.streaming) {
              this.onend?.();
              this.isRecording = false;
              window.postMessage({ type: 'WHISPER_PAGE_HANDLED' }, "*");
            } else {
              window.postMessage({ type: 'WHISPER_PAGE_HANDLED' }, "*");
            }
          }
        }

        if (e.data && e.data.type === 'WHISPER_AUDIO_START') {
          this.onaudiostart?.();
          this.dispatchEvent(new Event('audiostart'));
          this.onsoundstart?.();
          this.dispatchEvent(new Event('soundstart'));
        }

        if (e.data && e.data.type === 'WHISPER_AUDIO_END') {
          this.onaudioend?.();
          this.dispatchEvent(new Event('audioend'));
          this.onsoundend?.();
          this.dispatchEvent(new Event('soundend'));
        }

        if (e.data && e.data.type === 'WHISPER_SPEECH_START') {
          this.onspeechstart?.();
          this.dispatchEvent(new Event('speechstart'));
        }

        if (e.data && e.data.type === 'WHISPER_SPEECH_END') {
          this.onspeechend?.();
          this.dispatchEvent(new Event('speechend'));
        }

        if (e.data && e.data.type === 'WHISPER_FORCE_END') {
          this.onend?.();
          this.isRecording = false;
        }
      });
    }

    start() {
      if (this.isRecording) {
        if (this._streamingActive) {
          this.isRecording = false; // allow restart during streaming sessions
        } else {
          return;
        }
      }
      this.isRecording = true;
      this.onstart?.();
      this._results = [];
      this._interimActive = false;

      this.dispatchEvent(new Event('audiostart'));
      this.dispatchEvent(new Event('soundstart'));

      let requestedLang = this.lang || 'en';
      if (requestedLang.includes('-')) requestedLang = requestedLang.split('-')[0];

      window.postMessage({
        type: 'WHISPER_START_RECORDING',
        language: requestedLang
      }, "*");
    }

    stop() {
      if (!this.isRecording) return;
      this.isRecording = false;
      window.postMessage({ type: 'WHISPER_STOP_RECORDING' }, "*");
      this.dispatchEvent(new Event('audioend'));
      this.dispatchEvent(new Event('soundend'));
      this.onend?.();
    }

    abort() {
      this.isRecording = false;
      window.postMessage({ type: 'WHISPER_ABORT_RECORDING' }, "*");
      this.dispatchEvent(new Event('audioend'));
      this.dispatchEvent(new Event('soundend'));
      this.onend?.();
    }

    dispatchEvent(event) { if (this["on" + event.type]) this["on" + event.type](event); }
    addEventListener(type, callback) { this["on" + type] = callback; }
  };

  window.SpeechRecognition = window.webkitSpeechRecognition;
  window.SpeechRecognitionEvent = window.webkitSpeechRecognitionEvent;

})();