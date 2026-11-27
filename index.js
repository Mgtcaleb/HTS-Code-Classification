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
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'antdigital/lingdt-decision-fast-1.0:free';
const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const USITC_LOOKUP_URL = 'https://datawebws.usitc.gov/dataweb/api/v2/tariff/currentTariffLookup';
const USITC_DETAILS_URL = 'https://datawebws.usitc.gov/dataweb/api/v2/tariff/currentTariffDetails';
const TARIFF_YEAR = '2024';

/**
 * Detect if a model is an OpenRouter decisions model (which requires /api/alpha/decisions)
 */
function isDecisionModel(model) {
    if (!model) return false;
    const m = model.toLowerCase();
    return m.includes('decision') || m.startsWith('antdigital/lingdt') || m.startsWith('typesafe/jev');
}

/**
 * Clean product title for customs compliance (remove promotional words, emojis, special characters)
 */
function cleanCustomsTitle(title) {
    if (!title) return '';
    let cleaned = title.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}]/gu, '');
    cleaned = cleaned.replace(/[!|()[\]{}*~^,]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned || title.trim();
}

/**
 * Call OpenRouter /api/alpha/decisions endpoint for decision models
 */
async function selectWithDecisionsApi(model, productTitle, topCandidates) {
    console.log(`Using OpenRouter Decisions API (${OPENROUTER_DECISIONS_URL}) with model: ${model}...`);
    if (!topCandidates || topCandidates.length === 0) {
        return {
            hsCode: '',
            articleDescription: '',
            productName: cleanCustomsTitle(productTitle)
        };
    }

    const criteria = {};
    for (const candidate of topCandidates) {
        const key = String(candidate.code).replace(/[^a-zA-Z0-9_]/g, '');
        if (key) {
            criteria[key] = (candidate.description || 'Candidate code ' + key).substring(0, 300);
        }
    }

    const response = await fetch(OPENROUTER_DECISIONS_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: model,
            state: {
                product_title: productTitle
            },
            questions: {
                hs_code: {
                    type: 'choice',
                    instructions: 'Select the most accurate Harmonized System (HS) code classification for this product from the available choices.',
                    criteria: criteria
                }
            }
        })
    });

    const data = await response.json();
    if (!response.ok) {
        const errorMsg = data.error?.message || `Decisions API returned status ${response.status}`;
        throw new Error(errorMsg);
    }

    const chosenCode = data.answers?.hs_code?.choice;
    const confidence = data.answers?.hs_code?.confidence;
    console.log(`Decisions API selected code: ${chosenCode} (confidence: ${confidence})`);

    let matched = topCandidates.find(c => String(c.code).replace(/[^a-zA-Z0-9_]/g, '') === chosenCode);
    if (!matched && topCandidates.length > 0) {
        console.log(`Chosen code "${chosenCode}" not directly in candidate list. Snapping to first candidate.`);
        matched = topCandidates[0];
    }

    return {
        hsCode: matched ? matched.code : (chosenCode || ''),
        articleDescription: matched ? matched.description : '',
        productName: cleanCustomsTitle(productTitle)
    };
}

// ── In-memory cache: same product title → same result, zero tokens ──
const resultCache = new Map();
const aiHeadingCache = new Map();

