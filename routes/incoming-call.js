// Incoming call route handler

// In-memory store for webhook bodies keyed by CallSid
export const callMeta = {};

// Register incoming call route
export const registerIncomingCallRoute = (fastify) => {
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
            // Escape ampersands for safe XML embedding
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
            const safeTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">The application encountered an error. Goodbye.</Say></Response>`;
            try { 
                reply.type('text/xml').status(200).send(safeTwiml); 
            } catch (e) { 
                console.error('[ERROR] Failed to send fallback TwiML:', e); 
            }
        }
    });
};

// Get webhook body for a call
export const getCallMeta = (callSid) => {
    if (callSid && callMeta[callSid]) {
        const meta = callMeta[callSid];
        delete callMeta[callSid]; // Free memory after retrieval
        return meta;
    }
    return null;
};
