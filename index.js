import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import fs from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import FormData from 'form-data';
import twilio from 'twilio';

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
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || null;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || null;

// Initialize Twilio client if credentials are available
let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    console.log('Twilio client initialized for call recording');
} else {
    console.log('Twilio credentials not set - call recording disabled');
}

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

// Function to load agent settings from GCS bucket
const loadAgentSettings = async () => {
    const DEFAULT_SYSTEM_MESSAGE = `You are Update247's AI phone agent. Speak with a clear Australian English accent.

GOAL:
1)become a support or sales agent when you determine whether caller needs Support or Sales.
2) IF call is realted to admin or its someone selling something, ask them send email to : info@update247.com.au and admin team will respond on the email.

RULES:
- Follow the FLOW strictly.
- Ask ONE question at a time.
- If the caller gives partial info, ask for the missing piece.
- Always repeat key details back for confirmation.
- Do not proceed to the next step until the current step is complete.
- If caller refuses to share details, continue politely with what you have.
- Use save_caller_info function to store collected data as you learn it.
- become a support or sales agent when you determine whether caller needs Support or Sales.

FLOW (state machine):

STATE A — COLLECT PROPERTY Name
- Ask: "Can I please have your property Name?" 
- If provided -> save it -> go to STATE B.
- If not provided -> ask: "if you are accommodation provider ?" -> go to STATE F.

STATE B — GET PROPERTY ID
- Say: "Thanks. Do you have your property ID is <ID>. its is visible on top left when logged into Update247."
- If yes -> go to STATE G.
- If no -> ask : how can I help you ?-> become a sales or support agent based on their response.

STATE C — COLLECT PROPERTY NAME
- Ask: "What is the property name?"
- If provided -> save it -> go to STATE E.
- If not provided -> ask again once. If still missing -> go to STATE F (general triage).

STATE D — CHECK CLIENT STATUS
- Ask: "Are you currently using Update247?"
- If yes -> go to STATE G (Support).
- If no -> go to STATE H (Sales).
- If unsure -> ask: "Did you ever have an Update247 login before?" then decide.

STATE E — CHECK CLIENT STATUS (NO ID PATH)
- Ask: "Are you currently using Update247?"
- If yes -> go to STATE G (Support) and ask for property ID later if needed.
- If no -> go to STATE H (Sales).

STATE F — GENERAL TRIAGE (MISSING DETAILS)
- Ask: "Are you calling for help with an existing Update247 account, or are you looking to start using Update247?"
- If existing -> STATE G.
- If new -> STATE H.

STATE G — SUPPORT MODE
- Be a support agent.
- Ask: "What issue can I help with today?"
- If account lookup needed and missing ID -> ask for property ID again.

STATE H — SALES MODE
- Be a sales agent.
- Ask: "Which channel manager / booking system are you using now, and how many properties do you manage?"
- Offer next step: demo / pricing / onboarding.


Speaking style rules (very important):

- Speak slowly and clearly.
- Use short sentences.
- Pause briefly between sentences.
- Avoid technical words.
- Avoid long explanations.
- Ask one question at a time.
- If the caller sounds confused or asks "pardon" or "sorry?", slow down even more.
- If needed, rephrase using simpler words.
- Give the user time to respond after each question.

LANGUAGE: You must ALWAYS speak and respond in English only unless caller ask you to speak in another language. If caller ask you to speak in another language, you must speak in that language.
 
When speaking Hindi, prefer Hinglish (simple Hindi mixed with English).
Avoid long pure-Hindi sentences.

When speaking punjabi, prefer punglish (simple punjabi mixed with English).
Avoid long pure-punjabi sentences.

You are speaking to people who may not be fluent in English.

Example speaking style:

Instead of:
"Please provide your property identification number so I can assist you."

Say:
"That's okay.
I can help you.
May I please have your property ID?"`;

    // If GCS is not configured, return default settings
    if (!GCS_BUCKET || !storage) {
        console.log('ℹ️  GCS not configured. Using default system message.');
        return {
            system_message: DEFAULT_SYSTEM_MESSAGE,
            voice: 'sage',
            temperature: 0.2,
            use_realtime_transcription: false
        };
    }

    try {
        // Load settings from GCS bucket
        const settingsFile = storage.bucket(GCS_BUCKET).file('ai-setting/u247-agent.json');
        const [exists] = await settingsFile.exists();
        
        if (!exists) {
            console.log('⚠️  Settings file not found in GCS (gs://' + GCS_BUCKET + '/ai-setting/u247-agent.json). Using default settings.');
            return {
                system_message: DEFAULT_SYSTEM_MESSAGE,
                voice: 'sage',
                temperature: 0.2,
                use_realtime_transcription: false
            };
        }

        const [fileContent] = await settingsFile.download();
        const settings = JSON.parse(fileContent.toString('utf-8'));
        
        console.log('✓ Loaded agent settings from GCS: gs://' + GCS_BUCKET + '/ai-setting/u247-agent.json');
        console.log('  - voice:', settings.voice);
        console.log('  - temperature:', settings.temperature);
        console.log('  - system_message length:', settings.system_message ? settings.system_message.length : 'undefined');
        
        const finalSettings = {
            system_message: settings.system_message || DEFAULT_SYSTEM_MESSAGE,
            voice: settings.voice || 'sage',
            temperature: settings.temperature !== undefined ? settings.temperature : 0.2,
            use_realtime_transcription: settings.use_realtime_transcription || false
        };
        
        console.log('✓ Final settings to use - system_message length:', finalSettings.system_message.length);
        return finalSettings;
    } catch (error) {
        console.error('✗ Error loading agent settings from GCS:', error.message);
        console.log('  Falling back to default system message.');
        return {
            system_message: DEFAULT_SYSTEM_MESSAGE,
            voice: 'sage',
            temperature: 0.2,
            use_realtime_transcription: false
        };
    }
};

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Placeholder for agent settings (will be loaded at startup)
let AGENT_SETTINGS = null;

