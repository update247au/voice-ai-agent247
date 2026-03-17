// Call Log API service - sends call data to external logging server

import { CALL_LOG_API_CONFIG } from '../config/index.js';

/**
 * Send call log data to external API
 * 
 * @param {Object} callData - The call data to log
 * @param {string} callData.callerNumber - Caller's phone number
 * @param {Object} callData.callState - Call state with property info, issue, etc.
 * @param {Object} callData.transcript - Full transcript object
 * @param {string} callData.transcriptionText - AssemblyAI transcription text (optional)
 * @param {string} callData.transcriptionUrl - URL to transcription text file in GCS (optional)
 * @param {string} callData.recordingUrl - URL to call recording file in GCS (optional)
 * @returns {Object} { success: boolean, log_id?: number, message?: string, error?: string }
 */
export const sendCallLog = async (callData) => {
    if (!CALL_LOG_API_CONFIG.ENABLED) {
        console.log('[Call Log API] Disabled - skipping');
        return { success: false, error: 'Call Log API disabled' };
    }

    if (!CALL_LOG_API_CONFIG.API_URL) {
        console.log('[Call Log API] No API URL configured - skipping');
        return { success: false, error: 'No API URL configured' };
    }

    const { callerNumber, callState, transcript, transcriptionText, transcriptionUrl, recordingUrl } = callData;

    try {
        // Build the API payload matching the expected format
        const payload = {
            phone_number: callerNumber || '',
            display_name: callState.caller_name || '',
            logged_admin: CALL_LOG_API_CONFIG.LOGGED_ADMIN || '3CX',
            prop_id: callState.property_id ? parseInt(callState.property_id, 10) || 0 : 0,
            prop_contact_person: callState.contact_name || callState.caller_name || '',
            email_id: callState.caller_email || '',
            issue_area: mapIssueArea(callState.issue_type, callState.issue_description),
            issue_with: mapIssueWith(callState.issue_type, callState.issue_description),
            notes: buildNotes(callState, transcript, transcriptionText),
            transcription_url: transcriptionUrl || '',
            recording_url: recordingUrl || '',
            current_client: callState.is_existing_client === true ? 'yes' : 
                           callState.is_existing_client === false ? 'no' : 'unknown',
            assign_to: mapAssignTo(callState),
            status: 'Open',
            answer_by: CALL_LOG_API_CONFIG.ANSWER_BY || 'AI Agent',
            display_name_flag: callState.caller_name ? 'y' : 'n'
        };

        console.log('[Call Log API] Sending call log:', JSON.stringify(payload, null, 2));

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CALL_LOG_API_CONFIG.TIMEOUT_MS);

        const headers = {
            'Content-Type': 'application/json'
        };

        // Add API key if configured
        if (CALL_LOG_API_CONFIG.API_KEY) {
            headers['Authorization'] = `Bearer ${CALL_LOG_API_CONFIG.API_KEY}`;
            headers['X-API-Key'] = CALL_LOG_API_CONFIG.API_KEY;
        }

        const response = await fetch(CALL_LOG_API_CONFIG.API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const data = await response.json();

        if (!response.ok) {
            console.error(`[Call Log API] HTTP ${response.status}:`, data);
            return { 
                success: false, 
                error: data.error || `HTTP ${response.status}` 
            };
        }

        if (data.success) {
            console.log(`[Call Log API] ✓ Call logged successfully. Log ID: ${data.log_id}`);
            return {
                success: true,
                log_id: data.log_id,
                message: data.message || 'Call log inserted successfully'
            };
        } else {
            console.error('[Call Log API] API returned error:', data.error);
            return {
                success: false,
                error: data.error || 'Unknown error'
            };
        }

    } catch (error) {
        if (error.name === 'AbortError') {
            console.error('[Call Log API] Request timed out');
            return { success: false, error: 'Request timed out' };
        }
        console.error('[Call Log API] Failed to send call log:', error.message);
        return { success: false, error: error.message };
    }
};

/**
 * Map issue type to issue_area field
 */
const mapIssueArea = (issueType, issueDescription) => {
    const desc = (issueDescription || '').toLowerCase();
    
    if (issueType === 'rate_issue' || desc.includes('rate')) return 'Rates';
    if (issueType === 'booking_issue' || desc.includes('booking')) return 'Booking';
    if (issueType === 'double_booking_issue' || desc.includes('double')) return 'Booking';
    if (issueType === 'login_issue' || desc.includes('login') || desc.includes('password')) return 'Login';
    if (desc.includes('website') || desc.includes('site')) return 'Website';
    if (desc.includes('channel') || desc.includes('connection')) return 'Channel';
    if (desc.includes('payment')) return 'Payment';
    if (desc.includes('demo')) return 'Demo';
    if (desc.includes('pricing') || desc.includes('price')) return 'Sales';
    
    return 'General';
};

/**
 * Map issue type to issue_with field (more specific)
 */
const mapIssueWith = (issueType, issueDescription) => {
    const desc = (issueDescription || '').toLowerCase();
    
    if (issueType === 'rate_issue') return 'Rate Update';
    if (issueType === 'booking_issue') return 'Booking Issue';
    if (issueType === 'double_booking_issue') return 'Double Booking';
    if (issueType === 'login_issue') return 'Login/Password';
    if (desc.includes('not working')) return 'Not Working';
    if (desc.includes('error')) return 'Error';
    if (desc.includes('sync')) return 'Sync Issue';
    
    return issueDescription ? issueDescription.substring(0, 100) : 'General Inquiry';
};

/**
 * Build notes field from call state, transcript, and AssemblyAI transcription
 */
const buildNotes = (callState, transcript, transcriptionText) => {
    const notes = [];
    
    // Add AssemblyAI transcription text first (main content)
    if (transcriptionText && transcriptionText.trim()) {
        notes.push(`Call Transcript: ${transcriptionText.trim()}`);
    }
    
    if (callState.issue_description) {
        notes.push(`Issue: ${callState.issue_description}`);
    }
    
    if (callState.sales_need) {
        notes.push(`Sales Need: ${callState.sales_need}`);
    }
    
    if (callState.demo_choice) {
        notes.push(`Demo: ${callState.demo_choice}`);
    }
    
    if (callState.demo_preferred_time) {
        notes.push(`Demo Time: ${callState.demo_preferred_time}`);
    }
    
    if (callState.routing) {
        notes.push(`Routed to: ${callState.routing}`);
    }
    
    if (transcript && transcript.tokenUsage) {
        notes.push(`Duration: ${transcript.tokenUsage.call_duration_formatted || 'Unknown'}`);
    }
    
    // Add disconnect info
    if (transcript && transcript.disconnectInfo) {
        notes.push(`Ended by: ${transcript.disconnectInfo.disconnected_by || 'unknown'}`);
    }
    
    return notes.join(' | ') || 'AI Agent call';
};

/**
 * Map call state to assign_to field
 */
const mapAssignTo = (callState) => {
    if (callState.routing === 'sales') return 'Sales Team';
    if (callState.routing === 'support') return 'Support Team';
    if (callState.demo_choice) return 'Sales Team';
    if (callState.issue_type === 'login_issue') return 'Support Team';
    
    return 'Support Team';
};

export default { sendCallLog };
