/**
 * AudioSegmentProcessor - Sophisticated VAD with speech onset detection
 * Ported from Keet to plain JavaScript
 */
export class AudioSegmentProcessor {
    constructor(options = {}) {
        const sampleRate = options.sampleRate ?? 16000;
        const windowDuration = 0.080;
        const windowSize = Math.round(windowDuration * sampleRate);

        this.options = {
            sampleRate,
            minSpeechDuration: 0.240,
            silenceThreshold: 0.4,
            energyThreshold: 0.08,
            smaLength: 6,
            lookbackChunks: 3,
            overlapDuration: 0.080,
            lookbackDuration: 0.120,
            maxHistoryLength: 20,
            noiseFloorAdaptationRate: 0.05,
            fastAdaptationRate: 0.15,
            snrThreshold: 3.0,
            minBackgroundDuration: 1.0,
            minSnrThreshold: 1.0,
            energyRiseThreshold: 0.08,
            maxSegmentDuration: 4.8,
            maxSilenceWithinSpeech: 0.160,
            endingSpeechTolerance: 0.240,
            logger: () => {}, // Disable logging by default
            ...options,
            windowSize: Math.round(windowDuration * (options.sampleRate ?? sampleRate))
        };

        this.reset();
    }

    log(message, data) {
        if (typeof this.options.logger === 'function') {
            this.options.logger(`[AudioSegmentProcessor] ${message}`, data);
        }
    }

    addSpeechEnergy(energy) {
        this.state.speechEnergySum += energy;
        this.state.speechEnergyCount++;
    }

    processAudioData(chunk, currentTime, energy) {
        if (!chunk || !chunk.length) return [];

        const segments = [];
        const isSpeech = energy > this.options.energyThreshold;

        if (!isSpeech) {
            const chunkDurationSec = chunk.length / this.options.sampleRate;
            this.state.silenceDuration += chunkDurationSec;
        } else {
            this.state.silenceDuration = 0;
        }

        this.updateNoiseFloor(energy, isSpeech);
        const snr = this.calculateSNR(energy);

        this.state.recentChunks.push({
            time: currentTime,
            energy,
            isSpeech,
            snr
        });

        if (this.state.recentChunks.length > this.options.maxHistoryLength * 10) {
            this.state.recentChunks.shift();
        }

        // Proactive Segment Splitting
        if (this.state.inSpeech && this.state.speechStartTime !== null) {
            const currentSpeechDuration = currentTime - this.state.speechStartTime;
            if (currentSpeechDuration > this.options.maxSegmentDuration) {
                const segment = this.createSegment(this.state.speechStartTime, currentTime);
                if (segment) segments.push(segment);
                this.startSpeech(currentTime, energy);
            }
        }

        // Speech State Machine
        if (!this.state.inSpeech && isSpeech) {
            // Transition: Silence -> Speech
            const realStartIndex = this.findSpeechStart();
            const realStartTime = realStartIndex !== -1
                ? this.state.recentChunks[realStartIndex].time
                : currentTime;

            this.startSpeech(realStartTime, energy);
        } else if (this.state.inSpeech && !isSpeech) {
            // Transition: Speech -> potentially Silence
            this.state.silenceCounter++;

            const chunksNeeded = Math.ceil(this.options.silenceThreshold / (this.options.windowSize / this.options.sampleRate));
            const silenceDuration = this.state.silenceCounter * (this.options.windowSize / this.options.sampleRate);
            const isConfirmedSilence = this.state.silenceCounter >= chunksNeeded;

            if (silenceDuration < this.options.maxSilenceWithinSpeech) {
                this.addSpeechEnergy(energy);
            } else if (isConfirmedSilence) {
                if (this.state.speechStartTime !== null) {
                    const speechDuration = currentTime - this.state.speechStartTime;
                    const avgEnergy = this.state.speechEnergyCount > 0
                        ? this.state.speechEnergySum / this.state.speechEnergyCount
                        : 0;

                    this.recordSpeechStat({
                        startTime: this.state.speechStartTime,
                        endTime: currentTime,
                        duration: speechDuration,
                        avgEnergy,
                        energyIntegral: avgEnergy * speechDuration
                    });
                }

                const segment = this.createSegment(this.state.speechStartTime, currentTime);
                if (segment) segments.push(segment);

                this.startSilence(currentTime);
            }
        } else {
            if (this.state.inSpeech) {
                this.addSpeechEnergy(energy);
            }
        }

        this.updateStats();
        return segments;
    }

