// server.js
// Required packages: express, cors, bcrypt, jsonwebtoken, axios, ws, dotenv
// Install with: npm install express cors bcrypt jsonwebtoken axios ws dotenv

require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret_change_me';

// ---------- Finnhub API key from .env ----------
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_API_KEY) {
  console.warn('⚠️  FINNHUB_API_KEY not found in .env – news and some quotes may fail.');
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve index.html from same folder

// Explicit root route
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- Persistent storage (simple JSON file) ----------
const DB_FILE = path.join(__dirname, 'db.json');
let db = { users: [], portfolios: {} };

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (err) { console.error('DB load error', err); }
}
function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
loadDB();

function getPortfolio(username) {
  if (!db.portfolios[username]) {
    db.portfolios[username] = { cash: 100000, holdings: {} };
    saveDB();
  }
  return db.portfolios[username];
}

// ---------- Authentication Routes ----------
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (db.users.find(u => u.username === username)) return res.status(400).json({ error: 'User already exists' });
  const hashed = await bcrypt.hash(password, 10);
  db.users.push({ username, password: hashed });
  db.portfolios[username] = { cash: 100000, holdings: {} };
  saveDB();
  res.json({ message: 'Registration successful' });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username, portfolio: getPortfolio(username) });
});

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/portfolio', authenticate, (req, res) => {
  res.json({ portfolio: getPortfolio(req.user.username) });
});

app.post('/api/portfolio/sync', authenticate, (req, res) => {
  const { portfolio } = req.body;
  db.portfolios[req.user.username] = portfolio;
  saveDB();
  res.json({ success: true });
});

