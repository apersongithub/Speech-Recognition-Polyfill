/**
 * UtteranceBasedMerger
 * 
 * Separates "mature" (finalized) text from "immature" (in-progress) text.
 * Uses punctuation to detect mature sentence boundaries.
 */
export class UtteranceBasedMerger {
    constructor() {
        this.committedText = '';
        this.currentWindowText = '';
    }

    process(text) {
        if (!text) {
            this.currentWindowText = '';
            return;
        }

        // The text received here is the full transcription of the current audio window.
        // We keep it as immature (isFinal=false) until VAD detects silence, at which
        // point the worker will call commitCurrentWindow().
        this.currentWindowText = text.trim();
    }

    commitCurrentWindow() {
        if (this.currentWindowText) {
            if (this.committedText) {
                this.committedText += ' ' + this.currentWindowText;
            } else {
                this.committedText = this.currentWindowText;
            }
        }
        this.currentWindowText = '';
    }

    forceFinalize() {
        this.commitCurrentWindow();
    }

    getMature() {
        // Only return text that has been permanently committed.
        // This guarantees append-only behavior, preventing background.js
        // diffing logic from corrupting the text or causing duplication.
        return this.committedText;
    }

    getImmature() {
        return this.currentWindowText;
    }

    reset() {
        this.committedText = '';
        this.currentWindowText = '';
    }
}