// Constantss
const SYSTEM_MESSAGE = `You are Update247's AI phone agent. Speak with a clear Australian English accent.

GOAL:
1)become a support or sales agent when you determine whether caller needs Support or Sales.
2) IF call is realted to admin or its someone selling something, ask them send email to : info@update247.com.au and admin team will respond on the email.

RULES:
- Follow the FLOW strictly.
- Ask ONE question at a time.
- If the caller gives partial info, ask for the missing piece.
- Always repeat key details back for confirmation.
- Do not proceed to the next step until the current step is complete.
- If caller refuses to share details, continue politely with what you have.
- Use save_caller_info function to store collected data as you learn it.
- become a support or sales agent when you determine whether caller needs Support or Sales.

FLOW (state machine):

STATE A — COLLECT PROPERTY Name
- Ask: "Can I please have your property Name?" 
- If provided -> save it -> go to STATE B.
- If not provided -> ask: "if you are accommodation provider ?" -> go to STATE F.

STATE B — GET PROPERTY ID
- Say: "Thanks. Do you have your property ID is <ID>. its is visible on top left when logged into Update247."
- If yes -> go to STATE G.
- If no -> ask : how can I help you ?-> become a sales or support agent based on their response.

STATE C — COLLECT PROPERTY NAME
- Ask: "What is the property name?"
- If provided -> save it -> go to STATE E.
- If not provided -> ask again once. If still missing -> go to STATE F (general triage).

STATE D — CHECK CLIENT STATUS
- Ask: "Are you currently using Update247?"
- If yes -> go to STATE G (Support).
- If no -> go to STATE H (Sales).
- If unsure -> ask: "Did you ever have an Update247 login before?" then decide.

STATE E — CHECK CLIENT STATUS (NO ID PATH)
- Ask: "Are you currently using Update247?"
- If yes -> go to STATE G (Support) and ask for property ID later if needed.
- If no -> go to STATE H (Sales).

STATE F — GENERAL TRIAGE (MISSING DETAILS)
- Ask: "Are you calling for help with an existing Update247 account, or are you looking to start using Update247?"
- If existing -> STATE G.
- If new -> STATE H.

STATE G — SUPPORT MODE
- Be a support agent.
- Ask: "What issue can I help with today?"
- If account lookup needed and missing ID -> ask for property ID again.

STATE H — SALES MODE
- Be a sales agent.
- Ask: "Which channel manager / booking system are you using now, and how many properties do you manage?"
- Offer next step: demo / pricing / onboarding.


Speaking style rules (very important):

- Speak slowly and clearly.
- Use short sentences.
- Pause briefly between sentences.
- Avoid technical words.
- Avoid long explanations.
- Ask one question at a time.
- If the caller sounds confused or asks “pardon” or “sorry?”, slow down even more.
- If needed, rephrase using simpler words.
- Give the user time to respond after each question.

LANGUAGE: You must ALWAYS speak and respond in English only unless caller ask you to speak in another language. If caller ask you to speak in another language, you must speak in that language.
 
When speaking Hindi, prefer Hinglish (simple Hindi mixed with English).
Avoid long pure-Hindi sentences.

When speaking punjabi, prefer punglish (simple punjabi mixed with English).
Avoid long pure-punjabi sentences.

You are speaking to people who may not be fluent in English.

Example speaking style:

Instead of:
"Please provide your property identification number so I can assist you."

Say:
"That’s okay.
I can help you.
May I please have your property ID?"`
;

