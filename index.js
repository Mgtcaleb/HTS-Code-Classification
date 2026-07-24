require('dotenv').config();
const OpenAI = require('openai');
const express = require('express');

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

const KEYWORD_EXTRACTION_PROMPT = `You are a customs classification engine.
Analyze the product title and determine the 3 most likely 4-digit Harmonized System (HS) heading numbers for the core physical item.
You MUST ignore all brand names and marketing adjectives (like "soft", "luxury", "secure", "cottony", "best", "regular", etc).
Focus entirely on what the physical product actually is.
Respond ONLY with a comma-separated list of the three 4-digit numbers. Do not provide any explanations, text, or extra characters.`;

const SELECTION_PROMPT = `You are a global shipping export and customs compliance expert.

Your task is to rewrite product titles for international customs declarations and select the most accurate Harmonized System HS Code from a provided list of valid USITC candidates.

Convert long marketing heavy or cluttered product titles into clear concise customs compliant descriptions suitable for clearance in USA.

Follow these rules strictly:
- Remove promotional words emojis symbols excessive adjectives and unnecessary punctuation.
- Do not use commas special characters or ambiguous wording.
- Avoid generic terms such as beverage parts accessories item goods.
- Each product title must include the brand name exact product type quantity or pack size material or composition if relevant and intended function or use.

Output format strictly:

product name: [Refined customs compliant product title]
HS Code: [Accurate 8 digit HS Code selected from the provided candidates]
article description: [Official article description of the selected HS Code from the candidates]

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

app.post('/api/classify', async (req, res) => {
    console.log('Received request with body:', req.body);
    try {
        const { productTitle } = req.body;
        
        if (!productTitle) {
            return res.status(400).json({ error: 'productTitle is required in the request body.' });
        }

        console.log('Step 1: Extracting search keywords...');
        const keywordResponse = await openai.chat.completions.create({
            model: OPENROUTER_MODEL,
            temperature: 0,
            messages: [
                { role: 'system', content: KEYWORD_EXTRACTION_PROMPT },
                { role: 'user', content: productTitle }
            ]
        });
        const keywordsText = keywordResponse.choices[0].message.content.trim();
        const keywords = keywordsText.split(',').map(k => k.trim()).filter(k => /^\d{4}$/.test(k));
        if (keywords.length === 0) keywords.push(keywordsText); // fallback
        
        console.log(`Extracted Keywords: ${keywords.join(', ')}`);

        console.log('Step 2: Fetching USITC Tariffs...');
        let allCandidates = [];
        for (const kw of keywords) {
            const candidates = await searchTariffs(kw);
            allCandidates = allCandidates.concat(candidates);
        }
        
        // Remove duplicates and limit to top 30
        const uniqueCandidatesMap = new Map();
        for (const c of allCandidates) {
            if (!uniqueCandidatesMap.has(c.code)) {
                uniqueCandidatesMap.set(c.code, c);
            }
        }
        
        const topCandidates = Array.from(uniqueCandidatesMap.values()).slice(0, 30).map(c => ({
            code: c.code,
            description: c.desc
        }));
        
        console.log(`Found ${allCandidates.length} raw candidates. Sending top ${topCandidates.length} unique candidates to LLM.`);

        console.log('Step 3: Selecting best HS Code...');
        const selectionResponse = await openai.chat.completions.create({
            model: OPENROUTER_MODEL,
            temperature: 0,
            messages: [
                { role: 'system', content: SELECTION_PROMPT },
                { role: 'user', content: `Original Product Title: ${productTitle}\n\nUSITC Candidates:\n${JSON.stringify(topCandidates, null, 2)}` }
            ]
        });
        const selectionText = selectionResponse.choices[0].message.content.trim();

        console.log('Step 4: Fetching Duty Rate...');
        let finalResult = selectionText;
        let hsCode = "";
        let rate = "Unknown";
        const hsCodeMatch = selectionText.match(/HS Code:\s*(\d{8})/i);
        if (hsCodeMatch && hsCodeMatch[1]) {
            hsCode = hsCodeMatch[1];
            console.log(`Fetching rate for HS Code: ${hsCode}`);
            rate = await getTariffRate(hsCode);
            finalResult += `\ngeneral duty rate: ${rate}`;
        } else {
            console.log('Could not parse 8-digit HS Code from LLM output. Rate lookup skipped.');
            finalResult += `\ngeneral duty rate: Unknown`;
        }
        
        const productNameMatch = selectionText.match(/product name:\s*(.*)/i);
        const articleDescMatch = selectionText.match(/article description:\s*(.*)/i);

        const structuredData = {
            productName: productNameMatch ? productNameMatch[1].trim() : "",
            hsCode: hsCode,
            articleDescription: articleDescMatch ? articleDescMatch[1].trim() : "",
            dutyRate: rate
        };

        res.json({ result: finalResult, data: structuredData });
    } catch (error) {
        console.error('Error classifying product:', error);
        res.status(500).json({ error: 'Failed to process request', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`HS Code Classification API running on port ${PORT}`);
    console.log(`Send a POST request to http://localhost:${PORT}/api/classify`);
});
