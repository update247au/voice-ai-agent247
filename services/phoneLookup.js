import fs from 'fs';
import path from 'path';
import { getStorage, GCS_BUCKET } from './storage.js';
import { PHONE_LOOKUP_CONFIG } from '../config/index.js';

// Main function to lookup property by phone number
// Priority: 1) API (if configured), 2) GCS file, 3) Local file
export const lookupPropertyByPhone = async (phoneNumber) => {
    if (!phoneNumber) {
        console.log('[Phone Lookup] No phone number provided');
        return null;
    }

    // Debug: Log config status
    console.log('[Phone Lookup] API_URL configured:', PHONE_LOOKUP_CONFIG.API_URL ? 'YES' : 'NO');

    // Try API first if configured
    if (PHONE_LOOKUP_CONFIG.API_URL) {
        const apiResult = await lookupViaAPI(phoneNumber);
        if (apiResult !== null) {
            return apiResult;  // API returned a result (found or not found)
        }
        // API failed - fall through to file-based lookup if fallback enabled
        if (!PHONE_LOOKUP_CONFIG.FALLBACK_TO_FILE) {
            console.log('[Phone Lookup] API failed and fallback disabled');
            return null;
        }
        console.log('[Phone Lookup] API failed, falling back to file-based lookup');
    }

    // File-based lookup (GCS or local)
    return await lookupViaFile(phoneNumber);
};

// Lookup via API endpoint
const lookupViaAPI = async (phoneNumber) => {
    const { API_URL, API_KEY, TIMEOUT_MS } = PHONE_LOOKUP_CONFIG;
    
    console.log('[Phone Lookup] Calling API:', API_URL);
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const headers = {
            'Content-Type': 'application/json'
        };
        
        // Add API key if configured
        if (API_KEY) {
            headers['Authorization'] = `Bearer ${API_KEY}`;
            headers['X-API-Key'] = API_KEY;
        }

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({ phone_number: phoneNumber }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error(`[Phone Lookup] API returned HTTP ${response.status}`);
            return null;  // Return null to trigger fallback
        }

        const data = await response.json();
        console.log('[Phone Lookup] API response:', JSON.stringify(data));

        // Handle API response
        if (data.success === false || data.error) {
            console.error('[Phone Lookup] API error:', data.error || 'Unknown error');
            return null;
        }

        // Not found - return structured "not found" result
        if (!data.is_existing_client && (!data.properties || data.properties.length === 0)) {
            console.log('[Phone Lookup] API: Caller not found in database');
            return {
                is_existing_client: false,
                property_count: 0,
                has_multiple_properties: false,
                properties: [],
                source: 'api'
            };
        }

        // Found - structure the response
        const properties = data.properties || [];
        if (properties.length === 0 && data.property_id) {
            // Handle flat response format
            properties.push({
                property_id: data.property_id,
                property_name: data.property_name,
                contact_name: data.contact_name || null,
                contact_email: data.contact_email || null
            });
        }

        const result = {
            is_existing_client: true,
            property_count: properties.length,
            has_multiple_properties: properties.length > 1,
            properties: properties,
            // Backward compatibility - first property at top level
            property_id: properties[0]?.property_id,
            property_name: properties[0]?.property_name,
            contact_name: properties[0]?.contact_name || null,
            contact_email: properties[0]?.contact_email || null,
            source: 'api'
        };

        console.log(`[Phone Lookup] ✓ API found ${properties.length} property(ies) for caller`);
        properties.forEach((p, i) => {
            console.log(`   ${i + 1}. ${p.property_name} (ID: ${p.property_id})${p.contact_name ? ` - Contact: ${p.contact_name}` : ''}`);
        });

        return result;

    } catch (err) {
        if (err.name === 'AbortError') {
            console.error(`[Phone Lookup] API timeout after ${TIMEOUT_MS}ms`);
        } else {
            console.error('[Phone Lookup] API error:', err.message);
        }
        return null;  // Return null to trigger fallback
    }
};

// Lookup via file (GCS or local phone-mappings.json)
const lookupViaFile = async (phoneNumber) => {
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
                    const result = findPhoneMatch(phoneNumber, mappings.phone_mappings);
                    if (result) result.source = 'gcs_file';
                    return result;
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
            const result = findPhoneMatch(phoneNumber, mappings.phone_mappings);
            if (result) result.source = 'local_file';
            return result;
        } else {
            console.log('[Phone Lookup] ✗ Local phone-mappings.json not found at:', localPath);
        }
        
        console.log('[Phone Lookup] No phone mappings file found (GCS or local)');
        return null;
    } catch (err) {
        console.error('[Phone Lookup] File lookup error:', err.message);
        return null;
    }
};

// Helper function to find ALL phone matches from file (handles different formats)
export const findPhoneMatch = (phoneNumber, mappings) => {
    if (!phoneNumber || !mappings || !Array.isArray(mappings)) {
        console.log('[Phone Lookup] Invalid input - phoneNumber:', phoneNumber, 'mappings type:', Array.isArray(mappings), 'is null:', mappings === null);
        return null;
    }
    
    console.log('[Phone Lookup] Searching in', mappings.length, 'mappings for number:', phoneNumber);
    
    // Normalize the phone number (remove all non-digits, keep as string for comparison)
    const normalized = String(phoneNumber).replace(/\D/g, '');
    console.log('[Phone Lookup] Normalized caller number:', normalized);
    
    // Collect ALL matching properties (caller may have multiple properties)
    const matchedProperties = [];
    const seenPropertyIds = new Set();
    
    for (const mapping of mappings) {
        const mappingNormalized = String(mapping.phone_number).replace(/\D/g, '');
        
        // Check if this phone number matches
        const isMatch = normalized === mappingNormalized || phoneNumber === mapping.phone_number;
        
        if (isMatch && !seenPropertyIds.has(mapping.property_id)) {
            console.log(`[Phone Lookup] ✓ MATCH FOUND: ${phoneNumber} → ${mapping.property_name} (ID: ${mapping.property_id})`);
            matchedProperties.push({
                property_id: mapping.property_id,
                property_name: mapping.property_name,
                contact_name: mapping.contact_name || null,
                contact_email: mapping.contact_email || null,
                phone_number: mapping.phone_number
            });
            seenPropertyIds.add(mapping.property_id);
        }
    }
    
    if (matchedProperties.length === 0) {
        console.log(`[Phone Lookup] ✗ NO MATCH found for: ${phoneNumber} (normalized: ${normalized})`);
        return null;
    }
    
    // Return structured result with all properties
    const result = {
        is_existing_client: true,
        property_count: matchedProperties.length,
        has_multiple_properties: matchedProperties.length > 1,
        properties: matchedProperties,
        // For backward compatibility, also include first property at top level
        property_id: matchedProperties[0].property_id,
        property_name: matchedProperties[0].property_name,
        contact_name: matchedProperties[0].contact_name,
        contact_email: matchedProperties[0].contact_email,
        phone_number: matchedProperties[0].phone_number
    };
    
    console.log(`[Phone Lookup] ✓ Found ${matchedProperties.length} property(ies) for this caller`);
    if (matchedProperties.length > 1) {
        console.log('[Phone Lookup] Properties:', matchedProperties.map(p => `${p.property_name} (${p.property_id})`).join(', '));
    }
    
    return result;
};
