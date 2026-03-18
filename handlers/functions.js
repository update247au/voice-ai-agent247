// AI Function call handlers

import { getTwilioClient, endCall } from '../services/twilio.js';
import { sendMessageToPropertyOwner } from '../services/email.js';

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
    
    // Build collected_info summary so AI knows what's already been collected
    const collectedInfo = {
        property_id: callState.property_id || null,
        property_name: callState.property_name || null,
        caller_name: callState.caller_name || null,
        caller_email: callState.caller_email || null,
        is_existing_client: callState.is_existing_client,
        is_logged_in: callState.is_logged_in,
        issue_description: callState.issue_description || null,
        demo_choice: callState.demo_choice || null,
        demo_preferred_time: callState.demo_preferred_time || null
    };
    
    const responseData = { 
        success: true, 
        saved: args,
        collected_info: collectedInfo,
        caller_phone_last3: last3 || null,
        caller_phone_available: !!callerNumber,
        REMINDER: "DO NOT ask for information that is already in collected_info. If is_logged_in is true or false, do not ask again. If property_id is set, do not ask for it."
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

// Handle get_faq_answer function call
export const handleGetFaqAnswer = async (args, response, openAiWs) => {
    const query = (args.query || '').toLowerCase();
    console.log('[Function Call] get_faq_answer - Query:', query);
    
    try {
        // Load FAQ data
        const fs = await import('fs');
        const path = await import('path');
        const faqPath = path.join(process.cwd(), 'ai-setting', 'u247-faqs.json');
        const faqData = JSON.parse(fs.readFileSync(faqPath, 'utf8'));
        
        // Search for matching FAQ
        let bestMatch = null;
        let bestScore = 0;
        
        for (const faq of faqData.faqs) {
            let score = 0;
            
            // Check keywords
            for (const keyword of faq.keywords) {
                if (query.includes(keyword.toLowerCase())) {
                    score += 2;
                }
            }
            
            // Check question similarity
            const questionWords = faq.question.toLowerCase().split(' ');
            for (const word of questionWords) {
                if (query.includes(word) && word.length > 3) {
                    score += 1;
                }
            }
            
            if (score > bestScore) {
                bestScore = score;
                bestMatch = faq;
            }
        }
        
        let responseData;
        if (bestMatch && bestScore >= 2) {
            responseData = {
                found: true,
                faq_id: bestMatch.id,
                question: bestMatch.question,
                answer: bestMatch.answer,
                INSTRUCTION: 'Use this answer to respond to the caller. Speak it naturally and conversationally, not word-for-word.'
            };
            console.log('[FAQ] Found match:', bestMatch.id, 'Score:', bestScore);
        } else {
            responseData = {
                found: false,
                answer: faqData.fallback_response,
                INSTRUCTION: 'No specific FAQ matched. Use the fallback response or answer based on your general knowledge about Update247.'
            };
            console.log('[FAQ] No match found for query');
        }
        
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
    } catch (error) {
        console.error('[FAQ] Failed to fetch FAQ:', error.message);
        
        const errorOutput = {
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify({ 
                    found: false, 
                    error: 'Unable to retrieve FAQ. Please answer based on your knowledge or offer to escalate.',
                    details: error.message 
                })
            }
        };
        openAiWs.send(JSON.stringify(errorOutput));
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
    }
};

