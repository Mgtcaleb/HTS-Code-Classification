require('dotenv').config();
// Ignore SSL errors for ICEGate API since they often have incomplete certificate chains
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const OpenAI = require('openai');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/['"]/g, '').trim() : null;
const supabaseKey = (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '').replace(/['"]/g, '').trim(); 
let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log('Supabase client initialized.');
} else {
    console.warn('Supabase credentials missing. Teaching feature disabled.');
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Initialize OpenAI SDK using OpenRouter's base URL
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY, 
});

const USITC_TOKEN = process.env.USITC_TOKEN;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
const USITC_LOOKUP_URL = 'https://datawebws.usitc.gov/dataweb/api/v2/tariff/currentTariffLookup';
const USITC_DETAILS_URL = 'https://datawebws.usitc.gov/dataweb/api/v2/tariff/currentTariffDetails';
const TARIFF_YEAR = '2024';

// ── In-memory cache: same product title → same result, zero tokens ──
const resultCache = new Map();

// ── Marketing / filler words to strip before searching USITC (FREE, no LLM) ──
const STOPWORDS = new Set([
    // marketing
    'best', 'premium', 'luxury', 'pro', 'ultra', 'super', 'mega', 'elite', 'deluxe',
    'new', 'latest', 'advanced', 'original', 'genuine', 'authentic', 'official',
    'exclusive', 'special', 'limited', 'edition', 'upgraded', 'improved', 'enhanced',
    // adjectives
    'soft', 'cottony', 'secure', 'regular', 'extra', 'large', 'small', 'medium',
    'big', 'mini', 'slim', 'thin', 'thick', 'heavy', 'light', 'lightweight',
    'durable', 'portable', 'foldable', 'adjustable', 'flexible', 'comfortable',
    'strong', 'sturdy', 'smooth', 'sleek', 'modern', 'classic', 'stylish',
    'fashionable', 'elegant', 'beautiful', 'pretty', 'cute', 'cool', 'hot',
    'warm', 'cold', 'dry', 'wet', 'waterproof', 'dustproof', 'shockproof',
    'invisible', 'clear', 'transparent', 'opaque', 'matte', 'glossy',
    // colors
    'black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple',
    'orange', 'brown', 'grey', 'gray', 'silver', 'gold', 'golden', 'multicolor',
    // fillers
    'for', 'with', 'and', 'the', 'of', 'in', 'on', 'at', 'to', 'by', 'from',
    'pack', 'pcs', 'set', 'piece', 'pieces', 'pair', 'pairs', 'unit', 'units',
    'combo', 'bundle', 'lot', 'box', 'case', 'bag',
    'free', 'bpa', 'eco', 'friendly', 'non', 'toxic', 'safe',
    'suitable', 'ideal', 'perfect', 'great', 'good', 'nice', 'fine',
    'home', 'kitchen', 'office', 'outdoor', 'indoor', 'travel', 'daily', 'use',
    // size / quantity patterns handled separately
    'ml', 'oz', 'gm', 'kg', 'cm', 'mm', 'inch', 'ft', 'liter', 'litre',
]);

/**
 * Extract 2-3 meaningful product keywords from a title — NO LLM needed.
 * Strips brands (usually first word), marketing fluff, sizes, and punctuation.
 */
function extractKeywords(title) {
    // Normalise: lowercase, strip special chars except alphanumeric and spaces
    let cleaned = title.toLowerCase()
        .replace(/[|,()[\]{}&\/\\]+/g, ' ')   // pipes, parens, etc → space
        .replace(/[^a-z0-9\s-]/g, '')          // remove remaining special chars
        .replace(/\b\d+\s*(ml|oz|gm|g|kg|cm|mm|inch|ft|liter|litre|pack|pcs|pieces|pair)\b/g, '') // remove measurements
        .replace(/\b\d+\b/g, '')               // remove standalone numbers
        .replace(/\s+/g, ' ')                  // collapse whitespace
        .trim();

    const words = cleaned.split(' ').filter(w => w.length > 1);

    // Remove stopwords
    const meaningful = words.filter(w => !STOPWORDS.has(w));

    // Take up to 3 most meaningful words (skip first word — usually the brand)
    let keywords = meaningful;
    if (keywords.length > 3) {
        keywords = keywords.slice(1, 4); // skip brand, take next 3
    }

    // Deduplicate
    keywords = [...new Set(keywords)];

    return keywords.length > 0 ? keywords : [cleaned.split(' ')[0] || title.substring(0, 20)];
}

const SELECTION_PROMPT = `You are a global shipping export and customs compliance expert.

Your task is to rewrite product titles for international customs declarations and select the most accurate Harmonized System HS Code from a provided list of valid USITC candidates.

Convert long marketing heavy or cluttered product titles into clear concise customs compliant descriptions suitable for clearance in USA.

Follow these rules strictly:
- Remove promotional words emojis symbols excessive adjectives and unnecessary punctuation.
- Do not use commas special characters or ambiguous wording.
- Avoid generic terms such as beverage parts accessories item goods.
- Each product title must include the brand name exact product type quantity or pack size material or composition if relevant and intended function or use.

CRITICAL INSTRUCTION: You MUST select the HS Code EXACTLY as it appears in the provided "Valid USITC Candidates" list. Copy the code character-for-character. Do NOT invent, modify, guess, or use an HS code from your internal memory. If no perfect match exists, pick the closest matching code FROM THE LIST.

Output format strictly:

product name: [Refined customs compliant product title]
HS Code: [Code copied EXACTLY from the candidates list]
article description: [Official article description copied EXACTLY from the candidates list]

Do not provide explanations or extra commentary. Return only the formatted result.`;

async function searchTariffs(keyword) {
    const response = await fetch(USITC_LOOKUP_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${USITC_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ searchTerm: keyword, tariffYear: TARIFF_YEAR })
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.list || [];
}

async function getTariffRate(hsCode) {
    const response = await fetch(`${USITC_DETAILS_URL}?year=${TARIFF_YEAR}&hts8=${hsCode}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${USITC_TOKEN}`
        }
    });
    if (!response.ok) return "Unknown";
    const data = await response.json();
    try {
        const tariffTreatment = data.sections.find(s => s.id === 'tariff_treatment');
        const mfn = tariffTreatment.children.find(c => c.id === 'mfn');
        const mfnText = mfn.children.find(c => c.id === 'mfn_text');
        return mfnText.value;
    } catch (e) {
        return "Unknown";
    }
}