// Note: VOICE and TEMPERATURE are now loaded dynamically from GCS settings
// They are available in AGENT_SETTINGS.voice and AGENT_SETTINGS.temperature
// after loadAgentSettings() is called at startup.

const TEMPERATURE = 0.2; // Controls the randomness of the AI's responsess
const USE_REALTIME_TRANSCRIPTION = false;
//const PORT = process.env.PORT || 5050; // Allow dynamic port assignment


const PORT = Number(process.env.PORT) || 8080;



// List of Event Types to log to the console. See the OpenAI Realtime API Documentation: https://platform.openai.com/docs/api-reference/realtime
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'response.audio.done',
    'response.audio_transcript.done',
    'response.output_audio.done',
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
    fastify.get('/media-stream', { websocket: true }, async (connection, req) => {
        console.log('Client connected');
        
        // Use settings loaded at startup (AGENT_SETTINGS is already loaded)
        const callSettings = AGENT_SETTINGS || {
            system_message: 'You are a helpful AI assistant.',
            voice: 'sage',
            temperature: 0.2,
            use_realtime_transcription: false
        };
        console.log('✓ Using agent settings:');
        console.log('  - Voice:', callSettings.voice);
        console.log('  - System message length:', callSettings.system_message ? callSettings.system_message.length : 'undefined');
        console.log('  - Temperature:', callSettings.temperature);

        // Connection-specific state
        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;
        let sessionInitialized = false;
        let shouldSendInitialGreeting = true;
        let pendingAudioDeltas = [];
        let callerNumber = null; // Caller phone number (if provided by Twilio)
        let calleeNumber = null; // Called/destination phone number (if provided by Twilio)
        let callSid = null; // Twilio call SID (if provided)
        let webhookBody = null; // Full webhook body if available
        let recordingSid = null; // Twilio recording SID
    let conversationLog = [];
    let callStartTime = new Date();
    let currentResponseText = '';  // Accumulate text deltas
    let allEvents = [];  // Capture ALL events for debugging
    
    // Slot-filling state: collect caller information during the call
    let callState = {
        property_id: null,
        property_name: null,
        caller_name: null,
        caller_email: null,
        issue_description: null,
        is_existing_client: null,
        routing: null, // 'support' or 'sales'
        current_state: 'A' // Track state machine progress (A-H)
    };
    
    // Silence detection state
    let silenceTimer = null;
    let silenceCount = 0;
    let waitingForCaller = false;
    let callerSpokeSinceLastResponse = false;
    let conversationTurns = 0; // Track number of exchanges
    let lastSilencePromptTime = 0; // Prevent rapid-fire silence prompts
    
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

        const openAiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${callSettings.temperature}`, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            console.log('[initializeSession] Using system_message length:', callSettings.system_message ? callSettings.system_message.length : 'undefined', 'voice:', callSettings.voice);
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    type: 'realtime',
                    model: "gpt-realtime",
                    output_modalities: ["audio"],
                    audio: {
                        input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                        output: { format: { type: 'audio/pcmu' }, voice: callSettings.voice },
                    },
                    instructions: callSettings.system_message,
                    tools: [
                        {
                            type: "function",
                            name: "save_caller_info",
                            description: "Save caller information collected during the call. Call this function whenever you learn any caller details like property name/ID, caller name, email, or their issue.",
                            parameters: {
                                type: "object",
                                properties: {
                                    property_id: { type: "string", description: "Property ID if mentioned" },
                                    property_name: { type: "string", description: "Property name if mentioned" },
                                    caller_name: { type: "string", description: "Caller's name" },
                                    caller_email: { type: "string", description: "Caller's email address" },
                                    issue_description: { type: "string", description: "Brief description of their issue or question" },
                                    is_existing_client: { type: "boolean", description: "Whether caller is an existing Update247 client" },
                                    current_state: { type: "string", description: "Current state in the flow (A-H)" }
                                }
                            }
                        },
                        {
                            type: "function",
                            name: "route_call",
                            description: "Record the routing decision once you've determined whether to route to Support or Sales.",
                            parameters: {
                                type: "object",
                                properties: {
                                    routing: { 
                                        type: "string", 
                                        enum: ["support", "sales"],
                                        description: "Route to 'support' for existing clients or 'sales' for new prospects" 
                                    },
                                    reason: { type: "string", description: "Brief reason for routing decision" }
                                },
                                required: ["routing"]
                            }
                        },
                        {
                            type: "function",
                            name: "get_pricing_details",
                            description: "Fetch current Update247 software pricing and plans. Call this when caller asks about pricing, plans, or costs. Property types: Hotel or Vacational Rental.",
                            parameters: {
                                type: "object",
                                properties: {
                                    property_type: { type: "string", description: "Property type: Hotel or Vacational Rental", enum: ["Hotel", "Vacational Rental"] }
                                },
                                required: ["property_type"]
                            }
                        },
                        {
                            type: "function",
                            name: "get_interface_screenshots",
                            description: "Get screenshots of the Update247 interface. Call this when caller wants to see what the software looks like or see interface examples.",
                            parameters: {
                                type: "object",
                                properties: {
                                    feature: { type: "string", description: "Feature to show: dashboard, bookings, reports, or settings", enum: ["dashboard", "bookings", "reports", "settings"] }
                                },
                                required: ["feature"]
                            }
                        }
                    ],
                    tool_choice: "auto"
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
            sessionInitialized = true;
            console.log('[initializeSession] Session initialized. streamSid:', streamSid, 'shouldSendInitialGreeting:', shouldSendInitialGreeting);

            // Send initial greeting only after streamSid is available
            if (streamSid && shouldSendInitialGreeting) {
                console.log('[initializeSession] Conditions met. Calling sendInitialConversationItem now.');
                shouldSendInitialGreeting = false;
                sendInitialConversationItem();
            } else {
                console.log('[initializeSession] NOT calling sendInitialConversationItem. streamSid:', streamSid, 'shouldSendInitialGreeting:', shouldSendInitialGreeting);
            }
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            console.log('[sendInitialConversationItem] Sending initial greeting to OpenAI');
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Say this greeting to the caller: Hi there, this is Lucy from Update 2 4 7. How are you today?'
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
        
        // Handle silence after AI speaks - DISABLED
        // AI will only respond to real caller input, not auto-prompts
        const handleSilence = () => {
            console.log('[handleSilence] Called but DISABLED - AI waits for real caller input');
            return;
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            console.log('[DEBUG] streamSid at OpenAI connect:', streamSid, 'sessionInitialized:', sessionInitialized, 'shouldSendInitialGreeting:', shouldSendInitialGreeting);
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
                console.log(`[EVENT] ${response.type}`);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`[EVENT_DETAIL] ${response.type}`, response);
                }

                // Handle function calls from AI
                if (response.type === 'response.function_call_arguments.done') {
                    const functionName = response.name;
                    const args = JSON.parse(response.arguments || '{}');
                    
                    console.log(`[Function Call] ${functionName}`, args);
                    
                    if (functionName === 'save_caller_info') {
                        // Update callState with provided information
                        if (args.property_id) callState.property_id = args.property_id;
                        if (args.property_name) callState.property_name = args.property_name;
                        if (args.caller_name) callState.caller_name = args.caller_name;
                        if (args.caller_email) callState.caller_email = args.caller_email;
                        if (args.issue_description) callState.issue_description = args.issue_description;
                        if (args.is_existing_client !== undefined) callState.is_existing_client = args.is_existing_client;
                        if (args.current_state) callState.current_state = args.current_state;
                        
                        console.log('[CallState Updated]', callState);
                        
                        // Send function result back to AI
                        const functionOutput = {
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: response.call_id,
                                output: JSON.stringify({ success: true, saved: args })
                            }
                        };
                        openAiWs.send(JSON.stringify(functionOutput));
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                    }
                    
                    if (functionName === 'route_call') {
                        // Record routing decision
                        callState.routing = args.routing;
                        console.log(`[ROUTING DECISION] ${args.routing.toUpperCase()} - Reason: ${args.reason || 'Not specified'}`);
                        
                        // Send function result back to AI
                        const functionOutput = {
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: response.call_id,
                                output: JSON.stringify({ success: true, routed_to: args.routing })
                            }
                        };
                        openAiWs.send(JSON.stringify(functionOutput));
                        openAiWs.send(JSON.stringify({ type: 'response.create' }));
                    }
                    
                    if (functionName === 'get_pricing_details') {
                        const propertyType = args.property_type || 'Hotel';
                        console.log('[Function Call] get_pricing_details - Fetching rates for property type:', propertyType);
                        
                        try {
                            // Call mock rates endpoint
                            const ratesUrl = 'https://testserver.update247.com.au/testaj/mock_rates.php';
                            const ratesResponse = await fetch(ratesUrl);
                            
                            if (!ratesResponse.ok) {
                                throw new Error(`HTTP ${ratesResponse.status}: ${ratesResponse.statusText}`);
                            }
                            
                            const ratesData = await ratesResponse.json();
                            console.log('[Pricing] Successfully fetched rates for property type:', propertyType);
                            
                            const functionOutput = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: response.call_id,
                                    output: JSON.stringify(ratesData)
                                }
                            };
                            openAiWs.send(JSON.stringify(functionOutput));
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        } catch (error) {
                            console.error('[Pricing] Failed to fetch pricing:', error.message);
                            
                            const errorOutput = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: response.call_id,
                                    output: JSON.stringify({ error: 'Unable to retrieve pricing details. Please contact sales for current pricing.', details: error.message })
                                }
                            };
                            openAiWs.send(JSON.stringify(errorOutput));
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        }
                    }

                    if (functionName === 'get_interface_screenshots') {
                        const feature = args.feature || 'dashboard';
                        console.log('[Function Call] get_interface_screenshots - Fetching screenshots for feature:', feature);
                        
                        try {
                            // Call screenshots endpoint
                            const screenshotsUrl = 'https://testserver.update247.com.au/testaj/mock_screenshots.php?feature=' + encodeURIComponent(feature);
                            const screenshotsResponse = await fetch(screenshotsUrl);
                            
                            if (!screenshotsResponse.ok) {
                                throw new Error(`HTTP ${screenshotsResponse.status}: ${screenshotsResponse.statusText}`);
                            }
                            
                            const screenshotsData = await screenshotsResponse.json();
                            console.log('[Screenshots] Successfully fetched screenshots for feature:', feature);
                            
                            const functionOutput = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: response.call_id,
                                    output: JSON.stringify(screenshotsData)
                                }
                            };
                            openAiWs.send(JSON.stringify(functionOutput));
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        } catch (error) {
                            console.error('[Screenshots] Failed to fetch screenshots:', error.message);
                            
                            const errorOutput = {
                                type: 'conversation.item.create',
                                item: {
                                    type: 'function_call_output',
                                    call_id: response.call_id,
                                    output: JSON.stringify({ error: 'Unable to retrieve interface screenshots. Please visit our website for demos.', details: error.message })
                                }
                            };
                            openAiWs.send(JSON.stringify(errorOutput));
                            openAiWs.send(JSON.stringify({ type: 'response.create' }));
                        }
                    }
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    console.log('[CALLER SPEAKING] Speech detected - cancelling silence timer');
                    console.log('  silenceTimer exists:', !!silenceTimer);
                    console.log('  waitingForCaller:', waitingForCaller);
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                    
                    // Cancel silence timer when caller speaks
                    if (silenceTimer) {
                        clearTimeout(silenceTimer);
                        silenceTimer = null;
                        console.log('[Silence Timer] ✓ Cancelled due to caller speech');
                    }
                    waitingForCaller = false;
                    silenceCount = 0; // Reset silence count when caller speaks
                    callerSpokeSinceLastResponse = true;
                    conversationTurns++; // Increment conversation turns
                    console.log('[Conversation] Turn count:', conversationTurns);
                    
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
                
                // When AI finishes speaking audio, DO NOT auto-prompt on silence
                // Only AI should wait for real caller input
                if (response.type === 'response.audio.done' || response.type === 'response.audio_transcript.done') {
                    console.log(`[AI FINISHED AUDIO] ${response.type} - Waiting for real caller input (silence detection disabled)`);
                    // Silence timer disabled - let caller respond naturally
                }
                
                // Also try response.done as fallback - DISABLED
                if (response.type === 'response.done') {
                    console.log('[response.done] Response completed - silence detection disabled');
                    // Silence timer disabled - let caller respond naturally
                }


                if (response.type === 'response.output_audio.delta' && response.delta) {
                    if (!streamSid) {
                        pendingAudioDeltas.push(response.delta);
                        console.log('[audio.delta] Buffered (no streamSid). Pending count:', pendingAudioDeltas.length);
                        return;
                    }
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(audioDelta));
                    if (SHOW_TIMING_MATH) console.log('[audio.delta] Forwarded to Twilio. streamSid:', streamSid, 'payload bytes:', response.delta.length);

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
                    console.log('[input_audio_buffer.committed] Speech buffer committed - waiting for actual speech recognition');
                    // Don't auto-generate response here - wait for actual speech
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                console.log('[Twilio WebSocket] Received event:', data.event);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        
                        // If caller speech is being detected, buffer this audio chunk for later transcription
                        if (isCapturingCallerSpeech && data.media.payload) {
                            callerAudioChunks.push(data.media.payload);
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
                            console.log('[start event] sessionInitialized:', sessionInitialized, 'shouldSendInitialGreeting:', shouldSendInitialGreeting);

                            // Flush any pending audio deltas now that streamSid is available
                            if (pendingAudioDeltas.length > 0) {
                                console.log('[audio.delta] Flushing pending audio. Count:', pendingAudioDeltas.length, 'streamSid:', streamSid);
                                pendingAudioDeltas.forEach((delta) => {
                                    const audioDelta = {
                                        event: 'media',
                                        streamSid: streamSid,
                                        media: { payload: delta }
                                    };
                                    connection.send(JSON.stringify(audioDelta));
                                });
                                pendingAudioDeltas = [];
                            }

                            // If session is ready, send initial greeting now that streamSid is available
                            if (sessionInitialized && shouldSendInitialGreeting) {
                                console.log('[start event] Conditions met. Calling sendInitialConversationItem now.');
                                shouldSendInitialGreeting = false;
                                sendInitialConversationItem();
                            } else {
                                console.log('[start event] NOT calling sendInitialConversationItem. sessionInitialized:', sessionInitialized, 'shouldSendInitialGreeting:', shouldSendInitialGreeting);
                            }

                        // Start call recording via Twilio API
                        if (twilioClient && callSid) {
                            try {
                                twilioClient.calls(callSid)
                                    .recordings
                                    .create({ recordingChannels: 'dual' })
                                    .then(recording => {
                                        recordingSid = recording.sid;
                                        console.log('[Recording] Started recording:', recordingSid);
                                    })
                                    .catch(err => {
                                        console.error('[Recording] Failed to start:', err.message);
                                    });
                            } catch (e) {
                                console.error('[Recording] Error initiating recording:', e.message);
                            }
                        } else if (!callSid) {
                            console.log('[Recording] No callSid available, cannot start recording');
                        }

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
            
            console.log('═══════════════════════════════════════════');
            console.log('[Call Summary] Collected Caller Information:');
            console.log('  Property ID:', callState.property_id || 'Not provided');
            console.log('  Property Name:', callState.property_name || 'Not provided');
            console.log('  Caller Name:', callState.caller_name || 'Not provided');
            console.log('  Caller Email:', callState.caller_email || 'Not provided');
            console.log('  Issue:', callState.issue_description || 'Not provided');
            console.log('  Existing Client:', callState.is_existing_client !== null ? (callState.is_existing_client ? 'Yes' : 'No') : 'Not determined');
            console.log('  Routed To:', callState.routing ? callState.routing.toUpperCase() : 'Not routed');
            console.log('  Final State:', callState.current_state);
            console.log('═══════════════════════════════════════════');
            
            // Extract numbers from webhookBody if not already set
            if (!callerNumber && webhookBody) {
                callerNumber = webhookBody.From || webhookBody.from || null;
            }
            if (!calleeNumber && webhookBody) {
                calleeNumber = webhookBody.To || webhookBody.to || null;
            }
            if (!callSid && webhookBody) {
                callSid = webhookBody.CallSid || webhookBody.callSid || null;
            }
            
            const callEndTime = new Date();
            const duration = Math.round((callEndTime - callStartTime) / 1000); // Duration in seconds
            
            // Format: call-<callerNumber>-<toNumber>-<dd>-<mon>-<yyyy>-<hh>-<mm>.json
            const sanitize = (s) => (String(s || '')).replace(/[^0-9]/g, '') || 'unknown';
            const callerFormatted = sanitize(callerNumber);
            const calleeFormatted = sanitize(calleeNumber);
            
            const dd = String(callStartTime.getDate()).padStart(2, '0');
            const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
            const mon = monthNames[callStartTime.getMonth()];
            const yyyy = callStartTime.getFullYear();
            const hh = String(callStartTime.getHours()).padStart(2, '0');
            const min = String(callStartTime.getMinutes()).padStart(2, '0');
            
            const filename = `call-from-${callerFormatted}-to-${calleeFormatted}-${dd}-${mon}-${yyyy}-${hh}-${min}.json`;

            const transcript = {
                callId: streamSid,
                callSid: callSid,
                recordingSid: recordingSid,
                callerNumber: callerNumber,
                calleeNumber: calleeNumber,
                callState: callState,
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

// Load agent settings from GCS and start the server
loadAgentSettings().then((settings) => {
    AGENT_SETTINGS = settings;
    
    fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        console.log(`Server is listening on port ${PORT}`);
    });
}).catch((error) => {
    console.error('Failed to load agent settings:', error);
    process.exit(1);
});

