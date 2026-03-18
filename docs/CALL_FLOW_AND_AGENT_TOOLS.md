# Update247 AI Voice Agent - Call Flow & Agent Tools Documentation

## Overview

This document explains how incoming calls are processed, how the AI agent (Emma) responds to callers, and the tools available to assist callers. The system uses **OpenAI's Realtime API** integrated with **Twilio** to provide real-time voice conversations.

---

## Table of Contents

1. [Call Flow](#call-flow)
2. [Agent Response System](#agent-response-system)
3. [Available Tools/Functions](#available-toolsfunctions)
4. [AI Agent Behavior](#ai-agent-behavior)
5. [Supporting Services](#supporting-services)
6. [Architecture Diagram](#architecture-diagram)

---

## Call Flow

### Step-by-Step Process

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. INCOMING CALL                                                            │
│    ↓                                                                        │
│    Caller dials → Twilio receives call → Webhook to /incoming-call          │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. CALL SETUP                                                               │
│    ↓                                                                        │
│    Server returns TwiML with <Stream> element → WebSocket connection opens  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. CONNECTION ESTABLISHED                                                   │
│    ↓                                                                        │
│    Dual WebSocket connections created:                                      │
│    • Twilio ↔ Server (mulaw audio)                                          │
│    • Server ↔ OpenAI Realtime API                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. PHONE LOOKUP (Background)                                                │
│    ↓                                                                        │
│    System identifies caller: property ID, property name, contact name       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. AI GREETING                                                              │
│    ↓                                                                        │
│    Emma: "This is Emma from Update 2 4 7. How can I assist today?"         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 6. REAL-TIME CONVERSATION                                                   │
│    ↓                                                                        │
│    Bidirectional audio streaming with AI processing                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ 7. CALL END                                                                 │
│    ↓                                                                        │
│    • AI says goodbye                                                        │
│    • Recording saved                                                        │
│    • Transcript generated                                                   │
│    • Email notification sent                                                │
│    • Call logged to external system                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Entry Points

| File | Purpose |
|------|---------|
| `index.js` | Main application entry, initializes server |
| `routes/incoming-call.js` | HTTP endpoint for Twilio webhooks |
| `routes/media-stream.js` | WebSocket handler for real-time audio |

---

## Agent Response System

### How the AI Processes Speech

1. **Audio Input**: Twilio sends `mulaw` audio packets to the server
2. **Speech Detection**: OpenAI's server-side VAD (Voice Activity Detection) identifies when the caller is speaking
3. **Processing**: AI generates a contextual response
4. **Audio Output**: Response audio is streamed back through Twilio to the caller

### Voice Configuration

| Setting | Value |
|---------|-------|
| Voice | `sage` (female voice) |
| Model | `gpt-realtime-1.5` |
| Temperature | `0.2` (consistent, focused responses) |
| Output Format | `audio/pcmu` (mulaw) |

### Speech Interruption Handling

When a caller speaks while Emma is talking:
- AI response is immediately truncated
- Audio buffer is cleared
- AI listens to the caller's new input

### Inactivity Detection

| Timeout | Action |
|---------|--------|
| 30 seconds of silence | First warning: "Are you still there?" |
| Additional silence | Final warning |
| Extended silence | Auto-hangup with reason "inactivity" |

---

## Available Tools/Functions

The AI agent has **7 specialized tools** to assist callers:

### 1. `save_caller_info`
**Purpose**: Stores caller details collected during the conversation

| Parameter | Description |
|-----------|-------------|
| `property_id` | The caller's property ID |
| `property_name` | Name of the property |
| `caller_name` | Caller's name |
| `caller_email` | Email address |
| `issue_description` | Description of their issue/request |
| `is_existing_client` | Whether they're an existing customer |
| `is_logged_in` | Whether they're logged into the platform |
| `demo_choice` | Preferred demo type (self-serve/live) |
| `demo_preferred_time` | Preferred time for live demo |

---

### 2. `route_call`
**Purpose**: Records the routing decision for the call

| Parameter | Description |
|-----------|-------------|
| `routing` | Either `support` or `sales` |
| `reason` | Why the call was routed this way |

---

### 3. `get_pricing_details`
**Purpose**: Fetches pricing information from the external API

| Parameter | Description |
|-----------|-------------|
| `property_type` | Either `Hotel` or `Vacational Rental` |

**Returns**: Pricing plans and details for the specified property type

---

### 4. `get_interface_screenshots`
**Purpose**: Retrieves UI screenshots to help explain features

| Parameter | Description |
|-----------|-------------|
| `feature` | One of: `dashboard`, `bookings`, `reports`, `settings` |

**Returns**: Screenshot references and descriptions for the requested feature

---

### 5. `get_faq_answer`
**Purpose**: Searches the FAQ database for relevant answers

| Parameter | Description |
|-----------|-------------|
| `query` | The caller's question |

**FAQ Topics Covered**:
- Channel integrations
- Free trial information
- Sync speed
- Initial setup process
- Support hours
- Mobile app availability
- Payment processing
- And more (16 pre-defined FAQs)

---

### 6. `end_call`
**Purpose**: Ends the call politely with appropriate goodbye

| Parameter | Description |
|-----------|-------------|
| `reason` | One of: `completed`, `caller_goodbye`, `no_more_questions`, `escalated` |

**Behavior**: Triggers Twilio hangup after 8-second delay to allow goodbye message

---

### 7. `get_website_troubleshooting`
**Purpose**: Multi-step diagnostic tool for website issues

| Parameter | Description |
|-----------|-------------|
| `website_address` | The website URL having issues |
| `first_noticed` | When the problem was first noticed |
| `error_message` | Any error message displayed |
| `other_websites_working` | Whether other websites work normally |

**Returns**: Diagnostic guidance and next steps

---

## AI Agent Behavior

### Agent Persona: Emma
- **Role**: Female expert phone agent
- **Speaking Style**: Slow, clear, calm, friendly, slightly cheerful
- **Language**: English by default (switches to Hinglish/Punglish only if explicitly requested)

### Conversation State Machine

The agent follows a structured state machine for consistent handling:

| State | Purpose |
|-------|---------|
| `STATE_1_LISTEN` | Initial state - capture name, property, reason |
| `STATE_A_PROPERTY_NAME` | Collect property name |
| `STATE_B_PROPERTY_ID` | Collect property ID (skipped if known) |
| `STATE_F_TRIAGE` | Determine if support or sales caller |
| `STATE_G_SUPPORT_MODE` | Support flow - collect issue details |
| `STATE_H_SALES_MODE` | Sales flow - qualify and offer demos |
| `STATE_DEMO_OPTIONS` | Offer self-serve or live demo |
| `STATE_RATE_I` | Scripted help for rate updates |
| `STATE_ISS_ESCALATE` | Escalate complex issues to support team |

### Key Behavioral Rules

1. **Never repeat questions** for information already collected
2. **Don't ask for property ID** if already known from phone lookup
3. **Listen first** to the caller's issue before asking for details
4. **Never read back property names** (may mispronounce)
5. **Confirm phone numbers** by last 3 digits only

---

## Supporting Services

### Phone Lookup
**File**: `services/phoneLookup.js`

Identifies callers using multiple data sources:
- External API → GCS file → Local file (priority order)

**Returns**:
- `is_existing_client`: Whether they're a known customer
- `property_id`: Their property identifier
- `property_name`: Name of their property
- `contact_name`: Caller's name (if known)

---

### Email Notifications
**File**: `services/email.js`

Sends call summary emails with:
- Call details (duration, timestamps)
- Caller information collected
- Token usage statistics
- Disconnect reason
- JSON transcript attachment

**Supports**: Both SMTP (cPanel) and AWS SES

---

### Call Logging
**File**: `services/callLog.js`

Posts call data to external API:
- Issue category mapping (Rates, Booking, Login, etc.)
- Transcription URL
- Recording URL
- Support team assignment

---

### Transcription
**File**: `services/assemblyai.js`

Post-call transcription features:
- Speaker diarization (labels speakers A/B)
- Australian English (en_au) support
- Stored in Google Cloud Storage

---

### Recording Storage
**File**: `services/storage.js`

Google Cloud Storage integration:
- Transcripts stored to GCS bucket
- Local file fallback available
- Agent settings loaded from GCS or local
- Recordings uploaded and indexed

---

## Architecture Diagram

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Caller    │────▶│  Twilio Voice    │────▶│  /incoming-call │
│  (Phone)    │     │   (Webhook)      │     │  (TwiML + Stream)│
└─────────────┘     └──────────────────┘     └────────┬────────┘
                                                      │
                    ┌──────────────────┐              ▼
                    │  Twilio Stream   │◀────▶ /media-stream (WS)
                    │  (Bidirectional) │              │
                    └──────────────────┘              │
                                                      ▼
                    ┌──────────────────┐     ┌─────────────────┐
                    │ OpenAI Realtime  │◀───▶│  Session Handler │
                    │      API         │     │  + 7 Functions   │
                    └──────────────────┘     └────────┬────────┘
                                                      │
        ┌─────────────────────────────────────────────┼─────────────────────────────────┐
        │                 │                           │                │                │
  ┌─────▼────┐    ┌───────▼───┐    ┌─────────▼────┐  ┌──────▼─────┐   ┌──────▼─────┐
  │  Phone   │    │    GCS    │    │    Email     │  │  Call Log  │   │ AssemblyAI │
  │  Lookup  │    │  Storage  │    │   Service    │  │    API     │   │ Transcript │
  │          │    │           │    │              │  │            │   │            │
  │ • API    │    │ • Trans-  │    │ • SMTP       │  │ • Issue    │   │ • Speaker  │
  │ • GCS    │    │   cripts  │    │ • AWS SES    │  │   Category │   │   Labels   │
  │ • Local  │    │ • Settings│    │ • Summary    │  │ • Team     │   │ • en_au    │
  └──────────┘    └───────────┘    └──────────────┘  └────────────┘   └────────────┘
```

---

## Configuration Summary

| Setting | Purpose |
|---------|---------|
| `OPENAI_API_KEY` | OpenAI Realtime API authentication |
| `GCS_BUCKET` | Google Cloud Storage for transcripts |
| `TWILIO_ACCOUNT_SID/AUTH_TOKEN` | Twilio call control |
| `PHONE_LOOKUP_API_URL` | External phone lookup endpoint |
| `ASSEMBLYAI_API_KEY` | Post-call transcription |
| `CALL_LOG_API_URL` | External call logging |
| `EMAIL_CONFIG` | SMTP or AWS SES for notifications |
| `INACTIVITY_SETTINGS` | Silence timeouts (30s warning) |

---

## Quick Reference: Tool Usage by Scenario

| Caller Scenario | Tools Used |
|-----------------|------------|
| New customer inquiry | `route_call` → `get_pricing_details` → `save_caller_info` |
| Existing customer with issue | `route_call` → `get_faq_answer` → `save_caller_info` |
| Website not working | `get_website_troubleshooting` → `save_caller_info` |
| Wants a demo | `route_call` → `save_caller_info` (with demo_choice) |
| General question | `get_faq_answer` → `save_caller_info` |
| Complex issue | `route_call` → `save_caller_info` → `end_call` (escalated) |
| Call complete | `end_call` (with appropriate reason) |

---

*Last Updated: March 2026*