// ── Fast-path HTS Taxonomy for Commercial E-commerce & Retail Goods ──
const HTS_TAXONOMY_RULES = [
    {
        category: "Drinkware / Water Bottles",
        pattern: /\b(water\s*bottle|sipper\s*bottle|flask|vacuum\s*flask|thermos|tumbler|hydration\s*bottle|shaker\s*bottle|drinking\s*bottle|sports\s*bottle)\b/i,
        headings: ["9617", "3924", "7323", "7615", "3923"],
        allowedChapters: ["96", "39", "73", "76", "70"],
        keywords: ["vacuum flask", "water bottle", "tableware plastic bottle"],
        fallbackCandidates: [
            { code: "96170010", desc: "Vacuum flasks and other vacuum vessels, complete with cases, capacity exceeding 1 liter" },
            { code: "96170030", desc: "Vacuum flasks and other vacuum vessels, complete with cases, capacity not exceeding 1 liter" },
            { code: "39241040", desc: "Tableware and kitchenware of plastics: reusable drinkware, water bottles, and tumblers" },
            { code: "73239300", desc: "Table, kitchen or other household articles and parts thereof, of stainless steel (metal water bottles)" },
            { code: "76151000", desc: "Table, kitchen or other household articles and parts thereof, of aluminum (aluminum sports bottles)" }
        ]
    },
    {
        category: "Drinking Water / Mineral Water",
        pattern: /\b(drinking\s*water|mineral\s*water|spring\s*water|purified\s*water|sparkling\s*water|packaged\s*water|^water$)\b/i,
        negativePattern: /\b(bottle|pump|filter|heater|tank|gun|color|melon|purifier|supply|pipe)\b/i,
        headings: ["2201", "2202"],
        allowedChapters: ["22"],
        keywords: ["mineral water", "drinking water", "aerated waters"],
        fallbackCandidates: [
            { code: "22011000", desc: "Mineral waters and aerated waters, not containing added sugar or other sweetening matter nor flavored" },
            { code: "22019000", desc: "Other waters, including natural or artificial mineral waters and aerated waters; ice and snow" },
            { code: "22021000", desc: "Waters, including mineral waters and aerated waters, containing added sugar or other sweetening matter or flavored" }
        ]
    },
    {
        category: "Footwear / Shoes",
        pattern: /\b(shoes|sneakers|running\s*shoes|athletic\s*shoes|boots|sandals|slippers|loafers|footwear|flip\s*flops)\b/i,
        headings: ["6402", "6403", "6404", "6405"],
        allowedChapters: ["64"],
        keywords: ["footwear rubber plastics", "sports footwear textile", "footwear leather uppers"],
        fallbackCandidates: [
            { code: "64041190", desc: "Sports footwear with outer soles of rubber or plastics and uppers of textile materials" },
            { code: "64021990", desc: "Other sports footwear with outer soles and uppers of rubber or plastics" },
            { code: "64039990", desc: "Footwear with outer soles of rubber, plastics, leather and uppers of leather" },
            { code: "64041990", desc: "Footwear with outer soles of rubber or plastics and uppers of textile materials, other" }
        ]
    },
    {
        category: "Apparel / T-Shirts & Tops",
        pattern: /\b(t-shirt|t\s*shirt|tee|polo\s*shirt|cotton\s*shirt|tank\s*top)\b/i,
        headings: ["6109", "6205", "6206"],
        allowedChapters: ["61", "62"],
        keywords: ["t-shirts cotton knitted", "t-shirts man-made knitted"],
        fallbackCandidates: [
            { code: "61091000", desc: "T-shirts, singlets and other vests, knitted or crocheted, of cotton" },
            { code: "61099010", desc: "T-shirts, singlets and other vests, knitted or crocheted, of man-made fibers" },
            { code: "62052000", desc: "Men's or boys' shirts, not knitted, of cotton" }
        ]
    },
    {
        category: "Hoodies & Sweatshirts",
        pattern: /\b(hoodie|sweatshirt|pullover|cardigan|sweater|fleece)\b/i,
        headings: ["6110"],
        allowedChapters: ["61"],
        keywords: ["sweaters sweatshirts knitted", "hoodies cotton knitted"],
        fallbackCandidates: [
            { code: "61102020", desc: "Sweaters, pullovers, sweatshirts, knitted or crocheted, of cotton" },
            { code: "61103030", desc: "Sweaters, pullovers, sweatshirts, knitted or crocheted, of man-made fibers" }
        ]
    },
    {
        category: "Trousers & Jeans",
        pattern: /\b(jeans|denim|pants|trousers|shorts|tights|leggings)\b/i,
        headings: ["6203", "6204", "6103", "6104"],
        allowedChapters: ["61", "62"],
        keywords: ["trousers cotton", "denim jeans"],
        fallbackCandidates: [
            { code: "62034240", desc: "Men's or boys' trousers, bib and brace overalls, breeches and shorts, of cotton: blue denim" },
            { code: "62046240", desc: "Women's or girls' trousers, bib and brace overalls, breeches and shorts, of cotton: blue denim" }
        ]
    },
    {
        category: "Bags, Backpacks & Wallets",
        pattern: /\b(backpack|handbag|tote\s*bag|shoulder\s*bag|duffel\s*bag|wallet|purse|suitcase|luggage|clutch|crossbody)\b/i,
        headings: ["4202"],
        allowedChapters: ["42"],
        keywords: ["backpacks", "handbags", "wallets"],
        fallbackCandidates: [
            { code: "42029231", desc: "Travel, sports and similar bags: with outer surface of textile materials, backpacks" },
            { code: "42022215", desc: "Handbags, with outer surface of plastic sheeting or textile materials" },
            { code: "42023160", desc: "Articles of a kind normally carried in the pocket or handbag, with outer surface of leather" }
        ]
    },
    {
        category: "Mobile Cases & Covers",
        pattern: /\b(phone\s*case|iphone\s*case|mobile\s*case|phone\s*cover|protective\s*case|airpods\s*case)\b/i,
        headings: ["3926", "4202"],
        allowedChapters: ["39", "42"],
        keywords: ["case for mobile phone", "cellular phone cases of plastics"],
        fallbackCandidates: [
            { code: "39269099", desc: "Other articles of plastics: protective covers and cases for mobile cellular telephones" },
            { code: "42023210", desc: "Articles carried in pocket: cases for cellular telephones with outer surface of sheeting of plastics" }
        ]
    },
    {
        category: "Chargers & Cables",
        pattern: /\b(charger|charging\s*cable|usb\s*cable|type\s*c\s*cable|lightning\s*cable|power\s*adapter|fast\s*charger)\b/i,
        headings: ["8504", "8544"],
        allowedChapters: ["85"],
        keywords: ["power supplies chargers", "insulated electric conductors usb cables"],
        fallbackCandidates: [
            { code: "85044095", desc: "Electrical transformers, static converters: power supplies, battery chargers for mobile devices" },
            { code: "85444220", desc: "Insulated electric conductors fitted with connectors: cables for telecommunications (USB)" }
        ]
    },
    {
        category: "Headphones & Earbuds",
        pattern: /\b(headphones|earbuds|earphones|headset|airpods|wireless\s*earbuds|bluetooth\s*earphones)\b/i,
        headings: ["8518"],
        allowedChapters: ["85"],
        keywords: ["headphones earphones wireless"],
        fallbackCandidates: [
            { code: "85183020", desc: "Headphones and earphones, whether or not combined with a microphone: wireless bluetooth headsets" }
        ]
    },
    {
        category: "Cosmetics & Haircare",
        pattern: /\b(shampoo|conditioner|hair\s*oil|face\s*cream|lotion|moisturizer|sunscreen|serum|perfume|cologne|lipstick|lip\s*balm|mascara|body\s*wash|soap)\b/i,
        headings: ["3305", "3304", "3303", "3401"],
        allowedChapters: ["33", "34"],
        keywords: ["shampoos preparations for hair", "beauty or make-up preparations", "perfumes and toilet waters"],
        fallbackCandidates: [
            { code: "33051000", desc: "Preparations for use on the hair: shampoos" },
            { code: "33059000", desc: "Preparations for use on the hair: hair conditioners, pomades, and styling products" },
            { code: "33049950", desc: "Beauty or make-up preparations: skin lotions, moisturizers, and creams" },
            { code: "33030000", desc: "Perfumes and toilet waters" },
            { code: "34013000", desc: "Organic surface-active products for washing skin, liquid or cream" }
        ]
    },
    {
        category: "Bedding & Home Textiles",
        pattern: /\b(bedsheet|bed\s*sheet|bedding|pillow|pillowcase|blanket|duvet|towel|bath\s*towel|curtain)\b/i,
        headings: ["6302", "9404", "6303"],
        allowedChapters: ["63", "94"],
        keywords: ["bed linen cotton", "towels cotton", "articles of bedding pillows"],
        fallbackCandidates: [
            { code: "63023190", desc: "Bed linen, of cotton, not printed" },
            { code: "63026000", desc: "Toilet linen and kitchen linen, of terry toweling or similar terry fabrics, of cotton" },
            { code: "94049020", desc: "Articles of bedding: pillows, cushions and similar furnishings" }
        ]
    },
    {
        category: "Cookware & Kitchenware",
        pattern: /\b(frying\s*pan|cookware|saucepan|pot|knife|chef\s*knife|kitchen\s*knife|spatula|cutting\s*board|lunch\s*box)\b/i,
        headings: ["7323", "7615", "8211", "3924"],
        allowedChapters: ["73", "76", "82", "39"],
        keywords: ["kitchen articles stainless steel", "cookware aluminum", "kitchen knives"],
        fallbackCandidates: [
            { code: "73239300", desc: "Table, kitchen or other household articles and parts thereof, of stainless steel" },
            { code: "76151030", desc: "Table, kitchen or other household articles of aluminum: cooking utensils" },
            { code: "82119290", desc: "Knives having fixed blades: kitchen knives and butcher knives" }
        ]
    },
    {
        category: "Watches & Clocks",
        pattern: /\b(wrist\s*watch|smartwatch|smart\s*watch|watch|clock)\b/i,
        negativePattern: /\b(watch\s*strap|watch\s*band)\b/i,
        headings: ["9102", "8517"],
        allowedChapters: ["91", "85"],
        keywords: ["wrist watches electronic", "smart watches transceivers"],
        fallbackCandidates: [
            { code: "85176200", desc: "Machines for the transmission or reception of voice, images or other data: smart watches" },
            { code: "91021100", desc: "Wrist watches, electrically operated, with mechanical display only" }
        ]
    }
];

