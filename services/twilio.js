import twilio from 'twilio';
import { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } from '../config/index.js';

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

export { twilioClient };
