# Email Tool & Webhook API Documentation

## Overview

The system provides two ways to send emails to property owners:

1. **Agent Tool** — The AI voice agent can send emails during a live call
2. **Webhook API** — External systems can trigger emails via HTTP POST

Both methods use the same underlying email service and templates. All emails are BCC'd to `support@update247.com.au`.

---

## 1. Agent Tool — `send_email_to_property_owner`

During a live call, the AI agent can decide to send an email to a property owner. The tool is registered with OpenAI and called automatically when appropriate.

### Parameters

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `recipient_email` | Yes | string | The property owner's email address |
| `message` | Yes | string | The message content to send |
| `subject` | No | string | Email subject line. Default: `"Message from Update247 - {date}"` |
| `template` | No | string | `"support"` or `"sales"`. Auto-selects based on call routing if not specified |

### How It Works

1. OpenAI decides to call `send_email_to_property_owner` based on conversation context
2. The handler in `handlers/functions.js` receives the call
3. **Template auto-selection**: If no template specified, uses `callState.routing` — `"sales"` routing → sales template, everything else → support template
4. Calls `sendMessageToPropertyOwner()` from `services/email.js`
5. On success → AI confirms to the caller that the email was sent
6. On failure → AI apologises to the caller

### Code Flow

```
OpenAI function call
  → routes/media-stream.js (dispatches function call)
    → handlers/functions.js (handleSendEmailToPropertyOwner)
      → services/email.js (sendMessageToPropertyOwner)
        → Nodemailer (SMTP / AWS SES)
```

---

## 2. Webhook API — `POST /api/send-email`

External systems can send emails by calling this HTTP endpoint.

### Endpoint

```
POST /api/send-email
```

### Authentication

Include an API key in one of these ways:

- **Header**: `x-api-key: YOUR_API_KEY`
- **Body field**: `"api_key": "YOUR_API_KEY"`

The API key is configured via the `EMAIL_WEBHOOK_API_KEY` environment variable. If no key is configured, the endpoint is unprotected (a warning is logged).

### Request Body

```json
{
  "recipient_email": "owner@hotel.com",
  "message": "Your booking has been confirmed.",
  "subject": "Booking Confirmation",
  "template": "support"
}
```

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `recipient_email` | Yes | string | Recipient email address (validated with regex) |
| `message` | Yes | string | Message content |
| `subject` | No | string | Email subject. Default: `"Message from Update247 - {date}"` |
| `template` | No | string | `"support"` (default) or `"sales"` |

### Response — Success (200)

```json
{
  "success": true,
  "message": "Email sent successfully",
  "recipient": "owner@hotel.com",
  "template": "support",
  "messageId": "abc123"
}
```

### Response — Validation Error (400)

```json
{
  "success": false,
  "error": "Missing required field: recipient_email"
}
```

Validation checks:
- Missing `recipient_email` → 400
- Missing `message` → 400
- Invalid email format → 400
- Invalid template value → 400

### Response — Server Error (500)

```json
{
  "success": false,
  "error": "Error message"
}
```

### Health Check

```
GET /api/send-email/health
```

Returns email configuration status, whether API key is required, and available templates.

---

## 3. Email Service

### Configuration (Environment Variables)

| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_ENABLED` | Must be `"true"` to enable email | — |
| `SMTP_HOST` | SMTP server host | — |
| `SMTP_PORT` | SMTP server port | `465` |
| `SMTP_USER` | SMTP username | — |
| `SMTP_PASS` | SMTP password | — |
| `SMTP_SECURE` | Use TLS | `true` |
| `AWS_SES_ACCESS_KEY` | AWS SES access key (alternative to SMTP) | — |
| `AWS_SES_SECRET_KEY` | AWS SES secret key | — |
| `AWS_SES_REGION` | AWS SES region | `us-east-1` |
| `SES_FROM_EMAIL` | Sender email address | — |
| `EMAIL_WEBHOOK_API_KEY` | API key for webhook endpoint | — |

### Transport Priority

1. **SMTP** — Used if `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` are all set
2. **AWS SES** — Used if `AWS_SES_ACCESS_KEY` and `AWS_SES_SECRET_KEY` are set
3. **Disabled** — Neither configured

### From Address

Priority: `SES_FROM_EMAIL` → `SMTP_USER` (if contains `@`) → `noreply@update247.com.au`

### BCC

All emails are automatically BCC'd to `support@update247.com.au`.

---

## 4. Email Templates

Templates are HTML files stored in `ai-setting/email-templates/`. They are loaded once at startup.

### Available Templates

| Template | File | Header Color | Branding |
|----------|------|-------------|----------|
| `support` | `ai-setting/email-templates/support.html` | Blue (#2563eb) | "Update247 Support Team" |
| `sales` | `ai-setting/email-templates/sales.html` | Green (#059669) | "Update247 Sales Team" |

### Template Placeholders

| Placeholder | Replaced With |
|-------------|--------------|
| `{{MESSAGE}}` | Email message content (newlines → `<br>`) |
| `{{YEAR}}` | Current year |

### Support Template

- Blue header with "Update247 Support Team" branding
- Message displayed in a blue left-bordered box
- Quick links: Knowledge Base, Login, Call Support
- Footer with `support@update247.com.au`

### Sales Template

- Green header with "Update247 Sales Team" branding
- Message displayed in a green left-bordered box
- "Why Choose Update247?" section with value propositions
- "Book a Free Demo" call-to-action button
- Footer with `sales@update247.com.au`

### Fallback

If the template file is not found, the email is sent as plain text only (no HTML).

---

## 5. Agent Tool vs Webhook — Comparison

| Aspect | Agent Tool (during call) | Webhook API (external) |
|--------|------------------------|------------------------|
| **Trigger** | AI decides during live call | External system sends HTTP POST |
| **Auth** | Internal (WebSocket) | API key required |
| **Template** | Auto-selects from call routing | Defaults to `"support"` |
| **Email validation** | Trusts AI input | Regex validation |
| **Response** | AI speaks confirmation to caller | HTTP JSON response |
| **BCC** | `support@update247.com.au` | `support@update247.com.au` |
| **Underlying service** | `sendMessageToPropertyOwner()` | `sendMessageToPropertyOwner()` |

---

## 6. File Reference

| File | Purpose |
|------|---------|
| `handlers/openaiSession.js` | Tool definition (parameters, description) |
| `handlers/functions.js` | Tool handler (processes AI function call) |
| `routes/media-stream.js` | Dispatches function calls from OpenAI |
| `routes/send-email.js` | Webhook HTTP endpoint |
| `services/email.js` | Email service (SMTP/SES, templates, BCC) |
| `config/index.js` | Email configuration (env vars) |
| `ai-setting/email-templates/support.html` | Support email template |
| `ai-setting/email-templates/sales.html` | Sales email template |
