/**
 * BLOOMBERG TERMINAL SECURE BACKEND GATEWAY
 * Provides API proxies for Finnhub (quotes), Yahoo Finance (candles),
 * and fallbacks (Alpha Vantage, Twelve Data).
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const WebSocket = require('ws');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ==================== AUTHENTICATION (kept for compatibility) ====================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    const users = db.getUsers();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase()))
        return res.status(409).json({ error: 'Username taken' });
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    db.saveUser({ username, password: hashedPassword, portfolio: { cash: 100000, holdings: {} }, created_at: new Date().toISOString() });
    res.status(201).json({ success: true });
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = db.getUsers();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET || 'fallback', { expiresIn: '24h' });
    res.json({ token, username: user.username, portfolio: user.portfolio });
});

app.post('/api/portfolio/sync', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'No token' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback');
        db.updateUserPortfolio(decoded.username, req.body.portfolio);
        res.json({ success: true });
    } catch(e) { res.status(403).json({ error: 'Invalid token' }); }
});

// ==================== FINNHUB PROXY (quotes, profile) ====================
app.get('/api/finnhub', async (req, res) => {
    const endpoint = req.query.endpoint;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Finnhub API key missing' });
    try {
        const url = `https://finnhub.io/api/v1/${endpoint}&token=${apiKey}`;
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Finnhub proxy error' });
    }
});

// ==================== YAHOO FINANCE PROXY (fast, free candles) ====================
app.get('/api/yahoo', async (req, res) => {
    const { symbol, interval, range } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
    // Default to daily candles, range based on days
    const yahooInterval = interval || '1d';
    const yahooRange = range || '1mo';
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${yahooInterval}&range=${yahooRange}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data && data.chart && data.chart.result && data.chart.result[0]) {
            const result = data.chart.result[0];
            const timestamps = result.timestamp;
            const quote = result.indicators.quote[0];
            const candles = timestamps.map((t, idx) => ({
                time: new Date(t * 1000).toISOString().split('T')[0],
                open: quote.open[idx],
                high: quote.high[idx],
                low: quote.low[idx],
                close: quote.close[idx],
                volume: quote.volume[idx]
            })).filter(c => c.open !== null);
            res.json({ success: true, data: candles });
        } else {
            res.status(404).json({ error: 'No data from Yahoo' });
        }
    } catch (err) {
        res.status(502).json({ error: 'Yahoo proxy error' });
    }
});

// ==================== ALPHA VANTAGE PROXY (fallback) ====================
app.get('/api/alphavantage', async (req, res) => {
    const { function: func, symbol, outputsize } = req.query;
    if (!func || !symbol) return res.status(400).json({ error: 'Missing parameters' });
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Alpha Vantage key missing' });
    try {
        const url = `https://www.alphavantage.co/query?function=${func}&symbol=${symbol}&outputsize=${outputsize || 'compact'}&apikey=${apiKey}`;
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Alpha Vantage proxy error' });
    }
});

// ==================== TWELVE DATA PROXY (fallback) ====================
app.get('/api/twelvedata', async (req, res) => {
    const { symbol, interval, outputsize } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Missing symbol' });
    const apiKey = process.env.TWELVE_DATA_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Twelve Data key missing' });
    try {
        const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval || '1day'}&outputsize=${outputsize || 30}&apikey=${apiKey}`;
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'Twelve Data proxy error' });
    }
});

// ==================== WEB SOCKET SERVER (real-time trades via Finnhub) ====================
const server = app.listen(PORT, () => {
    console.log(`============================================================`);
    console.log(`  BLOOMBERG TERMINAL SYSTEM ACTIVE ON PORT ${PORT}`);
    console.log(`  ACCESS AT: http://localhost:${PORT}`);
    console.log(`============================================================`);
});

const wss = new WebSocket.Server({ server });
let finnhubWs = null;
const clients = new Set();

function connectFinnhubWebSocket() {
    const finnhubKey = process.env.FINNHUB_API_KEY;
    if (!finnhubKey) {
        console.warn('⚠️ FINNHUB_API_KEY missing – WebSocket will not stream real trades.');
        return;
    }
    finnhubWs = new WebSocket(`wss://ws.finnhub.io?token=${finnhubKey}`);
    finnhubWs.on('open', () => console.log('✅ Finnhub WebSocket connected'));
    finnhubWs.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'trade') {
            msg.data.forEach(trade => {
                const payload = JSON.stringify({ type: 'trade', symbol: trade.s, price: trade.p });
                clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) client.send(payload);
                });
            });
        }
    });
    finnhubWs.on('error', (err) => console.error('Finnhub WS error', err));
    finnhubWs.on('close', () => {
        console.log('Finnhub WebSocket closed, reconnecting in 5s...');
        setTimeout(connectFinnhubWebSocket, 5000);
    });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    const subscriptions = new Set();
    ws.on('message', (message) => {
        try {
            const { type, symbol } = JSON.parse(message);
            if (type === 'subscribe' && finnhubWs && finnhubWs.readyState === WebSocket.OPEN) {
                if (!subscriptions.has(symbol)) {
                    subscriptions.add(symbol);
                    finnhubWs.send(JSON.stringify({ type: 'subscribe', symbol }));
                }
            }
        } catch (err) {}
    });
    ws.on('close', () => clients.delete(ws));
});

connectFinnhubWebSocket();

// ==================== SPA FALLBACK ====================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});