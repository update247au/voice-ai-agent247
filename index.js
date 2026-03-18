/**
 * Update247 AI Voice Agent
 * 
 * A voice-based AI assistant for Update247 using OpenAI's Realtime API and Twilio.
 * 
 * Project Structure:
 * - config/         - Configuration and environment variables
 * - services/       - External service integrations (Twilio, GCS, Email, etc.)
 * - handlers/       - Business logic handlers (function calls, inactivity, etc.)
 * - routes/         - HTTP and WebSocket route handlers
 * - utils/          - Utility functions and helpers
 */

import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Import configuration
import { PORT, validateConfig, OUTBOUND_CALL_CONFIG } from './config/index.js';

// Import services
import { initializeStorage, loadAgentSettings } from './services/storage.js';
import { initializeTwilio } from './services/twilio.js';
import { initializeEmail } from './services/email.js';

// Import routes
import { registerIncomingCallRoute } from './routes/incoming-call.js';
import { registerMediaStreamRoute } from './routes/media-stream.js';
import { registerSendEmailRoute } from './routes/send-email.js';
import { registerOutboundCallRoute } from './routes/outbound-call.js';

// Validate configuration
validateConfig();

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Root route
fastify.get('/', async (request, reply) => {
    reply.send({ 
        message: 'Update247 AI Voice Agent is running!',
        version: '2.0.0',
        endpoints: {
            health: '/',
            incomingCall: '/incoming-call',
            mediaStream: '/media-stream (WebSocket)',
            sendEmail: '/api/send-email (POST)',
            sendEmailHealth: '/api/send-email/health',
            outboundCall: '/api/outbound-call (POST)',
            outboundCallHealth: '/api/outbound-call/health'
        }
    });
});

// Main startup function
const start = async () => {
    try {
        console.log('═══════════════════════════════════════════');
        console.log('  Update247 AI Voice Agent - Starting Up');
        console.log('═══════════════════════════════════════════');

        // Initialize services
        console.log('\n[1/4] Initializing storage...');
        initializeStorage();

        console.log('\n[2/4] Initializing Twilio...');
        initializeTwilio();

        console.log('\n[3/4] Initializing email service...');
        initializeEmail();

        console.log('\n[4/4] Loading agent settings...');
        const agentSettings = await loadAgentSettings();
        console.log('  ✓ Voice:', agentSettings.voice);
        console.log('  ✓ Temperature:', agentSettings.temperature);
        console.log('  ✓ System message length:', agentSettings.system_message?.length || 0);
        console.log('  ✓ Outbound system message length:', agentSettings.outbound_system_message?.length || 0);

        // Register routes
        console.log('\nRegistering routes...');
        registerIncomingCallRoute(fastify);
        registerMediaStreamRoute(fastify, agentSettings);
        registerSendEmailRoute(fastify);
        registerOutboundCallRoute(fastify);
        console.log('  ✓ /incoming-call');
        console.log('  ✓ /media-stream');
        console.log('  ✓ /api/send-email');
        console.log('  ✓ /api/outbound-call');
        console.log('  ✓ Outbound calls enabled:', OUTBOUND_CALL_CONFIG.ENABLED, '(raw env:', process.env.OUTBOUND_CALL_ENABLED, ')');

        // Start server
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        
        console.log('\n═══════════════════════════════════════════');
        console.log(`  ✓ Server is listening on port ${PORT}`);
        console.log('═══════════════════════════════════════════\n');

    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
};

// Start the application
start();

