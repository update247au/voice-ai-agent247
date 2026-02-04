import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import FormData from 'form-data';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables
// Ensure call-history directory exists
const CALL_HISTORY_DIR = path.join(process.cwd(), 'call-history');
if (!fs.existsSync(CALL_HISTORY_DIR)) {
    fs.mkdirSync(CALL_HISTORY_DIR, { recursive: true });
}
const { OPENAI_API_KEY } = process.env;
// Optional: GCS bucket name for transcript persistence. If not set, falls back to local files.
const GCS_BUCKET = process.env.GCS_BUCKET || process.env.GOOGLE_CLOUD_BUCKET || null;

// In-memory store for webhook bodies keyed by CallSid (or fallback key)
const callMeta = {};

let storage = null;
if (GCS_BUCKET) {
    storage = new Storage();
    console.log(`GCS enabled. Uploading transcripts to bucket: ${GCS_BUCKET}`);
    
    // Test GCS connectivity on startup
    const testGCSConnectivity = async () => {
        try {
            const testFilename = `test-${Date.now()}.json`;
            const testFile = storage.bucket(GCS_BUCKET).file(testFilename);
            const testPayload = JSON.stringify({
                test: true,
                timestamp: new Date().toISOString(),
                message: 'GCS connectivity test'
            }, null, 2);
            
            await testFile.save(testPayload, { contentType: 'application/json' });
            console.log(`✓ GCS test successful: gs://${GCS_BUCKET}/${testFilename}`);
        } catch (err) {
            console.error(`✗ GCS test failed: ${err.message}`);
            console.error('   Make sure: 1) bucket exists, 2) service account has objectCreator role, 3) credentials are set');
        }
    };
    
    // Run test after short delay
    setTimeout(testGCSConnectivity, 500);
} else {
    console.log('GCS_BUCKET not set — transcripts will be saved to local call-history folder');
}

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = 'You are the Support and sales specialist for Update247 Channel Manager. Your purpose is to act as a knowledgeable and friendly support and sales staff member, assisting accommodation providers with questions, guidance, and basic troubleshooting. Website: https://www.update247.com.au/ Responsibilities: Explain Update247 benefits (real-time sync, preventing overbookings); Guide users on managing rates, availability, and OTA connections; Troubleshoot sync issues. Tone: Professional, friendly, and supportive. LANGUAGE: You must ALWAYS speak and respond in English only unless caller ask you to speak in another language. If caller ask you to speak in another language, you must speak in that language.';
const VOICE = 'alloy';

const TEMPERATURE = 0.4; // Controls the randomness of the AI's responsess
const USE_REALTIME_TRANSCRIPTION = true;
//const PORT = process.env.PORT || 5050; // Allow dynamic port assignment


const PORT = Number(process.env.PORT) || 8080;



// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    // transcription-related events (may vary by realtime API naming)
    'input_audio_transcript',
    'input_audio_transcription',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated',
    'response.function_call_arguments.done',
    'conversation.item.created'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    try {
        const body = request.body || {};
        console.log('[DEBUG] /incoming-call received. request.body:', JSON.stringify(body));

        const from = body.From || body.from || '';
        const to = body.To || body.to || '';
        const callSid = body.CallSid || body.callSid || '';

        // Store the full webhook body so it can be attached to the transcript later
        try {
            const callKey = callSid || `${from}-${Date.now()}`;
            callMeta[callKey] = { webhookBody: body, receivedAt: new Date().toISOString() };
            console.log('[DEBUG] Stored webhook body for callKey:', callKey);
        } catch (e) {
            console.error('[DEBUG] Error storing webhook body:', e.message);
        }

        console.log('[DEBUG] Extracted from webhook - from:', from, 'to:', to, 'callSid:', callSid);

        const fromEsc = encodeURIComponent(from || '');
        const toEsc = encodeURIComponent(to || '');
        const callSidEsc = encodeURIComponent(callSid || '');

        const streamUrl = `wss://cloudrun-ai247-452739190322.us-south1.run.app/media-stream?from=${fromEsc}&to=${toEsc}&callSid=${callSidEsc}`;
        // Escape ampersands for safe XML embedding (Twilio's XML parser requires &amp;)
        const streamUrlXml = streamUrl.replace(/&/g, '&amp;');

        const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say voice="Google.en-US-Chirp3-HD-Aoede">Connecting your call to Update 2 4 7</Say>
                              <Pause length="1"/>
                              <Say voice="Google.en-US-Chirp3-HD-Aoede"></Say>
                              <Connect>
                                  <Stream url="${streamUrlXml}">
                                      <Parameter name="from" value="${from}" />
                                      <Parameter name="to" value="${to}" />
                                      <Parameter name="callSid" value="${callSid}" />
                                  </Stream>
                              </Connect>
                          </Response>`;

        reply.type('text/xml').status(200).send(twimlResponse);
    } catch (err) {
        console.error('[ERROR] /incoming-call handler failed:', err && err.message ? err.message : err);
        // Always respond with valid TwiML to avoid Twilio playing the default error message
        const safeTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">The application encountered an error. Goodbye.</Say></Response>`;
        try { reply.type('text/xml').status(200).send(safeTwiml); } catch (e) { console.error('[ERROR] Failed to send fallback TwiML:', e); }
    }
});

