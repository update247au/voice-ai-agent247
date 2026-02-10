// AI Function call handlers

import { getTwilioClient, endCall } from '../services/twilio.js';

// Handle save_caller_info function call
export const handleSaveCallerInfo = (args, callState, callerNumber, response, openAiWs) => {
    // Update callState with provided information
    if (args.property_id) callState.property_id = args.property_id;
    if (args.property_name) callState.property_name = args.property_name;
    if (args.caller_name) callState.caller_name = args.caller_name;
    if (args.caller_email) callState.caller_email = args.caller_email;
    if (args.issue_description) callState.issue_description = args.issue_description;
    if (args.is_existing_client !== undefined) callState.is_existing_client = args.is_existing_client;
    if (args.is_logged_in !== undefined) callState.is_logged_in = args.is_logged_in;
    if (args.current_state) callState.current_state = args.current_state;
    if (args.sales_need) callState.sales_need = args.sales_need;
    if (args.demo_choice) callState.demo_choice = args.demo_choice;
    if (args.demo_preferred_time) callState.demo_preferred_time = args.demo_preferred_time;
    
    console.log('[CallState Updated]', callState);
    
    // Include caller phone last 3 digits so AI can reference it
    const phoneDigits = callerNumber ? callerNumber.replace(/[^0-9]/g, '') : '';
    const last3 = phoneDigits.length >= 3 ? phoneDigits.slice(-3) : phoneDigits;
    const last3Spaced = last3 ? last3.split('').join(' ') : '';
    
    const responseData = { 
        success: true, 
        saved: args,
        caller_phone_last3: last3 || null,
        caller_phone_available: !!callerNumber
    };
    
    // When demo is booked, add explicit spoken instruction with the digits
    if (args.intent === 'demo_booking' && last3) {
        responseData.SPEAK_THIS = `Demo is all set. Is it okay to call you on the number you are calling from, which ends in ${last3Spaced}?`;
        responseData.INSTRUCTION = `You MUST say the above SPEAK_THIS text exactly, then WAIT for the caller's response. The last 3 digits of their phone number are ${last3Spaced}. Say each digit separately.`;
    }
    
    // Send function result back to AI
    const functionOutput = {
        type: 'conversation.item.create',
        item: {
            type: 'function_call_output',
            call_id: response.call_id,
            output: JSON.stringify(responseData)
        }
    };
    openAiWs.send(JSON.stringify(functionOutput));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
    
    return callState;
};

// Handle route_call function call
export const handleRouteCall = (args, callState, response, openAiWs) => {
    // Record routing decision
    callState.routing = args.routing;
    console.log(`[ROUTING DECISION] ${args.routing.toUpperCase()} - Reason: ${args.reason || 'Not specified'}`);
    
    // Send function result back to AI
    const functionOutput = {
        type: 'conversation.item.create',
        item: {
            type: 'function_call_output',
            call_id: response.call_id,
            output: JSON.stringify({ success: true, routed_to: args.routing })
        }
    };
    openAiWs.send(JSON.stringify(functionOutput));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
    
    return callState;
};

// Handle get_pricing_details function call
export const handleGetPricingDetails = async (args, response, openAiWs) => {
    const propertyType = args.property_type || 'Hotel';
    console.log('[Function Call] get_pricing_details - Fetching rates for property type:', propertyType);
    
    try {
        // Call mock rates endpoint
        const ratesUrl = 'https://testserver.update247.com.au/testaj/mock_rates.php';
        const ratesResponse = await fetch(ratesUrl);
        
        if (!ratesResponse.ok) {
            throw new Error(`HTTP ${ratesResponse.status}: ${ratesResponse.statusText}`);
        }
        
        const ratesData = await ratesResponse.json();
        console.log('[Pricing] Successfully fetched rates for property type:', propertyType);
        
        const functionOutput = {
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify(ratesData)
            }
        };
        openAiWs.send(JSON.stringify(functionOutput));
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
    } catch (error) {
        console.error('[Pricing] Failed to fetch pricing:', error.message);
        
        const errorOutput = {
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify({ error: 'Unable to retrieve pricing details. Please contact sales for current pricing.', details: error.message })
            }
        };
        openAiWs.send(JSON.stringify(errorOutput));
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
    }
};

// Handle get_interface_screenshots function call
export const handleGetInterfaceScreenshots = async (args, response, openAiWs) => {
    const feature = args.feature || 'dashboard';
    console.log('[Function Call] get_interface_screenshots - Fetching screenshots for feature:', feature);
    
    try {
        // Call screenshots endpoint
        const screenshotsUrl = 'https://testserver.update247.com.au/testaj/mock_screenshots.php?feature=' + encodeURIComponent(feature);
        const screenshotsResponse = await fetch(screenshotsUrl);
        
        if (!screenshotsResponse.ok) {
            throw new Error(`HTTP ${screenshotsResponse.status}: ${screenshotsResponse.statusText}`);
        }
        
        const screenshotsData = await screenshotsResponse.json();
        console.log('[Screenshots] Successfully fetched screenshots for feature:', feature);
        
        const functionOutput = {
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify(screenshotsData)
            }
        };
        openAiWs.send(JSON.stringify(functionOutput));
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
    } catch (error) {
        console.error('[Screenshots] Failed to fetch screenshots:', error.message);
        
        const errorOutput = {
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify({ error: 'Unable to retrieve interface screenshots. Please visit our website for demos.', details: error.message })
            }
        };
        openAiWs.send(JSON.stringify(errorOutput));
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
    }
};

// Handle end_call function call
export const handleEndCall = async (args, callState, callSid, response, openAiWs, connection) => {
    const reason = args.reason || 'completed';
    console.log(`[END CALL] Ending call. Reason: ${reason}`);
    
    // Record the end reason and who disconnected in call state
    callState.end_reason = reason;
    callState.ended_by_agent = true;
    callState.disconnected_by = reason === 'inactivity' ? 'inactivity' : 'agent';
    callState.disconnect_reason = reason;
    
    // Send function result back to AI with instruction to say goodbye
    const functionOutput = {
        type: 'conversation.item.create',
        item: {
            type: 'function_call_output',
            call_id: response.call_id,
            output: JSON.stringify({ 
                success: true, 
                SPEAK_THIS: 'Thank you for calling Update247. Have a great day. Bye for now!',
                INSTRUCTION: 'You MUST say the SPEAK_THIS text exactly before the call ends.'
            })
        }
    };
    openAiWs.send(JSON.stringify(functionOutput));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));
    
    // Give a longer delay for the AI's goodbye to be spoken, then hang up
    setTimeout(async () => {
        console.log('[END CALL] Hanging up via Twilio...');
        
        const twilioClient = getTwilioClient();
        if (twilioClient && callSid) {
            const result = await endCall(callSid);
            if (!result.success) {
                // Fallback: close the websocket
                if (connection && connection.socket) {
                    connection.socket.close();
                }
            }
        } else {
            console.log('[END CALL] No Twilio client or callSid available, closing websocket');
            if (connection && connection.socket) {
                connection.socket.close();
            }
        }
    }, 8000); // 8 second delay to let goodbye be spoken
    
    return callState;
};