async function getIndiaData(hsCode) {
    try {
        const response = await fetch(`https://www.icegate.gov.in/Webappl/Desc_details_itchs?cth=${hsCode}&item_desc=`);
        if (!response.ok) return null;
        const data = await response.json();
        const items = data.rsAllCth || [];
        if (items.length === 0) return null;

        // Find the most specific matching code
        // 1. Exact 8-digit match
        let bestMatch = items.find(i => i.itc_code === hsCode);
        
        // 2. 6-digit prefix match (if US code ends in different sub-digits than India)
        if (!bestMatch && hsCode.length >= 6) {
            const prefix6 = hsCode.substring(0, 6);
            bestMatch = items.find(i => i.itc_code && i.itc_code.startsWith(prefix6) && i.itc_code.length === 8 && i.uqc);
        }

        // 3. Fallback to any 8-digit code
        if (!bestMatch) {
            const eightDigit = items.filter(i => i.itc_code && i.itc_code.length === 8 && i.uqc);
            bestMatch = eightDigit.length > 0 ? eightDigit[0] : items[items.length - 1];
        }

        return {
            itcCode: bestMatch.itc_code || '',
            itcDesc: bestMatch.itc_desc || '',
            importPolicy: bestMatch.itchs_policy || '',
            indiaDuty: bestMatch.rta != null ? `${bestMatch.rta}%` : 'N/A',
            uqc: bestMatch.uqc || ''
        };
    } catch (e) {
        console.error('ICEGate fetch error:', e.message);
        return null;
    }
}

// ── Service Health Checker ──
const serviceHealth = {
    openRouter: true,
    usitc: true,
    icegate: true,
    lastChecked: Date.now()
};

