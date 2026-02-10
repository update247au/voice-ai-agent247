// Email service for sending call transcripts
// Supports both SMTP (cPanel) and Amazon SES

import nodemailer from 'nodemailer';
import { EMAIL_CONFIG } from '../config/index.js';

let transporter = null;

// Initialize email transporter
export const initializeEmail = () => {
    if (!EMAIL_CONFIG.EMAIL_ENABLED) {
        console.log('[Email] Email notifications disabled (EMAIL_ENABLED not set to true)');
        return null;
    }

    // Check if SMTP is configured
    if (EMAIL_CONFIG.SMTP_HOST && EMAIL_CONFIG.SMTP_USER && EMAIL_CONFIG.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: EMAIL_CONFIG.SMTP_HOST,
            port: EMAIL_CONFIG.SMTP_PORT,
            secure: EMAIL_CONFIG.SMTP_SECURE,
            auth: {
                user: EMAIL_CONFIG.SMTP_USER,
                pass: EMAIL_CONFIG.SMTP_PASS
            }
        });
        console.log(`[Email] ✓ SMTP transporter initialized (${EMAIL_CONFIG.SMTP_HOST})`);
        return transporter;
    }

    // Check if AWS SES is configured
    if (EMAIL_CONFIG.AWS_SES_ACCESS_KEY && EMAIL_CONFIG.AWS_SES_SECRET_KEY) {
        transporter = nodemailer.createTransport({
            host: `email-smtp.${EMAIL_CONFIG.AWS_SES_REGION}.amazonaws.com`,
            port: 465,
            secure: true,
            auth: {
                user: EMAIL_CONFIG.AWS_SES_ACCESS_KEY,
                pass: EMAIL_CONFIG.AWS_SES_SECRET_KEY
            }
        });
        console.log(`[Email] ✓ AWS SES transporter initialized (${EMAIL_CONFIG.AWS_SES_REGION})`);
        return transporter;
    }

    console.log('[Email] ⚠️  No email configuration found. Email notifications disabled.');
    return null;
};

// Get email transporter
export const getEmailTransporter = () => transporter;

// Send call transcript email
export const sendCallTranscriptEmail = async (transcript, filename) => {
    if (!transporter) {
        console.log('[Email] Cannot send email: No transporter configured');
        return { success: false, error: 'Email not configured' };
    }

    if (!EMAIL_CONFIG.NOTIFY_EMAIL) {
        console.log('[Email] Cannot send email: NOTIFY_EMAIL not set');
        return { success: false, error: 'NOTIFY_EMAIL not configured' };
    }

    try {
        const fromEmail = EMAIL_CONFIG.SMTP_USER || EMAIL_CONFIG.SES_FROM_EMAIL || 'noreply@update247.com.au';
        
        // Format call summary for email body
        const callState = transcript.callState || {};
        const disconnectInfo = transcript.disconnectInfo || {};
        const tokenUsage = transcript.tokenUsage || {};
        
        const emailBody = `
Call Transcript Summary
========================

Call Details:
- Caller Number: ${transcript.callerNumber || 'Unknown'}
- Callee Number: ${transcript.calleeNumber || 'Unknown'}
- Call SID: ${transcript.callSid || 'N/A'}
- Duration: ${tokenUsage.call_duration_formatted || 'Unknown'}
- Start Time: ${transcript.startTime || 'Unknown'}
- End Time: ${transcript.endTime || 'Unknown'}

Caller Information:
- Property ID: ${callState.property_id || 'Not provided'}
- Property Name: ${callState.property_name || 'Not provided'}
- Caller Name: ${callState.caller_name || 'Not provided'}
- Caller Email: ${callState.caller_email || 'Not provided'}
- Existing Client: ${callState.is_existing_client !== null ? (callState.is_existing_client ? 'Yes' : 'No') : 'Not determined'}
- Routed To: ${callState.routing ? callState.routing.toUpperCase() : 'Not routed'}

Disconnect Info:
- Disconnected By: ${disconnectInfo.disconnected_by || 'Unknown'}
- Reason: ${disconnectInfo.disconnect_reason || 'Unknown'}

Token Usage:
- Input Tokens: ${tokenUsage.input_tokens || 0}
- Output Tokens: ${tokenUsage.output_tokens || 0}
- Estimated Cost: $${tokenUsage.estimated_cost_usd?.toFixed(6) || '0.00'}

Issue Description:
${callState.issue_description || 'No issue recorded'}

---
Full transcript attached as JSON file.
        `.trim();

        const mailOptions = {
            from: fromEmail,
            to: EMAIL_CONFIG.NOTIFY_EMAIL,
            subject: `Call Transcript - ${transcript.callerNumber || 'Unknown Caller'} - ${new Date().toLocaleDateString()}`,
            text: emailBody,
            attachments: [
                {
                    filename: filename,
                    content: JSON.stringify(transcript, null, 2),
                    contentType: 'application/json'
                }
            ]
        };

        const result = await transporter.sendMail(mailOptions);
        console.log(`[Email] ✓ Call transcript sent to ${EMAIL_CONFIG.NOTIFY_EMAIL}`);
        return { success: true, messageId: result.messageId };
    } catch (error) {
        console.error('[Email] ✗ Failed to send email:', error.message);
        return { success: false, error: error.message };
    }
};

// Test email configuration
export const testEmailConnection = async () => {
    if (!transporter) {
        console.log('[Email] Cannot test: No transporter configured');
        return { success: false, error: 'Email not configured' };
    }

    try {
        await transporter.verify();
        console.log('[Email] ✓ Email connection verified');
        return { success: true };
    } catch (error) {
        console.error('[Email] ✗ Email connection failed:', error.message);
        return { success: false, error: error.message };
    }
};