// WebSocket route for media-stream.
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let callerNumber = null; // Caller phone number (if provided by Twilio)
        let calleeNumber = null; // Called/destination phone number (if provided by Twilio)
        let callSid = null; // Twilio call SID (if provided)
        let webhookBody = null; // Full webhook body if available
    let conversationLog = [];
    let callStartTime = new Date();
    let currentResponseText = '';  // Accumulate text deltas
    let allEvents = [];  // Capture ALL events for debugging
    
    // For caller speech transcription via Whisper API
    let isCapturingCallerSpeech = false;
    let callerAudioChunks = [];  // Buffer audio base64 chunks during speech

        // Try to parse caller info from the WebSocket URL query params (e.g. TwiML can embed ?from={{From}})
        try {
            const rawUrl = req && req.url ? String(req.url) : '';
            console.log('[DEBUG] WebSocket URL:', rawUrl);
            const parsed = new URL(rawUrl, 'http://localhost');
            const qFrom = parsed.searchParams.get('from') || parsed.searchParams.get('From') || parsed.searchParams.get('caller') || parsed.searchParams.get('Caller');
            const qTo = parsed.searchParams.get('to') || parsed.searchParams.get('To');
            const qCallSid = parsed.searchParams.get('callSid') || parsed.searchParams.get('CallSid') || parsed.searchParams.get('callsid');
            if (qFrom) callerNumber = qFrom;
            if (qTo) calleeNumber = qTo;
            if (qCallSid) callSid = qCallSid;
            if (qFrom || qTo || qCallSid) console.log('[DEBUG] Parsed from WS URL - from:', qFrom, 'to:', qTo, 'callSid:', qCallSid);
        } catch (err) {
            console.error('[DEBUG] Error parsing WS URL:', err.message);
        }

            // If callSid was provided as a query param, try to attach saved webhook body
            try {
                const qParsed = new URL(req && req.url ? String(req.url) : '', 'http://localhost');
                const qCallSid = qParsed.searchParams.get('callSid') || qParsed.searchParams.get('CallSid') || null;
                const lookupKey = qCallSid || null;
                if (lookupKey && callMeta[lookupKey]) {
                    webhookBody = callMeta[lookupKey].webhookBody || null;
                    console.log('[DEBUG] Attached webhook body from callMeta for key (from WS URL):', lookupKey);
                }
            } catch (e) {
                // ignore
            }

        const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${TEMPERATURE}`, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: "gpt-realtime",
                    output_modalities: ["audio"],
                    voice: VOICE,
                    input_audio_format: "g711_ulaw",
                    output_audio_format: "g711_ulaw",
                    input_audio_transcription: { model: 'gpt-4o-transcribe' },
                    turn_detection: { type: "server_vad" },
                    instructions: SYSTEM_MESSAGE
                },
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first :
            sendInitialConversationItem();
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with : Update247 you are speaking with RAJ. How are you doing today?'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTwilio} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamSid: streamSid
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTwilio = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finisheds
        const sendMark = (connection, streamSid) => {
            if (streamSid) {
                const markEvent = {
                    event: 'mark',
                    streamSid: streamSid,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Transcribe caller audio using OpenAI Whisper API
        const transcribeCallerAudio = async () => {
            if (callerAudioChunks.length === 0) {
                console.log('[Whisper] No audio chunks to transcribe');
                return;
            }
            
            try {
                console.log('[Whisper] Transcribing', callerAudioChunks.length, 'audio chunks');
                
                // Combine all base64 chunks into PCMU buffer
                const pcmuBuffer = Buffer.concat(
                    callerAudioChunks.map(b64 => Buffer.from(b64, 'base64'))
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
                    return;
                }
                
                const result = await response.json();
                const transcribedText = result.text || '';
                
                if (transcribedText.trim()) {
                    console.log(`[Whisper] Transcribed caller speech: "${transcribedText}"`);
                    conversationLog.push({
                        role: 'user',
                        content: transcribedText,
                        timestamp: new Date().toISOString()
                    });
                    console.log(`[Transcript] User: ${transcribedText}`);
                } else {
                    console.log('[Whisper] Empty transcription result');
                }
            } catch (error) {
                console.error('[Whisper] Transcription failed:', error && error.message ? error.message : error);
            } finally {
                callerAudioChunks = [];  // Clear buffer after transcription
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);

                // Capture ALL events for debugging
                allEvents.push({
                    type: response.type,
                    keys: Object.keys(response),
                    timestamp: new Date().toISOString()
                });

                // Log ALL event types to understand what's being received
                console.log(`[ALL_EVENTS] Type: ${response.type}`);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                // Detect when caller speech starts (from OpenAI Realtime API)
                if (response.type === 'input_audio_buffer.speech_started') {
                    if (!USE_REALTIME_TRANSCRIPTION) {
                        isCapturingCallerSpeech = true;
                        callerAudioChunks = [];
                        console.log('[Whisper] Caller speech detected. Starting audio capture...');
                    }
                }

                // Realtime transcription events (built-in)
                if (
                    response.type === 'input_audio_transcript.done' ||
                    response.type === 'input_audio_transcription.done' ||
                    response.type === 'input_audio_transcript' ||
                    response.type === 'input_audio_transcription'
                ) {
                    const transcriptText = response.transcript || response.text || '';
                    if (transcriptText && transcriptText.trim()) {
                        conversationLog.push({
                            role: 'user',
                            content: transcriptText,
                            timestamp: new Date().toISOString()
                        });
                        console.log(`[Transcript] User (realtime): ${transcriptText}`);
                    }
                }

                // Capture conversation items from conversation.item.added events
                if (response.type === 'conversation.item.added' && response.item) {
                    const item = response.item;
                    
                    // Handle user messages (from caller's voice)
                    if (item.role === 'user' && item.content && Array.isArray(item.content)) {
                        const textContent = item.content.find(c => c.type === 'input_text');
                        if (textContent && textContent.text) {
                            conversationLog.push({
                                role: 'user',
                                content: textContent.text,
                                timestamp: new Date().toISOString()
                            });
                            console.log(`[Transcript] User: ${textContent.text}`);
                        }
                    }
                    
                    // Handle assistant messages from item.content
                    if (item.role === 'assistant' && item.content && Array.isArray(item.content)) {
                        const textContent = item.content.find(c => c.type === 'text');
                        if (textContent && textContent.text) {
                            conversationLog.push({
                                role: 'assistant',
                                content: textContent.text,
                                timestamp: new Date().toISOString()
                            });
                            console.log(`[Transcript] Assistant (from item): ${textContent.text}`);
                        }
                    }
                }

                // Alternative: Capture assistant response transcript from response.output_audio_transcript.done
                if (response.type === 'response.output_audio_transcript.done' && response.transcript) {
                    // Only log if not already captured from conversation.item.added
                    const lastEntry = conversationLog[conversationLog.length - 1];
                    if (!lastEntry || lastEntry.content !== response.transcript || lastEntry.role !== 'assistant') {
                        conversationLog.push({
                            role: 'assistant',
                            content: response.transcript,
                            timestamp: new Date().toISOString()
                        });
                        console.log(`[Transcript] Assistant (from transcript.done): ${response.transcript}`);
                    }
                }


                if (response.type === 'response.output_audio.delta' && response.delta) {
                    // Debug: log first 30 chars of OpenAI audio delta and Twilio payload
                    const delta = response.delta;
                    console.log("OpenAI audio delta (first 30):", delta.slice(0, 30));
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: delta }
                    };
                    const payload = audioDelta.media.payload;
                    console.log("Sending to Twilio (first 30):", payload.slice(0, 30));

                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTwilio) {
                        responseStartTimestampTwilio = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTwilio}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }

                    sendMark(connection, streamSid);
                }

                if (response.type === 'input_audio_buffer.speech_stopped') {
                    handleSpeechStartedEvent();
                    
                    // Caller speech has stopped; transcribe the buffered audio
                    if (!USE_REALTIME_TRANSCRIPTION && isCapturingCallerSpeech) {
                        isCapturingCallerSpeech = false;
                        console.log('[Whisper] Speech stopped. Transcribing buffered audio...');
                        transcribeCallerAudio().catch(err => console.error('[Whisper] Transcription error:', err));
                    }
                }

                // When user's speech is committed, request OpenAI to create a conversation item from it
                if (response.type === 'input_audio_buffer.committed') {
                    console.log('[input_audio_buffer.committed] Requesting conversation item creation...');
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        openAiWs.send(JSON.stringify({
                            type: 'response.create'
                        }));
                    }
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        
                        // If caller speech is being detected, buffer this audio chunk for later transcription
                        if (isCapturingCallerSpeech && data.media.payload) {
                            callerAudioChunks.push(data.media.payload);
                        }
                        
                        // Debug: inspect and save incoming audio payloads to help diagnose scrambled audio
                        try {
                            const payloadB64 = data.media.payload || '';
                            console.log('[DEBUG][media] payload length (base64):', payloadB64.length);

                            // Append base64 payload lines to a rolling file so we can inspect stream
                            try {
                                const sampleB64Path = path.join(CALL_HISTORY_DIR, `sample-${streamSid || 'unknown'}-b64.txt`);
                                fs.appendFileSync(sampleB64Path, payloadB64 + '\n');
                            } catch (e) {
                                console.error('[DEBUG] Failed to write base64 sample file:', e.message);
                            }

                            // Also write raw µ-law bytes (decoded from base64) for audio inspection
                            try {
                                const raw = Buffer.from(payloadB64, 'base64');
                                const sampleRawPath = path.join(CALL_HISTORY_DIR, `sample-${streamSid || 'unknown'}.ulaw`);
                                fs.appendFileSync(sampleRawPath, raw);
                                console.log('[DEBUG] Wrote raw sample bytes to', sampleRawPath);
                            } catch (e) {
                                console.error('[DEBUG] Failed to write raw audio sample file:', e.message);
                            }
                        } catch (e) {
                            console.error('[DEBUG] Error while saving media payload samples:', e && e.message ? e.message : e);
                        }

                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        
                        // Log the full start object to see what Twilio sends
                        console.log('[DEBUG] Full start object keys:', Object.keys(data.start));
                        console.log('[DEBUG] data.start:', JSON.stringify(data.start, null, 2).substring(0, 500));
                        
                        // Try to capture caller phone number and call SID from common places
                        callSid = data.start.callSid || data.start.CallSid || callSid || null;
                        callerNumber = data.start.from || data.start.From || data.start.caller || callerNumber || null;
                        calleeNumber = data.start.to || data.start.To || calleeNumber || null;

                        // Twilio sends <Parameter> values in the start event as an array under start.parameters
                        try {
                            const params = data.start.parameters || (data.start.stream && data.start.stream.parameters) || null;
                            if (params) {
                                console.log('[DEBUG] Raw parameters received:', JSON.stringify(params));
                                
                                if (Array.isArray(params)) {
                                    // params is an array of {name, value} objects
                                    params.forEach(p => {
                                        if (p && p.name && p.value) {
                                            const nameLC = p.name.toLowerCase();
                                            if (nameLC === 'from') callerNumber = p.value;
                                            if (nameLC === 'to') calleeNumber = p.value;
                                            if (nameLC === 'callsid') callSid = p.value;
                                        }
                                    });
                                } else if (typeof params === 'object') {
                                    // params is an object with key-value pairs
                                    Object.entries(params).forEach(([k, v]) => {
                                        const keyLC = String(k).toLowerCase();
                                        if (keyLC === 'from') callerNumber = v;
                                        if (keyLC === 'to') calleeNumber = v;
                                        if (keyLC === 'callsid') callSid = v;
                                    });
                                }
                            } else {
                                console.log('[DEBUG] No parameters found in start event');
                            }
                        } catch (e) {
                            console.error('[DEBUG] Error parsing parameters:', e.message);
                        }

                            // If callSid is available, try to attach webhook body saved earlier
                            try {
                                if (callSid && callMeta[callSid]) {
                                    webhookBody = callMeta[callSid].webhookBody || null;
                                    // free memory for this key now that we've attached it
                                    delete callMeta[callSid];
                                    console.log('[DEBUG] Attached webhook body from callMeta for callSid:', callSid);
                                }
                            } catch (e) {
                                console.error('[DEBUG] Error attaching webhook body from callMeta:', e.message);
                            }

                            console.log('Incoming stream has started', streamSid, 'caller:', callerNumber, 'callee:', calleeNumber, 'callSid:', callSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
                        break;
                    case 'stop':
                        console.log('[Twilio stop event] Call ended. Saving transcript.');
                        saveTranscript().catch((err) => console.error('[Twilio stop] Error saving transcript:', err));
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;

                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Save conversation transcript (upload to GCS if configured, otherwise local file)
        const saveTranscript = async () => {
            console.log(`[saveTranscript] Called. conversationLog length: ${conversationLog.length}, GCS_BUCKET: ${GCS_BUCKET}`);
            
            const callEndTime = new Date();
            const duration = Math.round((callEndTime - callStartTime) / 1000); // Duration in seconds
            const timestamp = callStartTime.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const filename = `call-${streamSid || 'unknown'}-${timestamp}.json`;

            const transcript = {
                callId: streamSid,
                callSid: callSid,
                callerNumber: callerNumber,
                calleeNumber: calleeNumber,
                webhookBody: webhookBody || null,
                startTime: callStartTime.toISOString(),
                endTime: callEndTime.toISOString(),
                duration: duration,
                conversation: conversationLog.length > 0 ? conversationLog : [{
                    role: 'note',
                    content: 'No conversation items captured during this call. Check conversation event structure.',
                    timestamp: new Date().toISOString()
                }]
            };

            const payload = JSON.stringify(transcript, null, 2);

            if (storage && GCS_BUCKET) {
                try {
                    const file = storage.bucket(GCS_BUCKET).file(filename);
                    await file.save(payload, { contentType: 'application/json' });
                    console.log(`[saveTranscript] ✓ Transcript uploaded to gs://${GCS_BUCKET}/${filename}`);
                    return;
                } catch (err) {
                    console.error(`[saveTranscript] ✗ Failed to upload to GCS: ${err.message}`, err);
                }
            }

            // Fallback to local file
            try {
                const filepath = path.join(CALL_HISTORY_DIR, filename);
                fs.writeFileSync(filepath, payload);
                console.log(`[saveTranscript] ✓ Transcript saved locally: ${filepath}`);
            } catch (err) {
                console.error(`[saveTranscript] ✗ Failed to save locally: ${err.message}`, err);
            }

            // Additionally create a backup file including caller phone number and callSid
            try {
                const sanitize = (s) => (String(s || '')).replace(/[^0-9]/g, '') || 'unknown';
                const callerForName = sanitize(callerNumber);
                const callSidForName = callSid || streamSid || 'unknown';
                const backupFilename = `index-${callerForName}-${callSidForName}-${timestamp}.json`;

                // Save locally
                const backupPath = path.join(CALL_HISTORY_DIR, backupFilename);
                fs.writeFileSync(backupPath, payload);
                console.log(`[saveTranscript] ✓ Backup saved locally: ${backupPath}`);

                // Also attempt to upload backup to GCS under a backups/ prefix if possible
                if (storage && GCS_BUCKET) {
                    try {
                        const backupFile = storage.bucket(GCS_BUCKET).file(`backups/${backupFilename}`);
                        await backupFile.save(payload, { contentType: 'application/json' });
                        console.log(`[saveTranscript] ✓ Backup uploaded to gs://${GCS_BUCKET}/backups/${backupFilename}`);
                    } catch (e) {
                        console.error(`[saveTranscript] ✗ Failed to upload backup to GCS: ${e.message}`);
                    }
                }
            } catch (e) {
                console.error('[saveTranscript] ✗ Failed to create backup file:', e.message);
            }
        };

        // Handle connection close: save transcript and close OpenAI connection
        connection.on('close', () => {
            console.log('[connection.close] Handler fired. Saving transcript and closing OpenAI connection.');
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            saveTranscript().catch((err) => console.error('[connection.close] Error saving transcript:', err));
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', (code, reason) => {
            console.log(`Disconnected from the OpenAI Realtime API. Code: ${code}, Reason: ${reason}`);
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
            console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error)));
        });
    });
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
