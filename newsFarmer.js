// newsFarmer.js - Multi-level sentiment & price prediction engine

const axios = require('axios');

// ---------- Configuration ----------
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const NEWSAPI_KEY = process.env.NEWSAPI_KEY; // optional, free tier 100 req/day

// Base weights for each factor (can be tuned)
const BASE_WEIGHTS = {
    macro: 0.30,
    industry: 0.25,
    competition: 0.20,
    household: 0.25
};

// Source reliability multiplier (1.0 = high, 0.5 = low)
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

// Helper: fetch news articles
async function fetchNews(symbol, daysBack = 3) {
    const articles = [];
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - daysBack);
    const fromStr = fromDate.toISOString().split('T')[0];

    // 1. Finnhub (free, no API key? but you already have FINNHUB_API_KEY)
    if (FINNHUB_API_KEY) {
        try {
            const url = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromStr}&to=${new Date().toISOString().split('T')[0]}&token=${FINNHUB_API_KEY}`;
            const res = await axios.get(url, { timeout: 8000 });
            if (res.data && res.data.length) {
                for (const item of res.data.slice(0, 20)) {
                    articles.push({
                        title: item.headline,
                        summary: item.summary || item.headline,
                        source: item.source || 'Finnhub',
                        url: item.url,
                        publishedAt: new Date(item.datetime * 1000).toISOString()
                    });
                }
            }
        } catch (e) { console.warn('Finnhub news fetch failed:', e.message); }
    }

    // 2. NewsAPI (if key provided) – general search with symbol + "stock"
    if (NEWSAPI_KEY) {
        try {
            const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol + ' stock')}&from=${fromStr}&sortBy=relevancy&pageSize=15&apiKey=${NEWSAPI_KEY}`;
            const res = await axios.get(url, { timeout: 8000 });
            if (res.data.articles) {
                for (const item of res.data.articles) {
                    articles.push({
                        title: item.title,
                        summary: item.description || item.title,
                        source: item.source.name,
                        url: item.url,
                        publishedAt: item.publishedAt
                    });
                }
            }
        } catch (e) { console.warn('NewsAPI fetch failed:', e.message); }
    }

    // 3. Fallback: if no articles, return empty array
    return articles;
}

// Classify a single article into one of the four levels using keyword matching
function classifyArticle(text) {
    const lower = (text || '').toLowerCase();
    let scores = { macro: 0, industry: 0, competition: 0, household: 0 };
    for (const [level, keywords] of Object.entries(KEYWORDS)) {
        for (const kw of keywords) {
            if (lower.includes(kw)) scores[level] += 1;
        }
    }
    // Find max score
    let maxLevel = 'macro';
    let maxScore = 0;
    for (const [level, score] of Object.entries(scores)) {
        if (score > maxScore) {
            maxScore = score;
            maxLevel = level;
        }
    }
    // If no keyword matched, default to 'macro'
    if (maxScore === 0) maxLevel = 'macro';
    return maxLevel;
}

// Sentiment score using simple lexicon (positive/negative word lists)
// You can replace with VADER or a local model later
function getSentiment(text) {
    const positive = ['surge', 'rise', 'gain', 'up', 'positive', 'bullish', 'beat', 'exceed', 'record', 'strong', 'growth', 'profit', 'upgrade', 'buy'];
    const negative = ['drop', 'fall', 'down', 'negative', 'bearish', 'miss', 'loss', 'weak', 'decline', 'downgrade', 'sell', 'investigation', 'lawsuit', 'fine', 'crisis'];
    const lower = text.toLowerCase();
    let posCount = 0, negCount = 0;
    for (const w of positive) if (lower.includes(w)) posCount++;
    for (const w of negative) if (lower.includes(w)) negCount++;
    const total = posCount + negCount;
    if (total === 0) return 0;
    const score = (posCount - negCount) / total;
    // Clamp to [-1, 1]
    return Math.min(1, Math.max(-1, score));
}

// Weight: recency (newer = higher), source reliability
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

    // Compute net sentiment per factor (normalized)
    const netScores = {};
    let totalWeight = 0;
    for (const [level, data] of Object.entries(factorScores)) {
        netScores[level] = data.weight > 0 ? data.sum / data.weight : 0;
        totalWeight += data.weight;
    }

    // Dynamic weight adjustment: if a factor has many articles, increase its importance
    const dynamicWeights = { ...BASE_WEIGHTS };
    for (const [level, data] of Object.entries(factorScores)) {
        const articleCount = enrichedArticles.filter(a => a.level === level).length;
        if (articleCount > 3) dynamicWeights[level] = Math.min(0.5, BASE_WEIGHTS[level] + 0.05 * (articleCount - 3));
        else if (articleCount === 0) dynamicWeights[level] = BASE_WEIGHTS[level] * 0.5;
    }
    // Renormalize weights to sum to 1
    const weightSum = Object.values(dynamicWeights).reduce((a,b) => a + b, 0);
    for (const level of Object.keys(dynamicWeights)) dynamicWeights[level] /= weightSum;

    // Final score
    let overallScore = 0;
    for (const [level, score] of Object.entries(netScores)) {
        overallScore += score * dynamicWeights[level];
    }

    // Probability of price increase (logistic function: P = 1/(1+exp(-k*score))), k=2 gives good spread
    const k = 2.0;
    const probabilityUp = 1 / (1 + Math.exp(-k * overallScore));
    const direction = probabilityUp > 0.6 ? 'UP' : (probabilityUp < 0.4 ? 'DOWN' : 'NEUTRAL');
    const confidence = Math.abs(probabilityUp - 0.5) * 2; // 0..1

    // Prepare breakdown for UI
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