async function checkServiceHealth() {
    console.log('Running background health check on external APIs...');
    
    // 1. OpenRouter (Check Auth Key endpoint)
    try {
        const orRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
            headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
        });
        serviceHealth.openRouter = orRes.ok;
    } catch { serviceHealth.openRouter = false; }

    // 2. USITC (Lookup endpoint with a dummy query)
    try {
        const usitcRes = await fetch(USITC_LOOKUP_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${USITC_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ searchTerm: '3305', tariffYear: TARIFF_YEAR })
        });
        serviceHealth.usitc = usitcRes.ok;
    } catch { serviceHealth.usitc = false; }

    // 3. ICEGate (Lookup endpoint with a dummy query)
    try {
        const iceRes = await fetch('https://www.icegate.gov.in/Webappl/Desc_details_itchs?cth=33051000&item_desc=');
        serviceHealth.icegate = iceRes.ok;
    } catch { serviceHealth.icegate = false; }
    
    serviceHealth.lastChecked = Date.now();
    console.log(`Health check complete: OR=${serviceHealth.openRouter} USITC=${serviceHealth.usitc} ICE=${serviceHealth.icegate}`);
}

// Run health checks every 2 minutes to prevent rate limiting
setInterval(checkServiceHealth, 120000);
checkServiceHealth(); // run immediately on startup

app.get('/api/ping', (req, res) => {
    res.json({
        server: true,
        openRouter: serviceHealth.openRouter,
        usitc: serviceHealth.usitc,
        icegate: serviceHealth.icegate
    });
});

// ── Keep-Alive Worker (Anti-Sleep) ──
// Render free tier sleeps after 15 mins. This pings every 14 mins.
let keepAliveTimer;
function resetKeepAlive() {
    clearTimeout(keepAliveTimer);
    // 14 minutes = 14 * 60 * 1000 = 840000 ms
    keepAliveTimer = setTimeout(() => {
        console.log('Keep-alive worker pinging to prevent sleep...');
        const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
        fetch(`${url}/api/ping`).catch(() => {});
        resetKeepAlive(); // Schedule the next one
    }, 840000);
}

