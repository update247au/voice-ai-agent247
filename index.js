import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();

// Retrieve the OpenAI API key from environment variables.
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key. Please set it in the .env file.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = 'You are the AI Support Specialist for Update247 Channel Manager. Your purpose is to act as a knowledgeable and friendly support staff member, assisting accommodation providers with questions, guidance, and basic troubleshooting. Website: https://www.update247.com.au/ Responsibilities: Explain Update247 benefits (real-time sync, preventing overbookings); Guide users on managing rates, availability, and OTA connections; Troubleshoot sync issues. Tone: Professional, friendly, and supportive. LANGUAGE: You must ALWAYS speak and respond in English only. LIMITATIONS: Do NOT access credentials, make account changes, or provide legal/financial advice. ESCALATION: For account-specific issues, billing, or complex connectivity problems, direct the user to contact Update247 support.';
const VOICE = 'alloy';
// const VOICE = 'sage';
//const VOICE = 'marin';
const TEMPERATURE = 0.4; // Controls the randomness of the AI's responses
const SPEAKING_RATE = 0.85; // Controls the speed of the AI's speech
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

// Tool Definitions
const TOOLS = [
    {
        type: 'function',
        name: 'query_update247_details',
        description: 'Get information about Update247 rates, availability, or general platform status. Use this whenever the user asks for specific data about their account or the system.',
        parameters: {
            type: 'object',
            properties: {
                query_type: {
                    type: 'string',
                    enum: ['availability', 'rates', 'connection_status'],
                    description: 'The type of information to retrieve.'
                },
                details: {
                    type: 'string',
                    description: 'Specific details about the query (e.g., date range, room type).'
                }
            },
            required: ['query_type']
        }
    }
];

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say voice="Google.en-US-Chirp3-HD-Aoede">Please wait while we connect your call to Update 2 4 7 friendly support agent</Say>
                              <Pause length="1"/>
                              <Say voice="Google.en-US-Chirp3-HD-Aoede">O.K., please tell me how can we assist you today in few words</Say>
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
                    tools: TOOLS,
                    tool_choice: 'auto',
                    temperature: TEMPERATURE,
                },
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first:
            // sendInitialConversationItem();
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
                            text: 'Greet the user with "Hello! I am the Update247 AI Support Specialist. I can answer your questions about the Channel Manager, help with troubleshooting, or guide you through our features. How can I help you today?"'
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
                if (response.type === 'response.function_call_arguments.done') {
                    console.log('Function call triggered:', response);
                    const iframe = response.arguments;
                    const callId = response.call_id;
                    const functionName = response.name;

                    let functionResult = "I couldn't find that information.";

                    // Handle specific function callss
                    if (functionName === 'query_update247_details') {
                        const args = JSON.parse(iframe);
                        console.log('Executing query_update247_details with args:', args);

                        // Real API Call Logic
                        try {
                            const API_BASE_URL = 'https://testserver.update247.com.au/testaj'; // <--- PLEASE UPDATE THIS URL
                            let url = '';

                            if (args.query_type === 'availability') {
                                url = `${API_BASE_URL}/mock_availability.php`;
                            } else if (args.query_type === 'rates') {
                                url = `${API_BASE_URL}/mock_rates.php`;
                            } else if (args.query_type === 'booking_details') {
                                url = `${API_BASE_URL}/mock_booking_details.php`;
                            } else if (args.query_type === 'connection_status') {
                                // Fallback mock for connection status if no file exists
                                functionResult = JSON.stringify({ status: 'success', data: 'All channel connections are active.' });
                            }

                            if (url) {
                                console.log(`Fetching data from: ${url}`);
                                const apiResponse = await fetch(url);
                                const data = await apiResponse.json();
                                functionResult = JSON.stringify(data);
                            }
                        } catch (err) {
                            console.error('Error fetching data:', err);
                            functionResult = "There was an error retrieving the information. Please check the system logs.";
                        }
                    }

                    // Send the result back to OpenAI
                    const functionOutputEvent = {
                        type: 'conversation.item.create',
                        item: {
                            type: 'function_call_output',
                            call_id: callId,
                            output: functionResult
                        }
                    };
                    openAiWs.send(JSON.stringify(functionOutputEvent));

                    // Trigger a new response to speak the result
                    openAiWs.send(JSON.stringify({ type: 'response.create' }));
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

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
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