// Handle get_website_troubleshooting function call
export const handleGetWebsiteTroubleshooting = async (args, callState, response, openAiWs) => {
    console.log('[Function Call] get_website_troubleshooting - Args:', args);
    
    // Initialize website_troubleshooting in callState if not exists
    if (!callState.website_troubleshooting) {
        callState.website_troubleshooting = {};
    }
    
    // Merge new args with existing callState data (persist collected info)
    if (args.website_address) callState.website_troubleshooting.website_address = args.website_address;
    if (args.first_noticed) callState.website_troubleshooting.first_noticed = args.first_noticed;
    if (args.error_message) callState.website_troubleshooting.error_message = args.error_message;
    if (args.other_websites_working) callState.website_troubleshooting.other_websites_working = args.other_websites_working;
    
    // Use persisted callState data
    const collectedInfo = {
        website_address: callState.website_troubleshooting.website_address || null,
        first_noticed: callState.website_troubleshooting.first_noticed || null,
        error_message: callState.website_troubleshooting.error_message || null,
        other_websites_working: callState.website_troubleshooting.other_websites_working || null
    };
    
    console.log('[Website Troubleshooting] Current collected info:', collectedInfo);
    
    // Determine which questions still need to be asked
    const questionsToAsk = [];
    
    if (!collectedInfo.website_address) {
        questionsToAsk.push({
            field: "website_address",
            question: "What is your website address or domain name?"
        });
    }
    
    if (!collectedInfo.first_noticed) {
        questionsToAsk.push({
            field: "first_noticed",
            question: "When did you first notice that the website was not working?"
        });
    }
    
    if (!collectedInfo.error_message) {
        questionsToAsk.push({
            field: "error_message",
            question: "When you visit the website, what message or error do you see?"
        });
    }
    
    if (!collectedInfo.other_websites_working) {
        questionsToAsk.push({
            field: "other_websites_working",
            question: "Are other websites working fine for you, or is it just this one?"
        });
    }
    
    let responseData;
    
    if (questionsToAsk.length > 0) {
        // Still collecting information - provide next question
        responseData = {
            status: "collecting_info",
            collected_so_far: collectedInfo,
            next_question: questionsToAsk[0].question,
            next_field: questionsToAsk[0].field,
            remaining_questions: questionsToAsk.length,
            all_questions: questionsToAsk,
            REMINDER: "DO NOT ask for information already in collected_so_far. If website_address is set, do NOT ask for it again.",
            INSTRUCTION: `Ask the caller: "${questionsToAsk[0].question}" Then call this function again with the answer. Ask ONE question at a time. NEVER repeat questions for fields already collected.`
        };
        console.log('[Website Troubleshooting] Need to collect:', questionsToAsk[0].field);
    } else {
        // All information collected - escalate to tech team
        responseData = {
            status: "escalated",
            collected_info: collectedInfo,
            escalation_message: "I have all the details I need. The issue has been escalated to our technical team. They will check the website and work on fixing it. Is there anything else I can help you with today?",
            INSTRUCTION: "Tell the caller: 'Thank you for providing those details. I have escalated this issue to our technical team. They will check your website and work on fixing it. Is there anything else I can help you with today?'"
        };
        console.log('[Website Troubleshooting] All info collected, escalating:', collectedInfo);
    }
    
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

// Handle send_email_to_property_owner function call
export const handleSendEmailToPropertyOwner = async (args, callState, response, openAiWs) => {
    const { recipient_email, message, subject, template } = args;
    
    // Determine template based on call routing or explicit parameter
    const templateType = template || (callState?.routing === 'sales' ? 'sales' : 'support');
    
    console.log(`[Function Call] send_email_to_property_owner - Sending to: ${recipient_email} (template: ${templateType})`);
    
    try {
        const result = await sendMessageToPropertyOwner(recipient_email, message, subject, templateType);
        
        let responseData;
        if (result.success) {
            responseData = {
                success: true,
                message: `Email has been sent successfully to ${recipient_email}`,
                template_used: result.template,
                INSTRUCTION: 'Confirm to the caller that the email has been sent successfully to the property owner.'
            };
            console.log('[Email] Successfully sent message to property owner:', recipient_email);
        } else {
            responseData = {
                success: false,
                error: result.error || 'Failed to send email',
                INSTRUCTION: 'Apologize to the caller and let them know there was an issue sending the email. Offer to try again or suggest an alternative.'
            };
            console.error('[Email] Failed to send message to property owner:', result.error);
        }
        
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
    } catch (error) {
        console.error('[Email] Exception while sending email:', error.message);
        
        const errorOutput = {
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: response.call_id,
                output: JSON.stringify({ 
                    success: false, 
                    error: 'An error occurred while sending the email',
                    details: error.message,
                    INSTRUCTION: 'Apologize for the technical issue and offer to help in another way.'
                })
            }
        };
        openAiWs.send(JSON.stringify(errorOutput));
        openAiWs.send(JSON.stringify({ type: 'response.create' }));
    }
};
