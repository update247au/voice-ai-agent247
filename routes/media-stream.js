// Media stream WebSocket route handler

import WebSocket from 'ws';
import { OPENAI_API_KEY, LOG_EVENT_TYPES, SHOW_TIMING_MATH, USE_REALTIME_TRANSCRIPTION } from '../config/index.js';
import { getTwilioClient, startRecording } from '../services/twilio.js';
import { lookupPropertyByPhone } from '../services/phoneLookup.js';
import { transcribeAudio } from '../services/transcription.js';
import { saveTranscriptToStorage, saveBackupTranscript } from '../services/storage.js';
import { sendCallTranscriptEmail } from '../services/email.js';
import { createInactivityHandler } from '../handlers/inactivity.js';
import { createSessionUpdate, createInitialGreeting, getOpenAIWebSocketUrl, getOpenAIWebSocketHeaders } from '../handlers/openaiSession.js';
import { 
    handleSaveCallerInfo, 
    handleRouteCall, 
    handleGetPricingDetails, 
    handleGetInterfaceScreenshots,
    handleEndCall 
} from '../handlers/functions.js';
import { 
    createInitialCallState, 
    parseUrlParams, 
    generateTranscriptFilename, 
    generateBackupFilename,
    calculateTokenCost,
    estimateTokensFromConversation 
} from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { callMeta } from './incoming-call.js';