    updateNoiseFloor(energy, isSpeech) {
        if (!isSpeech) {
            let adaptationRate = this.options.noiseFloorAdaptationRate;

            if (this.state.silenceDuration < this.options.minBackgroundDuration) {
                const blendFactor = Math.min(1, this.state.silenceDuration / this.options.minBackgroundDuration);
                adaptationRate = this.options.fastAdaptationRate * (1 - blendFactor) +
                    this.options.noiseFloorAdaptationRate * blendFactor;
            }

            this.state.noiseFloor = this.state.noiseFloor * (1 - adaptationRate) + energy * adaptationRate;
            this.state.noiseFloor = Math.max(0.00001, this.state.noiseFloor);
        }

        this.state.recentEnergies.push(energy);
        if (this.state.recentEnergies.length > 50) {
            this.state.recentEnergies.shift();
        }
    }

    calculateSNR(energy) {
        const noiseFloor = Math.max(0.0001, this.state.noiseFloor);
        return 10 * Math.log10(energy / noiseFloor);
    }

    startSpeech(time, energy) {
        this.state.inSpeech = true;
        this.state.speechStartTime = time;
        this.state.silenceCounter = 0;
        this.state.speechEnergySum = energy;
        this.state.speechEnergyCount = 1;
        this.state.silenceStartTime = null;
        this.state.silenceDuration = 0;
    }

    startSilence(time) {
        this.state.inSpeech = false;
        this.state.silenceStartTime = time;
        this.state.speechStartTime = null;
        this.state.silenceCounter = 0;
        this.state.speechEnergySum = 0;
        this.state.speechEnergyCount = 0;
        this.state.silenceDuration = 0.001;
    }

    findSpeechStart() {
        const chunks = this.state.recentChunks;
        const minSnrThreshold = this.options.minSnrThreshold;

        let firstSpeechIndex = 0;
        for (let i = chunks.length - 1; i >= 0; i--) {
            if (chunks[i].isSpeech) {
                firstSpeechIndex = i;
                break;
            }
        }

        let earliestRisingIndex = firstSpeechIndex;
        let foundRisingTrend = false;

        for (let i = firstSpeechIndex - 1; i >= 0; i--) {
            if (i < chunks.length - 1 &&
                chunks[i + 1].energy > chunks[i].energy * (1 + this.options.energyRiseThreshold)) {
                earliestRisingIndex = i;
                foundRisingTrend = true;
            }

            if (chunks[i].snr < minSnrThreshold / 2) break;
            if (firstSpeechIndex - i > 6) break;
        }

        if (foundRisingTrend) return earliestRisingIndex;

        for (let i = firstSpeechIndex; i >= 0; i--) {
            if (chunks[i].snr < minSnrThreshold) {
                return Math.min(chunks.length - 1, i + 1);
            }
        }

        return Math.max(0, firstSpeechIndex - 4);
    }

    createSegment(startTime, endTime) {
        const duration = endTime - startTime;
        if (duration <= 0) return null;
        return { startTime, endTime, duration };
    }

    updateStats() {
        const stats = this.state.currentStats;
        stats.noiseFloor = this.state.noiseFloor;
        stats.snr = this.state.recentChunks.length > 0
            ? this.state.recentChunks[this.state.recentChunks.length - 1].snr
            : 0;
        stats.snrThreshold = this.options.snrThreshold;
        stats.minSnrThreshold = this.options.minSnrThreshold;
        stats.energyRiseThreshold = this.options.energyRiseThreshold;
    }

    recordSpeechStat(stat) {
        this.state.speechStats.push(stat);
        if (this.state.speechStats.length > this.options.maxHistoryLength) {
            this.state.speechStats.shift();
        }
    }

    getStats() {
        return this.state.currentStats;
    }

    getStateInfo() {
        return {
            inSpeech: this.state.inSpeech,
            noiseFloor: this.state.noiseFloor,
            snr: this.state.currentStats.snr,
            speechStartTime: this.state.speechStartTime
        };
    }

    reset() {
        this.state = {
            inSpeech: false,
            speechStartTime: null,
            silenceStartTime: null,
            silenceCounter: 0,
            recentChunks: [],
            speechEnergySum: 0,
            speechEnergyCount: 0,
            speechStats: [],
            silenceStats: [],
            cachedSpeechSummary: null,
            currentStats: {
                noiseFloor: 0.005,
                snr: 0,
                snrThreshold: this.options.snrThreshold,
                minSnrThreshold: this.options.minSnrThreshold,
                energyRiseThreshold: this.options.energyRiseThreshold
            },
            noiseFloor: 0.005,
            recentEnergies: [],
            silenceDuration: 0
        };
    }
}
