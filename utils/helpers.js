// Utility helper functions

// Sanitize string for filenames (keep only digits)
export const sanitizeForFilename = (s) => {
    return (String(s || '')).replace(/[^0-9]/g, '') || 'unknown';
};

// Format duration as "Xm Ys"
export const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
};

// Generate call transcript filename
export const generateTranscriptFilename = (callerNumber, calleeNumber, startTime) => {
    const callerFormatted = sanitizeForFilename(callerNumber);
    const calleeFormatted = sanitizeForFilename(calleeNumber);
    
    const dd = String(startTime.getDate()).padStart(2, '0');
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mon = monthNames[startTime.getMonth()];
    const yyyy = startTime.getFullYear();
    const hh = String(startTime.getHours()).padStart(2, '0');
    const min = String(startTime.getMinutes()).padStart(2, '0');
    
    return `call-from-${callerFormatted}-to-${calleeFormatted}-${dd}-${mon}-${yyyy}-${hh}-${min}.json`;
};

// Generate backup filename
export const generateBackupFilename = (callerNumber, callSid, streamSid) => {
    const callerForName = sanitizeForFilename(callerNumber);
    const callSidForName = callSid || streamSid || 'unknown';
    const timestamp = Date.now();
    return `index-${callerForName}-${callSidForName}-${timestamp}.json`;
};

// Extract last 3 digits of phone number
export const getPhoneLast3Digits = (phoneNumber) => {
    if (!phoneNumber) return { digits: '', spaced: '' };
    
    const phoneDigits = phoneNumber.replace(/[^0-9]/g, '');
    const last3 = phoneDigits.length >= 3 ? phoneDigits.slice(-3) : phoneDigits;
    const last3Spaced = last3 ? last3.split('').join(' ') : '';
    
    return { digits: last3, spaced: last3Spaced };
};

// Parse URL parameters
export const parseUrlParams = (url) => {
    try {
        const parsed = new URL(url, 'http://localhost');
        return {
            from: parsed.searchParams.get('from') || parsed.searchParams.get('From') || parsed.searchParams.get('caller') || parsed.searchParams.get('Caller'),
            to: parsed.searchParams.get('to') || parsed.searchParams.get('To'),
            callSid: parsed.searchParams.get('callSid') || parsed.searchParams.get('CallSid') || parsed.searchParams.get('callsid')
        };
    } catch (err) {
        console.error('[parseUrlParams] Error:', err.message);
        return { from: null, to: null, callSid: null };
    }
};

// Create initial call state
export const createInitialCallState = (callStartTime) => {
    return {
        property_id: null,
        property_name: null,
        caller_name: null,
        caller_email: null,
        issue_description: null,
        is_existing_client: null,
        is_logged_in: null,
        routing: null,
        current_state: 'A',
        sales_need: null,
        demo_choice: null,
        demo_preferred_time: null,
        tokens_input: 0,
        tokens_output: 0,
        cost_dollars: 0,
        call_duration_seconds: 0,
        call_start_time: callStartTime.toISOString(),
        call_end_time: null,
        phone_lookup_performed: false,
        phone_lookup_found: false,
        phone_lookup_source: null,
        disconnected_by: null,
        disconnect_reason: null
    };
};

// Calculate token cost
export const calculateTokenCost = (inputTokens, outputTokens, pricing = {}) => {
    const inputCostPerMillion = pricing.input_tokens_per_1m || 32.00;
    const outputCostPerMillion = pricing.output_tokens_per_1m || 64.00;
    
    const inputCost = (inputTokens / 1000000) * inputCostPerMillion;
    const outputCost = (outputTokens / 1000000) * outputCostPerMillion;
    
    return parseFloat((inputCost + outputCost).toFixed(6));
};

// Estimate tokens from conversation log
export const estimateTokensFromConversation = (conversationLog) => {
    let estimatedTokens = 0;
    
    conversationLog.forEach(item => {
        if (item.content) {
            const words = String(item.content).split(/\s+/).length;
            estimatedTokens += Math.ceil(words * 1.3); // Conservative estimate
        }
    });
    
    // Assume roughly 40% input, 60% output for voice conversations
    return {
        input: Math.ceil(estimatedTokens * 0.4),
        output: Math.ceil(estimatedTokens * 0.6)
    };
};
