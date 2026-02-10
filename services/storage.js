import { Storage } from '@google-cloud/storage';
import fs from 'fs';
import path from 'path';
import { GCS_BUCKET, CALL_HISTORY_DIR, DEFAULT_SYSTEM_MESSAGE } from '../config/index.js';

let storage = null;

// Initialize GCS storage
export const initializeStorage = () => {
    if (GCS_BUCKET) {
        storage = new Storage();
        console.log(`GCS enabled. Uploading transcripts to bucket: ${GCS_BUCKET}`);
        
        // Test GCS connectivity on startup
        setTimeout(testGCSConnectivity, 500);
    } else {
        console.log('GCS_BUCKET not set — transcripts will be saved to local call-history folder');
    }
    return storage;
};

// Test GCS connectivity
const testGCSConnectivity = async () => {
    if (!storage || !GCS_BUCKET) return;
    
    try {
        const testFilename = `test-${Date.now()}.json`;
        const testFile = storage.bucket(GCS_BUCKET).file(testFilename);
        const testPayload = JSON.stringify({
            test: true,
            timestamp: new Date().toISOString(),
            message: 'GCS connectivity test'
        }, null, 2);
        
        await testFile.save(testPayload, { contentType: 'application/json' });
        console.log(`✓ GCS test successful: gs://${GCS_BUCKET}/${testFilename}`);
    } catch (err) {
        console.error(`✗ GCS test failed: ${err.message}`);
        console.error('   Make sure: 1) bucket exists, 2) service account has objectCreator role, 3) credentials are set');
    }
};

// Get storage instance
export const getStorage = () => storage;

// Save transcript to GCS or local file
export const saveTranscriptToStorage = async (filename, payload) => {
    // Try GCS first
    if (storage && GCS_BUCKET) {
        try {
            const file = storage.bucket(GCS_BUCKET).file(filename);
            await file.save(payload, { contentType: 'application/json' });
            console.log(`[saveTranscript] ✓ Transcript uploaded to gs://${GCS_BUCKET}/${filename}`);
            return { success: true, location: `gs://${GCS_BUCKET}/${filename}` };
        } catch (err) {
            console.error(`[saveTranscript] ✗ Failed to upload to GCS: ${err.message}`, err);
        }
    }

    // Fallback to local file
    try {
        const filepath = path.join(CALL_HISTORY_DIR, filename);
        fs.writeFileSync(filepath, payload);
        console.log(`[saveTranscript] ✓ Transcript saved locally: ${filepath}`);
        return { success: true, location: filepath };
    } catch (err) {
        console.error(`[saveTranscript] ✗ Failed to save locally: ${err.message}`, err);
        return { success: false, error: err.message };
    }
};

// Save backup transcript
export const saveBackupTranscript = async (filename, payload) => {
    // Save locally
    try {
        const backupPath = path.join(CALL_HISTORY_DIR, filename);
        fs.writeFileSync(backupPath, payload);
        console.log(`[saveTranscript] ✓ Backup saved locally: ${backupPath}`);
    } catch (e) {
        console.error('[saveTranscript] ✗ Failed to create backup file:', e.message);
    }

    // Also attempt to upload backup to GCS
    if (storage && GCS_BUCKET) {
        try {
            const backupFile = storage.bucket(GCS_BUCKET).file(`backups/${filename}`);
            await backupFile.save(payload, { contentType: 'application/json' });
            console.log(`[saveTranscript] ✓ Backup uploaded to gs://${GCS_BUCKET}/backups/${filename}`);
        } catch (e) {
            console.error(`[saveTranscript] ✗ Failed to upload backup to GCS: ${e.message}`);
        }
    }
};

// Load file from GCS or local
export const loadFromStorage = async (filename, localFallbackPath = null) => {
    // Try GCS first
    if (storage && GCS_BUCKET) {
        try {
            const file = storage.bucket(GCS_BUCKET).file(filename);
            const [exists] = await file.exists();
            if (exists) {
                const [content] = await file.download();
                return { success: true, content: content.toString('utf-8'), source: 'gcs' };
            }
        } catch (err) {
            console.log(`[Storage] GCS lookup failed for ${filename}: ${err.message}`);
        }
    }

    // Fallback to local file
    if (localFallbackPath && fs.existsSync(localFallbackPath)) {
        const content = fs.readFileSync(localFallbackPath, 'utf-8');
        return { success: true, content, source: 'local' };
    }

    return { success: false, content: null, source: null };
};

