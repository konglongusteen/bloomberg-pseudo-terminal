require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const WebSocket = require('ws');
const { connectDb, getUsers, saveUser, updateUserPortfolio, getTradeHistory, saveTradeHistory, getPortfolioHistory, savePortfolioHistory } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Yahoo API headers
const yahooHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
};

// Convert symbol for Yahoo: keep caret indices and .SS as is, replace . with - for stocks
function toYahooSymbol(symbol) {
    if (symbol.startsWith('^')) return symbol;
    if (symbol === '000300.SS') return symbol;
    return symbol.replace(/\./g, '-');
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- Auth Routes (MongoDB) ----------
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const users = await getUsers();
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'User exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
        username,
        password: hashed,
        portfolio: { cash: 100000, holdings: {} },
        createdAt: new Date()
    };
    const saved = await saveUser(newUser);
    if (!saved) return res.status(500).json({ error: 'Registration failed' });

    // ---------- Leaderboard reliability fix: save initial portfolio snapshot ----------
    const today = new Date().toISOString().split('T')[0];
    await savePortfolioHistory(username, today, 100000);

    res.json({ message: 'Registered' });
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = await getUsers();
    const user = users.find(u => u.username === username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
        token,
        username,
        portfolio: user.portfolio || { cash: 100000, holdings: {} }
    });
});

function authenticate(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        req.user = jwt.verify(auth.slice(7), JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
}

app.get('/api/portfolio', authenticate, async (req, res) => {
    const users = await getUsers();
    const user = users.find(u => u.username === req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ portfolio: user.portfolio || { cash: 100000, holdings: {} } });
});

app.post('/api/portfolio/sync', authenticate, async (req, res) => {
    const ok = await updateUserPortfolio(req.user.username, req.body.portfolio);
    if (ok) res.json({ success: true });
    else res.status(500).json({ error: 'Sync failed' });
});

// ---------- Trade History ----------
app.get('/api/trade-history', authenticate, async (req, res) => {
    const history = await getTradeHistory(req.user.username);
    res.json({ history });
});

app.post('/api/trade-history', authenticate, async (req, res) => {
    const { trades } = req.body;
    const ok = await saveTradeHistory(req.user.username, trades);
    res.json({ success: ok });
});

// ---------- Portfolio Value History ----------
app.post('/api/portfolio-history', authenticate, async (req, res) => {
    const { timestamp, totalValue } = req.body;
    const ok = await savePortfolioHistory(req.user.username, timestamp, totalValue);
    res.json({ success: ok });
});

app.get('/api/portfolio-history', authenticate, async (req, res) => {
    const history = await getPortfolioHistory(req.user.username);
    res.json({ history });
});

