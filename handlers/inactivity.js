// Inactivity detection and handling

import { INACTIVITY_SETTINGS } from '../config/index.js';

// Create inactivity handler for a call session
export const createInactivityHandler = (openAiWs) => {
    let inactivityTimer = null;
    let inactivityWarningCount = 0;

    // Start inactivity timer after AI finishes speaking
    const startInactivityTimer = () => {
        // Clear any existing timer
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }
        
        console.log('[Inactivity] Starting inactivity timer. Warning count:', inactivityWarningCount);
        
        let timeout;
        if (inactivityWarningCount === 0) {
            timeout = INACTIVITY_SETTINGS.FIRST_WARNING;
        } else if (inactivityWarningCount === 1) {
            timeout = INACTIVITY_SETTINGS.FINAL_WARNING - INACTIVITY_SETTINGS.FIRST_WARNING;
        } else {
            timeout = INACTIVITY_SETTINGS.HANGUP - INACTIVITY_SETTINGS.FINAL_WARNING;
        }
        
        inactivityTimer = setTimeout(() => {
            inactivityWarningCount++;
            console.log(`[Inactivity] Timer fired. Warning count now: ${inactivityWarningCount}`);
            
            if (inactivityWarningCount === 1) {
                // First warning
                console.log('[Inactivity] Sending first warning: Are you still there?');
                const prompt = {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: '[SYSTEM: Caller has been silent for 1 minute. Ask them: Are you still there?]' }]
                    }
                };
                openAiWs.send(JSON.stringify(prompt));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
                
            } else if (inactivityWarningCount === 2) {
                // Final warning
                console.log('[Inactivity] Sending final warning');
                const prompt = {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: '[SYSTEM: Caller still silent. Say: I have not heard from you. I will end the call now if you do not need anything else.]' }]
                    }
                };
                openAiWs.send(JSON.stringify(prompt));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
                
            } else {
                // Hangup
                console.log('[Inactivity] Extended silence. Ending call.');
                const prompt = {
                    type: 'conversation.item.create',
                    item: {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: '[SYSTEM: Caller has not responded. Say goodbye and call the end_call function with reason "inactivity".]' }]
                    }
                };
                openAiWs.send(JSON.stringify(prompt));
                openAiWs.send(JSON.stringify({ type: 'response.create' }));
            }
        }, timeout);
    };
    
    // Reset inactivity timer when caller speaks
    const resetInactivityTimer = () => {
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }
        inactivityWarningCount = 0;
        console.log('[Inactivity] Timer reset - caller spoke');
    };

    // Clear all timers (for cleanup)
    const clearTimers = () => {
        if (inactivityTimer) {
            clearTimeout(inactivityTimer);
            inactivityTimer = null;
        }
    };

    return {
        startInactivityTimer,
        resetInactivityTimer,
        clearTimers,
        getWarningCount: () => inactivityWarningCount
    };
};
