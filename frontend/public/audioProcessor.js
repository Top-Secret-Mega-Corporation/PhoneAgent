/**
 * AudioWorklet processor for microphone capture in Dev Mode.
 * 
 * Runs in the audio rendering thread. Receives Float32 PCM from the browser mic,
 * downsamples to 16kHz, converts to Int16, and sends 100ms chunks to the main thread.
 * The main thread then base64-encodes and sends to the backend WebSocket.
 */
class AudioProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = [];
        this.TARGET_SAMPLE_RATE = 16000;
        this.SAMPLES_PER_CHUNK = 1600; // 100ms at 16kHz
        this.ratio = 1; // will be set on first process() call
        this._ratioSet = false;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const samples = input[0]; // Float32Array, mono

        // Calculate downsample ratio once (sampleRate is a global in AudioWorkletGlobalScope)
        if (!this._ratioSet) {
            this.ratio = sampleRate / this.TARGET_SAMPLE_RATE;
            this._ratioSet = true;
        }

        // Downsample: pick every nth sample
        for (let i = 0; i < samples.length; i += this.ratio) {
            this.buffer.push(samples[Math.floor(i)]);
        }

        // Emit chunks of SAMPLES_PER_CHUNK
        while (this.buffer.length >= this.SAMPLES_PER_CHUNK) {
            const chunk = this.buffer.splice(0, this.SAMPLES_PER_CHUNK);

            // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
            const pcm16 = new Int16Array(chunk.length);
            for (let j = 0; j < chunk.length; j++) {
                pcm16[j] = Math.max(-32768, Math.min(32767, Math.round(chunk[j] * 32767)));
            }

            // Transfer the buffer (zero-copy) to the main thread
            this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
        }

        return true;
    }
}

registerProcessor('audio-processor', AudioProcessor);