// ---------- Leaderboard (with reliable day change) ----------
app.get('/api/leaderboard', authenticate, async (req, res) => {
    try {
        const db = await connectDb();
        if (!db) return res.status(500).json({ error: 'Database error' });

        const users = await db.collection('users').find({}).toArray();
        const leaderboard = [];

        for (const user of users) {
            // Get most recent portfolio history
            const latestHistory = await db.collection('portfolio_history')
                .find({ username: user.username })
                .sort({ timestamp: -1 })
                .limit(1)
                .toArray();

            let totalValue = user.portfolio?.cash || 0;
            if (latestHistory.length > 0) {
                totalValue = latestHistory[0].totalValue;
            } else {
                // Fallback: cash only (should not happen after registration fix)
                totalValue = user.portfolio?.cash || 0;
            }

            // Get yesterday's value (if exists)
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            const yesterdayHistory = await db.collection('portfolio_history')
                .findOne({ username: user.username, timestamp: yesterdayStr });

            const previousValue = yesterdayHistory ? yesterdayHistory.totalValue : totalValue;
            const dayChange = totalValue - previousValue;
            const dayChangePct = previousValue !== 0 ? (dayChange / previousValue) * 100 : 0;

            leaderboard.push({
                username: user.username,
                totalValue,
                dayChange,
                dayChangePct,
                hasHistory: latestHistory.length > 0
            });
        }

        leaderboard.sort((a, b) => b.totalValue - a.totalValue);
        res.json({ leaderboard });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- Yahoo Finance Quote ----------
app.get('/api/yahoo/quote', async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    const yahooSym = toYahooSymbol(symbol);
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`;
        const response = await axios.get(url, { params: { interval: '1d', range: '1d' }, headers: yahooHeaders, timeout: 8000 });
        const result = response.data.chart.result[0];
        if (!result) throw new Error('No quote data');
        const meta = result.meta;
        const quote = result.indicators.quote[0];
        const lastClose = quote.close[quote.close.length - 1];
        const previousClose = meta.previousClose;
        const change = lastClose - previousClose;
        const changePct = (change / previousClose) * 100;
        res.json({
            success: true,
            price: lastClose,
            change,
            changePct,
            volume: quote.volume[quote.volume.length - 1] || 0,
            prevClose: previousClose
        });
    } catch (err) {
        console.error(`Yahoo quote error ${symbol}:`, err.message);
        // Fallback to Finnhub if available
        if (FINNHUB_API_KEY) {
            try {
                const finnUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`;
                const finnRes = await axios.get(finnUrl, { timeout: 5000 });
                const finnData = finnRes.data;
                if (finnData && typeof finnData.c === 'number') {
                    res.json({
                        success: true,
                        price: finnData.c,
                        change: finnData.d,
                        changePct: finnData.dp,
                        volume: finnData.v,
                        prevClose: finnData.pc
                    });
                    return;
                }
            } catch (e) {}
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// ---------- Yahoo Historical Chart ----------
app.get('/api/yahoo', async (req, res) => {
    const { symbol, interval = '1d', range = '1mo' } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    const yahooSym = toYahooSymbol(symbol);
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`;
        const response = await axios.get(url, { params: { interval, range }, headers: yahooHeaders, timeout: 10000 });
        const result = response.data.chart.result[0];
        if (!result) throw new Error('No data');
        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0];
        const closes = quotes.close;
        const data = timestamps.map((t, i) => ({
            time: new Date(t * 1000).toISOString().split('T')[0],
            open: quotes.open[i],
            high: quotes.high[i],
            low: quotes.low[i],
            close: closes[i],
            volume: quotes.volume[i]
        })).filter(d => d.close !== null);
        res.json({ success: true, data });
    } catch (err) {
        console.error(`Yahoo chart error ${symbol}:`, err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ---------- Finnhub proxy (fallback) ----------
app.get('/api/finnhub', async (req, res) => {
    if (!FINNHUB_API_KEY) return res.status(500).json({ error: 'No Finnhub key' });
    const { endpoint } = req.query;
    try {
        const url = `https://finnhub.io/api/v1/${endpoint}&token=${FINNHUB_API_KEY}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- News ----------
app.get('/api/news', async (req, res) => {
    if (!FINNHUB_API_KEY) return res.json({ news: [] });
    try {
        const url = `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`;
        const response = await axios.get(url);
        const articles = response.data.slice(0, 12);
        const news = articles.map(a => ({
            title: a.headline,
            link: a.url,
            source: a.source,
            pubDate: new Date(a.datetime * 1000).toISOString()
        }));
        res.json({ news });
    } catch (err) {
        console.error('News error:', err.message);
        res.json({ news: [] });
    }
});

// ---------- Groq AI ----------
app.post('/api/copilot/query', async (req, res) => {
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY missing' });
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });
    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
                messages: [
                    { role: 'system', content: 'You are a financial AI assistant. Answer concisely.' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.7,
                max_tokens: 500
            },
            { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        res.json({ text: response.data.choices[0].message.content });
    } catch (err) {
        console.error('Groq error:', err.response?.data || err.message);
        res.status(500).json({ error: 'AI service error' });
    }
});

// ---------- ARIMA forecast ----------
async function fetchHistoricalPrices(symbol, days = 60) {
    const yahooSym = toYahooSymbol(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`;
    const response = await axios.get(url, { params: { interval: '1d', range: days <= 90 ? '3mo' : '6mo' }, headers: yahooHeaders });
    const result = response.data.chart.result[0];
    const closes = result.indicators.quote[0].close;
    const timestamps = result.timestamp;
    return timestamps.map((t, i) => ({ time: new Date(t * 1000), close: closes[i] })).filter(p => p.close !== null).slice(-days);
}

function ar2Forecast(prices, steps = 5) {
    if (prices.length < 3) return null;
    const y = prices.map(p => p.close);
    const n = y.length;
    const X = [], Y = [];
    for (let t = 2; t < n; t++) { X.push([1, y[t-1], y[t-2]]); Y.push(y[t]); }
    const XtX = [
        [X.reduce((s, row) => s + row[0]*row[0], 0), X.reduce((s, row) => s + row[0]*row[1], 0), X.reduce((s, row) => s + row[0]*row[2], 0)],
        [X.reduce((s, row) => s + row[1]*row[0], 0), X.reduce((s, row) => s + row[1]*row[1], 0), X.reduce((s, row) => s + row[1]*row[2], 0)],
        [X.reduce((s, row) => s + row[2]*row[0], 0), X.reduce((s, row) => s + row[2]*row[1], 0), X.reduce((s, row) => s + row[2]*row[2], 0)]
    ];
    const XtY = [
        X.reduce((s, row, i) => s + row[0] * Y[i], 0),
        X.reduce((s, row, i) => s + row[1] * Y[i], 0),
        X.reduce((s, row, i) => s + row[2] * Y[i], 0)
    ];
    const det = XtX[0][0]*(XtX[1][1]*XtX[2][2] - XtX[1][2]*XtX[2][1]) - XtX[0][1]*(XtX[1][0]*XtX[2][2] - XtX[1][2]*XtX[2][0]) + XtX[0][2]*(XtX[1][0]*XtX[2][1] - XtX[1][1]*XtX[2][0]);
    if (Math.abs(det) < 1e-9) return null;
    const inv = [
        [(XtX[1][1]*XtX[2][2] - XtX[1][2]*XtX[2][1])/det, (XtX[0][2]*XtX[2][1] - XtX[0][1]*XtX[2][2])/det, (XtX[0][1]*XtX[1][2] - XtX[0][2]*XtX[1][1])/det],
        [(XtX[1][2]*XtX[2][0] - XtX[1][0]*XtX[2][2])/det, (XtX[0][0]*XtX[2][2] - XtX[0][2]*XtX[2][0])/det, (XtX[0][2]*XtX[1][0] - XtX[0][0]*XtX[1][2])/det],
        [(XtX[1][0]*XtX[2][1] - XtX[1][1]*XtX[2][0])/det, (XtX[0][1]*XtX[2][0] - XtX[0][0]*XtX[2][1])/det, (XtX[0][0]*XtX[1][1] - XtX[0][1]*XtX[1][0])/det]
    ];
    const coeff = inv.map(row => row.reduce((s, v, i) => s + v * XtY[i], 0));
    const [c, phi1, phi2] = coeff;
    const forecast = [];
    let prev1 = y[n-1], prev2 = y[n-2];
    for (let i = 0; i < steps; i++) {
        const next = c + phi1*prev1 + phi2*prev2;
        forecast.push(next);
        prev2 = prev1;
        prev1 = next;
    }
    return forecast;
}

app.get('/api/forecast/arima', async (req, res) => {
    try {
        const { symbol, days = 5 } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol required' });
        const historical = await fetchHistoricalPrices(symbol, 60);
        if (historical.length < 10) throw new Error('Insufficient data');
        const forecast = ar2Forecast(historical, parseInt(days));
        if (!forecast) throw new Error('Forecast failed');
        const lastPrice = historical[historical.length-1].close;
        const residuals = [];
        for (let i = 3; i < historical.length; i++) {
            const pred = ar2Forecast(historical.slice(0, i), 1);
            if (pred && pred[0]) residuals.push(historical[i].close - pred[0]);
        }
        const stdDev = residuals.length ? Math.sqrt(residuals.reduce((s, r) => s + r*r, 0) / residuals.length) : 0;
        const confidence = 1.96 * stdDev;
        res.json({
            success: true,
            symbol,
            forecast: forecast.map(v => Number(v.toFixed(2))),
            lastPrice,
            confidenceInterval: { lower: forecast[forecast.length-1] - confidence, upper: forecast[forecast.length-1] + confidence }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ---------- WebSocket (simulated live prices) ----------
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const wss = new WebSocket.Server({ server });
const subscribers = new Map();
wss.on('connection', ws => {
    ws.on('message', msg => {
        try {
            const { type, symbol } = JSON.parse(msg);
            if (type === 'subscribe') {
                if (!subscribers.has(symbol)) subscribers.set(symbol, new Set());
                subscribers.get(symbol).add(ws);
            }
        } catch(e) {}
    });
    ws.on('close', () => {
        for (const [sym, clients] of subscribers.entries()) {
            clients.delete(ws);
            if (clients.size === 0) subscribers.delete(sym);
        }
    });
});
setInterval(async () => {
    for (const [symbol, clients] of subscribers.entries()) {
        if (clients.size === 0) continue;
        let price = 100;
        try {
            const yahooSym = toYahooSymbol(symbol);
            const res = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`, { params: { interval: '1d', range: '1d' }, headers: yahooHeaders });
            const lastClose = res.data.chart.result[0].indicators.quote[0].close.slice(-1)[0];
            if (lastClose) price = lastClose;
        } catch(e) {}
        const change = (Math.random() - 0.5) * price * 0.01;
        const newPrice = price + change;
        const msg = JSON.stringify({ type: 'trade', symbol, price: newPrice });
        clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }
}, 5000);