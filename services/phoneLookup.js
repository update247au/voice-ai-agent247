import fs from 'fs';
import path from 'path';
import { getStorage, GCS_BUCKET } from './storage.js';

// Function to load and lookup phone mappings
export const lookupPropertyByPhone = async (phoneNumber) => {
    const storage = getStorage();
    
    try {
        // Try to load from GCS first if available
        if (storage && GCS_BUCKET) {
            try {
                console.log('[Phone Lookup] Attempting GCS lookup from bucket:', GCS_BUCKET);
                const file = storage.bucket(GCS_BUCKET).file('phone-mappings.json');
                const [exists] = await file.exists();
                if (exists) {
                    const [content] = await file.download();
                    const mappings = JSON.parse(content.toString('utf-8'));
                    console.log('[Phone Lookup] ✓ Loaded phone mappings from GCS, found', mappings.phone_mappings?.length || 0, 'entries');
                    return findPhoneMatch(phoneNumber, mappings.phone_mappings);
                } else {
                    console.log('[Phone Lookup] phone-mappings.json does not exist in GCS');
                }
            } catch (err) {
                console.log('[Phone Lookup] GCS lookup failed, trying local file. Error:', err.message);
            }
        } else {
            console.log('[Phone Lookup] GCS not configured (storage:', !!storage, 'bucket:', GCS_BUCKET, ')');
        }
        
        // Fallback to local file
        const localPath = path.join(process.cwd(), 'phone-mappings.json');
        console.log('[Phone Lookup] Checking local file at:', localPath);
        if (fs.existsSync(localPath)) {
            console.log('[Phone Lookup] ✓ Local phone-mappings.json found');
            const content = fs.readFileSync(localPath, 'utf-8');
            const mappings = JSON.parse(content);
            console.log('[Phone Lookup] Loaded', mappings.phone_mappings?.length || 0, 'phone mappings from local file');
            return findPhoneMatch(phoneNumber, mappings.phone_mappings);
        } else {
            console.log('[Phone Lookup] ✗ Local phone-mappings.json not found at:', localPath);
        }
        
        console.log('[Phone Lookup] No phone mappings file found (GCS or local)');
        return null;
    } catch (err) {
        console.error('[Phone Lookup] Error:', err.message);
        return null;
    }
};

// Helper function to find phone match (handles different formats)
export const findPhoneMatch = (phoneNumber, mappings) => {
    if (!phoneNumber || !mappings || !Array.isArray(mappings)) {
        console.log('[Phone Lookup] Invalid input - phoneNumber:', phoneNumber, 'mappings type:', Array.isArray(mappings), 'is null:', mappings === null);
        return null;
    }
    
    console.log('[Phone Lookup] Searching in', mappings.length, 'mappings for number:', phoneNumber);
    
    // Normalize the phone number (remove all non-digits, keep as string for comparison)
    const normalized = String(phoneNumber).replace(/\D/g, '');
    console.log('[Phone Lookup] Normalized caller number:', normalized);
    
    for (const mapping of mappings) {
        const mappingNormalized = String(mapping.phone_number).replace(/\D/g, '');
        console.log('[Phone Lookup] Comparing against:', mapping.phone_number, '→ normalized:', mappingNormalized);
        
        // Check exact match on normalized numbers (most reliable)
        if (normalized === mappingNormalized) {
            console.log(`[Phone Lookup] ✓ EXACT MATCH FOUND: ${phoneNumber} → ${mapping.property_name} (ID: ${mapping.property_id})`);
            return {
                property_id: mapping.property_id,
                property_name: mapping.property_name,
                phone_number: mapping.phone_number
            };
        }
        
        // Check literal match
        if (phoneNumber === mapping.phone_number) {
            console.log(`[Phone Lookup] ✓ LITERAL MATCH FOUND: ${phoneNumber} → ${mapping.property_name} (ID: ${mapping.property_id})`);
            return {
                property_id: mapping.property_id,
                property_name: mapping.property_name,
                phone_number: mapping.phone_number
            };
        }
    }
    
    console.log(`[Phone Lookup] ✗ NO MATCH found for: ${phoneNumber} (normalized: ${normalized})`);
    return null;
};
