// Send Email Webhook Route
// POST /api/send-email - External systems can call this to send emails

import { EMAIL_CONFIG } from '../config/index.js';
import { sendMessageToPropertyOwner } from '../services/email.js';

// Register the send-email webhook route
export const registerSendEmailRoute = (fastify) => {
    
    // POST /api/send-email - Send email to property owner
    fastify.post('/api/send-email', async (request, reply) => {
        console.log('[Webhook] /api/send-email called');
        
        // Check API key authentication
        const apiKey = request.headers['x-api-key'] || request.body?.api_key;
        
        if (EMAIL_CONFIG.WEBHOOK_API_KEY) {
            if (!apiKey || apiKey !== EMAIL_CONFIG.WEBHOOK_API_KEY) {
                console.log('[Webhook] Unauthorized - Invalid or missing API key');
                return reply.status(401).send({
                    success: false,
                    error: 'Unauthorized - Invalid or missing API key'
                });
            }
        } else {
            console.log('[Webhook] Warning: No EMAIL_WEBHOOK_API_KEY configured - endpoint is unprotected');
        }
        
        // Validate request body
        const { recipient_email, message, subject } = request.body || {};
        
        if (!recipient_email) {
            return reply.status(400).send({
                success: false,
                error: 'Missing required field: recipient_email'
            });
        }
        
        if (!message) {
            return reply.status(400).send({
                success: false,
                error: 'Missing required field: message'
            });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(recipient_email)) {
            return reply.status(400).send({
                success: false,
                error: 'Invalid email format: recipient_email'
            });
        }
        
        try {
            // Send the email
            console.log(`[Webhook] Sending email to: ${recipient_email}`);
            const result = await sendMessageToPropertyOwner(recipient_email, message, subject);
            
            if (result.success) {
                console.log(`[Webhook] ✓ Email sent successfully to ${recipient_email}`);
                return reply.status(200).send({
                    success: true,
                    message: 'Email sent successfully',
                    recipient: recipient_email,
                    messageId: result.messageId
                });
            } else {
                console.error(`[Webhook] ✗ Failed to send email: ${result.error}`);
                return reply.status(500).send({
                    success: false,
                    error: result.error || 'Failed to send email'
                });
            }
        } catch (error) {
            console.error('[Webhook] ✗ Exception while sending email:', error.message);
            return reply.status(500).send({
                success: false,
                error: 'Internal server error',
                details: error.message
            });
        }
    });
    
    // GET /api/send-email/health - Health check for the email webhook
    fastify.get('/api/send-email/health', async (request, reply) => {
        return reply.send({
            status: 'ok',
            service: 'send-email-webhook',
            emailConfigured: !!(EMAIL_CONFIG.SMTP_HOST || EMAIL_CONFIG.AWS_SES_ACCESS_KEY),
            apiKeyRequired: !!EMAIL_CONFIG.WEBHOOK_API_KEY
        });
    });
};