// Register media stream WebSocket route
export const registerMediaStreamRoute = (fastify, agentSettings) => {
    fastify.register(async (fastify) => {
        fastify.get('/media-stream', { websocket: true }, async (connection, req) => {
            console.log('========== NEW WEBSOCKET CONNECTION ==========');
            console.log('Client connected');
            console.log('[ENTRY] WebSocket URL:', req.url);
            
            // Use settings loaded at startup
            const callSettings = agentSettings || {
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
            let callerNumber = null;
            let calleeNumber = null;
            let callSid = null;
            let webhookBody = null;
            let recordingSid = null;
            let conversationLog = [];
            let callStartTime = new Date();
            let allEvents = [];
            
            // Silence detection state
            let silenceTimer = null;
            let silenceCount = 0;
            let waitingForCaller = false;
            let callerSpokeSinceLastResponse = false;
            let conversationTurns = 0;
            
            // For caller speech transcription
            let isCapturingCallerSpeech = false;
            let callerAudioChunks = [];
            
            // Initialize call state
            let callState = createInitialCallState(callStartTime);

            // Parse URL parameters
            const urlParams = parseUrlParams(req.url || '');
            if (urlParams.from) callerNumber = urlParams.from;
            if (urlParams.to) calleeNumber = urlParams.to;
            if (urlParams.callSid) callSid = urlParams.callSid;
            console.log('[DEBUG] Parsed from URL - from:', callerNumber, 'to:', calleeNumber, 'callSid:', callSid);

            // Try to attach saved webhook body
            if (callSid && callMeta[callSid]) {
                webhookBody = callMeta[callSid].webhookBody || null;
                console.log('[DEBUG] Attached webhook body from callMeta');
            }

            // Create OpenAI WebSocket connection
            const openAiWs = new WebSocket(getOpenAIWebSocketUrl(callSettings.temperature), {
                headers: getOpenAIWebSocketHeaders()
            });

            // Create inactivity handler
            const inactivityHandler = createInactivityHandler(openAiWs);

            // Initialize OpenAI session
            const initializeSession = () => {
                console.log('[initializeSession] Using system_message length:', callSettings.system_message ? callSettings.system_message.length : 'undefined', 'voice:', callSettings.voice);
                const sessionUpdate = createSessionUpdate(callSettings);
                console.log('Sending session update:', JSON.stringify(sessionUpdate));
                openAiWs.send(JSON.stringify(sessionUpdate));
                sessionInitialized = true;

                if (streamSid && shouldSendInitialGreeting) {
                    console.log('[initializeSession] Conditions met. Sending initial greeting.');
                    shouldSendInitialGreeting = false;
                    sendInitialConversationItem();
                }
            };

            // Send initial greeting
            const sendInitialConversationItem = () => {
                console.log('[sendInitialConversationItem] Sending initial greeting to OpenAI');
                const greetingText = callSettings.initial_greeting || 'Greet the user with : Hi there, How are you today?';
                const initialConversationItem = createInitialGreeting(greetingText);
                openAiWs.send(JSON.stringify(initialConversationItem));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
            };

            // Handle speech interruption
            const handleSpeechStartedEvent = () => {
                if (markQueue.length > 0 && responseStartTimestampTwilio != null) {
                    const elapsedTime = latestMediaTimestamp - responseStartTimestampTwilio;

                    if (lastAssistantItem) {
                        const truncateEvent = {
                            type: 'conversation.item.truncate',
                            item_id: lastAssistantItem,
                            content_index: 0,
                            audio_end_ms: elapsedTime
                        };
                        openAiWs.send(JSON.stringify(truncateEvent));
                    }

                    connection.send(JSON.stringify({
                        event: 'clear',
                        streamSid: streamSid
                    }));

                    markQueue = [];
                    lastAssistantItem = null;
                    responseStartTimestampTwilio = null;
                }
            };

            // Send mark to Twilio
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

            // Transcribe caller audio
            const transcribeCallerAudio = async () => {
                const transcribedText = await transcribeAudio(callerAudioChunks);
                if (transcribedText) {
                    conversationLog.push({
                        role: 'user',
                        content: transcribedText,
                        timestamp: new Date().toISOString()
                    });
                    console.log(`[Transcript] User: ${transcribedText}`);
                }
                callerAudioChunks = [];
            };

            // OpenAI WebSocket open handler
            openAiWs.on('open', async () => {
                console.log('Connected to the OpenAI Realtime API');
                setTimeout(initializeSession, 100);
            });

            // OpenAI WebSocket message handler
            openAiWs.on('message', async (data) => {
                try {
                    const response = JSON.parse(data);

                    allEvents.push({
                        type: response.type,
                        keys: Object.keys(response),
                        timestamp: new Date().toISOString()
                    });

                    console.log(`[EVENT] ${response.type}`);

                    if (LOG_EVENT_TYPES.includes(response.type)) {
                        console.log(`[EVENT_DETAIL] ${response.type}`, response);
                    }

                    // Handle rate_limits.updated for token tracking
                    if (response.type === 'rate_limits.updated') {
                        if (response.rate_limits) {
                            callState.tokens_input = response.rate_limits.input_tokens || 0;
                            callState.tokens_output = response.rate_limits.output_tokens || 0;
                            callState.cost_dollars = calculateTokenCost(
                                callState.tokens_input, 
                                callState.tokens_output, 
                                callSettings.pricing
                            );
                            console.log(`[TOKENS] Input: ${callState.tokens_input}, Output: ${callState.tokens_output}, Cost: $${callState.cost_dollars.toFixed(6)}`);
                        }
                    }

                    // Handle function calls
                    if (response.type === 'response.function_call_arguments.done') {
                        const functionName = response.name;
                        const args = JSON.parse(response.arguments || '{}');
                        console.log(`[Function Call] ${functionName}`, args);

                        if (functionName === 'save_caller_info') {
                            callState = handleSaveCallerInfo(args, callState, callerNumber, response, openAiWs);
                        }
                        
                        if (functionName === 'route_call') {
                            callState = handleRouteCall(args, callState, response, openAiWs);
                        }
                        
                        if (functionName === 'get_pricing_details') {
                            await handleGetPricingDetails(args, response, openAiWs);
                        }

                        if (functionName === 'get_interface_screenshots') {
                            await handleGetInterfaceScreenshots(args, response, openAiWs);
                        }

                        if (functionName === 'end_call') {
                            callState = await handleEndCall(args, callState, callSid, response, openAiWs, connection);
                        }
                    }

                    // Handle caller speech detection
                    if (response.type === 'input_audio_buffer.speech_started') {
                        console.log('[CALLER SPEAKING] Speech detected');
                        
                        if (silenceTimer) {
                            clearTimeout(silenceTimer);
                            silenceTimer = null;
                        }
                        
                        inactivityHandler.resetInactivityTimer();
                        
                        waitingForCaller = false;
                        silenceCount = 0;
                        callerSpokeSinceLastResponse = true;
                        conversationTurns++;
                        
                        if (!USE_REALTIME_TRANSCRIPTION) {
                            isCapturingCallerSpeech = true;
                            callerAudioChunks = [];
                        }
                    }

                    // Handle realtime transcription
                    if (
                        response.type === 'input_audio_transcript.done' ||
                        response.type === 'input_audio_transcription.done'
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

                    // Capture conversation items
                    if (response.type === 'conversation.item.added' && response.item) {
                        const item = response.item;
                        
                        if (item.role === 'user' && item.content && Array.isArray(item.content)) {
                            const textContent = item.content.find(c => c.type === 'input_text');
                            if (textContent && textContent.text) {
                                conversationLog.push({
                                    role: 'user',
                                    content: textContent.text,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                        
                        if (item.role === 'assistant' && item.content && Array.isArray(item.content)) {
                            const textContent = item.content.find(c => c.type === 'text');
                            if (textContent && textContent.text) {
                                conversationLog.push({
                                    role: 'assistant',
                                    content: textContent.text,
                                    timestamp: new Date().toISOString()
                                });
                            }
                        }
                    }

                    // Capture assistant transcript
                    if (response.type === 'response.output_audio_transcript.done' && response.transcript) {
                        const lastEntry = conversationLog[conversationLog.length - 1];
                        if (!lastEntry || lastEntry.content !== response.transcript || lastEntry.role !== 'assistant') {
                            conversationLog.push({
                                role: 'assistant',
                                content: response.transcript,
                                timestamp: new Date().toISOString()
                            });
                        }
                    }
                    
                    // Start inactivity timer when AI finishes speaking
                    if (response.type === 'response.audio.done' || response.type === 'response.done') {
                        inactivityHandler.startInactivityTimer();
                    }

                    // Handle audio output
                    if (response.type === 'response.output_audio.delta' && response.delta) {
                        if (!streamSid) {
                            pendingAudioDeltas.push(response.delta);
                            return;
                        }
                        
                        const audioDelta = {
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: response.delta }
                        };
                        connection.send(JSON.stringify(audioDelta));

                        if (!responseStartTimestampTwilio) {
                            responseStartTimestampTwilio = latestMediaTimestamp;
                        }

                        if (response.item_id) {
                            lastAssistantItem = response.item_id;
                        }

                        sendMark(connection, streamSid);
                    }

                    // Handle speech stopped
                    if (response.type === 'input_audio_buffer.speech_stopped') {
                        handleSpeechStartedEvent();
                        
                        if (!USE_REALTIME_TRANSCRIPTION && isCapturingCallerSpeech) {
                            isCapturingCallerSpeech = false;
                            transcribeCallerAudio().catch(err => console.error('[Whisper] Transcription error:', err));
                        }
                    }

                } catch (error) {
                    console.error('Error processing OpenAI message:', error);
                }
            });

            // Twilio WebSocket message handler
            connection.on('message', (message) => {
                try {
                    const data = JSON.parse(message);

                    switch (data.event) {
                        case 'media':
                            latestMediaTimestamp = data.media.timestamp;
                            
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
                            
                            // Extract caller info from start event
                            callSid = data.start.callSid || data.start.CallSid || callSid || null;
                            callerNumber = data.start.from || data.start.From || callerNumber || null;
                            calleeNumber = data.start.to || data.start.To || calleeNumber || null;

                            // Process parameters
                            const params = data.start.parameters || null;
                            if (params) {
                                if (Array.isArray(params)) {
                                    params.forEach((p) => {
                                        if (p && p.name && p.value) {
                                            const nameLC = p.name.toLowerCase();
                                            if (nameLC === 'from') callerNumber = p.value;
                                            if (nameLC === 'to') calleeNumber = p.value;
                                            if (nameLC === 'callsid') callSid = p.value;
                                        }
                                    });
                                } else if (typeof params === 'object') {
                                    Object.entries(params).forEach(([k, v]) => {
                                        const keyLC = String(k).toLowerCase();
                                        if (keyLC === 'from') callerNumber = v;
                                        if (keyLC === 'to') calleeNumber = v;
                                        if (keyLC === 'callsid') callSid = v;
                                    });
                                }
                            }

                            // Attach webhook body
                            if (callSid && callMeta[callSid]) {
                                webhookBody = callMeta[callSid].webhookBody || null;
                                delete callMeta[callSid];
                            }

                            if (!callerNumber && webhookBody) {
                                callerNumber = webhookBody.From || webhookBody.from || null;
                            }

                            console.log('Stream started:', streamSid, 'caller:', callerNumber, 'callee:', calleeNumber, 'callSid:', callSid);

                            // Phone lookup
                            (async () => {
                                if (callerNumber) {
                                    callState.phone_lookup_performed = true;
                                    const propertyData = await lookupPropertyByPhone(callerNumber);
                                    if (propertyData) {
                                        callState.property_id = propertyData.property_id;
                                        callState.property_name = propertyData.property_name;
                                        callState.phone_lookup_found = true;
                                        callState.phone_lookup_source = 'phone-mappings.json';
                                        console.log('[Phone Lookup] Pre-populated:', callState.property_name, callState.property_id);
                                    } else {
                                        callState.phone_lookup_found = false;
                                    }
                                } else {
                                    callState.phone_lookup_performed = true;
                                    callState.phone_lookup_found = false;
                                }
                            })();

                            // Flush pending audio
                            if (pendingAudioDeltas.length > 0) {
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

                            // Send initial greeting if ready
                            if (sessionInitialized && shouldSendInitialGreeting) {
                                shouldSendInitialGreeting = false;
                                sendInitialConversationItem();
                            }

                            // Start recording
                            if (callSid) {
                                startRecording(callSid).then(result => {
                                    if (result.success) {
                                        recordingSid = result.recordingSid;
                                    }
                                });
                            }

                            responseStartTimestampTwilio = null;
                            latestMediaTimestamp = 0;
                            break;
                            
                        case 'stop':
                            console.log('[Twilio stop] Call ended. Saving transcript.');
                            saveTranscript().catch(err => console.error('[Twilio stop] Error:', err));
                            break;
                            
                        case 'mark':
                            if (markQueue.length > 0) {
                                markQueue.shift();
                            }
                            break;
                    }
                } catch (error) {
                    console.error('Error parsing Twilio message:', error);
                }
            });

            // Save transcript function
            const saveTranscript = async () => {
                logger.callSummary(callState, callerNumber, calleeNumber);

                // Estimate tokens if not captured
                if (callState.tokens_input === 0 && callState.tokens_output === 0 && conversationLog.length > 0) {
                    const estimated = estimateTokensFromConversation(conversationLog);
                    callState.tokens_input = estimated.input;
                    callState.tokens_output = estimated.output;
                    callState.cost_dollars = calculateTokenCost(callState.tokens_input, callState.tokens_output, callSettings.pricing);
                }

                logger.tokenUsage(callState);

                // Extract info from webhook if needed
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
                const duration = Math.round((callEndTime - callStartTime) / 1000);
                callState.call_duration_seconds = duration;
                callState.call_end_time = callEndTime.toISOString();

                logger.callTiming(callStartTime, callEndTime, duration);

                const filename = generateTranscriptFilename(callerNumber, calleeNumber, callStartTime);

                const transcript = {
                    callId: streamSid,
                    callSid: callSid,
                    recordingSid: recordingSid,
                    callerNumber: callerNumber,
                    calleeNumber: calleeNumber,
                    callState: callState,
                    phoneLookup: {
                        performed: callState.phone_lookup_performed,
                        found: callState.phone_lookup_found,
                        source: callState.phone_lookup_source,
                        property_id: callState.phone_lookup_found ? callState.property_id : null,
                        property_name: callState.phone_lookup_found ? callState.property_name : null
                    },
                    demoBooking: {
                        demo_preferred_date: callState.demo_preferred_date || null,
                        demo_preferred_time: callState.demo_preferred_time || null,
                        caller_name: callState.caller_name || null,
                        property_name: callState.property_name || null,
                        intent: callState.intent || null
                    },
                    tokenUsage: {
                        input_tokens: callState.tokens_input,
                        output_tokens: callState.tokens_output,
                        total_tokens: callState.tokens_input + callState.tokens_output,
                        estimated_cost_usd: parseFloat(callState.cost_dollars.toFixed(6)),
                        call_duration_seconds: duration,
                        call_duration_formatted: Math.floor(duration / 60) + 'm ' + (duration % 60) + 's',
                        call_start_time: callStartTime.toISOString(),
                        call_end_time: callEndTime.toISOString()
                    },
                    disconnectInfo: {
                        disconnected_by: callState.disconnected_by || 'unknown',
                        disconnect_reason: callState.disconnect_reason || 'unknown',
                        ended_by_agent: callState.ended_by_agent || false
                    },
                    webhookBody: webhookBody || null,
                    startTime: callStartTime.toISOString(),
                    endTime: callEndTime.toISOString(),
                    duration: duration,
                    conversation: conversationLog.length > 0 ? conversationLog : [{
                        role: 'note',
                        content: 'No conversation items captured during this call.',
                        timestamp: new Date().toISOString()
                    }]
                };

                const payload = JSON.stringify(transcript, null, 2);

                // Save to storage
                await saveTranscriptToStorage(filename, payload);

                // Create backup
                const backupFilename = generateBackupFilename(callerNumber, callSid, streamSid);
                await saveBackupTranscript(backupFilename, payload);

                // Send email notification
                await sendCallTranscriptEmail(transcript, filename);
            };

            // Connection close handler
            connection.on('close', () => {
                console.log('[connection.close] Handler fired.');
                
                if (!callState.disconnected_by) {
                    callState.disconnected_by = 'caller';
                    callState.disconnect_reason = 'caller_hangup';
                    console.log('[connection.close] Caller disconnected the call.');
                } else {
                    console.log(`[connection.close] Call was disconnected by: ${callState.disconnected_by}`);
                }
                
                inactivityHandler.clearTimers();
                
                if (openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.close();
                }
                
                saveTranscript().catch(err => console.error('[connection.close] Error saving transcript:', err));
                console.log('Client disconnected.');
            });

            // OpenAI WebSocket close handler
            openAiWs.on('close', (code, reason) => {
                console.log(`Disconnected from OpenAI. Code: ${code}, Reason: ${reason}`);
            });

            // OpenAI WebSocket error handler
            openAiWs.on('error', (error) => {
                console.error('Error in OpenAI WebSocket:', error);
            });
        });
    });
};
