import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load environment variables from .env file
dotenv.config();

// Ensure call-history directory exists
export const CALL_HISTORY_DIR = path.join(process.cwd(), 'call-history');
if (!fs.existsSync(CALL_HISTORY_DIR)) {
    fs.mkdirSync(CALL_HISTORY_DIR, { recursive: true });
}

// Environment variables
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const GCS_BUCKET = process.env.GCS_BUCKET || process.env.GOOGLE_CLOUD_BUCKET || null;
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || null;
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || null;
export const PORT = Number(process.env.PORT) || 8080;

// Phone lookup API configuration
export const PHONE_LOOKUP_CONFIG = {
    API_URL: process.env.PHONE_LOOKUP_API_URL || null,  // e.g., https://api.update247.com/lookup-phone
    API_KEY: process.env.PHONE_LOOKUP_API_KEY || null,  // Optional API key for auth
    TIMEOUT_MS: Number(process.env.PHONE_LOOKUP_TIMEOUT_MS) || 5000,  // 5 second timeout
    FALLBACK_TO_FILE: process.env.PHONE_LOOKUP_FALLBACK !== 'false'  // Fallback to phone-mappings.json if API fails
};

// AssemblyAI configuration (for call recording transcription)
export const ASSEMBLYAI_CONFIG = {
    API_KEY: process.env.ASSEMBLYAI_API_KEY || null,
    ENABLED: process.env.ASSEMBLYAI_ENABLED === 'true',
    SPEAKER_LABELS: process.env.ASSEMBLYAI_SPEAKER_LABELS !== 'false',  // Enable speaker diarization by default
    LANGUAGE_CODE: process.env.ASSEMBLYAI_LANGUAGE || 'en_au'  // Australian English
};

// Call Log API configuration (sends call data to external server)
export const CALL_LOG_API_CONFIG = {
    API_URL: process.env.CALL_LOG_API_URL || null,           // API endpoint URL
    API_KEY: process.env.CALL_LOG_API_KEY || null,           // Optional API key for auth
    TIMEOUT_MS: Number(process.env.CALL_LOG_TIMEOUT_MS) || 10000,  // 10 second timeout
    ENABLED: process.env.CALL_LOG_API_ENABLED === 'true',    // Enable/disable
    LOGGED_ADMIN: process.env.CALL_LOG_ADMIN || 'AI Agent',  // logged_admin field value
    ANSWER_BY: process.env.CALL_LOG_ANSWER_BY || 'AI Agent'  // answer_by field value
};

// Email configuration (for future use)
export const EMAIL_CONFIG = {
    // SMTP Configuration (cPanel)
    SMTP_HOST: process.env.SMTP_HOST || null,
    SMTP_PORT: Number(process.env.SMTP_PORT) || 465,
    SMTP_USER: process.env.SMTP_USER || null,
    SMTP_PASS: process.env.SMTP_PASS || null,
    SMTP_SECURE: process.env.SMTP_SECURE !== 'false', // Default true for port 465
    
    // AWS SES Configuration
    AWS_SES_ACCESS_KEY: process.env.AWS_SES_ACCESS_KEY || null,
    AWS_SES_SECRET_KEY: process.env.AWS_SES_SECRET_KEY || null,
    AWS_SES_REGION: process.env.AWS_SES_REGION || 'us-east-1',
    SES_FROM_EMAIL: process.env.SES_FROM_EMAIL || null,
    
    // Email Recipients
    NOTIFY_EMAIL: process.env.NOTIFY_EMAIL || null,                    // Default email (fallback)
    TRANSCRIPT_EMAIL: process.env.TRANSCRIPT_EMAIL || null,            // Email for transcript only
    RECORDING_EMAIL: process.env.RECORDING_EMAIL || null,              // Email for recording + transcript
    TEST_EMAIL: process.env.TEST_EMAIL || null,
    TEST_CALLER_NUMBER: process.env.TEST_CALLER_NUMBER || '+61423489798',
    EMAIL_ENABLED: process.env.EMAIL_ENABLED === 'true',
    
    // Webhook API Key (for /api/send-email endpoint)
    WEBHOOK_API_KEY: process.env.EMAIL_WEBHOOK_API_KEY || null
};

// OpenAI settings
export const USE_REALTIME_TRANSCRIPTION = false;
export const TEMPERATURE = 0.2;

