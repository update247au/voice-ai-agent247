import twilio from 'twilio';
import { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, SERVER_PUBLIC_URL } from '../config/index.js';

let twilioClient = null;

// Initialize Twilio client
export const initializeTwilio = () => {
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
        twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
        console.log('Twilio client initialized for call recording');
    } else {
        console.log('Twilio credentials not set - call recording disabled');
    }
    return twilioClient;
};

// Get Twilio client instance
export const getTwilioClient = () => twilioClient;

// End a call via Twilio
export const endCall = async (callSid) => {
    if (!twilioClient || !callSid) {
        console.log('[Twilio] Cannot end call: No client or callSid available');
        return { success: false, error: 'No Twilio client or callSid' };
    }

    try {
        await twilioClient.calls(callSid).update({ status: 'completed' });
        console.log('[END CALL] ✓ Call ended successfully via Twilio');
        return { success: true };
    } catch (err) {
        console.error('[END CALL] ✗ Failed to end call via Twilio:', err.message);
        return { success: false, error: err.message };
    }
};

// Start call recording
export const startRecording = async (callSid) => {
    if (!twilioClient || !callSid) {
        console.log('[Recording] Cannot start: No client or callSid available');
        return { success: false, recordingSid: null };
    }

    try {
        const recording = await twilioClient.calls(callSid)
            .recordings
            .create({ recordingChannels: 'dual' });
        
        console.log('[Recording] Started recording:', recording.sid);
        return { success: true, recordingSid: recording.sid };
    } catch (err) {
        console.error('[Recording] Failed to start:', err.message);
        return { success: false, recordingSid: null, error: err.message };
    }
};

// Check recording status
export const getRecordingStatus = async (recordingSid) => {
    if (!twilioClient || !recordingSid) {
        return { status: 'error', error: 'No client or recordingSid' };
    }

    try {
        const recording = await twilioClient.recordings(recordingSid).fetch();
        return { 
            status: recording.status, 
            duration: recording.duration,
            uri: recording.uri
        };
    } catch (err) {
        console.error('[Recording] Failed to get status:', err.message);
        return { status: 'error', error: err.message };
    }
};

// Download recording from Twilio (with retry for processing delay)
export const downloadRecording = async (recordingSid, options = {}) => {
    const {
        maxRetries = 10,
        initialDelayMs = 30000,  // Wait 30s before first attempt
        retryDelayMs = 15000,    // Wait 15s between retries
        format = 'mp3'           // mp3 or wav
    } = options;

    if (!twilioClient || !recordingSid) {
        console.log('[Recording Download] Cannot download: No client or recordingSid');
        return { success: false, error: 'No client or recordingSid' };
    }

    console.log(`[Recording Download] Waiting ${initialDelayMs/1000}s before first attempt...`);
    await sleep(initialDelayMs);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[Recording Download] Attempt ${attempt}/${maxRetries} for ${recordingSid}`);
            
            // Check if recording is ready
            const recording = await twilioClient.recordings(recordingSid).fetch();
            
            if (recording.status !== 'completed') {
                console.log(`[Recording Download] Status: ${recording.status}, waiting...`);
                if (attempt < maxRetries) {
                    await sleep(retryDelayMs);
                    continue;
                }
                return { success: false, error: `Recording not ready after ${maxRetries} attempts. Status: ${recording.status}` };
            }

            // Recording is ready - download it
            const mediaUrl = `https://api.twilio.com${recording.uri.replace('.json', `.${format}`)}`;
            console.log(`[Recording Download] Downloading from: ${mediaUrl}`);

            const response = await fetch(mediaUrl, {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            console.log(`[Recording Download] ✓ Downloaded ${buffer.length} bytes`);
            return { 
                success: true, 
                buffer: buffer,
                duration: recording.duration,
                format: format,
                contentType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
                filename: `recording-${recordingSid}.${format}`
            };

        } catch (err) {
            console.error(`[Recording Download] Attempt ${attempt} failed:`, err.message);
            if (attempt < maxRetries) {
                await sleep(retryDelayMs);
            }
        }
    }

    return { success: false, error: `Failed after ${maxRetries} attempts` };
};

// Helper sleep function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Make an outbound call
export const makeOutboundCall = async (toNumber, context = {}) => {
    if (!twilioClient) {
        return { success: false, error: 'Twilio client not initialized' };
    }
    if (!TWILIO_PHONE_NUMBER) {
        return { success: false, error: 'TWILIO_PHONE_NUMBER not configured' };
    }
    if (!toNumber) {
        return { success: false, error: 'No phone number provided' };
    }

    try {
        // Build the TwiML URL with context as query params
        const contextEncoded = encodeURIComponent(JSON.stringify(context));
        const twimlUrl = `https://${SERVER_PUBLIC_URL}/outbound-twiml?context=${contextEncoded}&to=${encodeURIComponent(toNumber)}`;

        console.log('[Outbound Call] Creating call to:', toNumber, 'from:', TWILIO_PHONE_NUMBER);

        const call = await twilioClient.calls.create({
            to: toNumber,
            from: TWILIO_PHONE_NUMBER,
            url: twimlUrl,
            statusCallback: `https://${SERVER_PUBLIC_URL}/outbound-status`,
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallbackMethod: 'POST'
        });

        console.log('[Outbound Call] ✓ Call created:', call.sid);
        return { success: true, callSid: call.sid, to: toNumber, from: TWILIO_PHONE_NUMBER };
    } catch (err) {
        console.error('[Outbound Call] ✗ Failed:', err.message);
        return { success: false, error: err.message };
    }
};

export { twilioClient };