function matchProductTaxonomy(title) {
    if (!title) return null;
    const t = title.trim();
    for (const rule of HTS_TAXONOMY_RULES) {
        if (rule.pattern.test(t)) {
            if (rule.negativePattern && rule.negativePattern.test(t)) continue;
            return rule;
        }
    }
    return null;
}

/**
 * AI Heading and Category Extractor for products not covered by fast taxonomy
 */
async function extractAiHeadings(title) {
    const cacheKey = title.trim().toLowerCase();
    if (aiHeadingCache.has(cacheKey)) {
        return aiHeadingCache.get(cacheKey);
    }

    try {
        const chatModel = isDecisionModel(OPENROUTER_MODEL)
            ? (process.env.OPENROUTER_CHAT_FALLBACK_MODEL || 'openrouter/free')
            : OPENROUTER_MODEL;

        const response = await openai.chat.completions.create({
            model: chatModel,
            temperature: 0,
            max_tokens: 150,
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert customs broker. Given a product title, return a JSON object with:\n1. "refinedName": clean customs product description (string)\n2. "headings": array of 2-4 most likely 4-digit HS heading numbers (e.g. ["8471", "8504"])\n3. "allowedChapters": array of 2-digit HS chapters (e.g. ["84", "85"])\nReturn ONLY valid JSON.'
                },
                { role: 'user', content: title }
            ]
        });

        const raw = response.choices[0]?.message?.content || response.choices[0]?.message?.reasoning || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            aiHeadingCache.set(cacheKey, parsed);
            return parsed;
        }
    } catch (e) {
        console.warn('extractAiHeadings error:', e.message);
    }

    return null;
}

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
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (USITC_TOKEN) {
            headers['Authorization'] = `Bearer ${USITC_TOKEN}`;
        }
        const response = await fetch(USITC_LOOKUP_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({ searchTerm: keyword, tariffYear: TARIFF_YEAR })
        });
        if (!response.ok) return [];
        const data = await response.json();
        return data.list || [];
    } catch (e) {
        console.error('USITC searchTariffs error:', e.message);
        return [];
    }
}

