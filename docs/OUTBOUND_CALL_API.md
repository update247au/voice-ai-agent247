# Outbound Call API Documentation

## Overview

The Outbound Call API allows external systems to trigger AI-initiated phone calls. When triggered, the system uses Twilio to place an outbound call and connects it to the OpenAI Realtime API, enabling the AI agent to have a conversation with the called person.

## Architecture Flow

```
External System → POST /api/outbound-call → Twilio creates call → Person answers
    → Twilio fetches /outbound-twiml → TwiML connects to /media-stream?direction=outbound
    → WebSocket opens → OpenAI Realtime API session starts
    → AI greets person with provided context/message
    → Conversation proceeds → Call ends → Transcript saved
```

## API Endpoint

### POST `/api/outbound-call`

Triggers an AI-initiated outbound phone call.

**Authentication:** API key via `x-api-key` header or `api_key` in request body.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `phone_number` | string | Yes | Phone number in E.164 format (e.g., `+61412345678`) |
| `message` | string | No | Message or information for the AI to deliver |
| `reason` | string | No | Reason for the call (e.g., "follow up on support ticket") |
| `caller_name` | string | No | Name of the person being called |
| `property_name` | string | No | Property name (for context) |
| `property_id` | string | No | Property ID (for context) |
| `greeting` | string | No | Custom greeting for the AI to use. If not provided, uses default greeting |

**Example Request:**

```bash
curl -X POST https://your-server.run.app/api/outbound-call \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "phone_number": "+61412345678",
    "reason": "Follow up on booking sync issue reported earlier today",
    "caller_name": "John Smith",
    "property_name": "Sunrise Beach Hotel",
    "property_id": "12345",
    "message": "We have resolved the booking sync issue. Your calendar should now be updating correctly."
  }'
```

**Success Response (200):**

```json
{
  "success": true,
  "message": "Outbound call initiated",
  "callSid": "CA1234567890abcdef",
  "to": "+61412345678",
  "from": "+61280001234"
}
```

**Error Responses:**

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Missing required field: phone_number | No phone number provided |
| 400 | Invalid phone_number format | Phone number not in E.164 format |
| 401 | Invalid or missing API key | Authentication failed |
| 403 | Outbound calls are not enabled | Feature is disabled in config |
| 500 | (varies) | Server or Twilio error |

---

### GET `/api/outbound-call/health`

Health check endpoint for the outbound call service.

**Response:**

```json
{
  "enabled": true,
  "api_key_required": true,
  "active_calls": 0
}
```

---

## Internal Endpoints (Used by Twilio)

These endpoints are called by Twilio during call processing. They should not be called directly.

### ALL `/outbound-twiml`

Twilio requests this URL when the outbound call is answered. Returns TwiML that connects the call audio to the `/media-stream` WebSocket with `direction=outbound`.

### POST `/outbound-status`

Twilio sends status callbacks here as the call progresses (ringing, in-progress, completed, failed, busy, no-answer). Used to clean up stored call context.

---

## How It Works

### 1. API Request Received
- External system sends POST to `/api/outbound-call` with phone number and context
- API key is validated
- Phone number format is validated (E.164)
- Call context (message, reason, caller_name, etc.) is stored in memory

### 2. Twilio Creates the Call
- `makeOutboundCall()` in `services/twilio.js` creates the call via Twilio's API
- The call's TwiML URL points to `/outbound-twiml`
- Status callback points to `/outbound-status`
- The CallSid is returned to the caller and used as a key for the stored context

### 3. Person Answers the Call
- Twilio fetches `/outbound-twiml` which returns TwiML with `<Connect><Stream>`
- The Stream URL includes `direction=outbound` as a query parameter
- This opens a WebSocket connection to `/media-stream`

### 4. Media Stream Handles the Call
- `media-stream.js` detects `direction=outbound` from URL parameters
- Retrieves stored outbound context using `getOutboundContext(callSid)`
- Sets `callState.direction = 'outbound'`
- **Skips phone lookup** (not needed — we already know who we're calling)
- **Uses outbound-specific greeting** instead of the default inbound greeting
- Injects outbound context into the OpenAI session as background information

### 5. AI Conversation
- The AI agent greets the person with the provided context
- The agent explains the reason for the call and delivers the message
- Normal conversation proceeds (the person can ask questions, etc.)
- All the same tools are available (save_caller_info, end_call, etc.)

### 6. Call Ends
- Transcript is saved the same way as inbound calls
- Call context is cleaned up from memory
- Email notification is sent with transcript

---

## Configuration

Environment variables in `config/index.js`:

| Variable | Description | Default |
|----------|-------------|---------|
| `TWILIO_PHONE_NUMBER` | The Twilio phone number to call from (E.164) | Required |
| `SERVER_PUBLIC_URL` | Public URL of the server (without https://) | Required |
| `OUTBOUND_CALL_API_KEY` | API key for authenticating outbound call requests | Required |
| `OUTBOUND_CALL_ENABLED` | Enable/disable the outbound call feature | `true` |
| `OUTBOUND_CALL_DEFAULT_GREETING` | Default greeting if none provided | See config |

---

## Files Involved

| File | Role |
|------|------|
| `routes/outbound-call.js` | API endpoint, TwiML generator, status callback, context store |
| `routes/media-stream.js` | WebSocket handler — detects outbound direction, injects context |
| `services/twilio.js` | `makeOutboundCall()` function — creates call via Twilio API |
| `config/index.js` | Configuration for outbound calls |
| `index.js` | Registers the outbound call route |

---

## Differences from Inbound Calls

| Aspect | Inbound | Outbound |
|--------|---------|----------|
| Initiated by | External caller | API request |
| Phone lookup | Yes (background) | No (context provided) |
| Greeting | Default inbound greeting | Custom greeting with context |
| AI context | Injected from phone lookup | Injected from API request body |
| TwiML source | `/incoming-call` | `/outbound-twiml` |
| Call direction in transcript | `inbound` (default) | `outbound` |
| Recording | Yes | Yes |
| Transcript email | Yes | Yes |

---

## Security

- API key authentication required for the `/api/outbound-call` endpoint
- Phone number validated for E.164 format to prevent injection
- Call context stored in memory with automatic cleanup (5-minute timeout + status callback cleanup)
- The feature can be disabled entirely via `OUTBOUND_CALL_ENABLED=false`
