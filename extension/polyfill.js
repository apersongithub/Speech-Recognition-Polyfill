(function () {
  if (window.__googleProviderConfig) return; // Google provider uses its own polyfill engine
  console.log(" >>> GTranslate Polyfill: Initializing...");

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
      this._pendingEnd = false;
      this._endTimer = null;
      this._ended = false;

      window.addEventListener("message", (e) => {
        if (e.data && e.data.type === 'WHISPER_CONFIG') {
          this._disableSpaceNormalization = !!e.data.disableSpaceNormalization;
          this._streamingActive = !!e.data.streamingActive;
        }

        if (e.data && e.data.type === 'WHISPER_RESULT_TO_PAGE') {
          if (e.data.stopFinal === true) {
            if (e.data.ackId) window.postMessage({ type: 'WHISPER_PAGE_HANDLED', ackId: e.data.ackId }, "*");
            this._pendingEnd = false;
            if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
            this._interimActive = false;
            this._ended = true;
            if (this.onend) this.onend();
            this.isRecording = false;
            return;
          }

          if (!this.onresult) return;
          if (this._ended) return;

          const isFinal = e.data.isFinal !== false;
          const isCommit = e.data.commit === true;
          const isResultFinal = isFinal || isCommit;
          if (!isFinal && !isCommit && !this.interimResults) {
            if (e.data.ackId) window.postMessage({ type: 'WHISPER_PAGE_HANDLED', ackId: e.data.ackId }, "*");
            return;
          }

          const rawText = e.data.text || '';
          const prevIndex = this._interimActive ? (this._results.length - 2) : (this._results.length - 1);
          const prev = (prevIndex >= 0 && this._results[prevIndex]) ? this._results[prevIndex].transcript : '';
          const needsSpace = !this._disableSpaceNormalization && !!prev &&
            !/[\s\(\[\{'"“‘]$/.test(prev) &&
            !/^[\s\.,!?;:\)\]\}'"”’]/.test(rawText);

          const text = needsSpace ? (' ' + rawText) : rawText;

          const resultObj = { transcript: text, confidence: 0.98, isFinal: isResultFinal };

          if (isResultFinal) {
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

          resultEvent.results[resultEvent.resultIndex].isFinal = isResultFinal;
          if (this.onresult) this.onresult(resultEvent);
          window.postMessage({ type: 'WHISPER_PAGE_HANDLED', ackId: e.data.ackId }, "*");

          if (isFinal) {
            if (!e.data.streaming) {
              this._ended = true;
              if (this.onend) this.onend();
              this.isRecording = false;
            } else if (this._pendingEnd) {
              this._pendingEnd = false;
              if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
              this._ended = true;
              if (this.onend) this.onend();
              this.isRecording = false;
            }
          }
        }

        if (e.data && e.data.type === 'WHISPER_AUDIO_START') {
          if (this.onaudiostart) this.onaudiostart();
          this.dispatchEvent(new Event('audiostart'));
          if (this.onsoundstart) this.onsoundstart();
          this.dispatchEvent(new Event('soundstart'));
        }

        if (e.data && e.data.type === 'WHISPER_AUDIO_END') {
          if (this.onaudioend) this.onaudioend();
          this.dispatchEvent(new Event('audioend'));
          if (this.onsoundend) this.onsoundend();
          this.dispatchEvent(new Event('soundend'));
        }

        if (e.data && e.data.type === 'WHISPER_SPEECH_START') {
          if (this.onspeechstart) this.onspeechstart();
          this.dispatchEvent(new Event('speechstart'));
        }

        if (e.data && e.data.type === 'WHISPER_SPEECH_END') {
          if (this.onspeechend) this.onspeechend();
          this.dispatchEvent(new Event('speechend'));
        }

        if (e.data && e.data.type === 'WHISPER_FORCE_END') {
          if (this._streamingActive && !this._pendingEnd) {
            this._pendingEnd = true;
            this._endTimer = setTimeout(() => {
              if (this._pendingEnd) {
                this._pendingEnd = false;
                this._ended = true;
                if (this.onend) this.onend();
                this.isRecording = false;
              }
            }, 5000);
          } else if (!this._streamingActive) {
            this._ended = true;
            if (this.onend) this.onend();
            this.isRecording = false;
          }
        }
      });
    }

    start() {
      if (this.isRecording || this._pendingEnd) {
        if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
        this._pendingEnd = false;
        this._ended = true;
        if (this.onend) this.onend();
        this.isRecording = false;

        if (!this._streamingActive) return;
      }
      this.isRecording = true;
      this._pendingEnd = false;
      this._ended = false;
      if (this.onstart) this.onstart();
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

      if (this._streamingActive) {
        this._pendingEnd = true;
        this._endTimer = setTimeout(() => {
          if (this._pendingEnd) {
            this._pendingEnd = false;
            this._ended = true;
            if (this.onend) this.onend();
          }
        }, 5000);
      } else {
        this._ended = true;
        if (this.onend) this.onend();
      }
    }

    abort() {
      this.isRecording = false;
      this._pendingEnd = false;
      if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
      window.postMessage({ type: 'WHISPER_ABORT_RECORDING' }, "*");
      this.dispatchEvent(new Event('audioend'));
      this.dispatchEvent(new Event('soundend'));
      this._ended = true;
      if (this.onend) this.onend();
    }

    dispatchEvent(event) { if (this["on" + event.type]) this["on" + event.type](event); }
    addEventListener(type, callback) { this["on" + type] = callback; }
  };

  window.SpeechRecognition = window.webkitSpeechRecognition;
  window.SpeechRecognitionEvent = window.webkitSpeechRecognitionEvent;

})();