async function getTariffRate(hsCode) {
    try {
        const headers = {};
        if (USITC_TOKEN) {
            headers['Authorization'] = `Bearer ${USITC_TOKEN}`;
        }
        const response = await fetch(`${USITC_DETAILS_URL}?year=${TARIFF_YEAR}&hts8=${hsCode}`, {
            method: 'GET',
            headers
        });
        if (!response.ok) return "Unknown";
        const data = await response.json();
        const tariffTreatment = data.sections?.find(s => s.id === 'tariff_treatment');
        const mfn = tariffTreatment?.children?.find(c => c.id === 'mfn');
        const mfnText = mfn?.children?.find(c => c.id === 'mfn_text');
        return mfnText?.value || "Unknown";
    } catch (e) {
        console.error('USITC getTariffRate error:', e.message);
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
        const headers = { 'Content-Type': 'application/json' };
        if (USITC_TOKEN) {
            headers['Authorization'] = `Bearer ${USITC_TOKEN}`;
        }
        const usitcRes = await fetch(USITC_LOOKUP_URL, {
            method: 'POST',
            headers,
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
            // ── Step 1: Smart Product Identification & Targeted HS Headings ──
        let targetHeadings = [];
        let allowedChapters = null;
        let curatedFallback = [];
        let identifiedCategory = "";

        // Fast-path: Check instantaneous commercial HTS taxonomy (0ms)
        const matchedTaxonomy = matchProductTaxonomy(productTitle);
        if (matchedTaxonomy) {
            console.log(`Step 1: Fast taxonomy match found: "${matchedTaxonomy.category}"`);
            targetHeadings = matchedTaxonomy.headings;
            allowedChapters = new Set(matchedTaxonomy.allowedChapters);
            curatedFallback = matchedTaxonomy.fallbackCandidates;
            identifiedCategory = matchedTaxonomy.category;
            productName = cleanCustomsTitle(productTitle);
        } else {
            // Dynamic path: AI heading and category extractor (with in-memory cache)
            console.log('Step 1: Extracting target headings via AI extractor...');
            const aiInfo = await extractAiHeadings(productTitle);
            if (aiInfo) {
                targetHeadings = aiInfo.headings || [];
                if (aiInfo.allowedChapters && aiInfo.allowedChapters.length > 0) {
                    allowedChapters = new Set(aiInfo.allowedChapters);
                }
                if (aiInfo.refinedName) {
                    productName = aiInfo.refinedName;
                }
            }
        }

        // ── Step 2: Fetch USITC Tariffs Targeted by Heading in Parallel ──
        console.log(`Step 2: Fetching targeted USITC Tariffs for headings: [${targetHeadings.join(', ')}]...`);
        let allCandidates = [];

        // Search USITC for targeted 4-digit headings in parallel (blazing fast)
        if (targetHeadings.length > 0) {
            const headingPromises = targetHeadings.slice(0, 4).map(h => searchTariffs(h));
            const results = await Promise.all(headingPromises);
            for (const list of results) {
                allCandidates = allCandidates.concat(list);
            }
        }

        // Also search with meaningful extracted keywords if candidates are scarce
        const keywords = extractKeywords(productTitle);
        if (allCandidates.length < 5 && keywords.length > 0) {
            const kwPromises = keywords.slice(0, 2).map(kw => searchTariffs(kw));
            const kwResults = await Promise.all(kwPromises);
            for (const list of kwResults) {
                allCandidates = allCandidates.concat(list);
            }
        }

        // Add curated fallback candidates for the identified category
        if (curatedFallback.length > 0) {
            allCandidates = allCandidates.concat(curatedFallback);
        }

        // ── Strict Chapter Filtering: Completely Eliminate Irrelevant Categories ──
        // (e.g. Reject vegetables "07" for water bottles or drinking water!)
        if (allowedChapters && allowedChapters.size > 0) {
            const preFilterCount = allCandidates.length;
            allCandidates = allCandidates.filter(c => {
                const ch = String(c.code).replace(/\./g, '').substring(0, 2);
                return allowedChapters.has(ch);
            });
            console.log(`Filtered candidates by allowed chapters [${Array.from(allowedChapters).join(',')}]: ${preFilterCount} → ${allCandidates.length}`);
        }

        // Deduplicate candidates
        const uniqueCandidatesMap = new Map();
        for (const c of allCandidates) {
            const normCode = String(c.code).replace(/\./g, '');
            if (!uniqueCandidatesMap.has(normCode)) {
                uniqueCandidatesMap.set(normCode, {
                    code: normCode,
                    description: c.desc || c.description || ''
                });
            }
        }

        // Rank candidates: Give highest priority to exact 4-digit heading matches and title keyword matches
        const scoredCandidates = Array.from(uniqueCandidatesMap.values()).map(c => {
            let score = 0;
            const h4 = c.code.substring(0, 4);
            const ch2 = c.code.substring(0, 2);
            if (targetHeadings.includes(h4)) score += 100;
            else if (allowedChapters && allowedChapters.has(ch2)) score += 50;

            const titleWords = productTitle.toLowerCase().split(/\s+/);
            const descLower = (c.description || '').toLowerCase();
            for (const w of titleWords) {
                if (w.length > 2 && !STOPWORDS.has(w) && descLower.includes(w)) {
                    score += 15;
                }
            }
            return { ...c, score };
        });

        scoredCandidates.sort((a, b) => b.score - a.score);
        const topCandidates = scoredCandidates.slice(0, 25).map(c => ({
            code: c.code,
            description: c.description
        }));
        
        console.log(`Found ${allCandidates.length} raw candidates. Sending top ${topCandidates.length} unique candidates to model.`);

        // Build a numbered list so the LLM can reference easily
        const candidateListText = topCandidates.map((c, i) => `${i+1}. Code: ${c.code} | Description: ${c.description}`).join('\n');

        // ── Step 3: Select best match using Decisions API or Chat Completions ──
        if (isDecisionModel(OPENROUTER_MODEL)) {
            console.log(`Step 3: Selecting best HS Code using Decisions API (${OPENROUTER_MODEL})...`);
            const decisionResult = await selectWithDecisionsApi(OPENROUTER_MODEL, productTitle, topCandidates);
            hsCode = decisionResult.hsCode;
            articleDescription = decisionResult.articleDescription;
            productName = decisionResult.productName;
        } else {
            console.log('Step 3: Selecting best HS Code (single LLM chat completion call)...');
            try {
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

                const hsCodeMatch = selectionText.match(/HS Code:\s*([\d.]{6,14})/i);
                const productNameMatch = selectionText.match(/product name:\s*(.*)/i);
                const articleDescMatch = selectionText.match(/article description:\s*(.*)/i);
                
                productName = productNameMatch ? productNameMatch[1].trim() : cleanCustomsTitle(productTitle);
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
                        } else if (topCandidates.length > 0) {
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
            } catch (llmErr) {
                // If OpenRouter returns the 400 decisions model error, automatically handle it via Decisions API
                if (llmErr.message && (llmErr.message.includes('decisions model') || llmErr.message.includes('/api/alpha/decisions'))) {
                    console.warn('Caught decisions model error from chat/completions endpoint, switching to Decisions API...');
                    const decisionResult = await selectWithDecisionsApi(OPENROUTER_MODEL, productTitle, topCandidates);
                    hsCode = decisionResult.hsCode;
                    articleDescription = decisionResult.articleDescription;
                    productName = decisionResult.productName;
                } else {
                    throw llmErr;
                }
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
