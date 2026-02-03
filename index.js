import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';

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

let storage = null;
if (GCS_BUCKET) {
    storage = new Storage();
    console.log(`GCS enabled. Uploading transcripts to bucket: ${GCS_BUCKET}`);
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
//const PORT = process.env.PORT || 5050; // Allow dynamic port assignment


const PORT = Number(process.env.PORT) || 8080;



// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated',
    'response.function_call_arguments.done'
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
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say voice="Google.en-US-Chirp3-HD-Aoede">Connecting your call to Update 2 4 7</Say>
                              <Pause length="1"/>
                              <Say voice="Google.en-US-Chirp3-HD-Aoede"></Say>
                              <Connect>
                                  <Stream url="wss://cloudrun-ai247-452739190322.us-south1.run.app/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
    let conversationLog = [];
    let callStartTime = new Date();

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
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                        output: { format: { type: 'audio/pcmu' }, voice: VOICE },
                    },
                    instructions: SYSTEM_MESSAGE,
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

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);

                                // Track conversation items
                                if (response.type === 'conversation.item.created') {
                                    const item = response.item;
                                    if (SHOW_TIMING_MATH) console.log('conversation.item.created:', JSON.stringify(item));
                                    if (item && item.role === 'user' && item.content) {
                                        const textContent = item.content.find(c => c.type === 'input_text');
                                        if (textContent) {
                                            conversationLog.push({
                                                role: 'user',
                                                content: textContent.text,
                                                timestamp: new Date().toISOString()
                                            });
                                            console.log(`[Transcript] User: ${textContent.text}`);
                                        }
                                    }
                                    if (item && item.role === 'assistant' && item.content) {
                                        const textContent = item.content.find(c => c.type === 'text');
                                        if (textContent) {
                                            conversationLog.push({
                                                role: 'assistant',
                                                content: textContent.text,
                                                timestamp: new Date().toISOString()
                                            });
                                            console.log(`[Transcript] Assistant: ${textContent.text}`);
                                        }
                                    }
                                }
                }

                if (response.type === 'response.output_audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
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

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
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
                        console.log('Incoming stream has started', streamSid);

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTwilio = null;
                        latestMediaTimestamp = 0;
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
            if (conversationLog.length === 0) {
                console.log('[saveTranscript] No conversation to save');
                return;
            }

            const callEndTime = new Date();
            const duration = Math.round((callEndTime - callStartTime) / 1000); // Duration in seconds
            const timestamp = callStartTime.toISOString().replace(/[:.]/g, '-').slice(0, -5);
            const filename = `call-${streamSid || 'unknown'}-${timestamp}.json`;

            const transcript = {
                callId: streamSid,
                startTime: callStartTime.toISOString(),
                endTime: callEndTime.toISOString(),
                duration: duration,
                conversation: conversationLog
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
