# Update247 AI Voice Agent - Project Documentation

## Overview

The Update247 AI Voice Agent is a real-time voice assistant that handles incoming phone calls for Update247's customer support and sales operations. It uses **OpenAI's Realtime API** for natural language understanding and generation, and **Twilio** for telephony.

**Version:** 2.0.0  
**Last Updated:** February 10, 2026

---

## Table of Contents

1. [Architecture](#architecture)
2. [Project Structure](#project-structure)
3. [Call Flow](#call-flow)
4. [AI Agent Tools](#ai-agent-tools)
5. [State Machine Flow](#state-machine-flow)
6. [Configuration](#configuration)
7. [Inactivity Handling](#inactivity-handling)
8. [Transcript & Storage](#transcript--storage)
9. [Email Notifications](#email-notifications)

---

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Caller's      │     │     Twilio      │     │   Cloud Run     │
│   Phone         │◄───►│   Media Stream  │◄───►│   (Node.js)     │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  OpenAI         │
                                                │  Realtime API   │
                                                └─────────────────┘
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  Google Cloud   │
                                                │  Storage (GCS)  │
                                                └─────────────────┘
```

### Technology Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js (ES Modules) |
| Web Framework | Fastify |
| Real-time Communication | WebSocket (ws) |
| AI/LLM | OpenAI Realtime API (GPT-4o) |
| Telephony | Twilio Programmable Voice |
| Storage | Google Cloud Storage / Local Files |
| Email | Nodemailer (SMTP / AWS SES) |
| Hosting | Google Cloud Run |

---

## Project Structure

```
speech-assistant-openai-realtime-api-node/
├── index.js                    # Main entry point (~90 lines)
├── package.json                # Dependencies and scripts
├── .env                        # Environment variables
│
├── config/
│   └── index.js               # Configuration & environment variables
│                              # - API keys, ports, timeouts
│                              # - Inactivity settings
│                              # - Default system message
│
├── services/
│   ├── storage.js             # GCS & local file storage
│   │                          # - Save/load transcripts
│   │                          # - Load agent settings
│   ├── twilio.js              # Twilio client wrapper
│   │                          # - End calls, start recordings
│   ├── phoneLookup.js         # Phone-to-property mapping
│   │                          # - Lookup caller by phone number
│   ├── transcription.js       # Whisper transcription
│   │                          # - Convert caller audio to text
│   └── email.js               # Email notifications
│                              # - Send call transcripts via email
│
├── handlers/
│   ├── functions.js           # AI function call handlers
│   │                          # - save_caller_info
│   │                          # - route_call
│   │                          # - get_pricing_details
│   │                          # - end_call
│   ├── inactivity.js          # Silence/inactivity detection
│   │                          # - Warnings and auto-hangup
│   └── openaiSession.js       # OpenAI session configuration
│                              # - Tool definitions
│                              # - Session update messages
│
├── routes/
│   ├── incoming-call.js       # /incoming-call POST route
│   │                          # - Receives Twilio webhook
│   │                          # - Returns TwiML response
│   └── media-stream.js        # /media-stream WebSocket route
│                              # - Handles real-time audio
│                              # - Manages conversation state
│
├── utils/
│   ├── helpers.js             # Utility functions
│   │                          # - Filename generation
│   │                          # - Token cost calculation
│   └── logger.js              # Centralized logging
│
├── ai-setting/                # AI configuration files
│   ├── u247-agent.json        # Voice, temperature settings
│   └── u247-system-message.json # System prompt
│
└── call-history/              # Local transcript storage
```

---

## Call Flow

### Step-by-Step Call Flow

```
1. INCOMING CALL
   ├── Caller dials Twilio phone number
   ├── Twilio sends webhook to /incoming-call
   ├── Server stores webhook body (caller info)
   └── Server returns TwiML with <Stream> to /media-stream

2. WEBSOCKET CONNECTION
   ├── Twilio connects WebSocket to /media-stream
   ├── Server extracts caller number from parameters
   ├── Server performs phone lookup (property matching)
   ├── Server connects to OpenAI Realtime API
   └── Server sends session configuration to OpenAI

3. INITIAL GREETING
   ├── Server sends greeting prompt to OpenAI
   ├── OpenAI generates audio response
   ├── Server forwards audio to Twilio
   └── Caller hears: "This is Lucy from Update247..."

4. CONVERSATION LOOP
   ├── Caller speaks
   │   ├── Twilio streams audio to server
   │   ├── Server forwards audio to OpenAI
   │   └── Inactivity timer is reset
   │
   ├── OpenAI processes speech
   │   ├── Transcribes caller audio
   │   ├── Generates response (may call functions)
   │   └── Streams audio back
   │
   └── Server handles response
       ├── Forwards audio to Twilio → Caller
       ├── Executes any function calls
       ├── Logs conversation
       └── Starts inactivity timer after playback

5. CALL END
   ├── Triggered by:
   │   ├── Caller says goodbye → Agent calls end_call
   │   ├── Inactivity timeout → Auto end_call
   │   └── Caller hangs up → Connection closes
   │
   ├── Server actions:
   │   ├── Determines who disconnected (agent/caller/inactivity)
   │   ├── Calculates call duration and token usage
   │   ├── Saves transcript to GCS/local
   │   ├── Sends email notification (if enabled)
   │   └── Closes WebSocket connections
```

### Sequence Diagram

```
Caller          Twilio          Server          OpenAI          GCS
  │               │               │               │              │
  │──dial──────►│               │               │              │
  │               │──webhook────►│               │              │
  │               │◄──TwiML──────│               │              │
  │               │               │               │              │
  │               │◄──WebSocket──►│               │              │
  │               │               │──connect─────►│              │
  │               │               │◄──session ok──│              │
  │               │               │               │              │
  │◄──"Hello"────│◄──audio───────│◄──audio──────│              │
  │               │               │               │              │
  │──"Hi..."────►│──audio───────►│──audio──────►│              │
  │               │               │◄──response───│              │
  │◄──response───│◄──audio───────│               │              │
  │               │               │               │              │
  │     ...conversation continues...             │              │
  │               │               │               │              │
  │──"Bye"──────►│──audio───────►│──audio──────►│              │
  │               │               │◄──end_call───│              │
  │◄──"Goodbye"──│◄──audio───────│               │              │
  │               │               │               │              │
  │◄──hangup─────│◄──completed───│               │              │
  │               │               │──save────────┼─────────────►│
  │               │               │               │              │
```

---

## AI Agent Tools

The AI agent has access to the following function tools:

### 1. `save_caller_info`

**Purpose:** Save information collected from the caller during the conversation.

**When to use:** Whenever the caller provides details like property name, ID, email, or describes their issue.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `property_id` | string | Property ID if mentioned |
| `property_name` | string | Property name if mentioned |
| `caller_name` | string | Caller's name |
| `caller_email` | string | Caller's email address |
| `issue_description` | string | Brief description of their issue |
| `is_existing_client` | boolean | Whether caller is an existing client |
| `is_logged_in` | boolean | Whether caller is logged into Update247 |
| `current_state` | string | Current state in the flow (A-H) |
| `sales_need` | string | What the sales caller is looking for |
| `demo_choice` | string | "self_serve" or "book_demo" |
| `demo_preferred_time` | string | Preferred day/time for demo |

---

### 2. `route_call`

**Purpose:** Record the routing decision (Support vs Sales).

**When to use:** Once the agent determines whether the caller needs support or is a sales prospect.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `routing` | string | Yes | "support" or "sales" |
| `reason` | string | No | Brief reason for routing decision |

---

### 3. `get_pricing_details`

**Purpose:** Fetch current Update247 software pricing and plans.

**When to use:** When caller asks about pricing, plans, or costs.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `property_type` | string | Yes | "Hotel" or "Vacational Rental" |

**Returns:** Pricing data from the mock_rates.php endpoint.

---

### 4. `get_interface_screenshots`

**Purpose:** Get descriptions of Update247 interface screenshots.

**When to use:** When caller wants to know what the software looks like.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `feature` | string | Yes | "dashboard", "bookings", "reports", or "settings" |

**Returns:** Screenshot descriptions from the mock_screenshots.php endpoint.

---

### 5. `end_call`

**Purpose:** End the call politely.

**When to use:** 
- Caller says goodbye/thank you/that's all
- Conversation is complete
- No more questions
- Inactivity timeout (called by system)

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reason` | string | Yes | "completed", "caller_goodbye", "no_more_questions", "escalated", or "inactivity" |

**Behavior:**
1. Records disconnect reason in call state
2. Sends goodbye message to caller
3. Waits 8 seconds for audio to play
4. Hangs up via Twilio API

---

## State Machine Flow

The agent follows a state machine to guide the conversation:

```
┌─────────────────────────────────────────────────────────────────┐
│                        STATE MACHINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  START                                                          │
│    │                                                            │
│    ▼                                                            │
│  [STATE A] ──► Collect Property Name                            │
│    │                                                            │
│    ├──(name provided)──► [STATE B] Get Property ID              │
│    │                         │                                  │
│    │                         ├──(ID provided)──► [STATE G]      │
│    │                         │                                  │
│    │                         └──(no ID)──► Determine Support/Sales
│    │                                                            │
│    └──(not accommodation)──► [STATE F] General Triage           │
│                                  │                              │
│                                  ├──(existing)──► [STATE G]     │
│                                  │                              │
│                                  └──(new)──► [STATE H]          │
│                                                                 │
│  [STATE G] SUPPORT MODE                                         │
│    • Ask "What issue can I help with today?"                    │
│    • Assist with existing account issues                        │
│    • May request property ID if needed                          │
│                                                                 │
│  [STATE H] SALES MODE                                           │
│    • Ask about current channel manager                          │
│    • Ask how many properties they manage                        │
│    • Offer demo / pricing / onboarding                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variables (.env)

```bash
# Required
OPENAI_API_KEY=sk-...              # OpenAI API key

# Optional - Twilio (for call control & recording)
TWILIO_ACCOUNT_SID=AC...           # Twilio Account SID
TWILIO_AUTH_TOKEN=...              # Twilio Auth Token

# Optional - Google Cloud Storage
GCS_BUCKET=your-bucket-name        # GCS bucket for transcripts
# or
GOOGLE_CLOUD_BUCKET=your-bucket    # Alternative name

# Optional - Email (SMTP)
EMAIL_ENABLED=true                 # Enable email notifications
NOTIFY_EMAIL=you@example.com       # Recipient email
SMTP_HOST=mail.yourdomain.com      # SMTP server
SMTP_PORT=465                      # SMTP port (465 for SSL)
SMTP_USER=your-email@domain.com    # SMTP username
SMTP_PASS=your-password            # SMTP password

# Optional - Email (AWS SES)
AWS_SES_ACCESS_KEY=AKIA...         # AWS SES access key
AWS_SES_SECRET_KEY=...             # AWS SES secret key
AWS_SES_REGION=us-east-1           # AWS region
SES_FROM_EMAIL=noreply@domain.com  # Verified sender email

# Server
PORT=8080                          # Server port (default: 8080)
```

### Agent Settings (ai-setting/u247-agent.json)

```json
{
  "voice": "sage",
  "temperature": 0.2,
  "initial_greeting": "Greet the user with : This is Lucy from Update 2 4 7. How are you today?"
}
```

### Available Voices

| Voice | Description |
|-------|-------------|
| `alloy` | Neutral, balanced |
| `echo` | Warm, conversational |
| `fable` | British accent |
| `onyx` | Deep, authoritative |
| `nova` | Friendly, upbeat |
| `sage` | Calm, professional |
| `shimmer` | Expressive, dynamic |

---

## Inactivity Handling

The system monitors for caller silence and takes progressive action:

| Time | Action |
|------|--------|
| 30 seconds | First warning: "Are you still there?" |
| 45 seconds | Final warning: "I'll end the call if you don't need anything else" |
| 60 seconds | Auto-hangup: Says goodbye and ends call |

### When Inactivity Timer Starts

The timer **only starts** when:
1. AI finishes generating response (`response.done`)
2. **AND** audio finishes playing to caller (all marks cleared)

### When Inactivity Timer Resets

The timer resets when:
- Caller starts speaking (`input_audio_buffer.speech_started`)
- New response is being generated

---

## Transcript & Storage

### Transcript Contents

Each call generates a JSON transcript with:

```json
{
  "callId": "stream-sid-xxx",
  "callSid": "CA-xxx",
  "callerNumber": "+61412345678",
  "calleeNumber": "+61298765432",
  
  "callState": {
    "property_id": "12345",
    "property_name": "Beach Resort",
    "caller_name": "John",
    "routing": "support",
    "current_state": "G"
  },
  
  "phoneLookup": {
    "performed": true,
    "found": true,
    "property_id": "12345"
  },
  
  "tokenUsage": {
    "input_tokens": 1234,
    "output_tokens": 5678,
    "estimated_cost_usd": 0.045,
    "call_duration_seconds": 180,
    "call_duration_formatted": "3m 0s"
  },
  
  "disconnectInfo": {
    "disconnected_by": "agent",
    "disconnect_reason": "caller_goodbye",
    "ended_by_agent": true
  },
  
  "conversation": [
    {"role": "assistant", "content": "Hello...", "timestamp": "..."},
    {"role": "user", "content": "Hi, I need help...", "timestamp": "..."}
  ]
}
```

### Storage Locations

| Priority | Location | Condition |
|----------|----------|-----------|
| 1 | GCS | If `GCS_BUCKET` is set |
| 2 | Local | `./call-history/` folder |

### Filename Format

```
call-from-<caller>-to-<callee>-<dd>-<mon>-<yyyy>-<hh>-<mm>.json

Example:
call-from-61412345678-to-61298765432-10-feb-2026-14-30.json
```

---

## Email Notifications

When enabled, the system sends an email after each call with:

- **Subject:** "Call Transcript - +61412345678 - 2/10/2026"
- **Body:** Summary of call details
- **Attachment:** Full transcript JSON file

### Email Summary Includes:

- Caller/callee numbers
- Call duration
- Property information collected
- Routing decision
- Disconnect info (who hung up)
- Token usage and cost
- Issue description

---

## Deployment

### Google Cloud Run

```bash
# Build and deploy
gcloud run deploy ai-voice-agent \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "OPENAI_API_KEY=sk-..."
```

### Docker

```bash
# Build
docker build -t ai-voice-agent .

# Run
docker run -p 8080:8080 \
  -e OPENAI_API_KEY=sk-... \
  ai-voice-agent
```

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Are you still there?" too soon | Timer started before audio finished | Fixed in v2.0 - timer now waits for playback |
| No phone lookup | Caller number not extracted | Check TwiML parameters |
| Transcripts not saving | GCS permissions | Verify service account has objectCreator role |
| Call not ending | Twilio credentials missing | Add TWILIO_ACCOUNT_SID and AUTH_TOKEN |

### Debug Logging

All events are logged to console:
- `[EVENT]` - OpenAI event types
- `[CALLER SPEAKING]` - Speech detected
- `[Inactivity]` - Timer status
- `[Phone Lookup]` - Property matching
- `[END CALL]` - Disconnect handling

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0.0 | Feb 10, 2026 | Modular refactor, email support, fixed inactivity timing |
| 1.0.1 | Feb 7, 2026 | Phone lookup, disconnect tracking |
| 1.0.0 | Feb 3, 2026 | Initial release |
