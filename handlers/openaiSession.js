// OpenAI session configuration and tools

import { OPENAI_API_KEY } from '../config/index.js';

// Get the OpenAI tools configuration
export const getOpenAITools = () => {
    return [
        {
            type: "function",
            name: "save_caller_info",
            description: "Save caller information collected during the call. Call this function whenever you learn any caller details like property name/ID, caller name, email, or their issue.",
            parameters: {
                type: "object",
                properties: {
                    property_id: { type: "string", description: "Property ID if mentioned" },
                    property_name: { type: "string", description: "Property name if mentioned" },
                    caller_name: { type: "string", description: "Caller's name" },
                    caller_email: { type: "string", description: "Caller's email address" },
                    issue_description: { type: "string", description: "Brief description of their issue or question" },
                    is_existing_client: { type: "boolean", description: "Whether caller is an existing Update247 client" },
                    is_logged_in: { type: "boolean", description: "Whether caller is currently logged into Update247" },
                    current_state: { type: "string", description: "Current state in the flow (A-H)" },
                    sales_need: { type: "string", description: "What the sales/new caller is looking for" },
                    demo_choice: { type: "string", description: "Demo preference: self_serve or book_demo", enum: ["self_serve", "book_demo"] },
                    demo_preferred_time: { type: "string", description: "Caller's preferred day and time for a booked demo" }
                }
            }
        },
        {
            type: "function",
            name: "route_call",
            description: "Record the routing decision once you've determined whether to route to Support or Sales.",
            parameters: {
                type: "object",
                properties: {
                    routing: { 
                        type: "string", 
                        enum: ["support", "sales"],
                        description: "Route to 'support' for existing clients or 'sales' for new prospects" 
                    },
                    reason: { type: "string", description: "Brief reason for routing decision" }
                },
                required: ["routing"]
            }
        },
        {
            type: "function",
            name: "get_pricing_details",
            description: "Fetch current Update247 software pricing and plans. Call this when caller asks about pricing, plans, or costs. Property types: Hotel or Vacational Rental.",
            parameters: {
                type: "object",
                properties: {
                    property_type: { type: "string", description: "Property type: Hotel or Vacational Rental", enum: ["Hotel", "Vacational Rental"] }
                },
                required: ["property_type"]
            }
        },
        {
            type: "function",
            name: "get_interface_screenshots",
            description: "Get screenshots of the Update247 interface. Call this when caller wants to see what the software looks like or see interface examples.",
            parameters: {
                type: "object",
                properties: {
                    feature: { type: "string", description: "Feature to show: dashboard, bookings, reports, or settings", enum: ["dashboard", "bookings", "reports", "settings"] }
                },
                required: ["feature"]
            }
        },
        {
            type: "function",
            name: "end_call",
            description: "End the call politely. Call this AFTER saying goodbye to the caller. Use when: caller says bye/goodbye/thank you that's all/nothing else, OR when conversation is complete and caller has no more questions.",
            parameters: {
                type: "object",
                properties: {
                    reason: { type: "string", description: "Reason for ending call: completed, caller_goodbye, no_more_questions, escalated" }
                },
                required: ["reason"]
            }
        }
    ];
};

// Create session update configuration
export const createSessionUpdate = (callSettings) => {
    return {
        type: 'session.update',
        session: {
            type: 'realtime',
            model: "gpt-realtime",
            output_modalities: ["audio"],
            audio: {
                input: { format: { type: 'audio/pcmu' }, turn_detection: { type: "server_vad" } },
                output: { format: { type: 'audio/pcmu' }, voice: callSettings.voice },
            },
            instructions: callSettings.system_message,
            tools: getOpenAITools(),
            tool_choice: "auto"
        }
    };
};

// Create initial conversation item (greeting)
export const createInitialGreeting = (greetingText) => {
    return {
        type: 'conversation.item.create',
        item: {
            type: 'message',
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text: greetingText || 'Greet the user with : Hi there, How are you today?'
                }
            ]
        }
    };
};

// Get OpenAI WebSocket URL
export const getOpenAIWebSocketUrl = (temperature) => {
    return `wss://api.openai.com/v1/realtime?model=gpt-realtime&temperature=${temperature}`;
};

// Get OpenAI WebSocket headers
export const getOpenAIWebSocketHeaders = () => {
    return {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
    };
};
