/**
 * Fixed-size circular buffer for PCM audio samples.
 * Uses global frame offsets for absolute addressing.
 */
export class RingBuffer {
    constructor(sampleRate, durationSeconds) {
        this.sampleRate = sampleRate;
        this.maxFrames = Math.floor(sampleRate * durationSeconds);
        this.buffer = new Float32Array(this.maxFrames);
        this.currentFrame = 0; // The next frame to be written (global)
    }

    /**
     * Append PCM frames to the buffer.
     */
    write(chunk) {
        let chunkLength = chunk.length;
        let dataToWrite = chunk;

        // If chunk is larger than buffer (unlikely but handle it), only take the end
        if (chunkLength > this.maxFrames) {
            const start = chunkLength - this.maxFrames;
            dataToWrite = chunk.subarray(start);
            // Advance frame counter for the skipped part
            this.currentFrame += start;
            // Now we only write maxFrames
            chunkLength = this.maxFrames;
        }

        const writePos = this.currentFrame % this.maxFrames;
        const remainingSpace = this.maxFrames - writePos;

        if (chunkLength <= remainingSpace) {
            // Single operation
            this.buffer.set(dataToWrite, writePos);
        } else {
            // Wrap around
            this.buffer.set(dataToWrite.subarray(0, remainingSpace), writePos);
            this.buffer.set(dataToWrite.subarray(remainingSpace), 0);
        }

        this.currentFrame += chunkLength;
    }

    /**
     * Read PCM frames between absolute frame indices.
     */
    read(startFrame, endFrame) {
        if (startFrame >= endFrame) {
            return new Float32Array(0);
        }

        const baseFrame = this.getBaseFrameOffset();
        
        // Clamp to available range
        let actualStart = Math.max(startFrame, baseFrame);
        let actualEnd = Math.min(endFrame, this.currentFrame);
        
        const readLength = actualEnd - actualStart;
        if (readLength <= 0) {
            return new Float32Array(0);
        }

        const out = new Float32Array(readLength);
        const startPos = actualStart % this.maxFrames;
        const remainingSpace = this.maxFrames - startPos;

        if (readLength <= remainingSpace) {
            // Contiguous read
            out.set(this.buffer.subarray(startPos, startPos + readLength));
        } else {
            // Wrap around read
            out.set(this.buffer.subarray(startPos, this.maxFrames), 0);
            out.set(this.buffer.subarray(0, readLength - remainingSpace), remainingSpace);
        }

        return out;
    }

    /**
     * Get the global frame offset of the oldest available sample.
     */
    getBaseFrameOffset() {
        return Math.max(0, this.currentFrame - this.maxFrames);
    }

    /**
     * Get the global frame offset of the next sample to be written.
     */
    getCurrentFrame() {
        return this.currentFrame;
    }

    /**
     * Get the current buffer time head in seconds.
     */
    getCurrentTime() {
        return this.currentFrame / this.sampleRate;
    }

    /**
     * Reset the buffer to initial state.
     */
    reset() {
        this.currentFrame = 0;
        this.buffer.fill(0);
    }
}