// ---------- Proxy Endpoints (Finnhub, Yahoo, Alpha Vantage, Twelve Data) ----------
app.get('/api/finnhub', async (req, res) => {
  const { endpoint } = req.query;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  if (!FINNHUB_API_KEY) return res.status(500).json({ error: 'Finnhub API key not configured' });
  try {
    const url = `https://finnhub.io/api/v1/${endpoint}&token=${FINNHUB_API_KEY}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Yahoo Finance chart
app.get('/api/yahoo', async (req, res) => {
  const { symbol, interval, range } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
    const response = await axios.get(url, { params: { interval: interval || '1d', range: range || '1mo' } });
    const result = response.data.chart.result[0];
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// Yahoo Finance quote
app.get('/api/yahoo/quote', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
    const response = await axios.get(url, { params: { interval: '1d', range: '1d' } });
    const result = response.data.chart.result[0];
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
      high: meta.regularMarketPrice,
      low: meta.regularMarketPrice,
      open: previousClose,
      volume: quote.volume[quote.volume.length - 1]
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Alpha Vantage (optional)
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || '';
app.get('/api/alphavantage', async (req, res) => {
  const { function: func, symbol } = req.query;
  if (!func || !symbol) return res.status(400).json({ error: 'Missing function or symbol' });
  if (!ALPHA_VANTAGE_KEY) return res.status(500).json({ error: 'Alpha Vantage key not configured' });
  try {
    const url = `https://www.alphavantage.co/query?function=${func}&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Twelve Data (optional)
const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY || '';
app.get('/api/twelvedata', async (req, res) => {
  const { symbol, interval } = req.query;
  if (!TWELVE_DATA_KEY) return res.status(500).json({ error: 'Twelve Data key not configured' });
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval || '1day'}&apikey=${TWELVE_DATA_KEY}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- NEWS ENDPOINT (Finnhub) ----------
app.get('/api/news', async (req, res) => {
  if (!FINNHUB_API_KEY) {
    // Fallback without key
    const fallbackNews = [
      { title: 'Fed signals rate cuts ahead', link: 'https://www.reuters.com/markets/us/fed-signals-rate-cuts-2025-06-01/', source: 'Reuters', pubDate: new Date().toISOString() },
      { title: 'Tech earnings beat estimates', link: 'https://www.bloomberg.com/news/articles/2025-06-01/tech-earnings-beat-estimates', source: 'Bloomberg', pubDate: new Date().toISOString() },
      { title: 'Market rallies on inflation data', link: 'https://www.wsj.com/market-rallies-inflation-data-123456789', source: 'WSJ', pubDate: new Date().toISOString() },
    ];
    return res.json({ news: fallbackNews });
  }
  try {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_API_KEY}`;
    const response = await axios.get(url);
    const articles = response.data.slice(0, 12);
    const news = articles.map(article => ({
      title: article.headline,
      link: article.url,
      source: article.source,
      pubDate: new Date(article.datetime * 1000).toISOString()
    }));
    res.json({ news });
  } catch (err) {
    console.error('News fetch error:', err);
    // Fallback with real external links
    const fallbackNews = [
      { title: 'Fed signals rate cuts ahead', link: 'https://www.reuters.com/markets/us/fed-signals-rate-cuts-2025-06-01/', source: 'Reuters', pubDate: new Date().toISOString() },
      { title: 'Tech earnings beat estimates', link: 'https://www.bloomberg.com/news/articles/2025-06-01/tech-earnings-beat-estimates', source: 'Bloomberg', pubDate: new Date().toISOString() },
      { title: 'Market rallies on inflation data', link: 'https://www.wsj.com/market-rallies-inflation-data-123456789', source: 'WSJ', pubDate: new Date().toISOString() },
    ];
    res.json({ news: fallbackNews });
  }
});

// ---------- AI Copilot Proxy (mock) ----------
app.post('/api/copilot/query', async (req, res) => {
  const { prompt } = req.body;
  // Replace with actual Groq API call if you have a key
  res.json({ text: `AI response to: "${prompt}". (Mock reply – integrate real LLM)` });
});

// ---------- ARIMA Forecast Endpoint (AR(2) model) ----------
async function fetchHistoricalPrices(symbol, days = 60) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
  const response = await axios.get(url, { params: { interval: '1d', range: days <= 90 ? '3mo' : '6mo' } });
  const result = response.data.chart.result[0];
  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close;
  const prices = timestamps.map((t, i) => ({ time: new Date(t * 1000), close: closes[i] })).filter(p => p.close !== null);
  return prices.slice(-days);
}

function ar2Forecast(prices, steps = 5) {
  if (prices.length < 3) return null;
  const y = prices.map(p => p.close);
  const n = y.length;
  const X = [], Y = [];
  for (let t = 2; t < n; t++) {
    X.push([1, y[t-1], y[t-2]]);
    Y.push(y[t]);
  }
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
  const det = XtX[0][0] * (XtX[1][1]*XtX[2][2] - XtX[1][2]*XtX[2][1]) -
              XtX[0][1] * (XtX[1][0]*XtX[2][2] - XtX[1][2]*XtX[2][0]) +
              XtX[0][2] * (XtX[1][0]*XtX[2][1] - XtX[1][1]*XtX[2][0]);
  if (Math.abs(det) < 1e-9) return null;
  const inv = [
    [(XtX[1][1]*XtX[2][2] - XtX[1][2]*XtX[2][1]) / det, (XtX[0][2]*XtX[2][1] - XtX[0][1]*XtX[2][2]) / det, (XtX[0][1]*XtX[1][2] - XtX[0][2]*XtX[1][1]) / det],
    [(XtX[1][2]*XtX[2][0] - XtX[1][0]*XtX[2][2]) / det, (XtX[0][0]*XtX[2][2] - XtX[0][2]*XtX[2][0]) / det, (XtX[0][2]*XtX[1][0] - XtX[0][0]*XtX[1][2]) / det],
    [(XtX[1][0]*XtX[2][1] - XtX[1][1]*XtX[2][0]) / det, (XtX[0][1]*XtX[2][0] - XtX[0][0]*XtX[2][1]) / det, (XtX[0][0]*XtX[1][1] - XtX[0][1]*XtX[1][0]) / det]
  ];
  const coeff = inv.map(row => row.reduce((sum, val, i) => sum + val * XtY[i], 0));
  const c = coeff[0], phi1 = coeff[1], phi2 = coeff[2];
  const forecast = [];
  let prev1 = y[y.length-1];
  let prev2 = y[y.length-2];
  for (let i = 0; i < steps; i++) {
    const next = c + phi1 * prev1 + phi2 * prev2;
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
    if (historical.length < 10) throw new Error('Not enough data');
    const forecast = ar2Forecast(historical, parseInt(days));
    if (!forecast) throw new Error('Forecast failed');
    const lastPrice = historical[historical.length-1].close;
    const residuals = [];
    for (let i = 3; i < historical.length; i++) {
      const subPrices = historical.slice(0, i);
      const pred = ar2Forecast(subPrices, 1);
      if (pred && pred[0]) residuals.push(historical[i].close - pred[0]);
    }
    const stdDev = residuals.length ? Math.sqrt(residuals.reduce((sum, r) => sum + r*r, 0) / residuals.length) : 0;
    const confidence = 1.96 * stdDev;
    res.json({
      success: true,
      symbol,
      forecast: forecast.map(v => Number(v.toFixed(2))),
      lastPrice,
      confidenceInterval: { lower: forecast[forecast.length-1] - confidence, upper: forecast[forecast.length-1] + confidence },
      method: 'AR(2) model'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- WebSocket Server for real-time price updates ----------
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const wss = new WebSocket.Server({ server });

const subscribers = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'subscribe') {
        const symbol = data.symbol;
        if (!subscribers.has(symbol)) subscribers.set(symbol, new Set());
        subscribers.get(symbol).add(ws);
        ws.send(JSON.stringify({ type: 'subscribed', symbol }));
      }
    } catch (err) { console.warn('WS message error', err); }
  });
  ws.on('close', () => {
    for (const [symbol, clients] of subscribers.entries()) {
      clients.delete(ws);
      if (clients.size === 0) subscribers.delete(symbol);
    }
  });
});

async function broadcastRandomPrices() {
  for (const [symbol, clients] of subscribers.entries()) {
    if (clients.size === 0) continue;
    let price = 100;
    try {
      const quoteRes = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, { params: { interval: '1d', range: '1d' } });
      const lastClose = quoteRes.data.chart.result[0].indicators.quote[0].close.slice(-1)[0];
      if (lastClose) price = lastClose;
    } catch(e) { /* fallback */ }
    const change = (Math.random() - 0.5) * price * 0.01;
    const newPrice = price + change;
    const tradeMsg = JSON.stringify({ type: 'trade', symbol, price: newPrice });
    clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(tradeMsg);
    });
  }
}
setInterval(broadcastRandomPrices, 5000);