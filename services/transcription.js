import FormData from 'form-data';
import { OPENAI_API_KEY } from '../config/index.js';

// Transcribe caller audio using OpenAI Whisper API
export const transcribeAudio = async (audioChunks) => {
    if (!audioChunks || audioChunks.length === 0) {
        console.log('[Whisper] No audio chunks to transcribe');
        return null;
    }
    
    try {
        console.log('[Whisper] Transcribing', audioChunks.length, 'audio chunks');
        
        // Combine all base64 chunks into PCMU buffer
        const pcmuBuffer = Buffer.concat(
            audioChunks.map(b64 => Buffer.from(b64, 'base64'))
        );
        
        // Decode µ-law (PCMU) to 16-bit PCM and wrap in a standard WAV file
        const muLawDecode = (uVal) => {
            uVal = ~uVal & 0xff;
            let t = ((uVal & 0x0f) << 3) + 0x84;
            t <<= (uVal & 0x70) >> 4;
            return (uVal & 0x80) ? (0x84 - t) : (t - 0x84);
        };

        const pcm16Buffer = Buffer.alloc(pcmuBuffer.length * 2);
        for (let i = 0; i < pcmuBuffer.length; i += 1) {
            const sample = muLawDecode(pcmuBuffer[i]);
            pcm16Buffer.writeInt16LE(sample, i * 2);
        }

        const createPcmWavHeader = (dataLength, sampleRate = 8000, numChannels = 1, bitsPerSample = 16) => {
            const blockAlign = (numChannels * bitsPerSample) / 8;
            const byteRate = sampleRate * blockAlign;
            const header = Buffer.alloc(44);

            header.write('RIFF', 0);
            header.writeUInt32LE(36 + dataLength, 4);
            header.write('WAVE', 8);
            header.write('fmt ', 12);
            header.writeUInt32LE(16, 16); // PCM
            header.writeUInt16LE(1, 20); // AudioFormat = PCM
            header.writeUInt16LE(numChannels, 22);
            header.writeUInt32LE(sampleRate, 24);
            header.writeUInt32LE(byteRate, 28);
            header.writeUInt16LE(blockAlign, 32);
            header.writeUInt16LE(bitsPerSample, 34);
            header.write('data', 36);
            header.writeUInt32LE(dataLength, 40);

            return header;
        };

        const wavHeader = createPcmWavHeader(pcm16Buffer.length);
        const wavBuffer = Buffer.concat([wavHeader, pcm16Buffer]);
        
        // Create form data for Whisper API
        const form = new FormData();
        form.append('model', 'whisper-1');
        form.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
        form.append('language', 'en');
        
        // Call OpenAI Whisper API
        const whisperUrl = 'https://api.openai.com/v1/audio/transcriptions';
        const contentLength = await new Promise((resolve, reject) => {
            form.getLength((err, length) => {
                if (err) return reject(err);
                resolve(length);
            });
        });

        const response = await fetch(whisperUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                ...form.getHeaders(),
                'Content-Length': String(contentLength)
            },
            body: form
        });
        
        if (!response.ok) {
            const errBody = await response.text();
            console.error('[Whisper] API error:', response.status, errBody);
            console.error('[Whisper] Response headers:', JSON.stringify(Object.fromEntries(response.headers.entries())));
            return null;
        }
        
        const result = await response.json();
        const transcribedText = result.text || '';
        
        if (transcribedText.trim()) {
            console.log(`[Whisper] Transcribed caller speech: "${transcribedText}"`);
            return transcribedText;
        } else {
            console.log('[Whisper] Empty transcription result');
            return null;
        }
    } catch (error) {
        console.error('[Whisper] Transcription failed:', error && error.message ? error.message : error);
        return null;
    }
};