app.post('/api/classify', async (req, res) => {
    console.log('Received request with body:', req.body);
    
    // User is active, reset the worker timer so it doesn't run during actual usage
    resetKeepAlive();
    
    try {
        const { productTitle } = req.body;
        
        if (!productTitle) {
            return res.status(400).json({ error: 'productTitle is required in the request body.' });
        }

        // ── Cache check: if we already classified this exact title, return instantly (0 tokens) ──
        const cacheKey = productTitle.trim().toLowerCase();
        if (resultCache.has(cacheKey)) {
            console.log('Cache HIT — returning cached result (0 tokens used).');
            return res.json(resultCache.get(cacheKey));
        }
        // ── Supabase Manual Override Check ──
        let overrideHsCode = null;
        if (supabase) {
            const { data, error } = await supabase
                .from('manual_overrides')
                .select('correct_hs_code')
                .eq('product_title', cacheKey)
                .single();
            
            if (data && data.correct_hs_code) {
                console.log(`Supabase Override HIT! Skipping LLM. Using code: ${data.correct_hs_code}`);
                overrideHsCode = data.correct_hs_code;
            }
        }

        let hsCode = "";
        let articleDescription = "";
        let productName = productTitle;
        let rate = "Unknown";

        if (overrideHsCode) {
            // We have a manual override!
            hsCode = overrideHsCode;
            
            // Search USITC for the overridden code just to get the official description
            const overrideCandidates = await searchTariffs(hsCode);
            const match = overrideCandidates.find(c => c.code === hsCode || String(c.code).replace(/\./g, '') === hsCode);
            articleDescription = match ? match.desc : "Manual Override - Official Description Not Found";
            
        } else {
            // ── Step 1: Extract keywords programmatically (FREE — no LLM call) ──
        console.log('Step 1: Extracting keywords (programmatic — no LLM)...');
        const keywords = extractKeywords(productTitle);
        console.log(`Extracted Keywords: ${keywords.join(', ')}`);

        // ── Step 2: Search USITC with each keyword ──
        console.log('Step 2: Fetching USITC Tariffs...');
        let allCandidates = [];
        for (const kw of keywords) {
            const candidates = await searchTariffs(kw);
            allCandidates = allCandidates.concat(candidates);
        }

        // ── Fallback: if programmatic keywords returned 0 results, use a cheap LLM call ──
        if (allCandidates.length === 0) {
            console.log('No USITC results from keywords. Falling back to LLM for HS code guess...');
            const fallbackResponse = await openai.chat.completions.create({
                model: OPENROUTER_MODEL,
                temperature: 0,
                max_tokens: 30,
                messages: [
                    { role: 'system', content: 'You are a customs classification engine. Given the product title, output the single most likely 4-digit HS heading number. Respond with ONLY the 4-digit number, nothing else.' },
                    { role: 'user', content: productTitle }
                ]
            });
            const fallbackCode = fallbackResponse.choices[0].message.content.trim().replace(/[^0-9]/g, '').substring(0, 4);
            console.log(`LLM fallback HS heading: ${fallbackCode}`);
            if (fallbackCode.length === 4) {
                const fallbackCandidates = await searchTariffs(fallbackCode);
                allCandidates = allCandidates.concat(fallbackCandidates);
            }
        }
        
        // Remove duplicates and limit to top 30
        const uniqueCandidatesMap = new Map();
        for (const c of allCandidates) {
            if (!uniqueCandidatesMap.has(c.code)) {
                uniqueCandidatesMap.set(c.code, c);
            }
        }
        
        const topCandidates = Array.from(uniqueCandidatesMap.values()).slice(0, 30).map(c => ({
            code: String(c.code).replace(/\./g, ''),  // normalize: strip dots
            description: c.desc
        }));
        
        console.log(`Found ${allCandidates.length} raw candidates. Sending top ${topCandidates.length} unique candidates to LLM.`);

        // Build a numbered list so the LLM can reference easily
        const candidateListText = topCandidates.map((c, i) => `${i+1}. Code: ${c.code} | Description: ${c.description}`).join('\n');

        // ── Step 3: Single LLM call to pick best match + rewrite title ──
        console.log('Step 3: Selecting best HS Code (single LLM call)...');
        const selectionResponse = await openai.chat.completions.create({
            model: OPENROUTER_MODEL,
            temperature: 0,
            messages: [
                { role: 'system', content: SELECTION_PROMPT },
                { role: 'user', content: `Original Product Title: ${productTitle}\n\nValid USITC Candidates (you MUST pick from this list):\n${candidateListText}` }
            ]
        });
        const selectionText = selectionResponse.choices[0].message.content.trim();
        console.log('LLM raw output:', selectionText);

        // Extract the HS code the LLM chose
        // (Variables already declared in outer scope)
        
        const hsCodeMatch = selectionText.match(/HS Code:\s*([\d.]{6,14})/i);
        const productNameMatch = selectionText.match(/product name:\s*(.*)/i);
        const articleDescMatch = selectionText.match(/article description:\s*(.*)/i);
        
        productName = productNameMatch ? productNameMatch[1].trim() : "";
        articleDescription = articleDescMatch ? articleDescMatch[1].trim() : "";

        if (hsCodeMatch && hsCodeMatch[1]) {
            // Strip dots — LLM may output "3305.10.00" but USITC uses "33051000"
            let llmCode = hsCodeMatch[1].replace(/\./g, '');
            console.log(`LLM selected code: ${hsCodeMatch[1]} → normalized: ${llmCode}`);
            
            // VALIDATION: Check if the LLM's code actually exists in our candidate list
            const validCodes = topCandidates.map(c => c.code);
            
            if (validCodes.includes(llmCode)) {
                hsCode = llmCode;
                console.log(`Code ${hsCode} is valid (found in candidate list).`);
            } else {
                // LLM hallucinated a code. Find the closest match from the real list.
                console.log(`Code ${llmCode} NOT found in candidate list. Finding closest match...`);
                
                let bestMatch = null;
                let bestMatchLength = 0;
                for (const candidate of topCandidates) {
                    let matchLen = 0;
                    for (let i = 0; i < Math.min(llmCode.length, candidate.code.length); i++) {
                        if (llmCode[i] === candidate.code[i]) matchLen++;
                        else break;
                    }
                    if (matchLen > bestMatchLength) {
                        bestMatchLength = matchLen;
                        bestMatch = candidate;
                    }
                }
                
                if (bestMatch) {
                    hsCode = bestMatch.code;
                    articleDescription = bestMatch.description;
                    console.log(`Snapped to closest valid code: ${hsCode} (${articleDescription})`);
                } else {
                    hsCode = topCandidates[0].code;
                    articleDescription = topCandidates[0].description;
                    console.log(`Fallback to first candidate: ${hsCode}`);
                }
            }
        } else {
            console.log('Could not parse HS Code from LLM output.');
            if (topCandidates.length > 0) {
                hsCode = topCandidates[0].code;
                articleDescription = topCandidates[0].description;
                console.log(`Fallback to first candidate: ${hsCode}`);
            }
        }
        } // End of else block (if no override)

        // ── Step 4: Fetch rate using the VALIDATED code ──
        let indiaData = null;
        if (hsCode) {
            console.log(`Step 4: Fetching Duty Rate for validated code: ${hsCode}...`);
            const [fetchedRate, fetchedIndiaData] = await Promise.all([
                getTariffRate(hsCode),
                getIndiaData(hsCode)
            ]);
            rate = fetchedRate;
            indiaData = fetchedIndiaData;
            
            // If rate lookup fails, try trimming the code
            if (rate === "Unknown" && hsCode.length > 8) {
                const trimmed = hsCode.substring(0, 8);
                console.log(`Rate not found. Retrying with trimmed code: ${trimmed}`);
                rate = await getTariffRate(trimmed);
                if (rate !== "Unknown") hsCode = trimmed;
            }
            console.log('India data:', indiaData);
        }

        const finalResult = `product name: ${productName}\nHS Code: ${hsCode}\narticle description: ${articleDescription}\ngeneral duty rate: ${rate}`;

        const structuredData = {
            productName,
            hsCode,
            articleDescription,
            dutyRate: rate,
            india: indiaData || { itcCode: 'N/A', itcDesc: 'N/A', importPolicy: 'N/A', indiaDuty: 'N/A', uqc: 'N/A' }
        };

        const responsePayload = { result: finalResult, data: structuredData };

        // ── Cache the result ──
        resultCache.set(cacheKey, responsePayload);
        console.log('Result cached for future lookups.');

        // ── Log to Supabase Search History (Fire and Forget) ──
        if (supabase) {
            supabase.from('search_history').insert({
                original_title: productTitle.trim(),
                refined_name: structuredData.productName,
                us_hs_code: structuredData.hsCode,
                us_description: structuredData.articleDescription,
                us_duty_rate: structuredData.dutyRate,
                india_hs_code: structuredData.india.itcCode,
                india_description: structuredData.india.itcDesc,
                india_duty_rate: structuredData.india.indiaDuty,
                import_policy: structuredData.india.importPolicy
            }).then(({ error }) => {
                if (error) console.error('Failed to log search history to Supabase:', error);
                else console.log(`Logged search history for: "${productTitle}"`);
            });
        }

        res.json(responsePayload);
    } catch (error) {
        console.error('Error classifying product:', error);
        res.status(500).json({ error: 'Failed to process request', details: error.message });
    }
});
app.post('/api/teach', async (req, res) => {
    try {
        const { productTitle, correctHsCode } = req.body;
        if (!productTitle || !correctHsCode) {
            return res.status(400).json({ error: 'Missing productTitle or correctHsCode' });
        }

        const cacheKey = productTitle.trim().toLowerCase();
        
        // Remove from in-memory cache so next run does fresh fetch
        resultCache.delete(cacheKey);

        if (!supabase) {
            return res.status(500).json({ error: 'Supabase is not configured on the server.' });
        }

        // Save to Supabase
        const { error } = await supabase
            .from('manual_overrides')
            .upsert({ 
                product_title: cacheKey, 
                correct_hs_code: correctHsCode,
                updated_at: new Date().toISOString()
            }, { onConflict: 'product_title' });

        if (error) {
            console.error('Supabase insert error:', error);
            return res.status(500).json({ error: 'Failed to save to database: ' + error.message });
        }

        console.log(`Learned new override: "${cacheKey}" -> ${correctHsCode}`);
        res.json({ success: true, message: 'Override saved successfully!' });
    } catch (e) {
        console.error('Teach error:', e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`HS Code Classification API running on port ${PORT}`);
    console.log(`Send a POST request to http://localhost:${PORT}/api/classify`);
    
    // Start the keep-alive worker initially
    resetKeepAlive();
});
