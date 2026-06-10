// newsFarmer.js - Multi-level sentiment & price prediction engine (with timeout fixes)

const axios = require('axios');

// ---------- Configuration ----------
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY; // optional

// Base weights for each factor
const BASE_WEIGHTS = {
    macro: 0.30,
    industry: 0.25,
    competition: 0.20,
    household: 0.25
};

// Source reliability multiplier
const SOURCE_RELIABILITY = {
    'Bloomberg': 1.0,
    'Reuters': 1.0,
    'WSJ': 1.0,
    'Financial Times': 1.0,
    'CNBC': 0.9,
    'Yahoo Finance': 0.8,
    'Seeking Alpha': 0.7,
    'Benzinga': 0.7,
    'MarketWatch': 0.8,
    'The Motley Fool': 0.5,
    'default': 0.6
};

// Keyword lists for classification
const KEYWORDS = {
    macro: ['fed', 'interest rate', 'inflation', 'cpi', 'gdp', 'recession', 'trade war', 'tariff', 'geopolitical', 'war', 'oil price', 'supply chain', 'stimulus', 'fiscal policy', 'central bank', 'dollar', 'currency'],
    industry: ['semiconductor', 'ev', 'electric vehicle', 'cloud', 'software', 'hardware', 'retail', 'banking', 'healthcare', 'biotech', 'pharma', 'renewable', 'energy', 'regulation', 'subsidy', 'industry report', 'sector', 'analyst'],
    competition: ['competitor', 'market share', 'lawsuit', 'samsung', 'google', 'microsoft', 'amazon', 'tesla', 'nvidia', 'intel', 'amd', 'qualcomm', 'netflix', 'disney', 'walmart', 'target', 'vs', 'rival', 'overtake', 'lead'],
    household: ['consumer', 'customer', 'review', 'sentiment', 'brand loyalty', 'satisfaction', 'complaint', 'app store', 'play store', 'social media', 'viral', 'trending', 'demand', 'sales', 'shipping', 'delivery']
};

// Fetch news with timeout and retry logic
async function fetchWithTimeout(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await axios.get(url, { signal: controller.signal, timeout: timeoutMs });
        clearTimeout(timeout);
        return response;
    } catch (err) {
        clearTimeout(timeout);
        throw err;
    }
}

// Fetch news from Finnhub
async function fetchFinnhubNews(symbol, fromDate) {
    if (!FINNHUB_API_KEY) return [];
    try {
        const url = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate}&to=${new Date().toISOString().split('T')[0]}&token=${FINNHUB_API_KEY}`;
        const res = await fetchWithTimeout(url, 15000);
        if (res.data && res.data.length) {
            return res.data.slice(0, 20).map(item => ({
                title: item.headline,
                summary: item.summary || item.headline,
                source: item.source || 'Finnhub',
                url: item.url,
                publishedAt: new Date(item.datetime * 1000).toISOString()
            }));
        }
    } catch (err) {
        console.warn(`Finnhub news fetch failed for ${symbol}:`, err.message);
    }
    return [];
}

// Fetch news from NewsAPI (optional)
async function fetchNewsAPI(symbol, fromDate) {
    if (!NEWSAPI_KEY) return [];
    try {
        const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol + ' stock')}&from=${fromDate}&sortBy=relevancy&pageSize=15&apiKey=${NEWSAPI_KEY}`;
        const res = await fetchWithTimeout(url, 15000);
        if (res.data.articles) {
            return res.data.articles.map(item => ({
                title: item.title,
                summary: item.description || item.title,
                source: item.source.name,
                url: item.url,
                publishedAt: item.publishedAt
            }));
        }
    } catch (err) {
        console.warn(`NewsAPI fetch failed for ${symbol}:`, err.message);
    }
    return [];
}

// Main fetch function (combine multiple sources)
async function fetchNews(symbol, daysBack = 3) {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - daysBack);
    const fromStr = fromDate.toISOString().split('T')[0];
    
    // Run both fetches in parallel, but don't let one failure block the other
    const [finnhubArticles, newsApiArticles] = await Promise.allSettled([
        fetchFinnhubNews(symbol, fromStr),
        fetchNewsAPI(symbol, fromStr)
    ]);
    
    let articles = [];
    if (finnhubArticles.status === 'fulfilled') articles.push(...finnhubArticles.value);
    if (newsApiArticles.status === 'fulfilled') articles.push(...newsApiArticles.value);
    
    // Remove duplicates by URL
    const unique = [];
    const seen = new Set();
    for (const a of articles) {
        if (!seen.has(a.url)) {
            seen.add(a.url);
            unique.push(a);
        }
    }
    return unique;
}

