// Outbound call route handlers

import { makeOutboundCall } from '../services/twilio.js';
import { OUTBOUND_CALL_CONFIG, SERVER_PUBLIC_URL } from '../config/index.js';

// In-memory store for outbound call context (message, reason, etc.)
export const outboundCallContext = {};

// Register outbound call routes
export const registerOutboundCallRoute = (fastify) => {

    // ─── POST /api/outbound-call ───
    // Webhook to trigger an AI-initiated outbound call
    fastify.post('/api/outbound-call', async (request, reply) => {
        try {
            // Authenticate
            const apiKey = request.headers['x-api-key'] || request.body?.api_key;
            if (OUTBOUND_CALL_CONFIG.API_KEY && apiKey !== OUTBOUND_CALL_CONFIG.API_KEY) {
                return reply.status(401).send({ success: false, error: 'Invalid or missing API key' });
            }

            if (!OUTBOUND_CALL_CONFIG.ENABLED) {
                return reply.status(403).send({ success: false, error: 'Outbound calls are not enabled' });
            }

            const { phone_number, message, reason, caller_name, property_name, property_id, greeting } = request.body || {};

            if (!phone_number) {
                return reply.status(400).send({ success: false, error: 'Missing required field: phone_number' });
            }

            // Validate phone number format (basic: must start with + and have digits)
            const phoneRegex = /^\+[1-9]\d{6,14}$/;
            if (!phoneRegex.test(phone_number)) {
                return reply.status(400).send({ 
                    success: false, 
                    error: 'Invalid phone_number format. Must be E.164 format (e.g., +61412345678)' 
                });
            }

            // Build context for the AI agent
            const callContext = {
                direction: 'outbound',
                message: message || null,
                reason: reason || null,
                caller_name: caller_name || null,
                property_name: property_name || null,
                property_id: property_id || null,
                greeting: greeting || OUTBOUND_CALL_CONFIG.DEFAULT_GREETING,
                initiated_at: new Date().toISOString()
            };

            console.log('[Outbound Call API] Request:', { phone_number, reason, caller_name, property_name });

            // Make the outbound call via Twilio
            const result = await makeOutboundCall(phone_number, callContext);

            if (!result.success) {
                return reply.status(500).send({ success: false, error: result.error });
            }

            // Store context so the media-stream can access it when the call connects
            outboundCallContext[result.callSid] = callContext;

            // Clean up context after 5 minutes (in case call never connects)
            setTimeout(() => {
                delete outboundCallContext[result.callSid];
            }, 5 * 60 * 1000);

            return reply.status(200).send({
                success: true,
                message: 'Outbound call initiated',
                callSid: result.callSid,
                to: result.to,
                from: result.from
            });

        } catch (err) {
            console.error('[Outbound Call API] Error:', err.message);
            return reply.status(500).send({ success: false, error: err.message });
        }
    });

    // ─── POST /outbound-twiml ───
    // Twilio requests this when the outbound call is answered
    // Returns TwiML that connects the call to the media-stream WebSocket
    fastify.all('/outbound-twiml', async (request, reply) => {
        try {
            const body = request.body || {};
            const query = request.query || {};

            const callSid = body.CallSid || body.callSid || '';
            const to = body.To || body.to || query.to || '';
            const from = body.From || body.from || '';
            const contextParam = query.context || '';

            // Parse context from query param
            let context = {};
            try {
                if (contextParam) {
                    context = JSON.parse(decodeURIComponent(contextParam));
                }
            } catch (e) {
                console.log('[Outbound TwiML] Could not parse context:', e.message);
            }

            // Store context with callSid if not already stored
            if (callSid && context && !outboundCallContext[callSid]) {
                outboundCallContext[callSid] = context;
            }

            console.log('[Outbound TwiML] Call answered. CallSid:', callSid, 'To:', to);

            const fromEsc = encodeURIComponent(from || '');
            const toEsc = encodeURIComponent(to || '');
            const callSidEsc = encodeURIComponent(callSid || '');

            const streamUrl = `wss://${SERVER_PUBLIC_URL}/media-stream?from=${fromEsc}&to=${toEsc}&callSid=${callSidEsc}&direction=outbound`;
            const streamUrlXml = streamUrl.replace(/&/g, '&amp;');

            const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Pause length="1"/>
                    <Connect>
                        <Stream url="${streamUrlXml}">
                            <Parameter name="from" value="${from}" />
                            <Parameter name="to" value="${to}" />
                            <Parameter name="callSid" value="${callSid}" />
                            <Parameter name="direction" value="outbound" />
                        </Stream>
                    </Connect>
                </Response>`;

            reply.type('text/xml').status(200).send(twimlResponse);
        } catch (err) {
            console.error('[Outbound TwiML] Error:', err.message);
            const safeTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Sorry, the system encountered an error. Goodbye.</Say></Response>`;
            reply.type('text/xml').status(200).send(safeTwiml);
        }
    });

    // ─── POST /outbound-status ───
    // Twilio status callback for outbound calls
    fastify.post('/outbound-status', async (request, reply) => {
        const body = request.body || {};
        const callSid = body.CallSid || '';
        const status = body.CallStatus || '';

        console.log(`[Outbound Status] CallSid: ${callSid}, Status: ${status}`);

        if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
            // Clean up stored context
            delete outboundCallContext[callSid];
        }

        reply.status(200).send({ received: true });
    });

    // ─── GET /api/outbound-call/health ───
    fastify.get('/api/outbound-call/health', async (request, reply) => {
        reply.send({
            enabled: OUTBOUND_CALL_CONFIG.ENABLED,
            api_key_required: !!OUTBOUND_CALL_CONFIG.API_KEY,
            active_calls: Object.keys(outboundCallContext).length
        });
    });
};

// Get outbound call context for a callSid
export const getOutboundContext = (callSid) => {
    if (callSid && outboundCallContext[callSid]) {
        const context = outboundCallContext[callSid];
        delete outboundCallContext[callSid]; // Free memory after retrieval
        return context;
    }
    return null;
};