// List of Event Types to log to the console
export const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'response.audio.done',
    'response.audio_transcript.done',
    'response.output_audio.done',
    'input_audio_transcript',
    'input_audio_transcription',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created',
    'session.updated',
    'response.function_call_arguments.done',
    'conversation.item.created'
];

// Show AI response elapsed timing calculations
export const SHOW_TIMING_MATH = false;

// Inactivity timeout settings (in milliseconds)
export const INACTIVITY_SETTINGS = {
    FIRST_WARNING: 30000,   // 30 seconds - "Are you still there?"
    FINAL_WARNING: 45000,   // 45 seconds - "I'll end the call"
    HANGUP: 60000           // 60 seconds - Auto hangup
};

// Default system message
export const DEFAULT_SYSTEM_MESSAGE = `You are Update247's AI phone agent. Speak with a clear Australian English accent.

GOAL:
1)become a support or sales agent when you determine whether caller needs Support or Sales.
2) IF call is realted to admin or its someone selling something, ask them send email to : info@update247.com.au and admin team will respond on the email.

RULES:
- Follow the FLOW strictly.
- Ask ONE question at a time.
- If the caller gives partial info, ask for the missing piece.
- Always repeat key details back for confirmation.
- Do not proceed to the next step until the current step is complete.
- If caller refuses to share details, continue politely with what you have.
- Use save_caller_info function to store collected data as you learn it.
- become a support or sales agent when you determine whether caller needs Support or Sales.

FLOW (state machine):

STATE A — COLLECT PROPERTY Name
- Ask: "Can I please have your property Name?" 
- If provided -> save it -> go to STATE B.
- If not provided -> ask: "if you are accommodation provider ?" -> go to STATE F.

STATE B — GET PROPERTY ID
- Say: "Thanks. Do you have your property ID is <ID>. its is visible on top left when logged into Update247."
- If yes -> go to STATE G.
- If no -> ask : how can I help you ?-> become a sales or support agent based on their response.

STATE C — COLLECT PROPERTY NAME
- Ask: "What is the property name?"
- If provided -> save it -> go to STATE E.
- If not provided -> ask again once. If still missing -> go to STATE F (general triage).

STATE D — CHECK CLIENT STATUS
- Ask: "Are you currently using Update247?"
- If yes -> go to STATE G (Support).
- If no -> go to STATE H (Sales).
- If unsure -> ask: "Did you ever have an Update247 login before?" then decide.

STATE E — CHECK CLIENT STATUS (NO ID PATH)
- Ask: "Are you currently using Update247?"
- If yes -> go to STATE G (Support) and ask for property ID later if needed.
- If no -> go to STATE H (Sales).

STATE F — GENERAL TRIAGE (MISSING DETAILS)
- Ask: "Are you calling for help with an existing Update247 account, or are you looking to start using Update247?"
- If existing -> STATE G.
- If new -> STATE H.

STATE G — SUPPORT MODE
- Be a support agent.
- Ask: "What issue can I help with today?"
- If account lookup needed and missing ID -> ask for property ID again.

STATE H — SALES MODE
- Be a sales agent.
- Ask: "Which channel manager / booking system are you using now, and how many properties do you manage?"
- Offer next step: demo / pricing / onboarding.

Speaking style rules (very important):

- Speak slowly and clearly.
- Use short sentences.
- Pause briefly between sentences.
- Avoid technical words.
- Avoid long explanations.
- Ask one question at a time.
- If the caller sounds confused or asks "pardon" or "sorry?", slow down even more.
- If needed, rephrase using simpler words.
- Give the user time to respond after each question.

LANGUAGE: You must ALWAYS speak and respond in English only unless caller ask you to speak in another language. If caller ask you to speak in another language, you must speak in that language.
 
When speaking Hindi, prefer Hinglish (simple Hindi mixed with English).
Avoid long pure-Hindi sentences.

When speaking punjabi, prefer punglish (simple punjabi mixed with English).
Avoid long pure-punjabi sentences.

You are speaking to people who may not be fluent in English.

Example speaking style:

Instead of:
"Please provide your property identification number so I can assist you."

Say:
"That's okay.
I can help you.
May I please have your property ID?"`;

// Validate required config
export const validateConfig = () => {
    if (!OPENAI_API_KEY) {
        console.error('Missing OpenAI API key. Please set it in the .env file.');
        process.exit(1);
    }
    return true;
};