// Load agent settings from GCS bucket
export const loadAgentSettings = async () => {
    // Helper function to load system message from file
    const loadSystemMessage = async () => {
        try {
            // Try GCS first
            if (storage && GCS_BUCKET) {
                try {
                    const sysMsgFile = storage.bucket(GCS_BUCKET).file('ai-setting/u247-system-message.json');
                    const [exists] = await sysMsgFile.exists();
                    if (exists) {
                        const [content] = await sysMsgFile.download();
                        const sysMsg = JSON.parse(content.toString('utf-8'));
                        console.log('✓ Loaded system message from GCS: gs://' + GCS_BUCKET + '/ai-setting/u247-system-message.json');
                        return sysMsg.system_message || DEFAULT_SYSTEM_MESSAGE;
                    }
                } catch (err) {
                    console.log('[loadSystemMessage] GCS lookup failed, trying local file. Error:', err.message);
                }
            }

            // Fallback to local file
            const localPath = path.join(process.cwd(), 'ai-setting', 'u247-system-message.json');
            if (fs.existsSync(localPath)) {
                const content = fs.readFileSync(localPath, 'utf-8');
                const sysMsg = JSON.parse(content);
                console.log('✓ Loaded system message from local file:', localPath);
                return sysMsg.system_message || DEFAULT_SYSTEM_MESSAGE;
            }

            console.log('⚠️  System message file not found (GCS or local), using embedded default');
            return DEFAULT_SYSTEM_MESSAGE;
        } catch (err) {
            console.error('✗ Error loading system message:', err.message);
            return DEFAULT_SYSTEM_MESSAGE;
        }
    };

    // If GCS is not configured, return default settings
    if (!GCS_BUCKET || !storage) {
        console.log('ℹ️  GCS not configured. Loading settings from local files.');
        const systemMsg = await loadSystemMessage();
        return {
            system_message: systemMsg,
            voice: 'sage',
            temperature: 0.2,
            use_realtime_transcription: false,
            initial_greeting: 'Greet the user with : This is Lucy from Update 2 4 7. How are you today?'
        };
    }

    try {
        // Load settings from GCS bucket
        const settingsFile = storage.bucket(GCS_BUCKET).file('ai-setting/u247-agent.json');
        const [exists] = await settingsFile.exists();
        
        if (!exists) {
            console.log('⚠️  Settings file not found in GCS (gs://' + GCS_BUCKET + '/ai-setting/u247-agent.json). Using default settings.');
            const systemMsg = await loadSystemMessage();
            return {
                system_message: systemMsg,
                voice: 'sage',
                temperature: 0.2,
                use_realtime_transcription: false,
                initial_greeting: 'Greet the user with : This is Lucy from Update 2 4 7. How are you today?'
            };
        }

        const [fileContent] = await settingsFile.download();
        const settings = JSON.parse(fileContent.toString('utf-8'));
        
        console.log('✓ Loaded agent settings from GCS: gs://' + GCS_BUCKET + '/ai-setting/u247-agent.json');
        console.log('  - voice:', settings.voice);
        console.log('  - temperature:', settings.temperature);
        
        // Load system message from separate file
        const systemMsg = await loadSystemMessage();
        
        const finalSettings = {
            system_message: systemMsg,
            voice: settings.voice || 'sage',
            temperature: settings.temperature !== undefined ? settings.temperature : 0.2,
            use_realtime_transcription: settings.use_realtime_transcription || false,
            initial_greeting: settings.initial_greeting || 'Greet the user with : This is Lucy from Update 2 4 7. How are you today?'
        };
        
        console.log('✓ Final settings to use - system_message length:', finalSettings.system_message.length);
        return finalSettings;
    } catch (error) {
        console.error('✗ Error loading agent settings from GCS:', error.message);
        console.log('  Falling back to default system message.');
        const systemMsg = await loadSystemMessage();
        return {
            system_message: systemMsg,
            voice: 'sage',
            temperature: 0.2,
            use_realtime_transcription: false,
            initial_greeting: 'Greet the user with : This is Lucy from Update 2 4 7. How are you today?'
        };
    }
};

export { storage, GCS_BUCKET };
