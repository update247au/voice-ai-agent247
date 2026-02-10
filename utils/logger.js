// Centralized logging utility

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

// Current log level (can be set via environment variable)
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.DEBUG;

// Format timestamp
const getTimestamp = () => {
    return new Date().toISOString();
};

// Base log function
const log = (level, prefix, ...args) => {
    if (LOG_LEVELS[level] >= currentLevel) {
        console.log(`[${getTimestamp()}] [${prefix}]`, ...args);
    }
};

// Logger object
export const logger = {
    debug: (prefix, ...args) => log('DEBUG', prefix, ...args),
    info: (prefix, ...args) => log('INFO', prefix, ...args),
    warn: (prefix, ...args) => {
        if (LOG_LEVELS.WARN >= currentLevel) {
            console.warn(`[${getTimestamp()}] [${prefix}]`, ...args);
        }
    },
    error: (prefix, ...args) => {
        if (LOG_LEVELS.ERROR >= currentLevel) {
            console.error(`[${getTimestamp()}] [${prefix}]`, ...args);
        }
    },
    
    // Specialized loggers
    event: (eventType, details = {}) => {
        console.log(`[EVENT] ${eventType}`, details);
    },
    
    callSummary: (callState, callerNumber, calleeNumber, duration) => {
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
        console.log('[Phone Lookup Summary]');
        console.log('  Lookup Performed:', callState.phone_lookup_performed ? 'Yes' : 'No');
        console.log('  Lookup Found:', callState.phone_lookup_found ? 'Yes' : 'No');
        if (callState.phone_lookup_found) {
            console.log('  Source:', callState.phone_lookup_source);
            console.log('  Property ID:', callState.property_id);
            console.log('  Property Name:', callState.property_name);
        }
        console.log('═══════════════════════════════════════════');
        console.log('[Disconnect Info]');
        console.log('  Disconnected By:', callState.disconnected_by || 'Unknown');
        console.log('  Reason:', callState.disconnect_reason || 'Unknown');
        console.log('═══════════════════════════════════════════');
    },
    
    tokenUsage: (callState) => {
        console.log('  [TOKEN USAGE & COST]');
        console.log('  Input Tokens:', callState.tokens_input);
        console.log('  Output Tokens:', callState.tokens_output);
        console.log('  Total Tokens:', callState.tokens_input + callState.tokens_output);
        console.log('  Estimated Cost: $' + callState.cost_dollars.toFixed(6));
        console.log('═══════════════════════════════════════════');
    },
    
    callTiming: (startTime, endTime, duration) => {
        console.log('  [CALL TIMES]');
        console.log('  Start Time:', startTime.toISOString());
        console.log('  End Time:', endTime.toISOString());
        console.log('═══════════════════════════════════════════');
        console.log('  [CALL DURATION]');
        console.log('  Duration:', duration, 'seconds (' + Math.floor(duration / 60) + 'm ' + (duration % 60) + 's)');
        console.log('═══════════════════════════════════════════');
    }
};

export default logger;