// Classify article using keyword matching
function classifyArticle(text) {
    const lower = (text || '').toLowerCase();
    let scores = { macro: 0, industry: 0, competition: 0, household: 0 };
    for (const [level, keywords] of Object.entries(KEYWORDS)) {
        for (const kw of keywords) {
            if (lower.includes(kw)) scores[level] += 1;
        }
    }
    let maxLevel = 'macro';
    let maxScore = 0;
    for (const [level, score] of Object.entries(scores)) {
        if (score > maxScore) {
            maxScore = score;
            maxLevel = level;
        }
    }
    if (maxScore === 0) maxLevel = 'macro';
    return maxLevel;
}

// Simple sentiment scoring (positive/negative word lists)
function getSentiment(text) {
    const positive = ['surge', 'rise', 'gain', 'up', 'positive', 'bullish', 'beat', 'exceed', 'record', 'strong', 'growth', 'profit', 'upgrade', 'buy', 'outperform'];
    const negative = ['drop', 'fall', 'down', 'negative', 'bearish', 'miss', 'loss', 'weak', 'decline', 'downgrade', 'sell', 'investigation', 'lawsuit', 'fine', 'crisis', 'plunge'];
    const lower = text.toLowerCase();
    let posCount = 0, negCount = 0;
    for (const w of positive) if (lower.includes(w)) posCount++;
    for (const w of negative) if (lower.includes(w)) negCount++;
    const total = posCount + negCount;
    if (total === 0) return 0;
    const score = (posCount - negCount) / total;
    return Math.min(1, Math.max(-1, score));
}

// Calculate weight based on recency and source reliability
function calculateWeight(article, now) {
    const ageHours = (now - new Date(article.publishedAt)) / (1000 * 3600);
    const recency = Math.exp(-ageHours / 48); // half-life 48 hours
    const source = article.source || 'default';
    const reliability = SOURCE_RELIABILITY[source] || SOURCE_RELIABILITY.default;
    return recency * reliability;
}

// Main prediction function
async function predictStockDirection(symbol, daysBack = 3) {
    const articles = await fetchNews(symbol, daysBack);
    if (articles.length === 0) {
        return {
            success: false,
            error: 'No news articles found for this symbol.',
            symbol,
            articlesCount: 0
        };
    }

    const now = new Date();
    const factorScores = { macro: { sum: 0, weight: 0 }, industry: { sum: 0, weight: 0 }, competition: { sum: 0, weight: 0 }, household: { sum: 0, weight: 0 } };
    const enrichedArticles = [];

    for (const article of articles) {
        const level = classifyArticle(article.title + ' ' + article.summary);
        const sentiment = getSentiment(article.title + ' ' + article.summary);
        const weight = calculateWeight(article, now);
        factorScores[level].sum += sentiment * weight;
        factorScores[level].weight += weight;
        enrichedArticles.push({
            title: article.title,
            source: article.source,
            level,
            sentiment,
            weight,
            url: article.url,
            publishedAt: article.publishedAt
        });
    }

    // Compute net sentiment per factor
    const netScores = {};
    for (const [level, data] of Object.entries(factorScores)) {
        netScores[level] = data.weight > 0 ? data.sum / data.weight : 0;
    }

    // Dynamic weights based on article count
    const dynamicWeights = { ...BASE_WEIGHTS };
    for (const [level, data] of Object.entries(factorScores)) {
        const articleCount = enrichedArticles.filter(a => a.level === level).length;
        if (articleCount > 3) dynamicWeights[level] = Math.min(0.5, BASE_WEIGHTS[level] + 0.05 * (articleCount - 3));
        else if (articleCount === 0) dynamicWeights[level] = BASE_WEIGHTS[level] * 0.5;
    }
    // Normalize
    const weightSum = Object.values(dynamicWeights).reduce((a,b) => a + b, 0);
    for (const level of Object.keys(dynamicWeights)) dynamicWeights[level] /= weightSum;

    let overallScore = 0;
    for (const [level, score] of Object.entries(netScores)) {
        overallScore += score * dynamicWeights[level];
    }

    const k = 2.0;
    const probabilityUp = 1 / (1 + Math.exp(-k * overallScore));
    const direction = probabilityUp > 0.6 ? 'UP' : (probabilityUp < 0.4 ? 'DOWN' : 'NEUTRAL');
    const confidence = Math.abs(probabilityUp - 0.5) * 2;

    const factorBreakdown = {};
    for (const level of Object.keys(netScores)) {
        factorBreakdown[level] = {
            sentiment: netScores[level].toFixed(3),
            weight: (dynamicWeights[level] * 100).toFixed(1) + '%',
            articleCount: enrichedArticles.filter(a => a.level === level).length
        };
    }

    return {
        success: true,
        symbol,
        overallScore: overallScore.toFixed(3),
        probabilityUp: (probabilityUp * 100).toFixed(1) + '%',
        direction,
        confidence: (confidence * 100).toFixed(1) + '%',
        factorBreakdown,
        topArticles: enrichedArticles.sort((a,b) => Math.abs(b.sentiment) - Math.abs(a.sentiment)).slice(0, 5),
        articlesCount: enrichedArticles.length
    };
}

module.exports = { predictStockDirection };