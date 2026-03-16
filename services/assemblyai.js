// AssemblyAI transcription service for call recordings
import { ASSEMBLYAI_CONFIG } from '../config/index.js';

const ASSEMBLYAI_API_BASE = 'https://api.assemblyai.com/v2';

// Transcribe audio from a buffer or URL
export const transcribeAudio = async (audioSource, options = {}) => {
    if (!ASSEMBLYAI_CONFIG.ENABLED || !ASSEMBLYAI_CONFIG.API_KEY) {
        console.log('[AssemblyAI] Transcription disabled or API key not set');
        return { success: false, error: 'AssemblyAI not configured' };
    }

    const {
        speakerLabels = ASSEMBLYAI_CONFIG.SPEAKER_LABELS,
        languageCode = ASSEMBLYAI_CONFIG.LANGUAGE_CODE
    } = options;

    try {
        let audioUrl;

        // If audioSource is a buffer, upload it first
        if (Buffer.isBuffer(audioSource)) {
            console.log('[AssemblyAI] Uploading audio buffer...');
            const uploadResult = await uploadAudio(audioSource);
            if (!uploadResult.success) {
                return uploadResult;
            }
            audioUrl = uploadResult.upload_url;
            console.log('[AssemblyAI] ✓ Audio uploaded');
        } else {
            // Assume it's a URL
            audioUrl = audioSource;
        }

        // Start transcription
        console.log('[AssemblyAI] Starting transcription...');
        const transcriptResult = await startTranscription(audioUrl, {
            speaker_labels: speakerLabels,
            language_code: languageCode
        });

        if (!transcriptResult.success) {
            return transcriptResult;
        }

        // Poll for completion
        console.log('[AssemblyAI] Waiting for transcription to complete...');
        const finalResult = await pollTranscriptionStatus(transcriptResult.id);
        
        return finalResult;

    } catch (err) {
        console.error('[AssemblyAI] Transcription error:', err.message);
        return { success: false, error: err.message };
    }
};

// Upload audio file to AssemblyAI
const uploadAudio = async (audioBuffer) => {
    try {
        const response = await fetch(`${ASSEMBLYAI_API_BASE}/upload`, {
            method: 'POST',
            headers: {
                'Authorization': ASSEMBLYAI_CONFIG.API_KEY,
                'Content-Type': 'application/octet-stream'
            },
            body: audioBuffer
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Upload failed: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return { success: true, upload_url: data.upload_url };
    } catch (err) {
        console.error('[AssemblyAI] Upload error:', err.message);
        return { success: false, error: err.message };
    }
};

// Start transcription job
const startTranscription = async (audioUrl, options = {}) => {
    try {
        const requestBody = {
            audio_url: audioUrl,
            speech_model: 'universal-2',  // Required by AssemblyAI API
            speaker_labels: options.speaker_labels ?? true,
            language_code: options.language_code || 'en_au'
        };

        const response = await fetch(`${ASSEMBLYAI_API_BASE}/transcript`, {
            method: 'POST',
            headers: {
                'Authorization': ASSEMBLYAI_CONFIG.API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`Start transcription failed: ${response.status} - ${error}`);
        }

        const data = await response.json();
        return { success: true, id: data.id, status: data.status };
    } catch (err) {
        console.error('[AssemblyAI] Start transcription error:', err.message);
        return { success: false, error: err.message };
    }
};

// Poll for transcription completion
const pollTranscriptionStatus = async (transcriptId, maxWaitMs = 300000) => {
    const pollIntervalMs = 5000;  // 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const response = await fetch(`${ASSEMBLYAI_API_BASE}/transcript/${transcriptId}`, {
                headers: {
                    'Authorization': ASSEMBLYAI_CONFIG.API_KEY
                }
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`Poll failed: ${response.status} - ${error}`);
            }

            const data = await response.json();

            if (data.status === 'completed') {
                console.log('[AssemblyAI] ✓ Transcription completed');
                return {
                    success: true,
                    id: data.id,
                    text: data.text,
                    utterances: data.utterances || [],
                    words: data.words || [],
                    audio_duration: data.audio_duration,
                    confidence: data.confidence,
                    formatted: formatTranscript(data)
                };
            }

            if (data.status === 'error') {
                console.error('[AssemblyAI] Transcription failed:', data.error);
                return { success: false, error: data.error || 'Transcription failed' };
            }

            // Still processing
            console.log(`[AssemblyAI] Status: ${data.status}, waiting...`);
            await sleep(pollIntervalMs);

        } catch (err) {
            console.error('[AssemblyAI] Poll error:', err.message);
            return { success: false, error: err.message };
        }
    }

    return { success: false, error: 'Transcription timed out' };
};

// Format transcript with speaker labels for email
const formatTranscript = (data) => {
    if (!data.utterances || data.utterances.length === 0) {
        // No speaker labels, just return plain text
        return data.text || '';
    }

    // Format with speaker labels
    let formatted = '';
    for (const utterance of data.utterances) {
        const speaker = utterance.speaker === 'A' ? 'Agent' : 'Caller';
        const timestamp = formatTimestamp(utterance.start);
        formatted += `[${timestamp}] ${speaker}: ${utterance.text}\n\n`;
    }

    return formatted.trim();
};

// Format milliseconds to MM:SS
const formatTimestamp = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

// Helper sleep function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default { transcribeAudio };
