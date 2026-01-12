(function() {
  console.log(" >>> GTranslate Polyfill: Initializing...");

  try {
    const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    Object.defineProperty(navigator, 'userAgent', { get: () => CHROME_UA });
    Object.defineProperty(navigator, 'vendor', { get: () => "Google Inc." });
    if (!navigator.userAgentData) {
        Object.defineProperty(navigator, 'userAgentData', {
            get: () => ({ brands: [{ brand: "Chromium", version: "120" }], mobile: false, platform: "Windows" })
        });
    }
  } catch(e) {}

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
      this.isRecording = false;
      
      window.addEventListener("message", (e) => {
        if (e.data && e.data.type === 'WHISPER_RESULT_TO_PAGE') {
             if (!this.onresult) return;
             const resultEvent = new window.webkitSpeechRecognitionEvent('result', {
                results: [[ { transcript: e.data.text, confidence: 0.98, isFinal: true } ]],
                resultIndex: 0
             });
             resultEvent.results[0].isFinal = true;

             this.onresult?.(resultEvent);
             this.onend?.();
             this.isRecording = false;

             // Ack to content script to mark processing done
             window.postMessage({ type: 'WHISPER_PAGE_HANDLED' }, "*");
        }
      });
    }

    start() {
      if (this.isRecording) return;
      this.isRecording = true;
      this.onstart?.();
      
      this.dispatchEvent(new Event('audiostart'));

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
      this.onend?.();
    }
    
    abort() {
      // Always signal cancel, even if isRecording is already false (late aborts from page)
      this.isRecording = false;
      window.postMessage({ type: 'WHISPER_ABORT_RECORDING' }, "*");
      this.dispatchEvent(new Event('audioend'));
      this.onend?.();
    }

    dispatchEvent(event) { if (this["on" + event.type]) this["on" + event.type](event); }
    addEventListener(type, callback) { this["on" + type] = callback; }
  };
})();