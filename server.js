require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const WebSocket = require('ws');
const cron = require('node-cron');
const crypto = require('crypto');

// Redis optional
let createClient = null;
if (process.env.REDIS_URL) {
    try {
        createClient = require('redis').createClient;
    } catch (e) {
        console.warn('Redis package not installed – caching disabled');
    }
}

const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { connectDb, getUsers, saveUser, updateUserPortfolio, updateUserTwoFactor, getUserByUsername, getTradeHistory, saveTradeHistory, getPortfolioHistory, savePortfolioHistory, saveConditionalOrder, getActiveConditionalOrders, updateConditionalOrderStatus, deleteConditionalOrder } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FRED_API_KEY = process.env.FRED_API_KEY;          // NEW: for macroeconomic data
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY; // NEW: for fundamentals

// Redis client (optional)
let redisClient = null;
(async () => {
    if (process.env.REDIS_URL && createClient) {
        redisClient = createClient({ url: process.env.REDIS_URL });
        redisClient.on('error', err => console.warn('Redis error:', err));
        await redisClient.connect();
        console.log('✅ Redis connected');
    } else if (process.env.REDIS_URL && !createClient) {
        console.warn('Redis package not installed – please run `npm install redis` or remove REDIS_URL from .env');
    }
})();

async function getCache(key) {
    if (!redisClient) return null;
    try {
        const data = await redisClient.get(key);
        return data ? JSON.parse(data) : null;
    } catch (e) { return null; }
}
async function setCache(key, value, ttlSeconds = 3600) {
    if (!redisClient) return;
    try {
        await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
    } catch (e) {}
}

// Yahoo helpers
function toYahooSymbol(symbol) {
    if (symbol.startsWith('^')) return symbol;
    if (symbol === '000300.SS') return symbol;
    return symbol.replace(/\./g, '-');
}
const yahooHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json'
};

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json());

// ========== AUTHENTICATION MIDDLEWARE ==========
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

// ========== AUTH ROUTES (no authentication required) ==========
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

    const normalizedUsername = username.toLowerCase();   // ✅ convert to lowercase

    const users = await getUsers();
    if (users.find(u => u.username === normalizedUsername)) {
        return res.status(400).json({ error: 'User exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const newUser = {
        username: normalizedUsername,                  // ✅ stored lowercase
        password: hashed,
        portfolio: { cash: 100000, holdings: {} },
        createdAt: new Date(),
        twoFactor: { enabled: false, secret: null, recoveryCodes: [] }
    };
    const saved = await saveUser(newUser);
    if (!saved) return res.status(500).json({ error: 'Registration failed' });

    const today = new Date().toISOString().split('T')[0];
    await savePortfolioHistory(normalizedUsername, today, 100000);   // ✅ use lowercase

    res.json({ message: 'Registered' });
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password, otp } = req.body;
    const user = await getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.twoFactor?.enabled) {
        if (!otp) return res.status(401).json({ error: '2FA code required' });
        const verified = speakeasy.totp.verify({
            secret: user.twoFactor.secret,
            encoding: 'base32',
            token: otp
        });
        if (!verified) return res.status(401).json({ error: 'Invalid 2FA code' });
    }

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
        token,
        username,
        portfolio: user.portfolio || { cash: 100000, holdings: {} },
        twoFactorEnabled: user.twoFactor?.enabled || false
    });
});

// ========== 2FA ENDPOINTS (require authentication) ==========
app.post('/api/auth/enable-2fa', authenticate, async (req, res) => {
    try {
        const user = await getUserByUsername(req.user.username);
        if (user.twoFactor?.enabled) {
            return res.status(400).json({ error: '2FA already enabled' });
        }
        const secret = speakeasy.generateSecret({ length: 20, name: `FinancialTerminal:${req.user.username}` });
        const qrCode = await QRCode.toDataURL(secret.otpauth_url);
        await updateUserTwoFactor(req.user.username, secret.base32, false, []);
        res.json({ secret: secret.base32, qrCode });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/auth/verify-2fa', authenticate, async (req, res) => {
    try {
        const { token } = req.body;
        const user = await getUserByUsername(req.user.username);
        if (!user.twoFactor?.secret) return res.status(400).json({ error: '2FA not initialized' });
        const verified = speakeasy.totp.verify({ secret: user.twoFactor.secret, encoding: 'base32', token });
        if (!verified) return res.status(401).json({ error: 'Invalid code' });
        const recoveryCodes = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex'));
        await updateUserTwoFactor(req.user.username, user.twoFactor.secret, true, recoveryCodes);
        res.json({ success: true, recoveryCodes });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Verification failed' });
    }
});

app.post('/api/auth/disable-2fa', authenticate, async (req, res) => {
    try {
        await updateUserTwoFactor(req.user.username, null, false, []);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Disable failed' });
    }
});

app.get('/api/auth/check-2fa', authenticate, async (req, res) => {
    try {
        const user = await getUserByUsername(req.user.username);
        res.json({ enabled: user?.twoFactor?.enabled || false });
    } catch (err) {
        res.status(500).json({ error: 'Check failed' });
    }
});

// ========== PORTFOLIO ROUTES ==========
app.get('/api/portfolio', authenticate, async (req, res) => {
    const user = await getUserByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ portfolio: user.portfolio || { cash: 100000, holdings: {} } });
});

app.post('/api/portfolio/sync', authenticate, async (req, res) => {
    const ok = await updateUserPortfolio(req.user.username, req.body.portfolio);
    if (ok) res.json({ success: true });
    else res.status(500).json({ error: 'Sync failed' });
});

// ========== RISK METRICS (Sharpe, Sortino, Max Drawdown) ==========
app.get('/api/portfolio/risk', authenticate, async (req, res) => {
    try {
        const db = await connectDb();
        if (!db) return res.status(500).json({ error: 'Database error' });

        const history = await db.collection('portfolio_history')
            .find({ username: req.user.username })
            .sort({ timestamp: 1 })
            .toArray();

        if (history.length < 2) {
            return res.json({ sharpe: null, sortino: null, maxDrawdown: null, message: 'Need at least 2 days of history' });
        }

        const values = history.map(h => h.totalValue);
        const returns = [];
        for (let i = 1; i < values.length; i++) {
            returns.push((values[i] - values[i-1]) / values[i-1]);
        }

        // Risk-free rate (use 10Y Treasury from FRED or default 2%)
        let riskFreeRate = 0.02;
        if (FRED_API_KEY) {
            try {
                const fredRes = await axios.get(`https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key=${FRED_API_KEY}&file_type=json&limit=1&sort_order=desc`);
                const latest = fredRes.data.observations[0];
                if (latest && latest.value) riskFreeRate = parseFloat(latest.value) / 100;
            } catch(e) { console.warn('Could not fetch risk-free rate, using default 2%'); }
        }

        const meanReturn = returns.reduce((a,b) => a + b, 0) / returns.length;
        const excessReturns = returns.map(r => r - riskFreeRate);
        const stdDev = Math.sqrt(returns.map(r => Math.pow(r - meanReturn, 2)).reduce((a,b) => a + b, 0) / returns.length);
        const sharpe = stdDev === 0 ? 0 : (meanReturn - riskFreeRate) / stdDev;

        // Sortino (downside deviation)
        const downsideReturns = returns.filter(r => r < 0);
        const downsideDev = downsideReturns.length ? Math.sqrt(downsideReturns.map(r => Math.pow(r, 2)).reduce((a,b) => a + b, 0) / downsideReturns.length) : 0;
        const sortino = downsideDev === 0 ? 0 : (meanReturn - riskFreeRate) / downsideDev;

        // Max Drawdown
        let peak = values[0];
        let maxDrawdown = 0;
        for (let i = 1; i < values.length; i++) {
            if (values[i] > peak) peak = values[i];
            const drawdown = (peak - values[i]) / peak;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }

        res.json({ sharpe: sharpe.toFixed(3), sortino: sortino.toFixed(3), maxDrawdown: (maxDrawdown * 100).toFixed(2) + '%' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ========== MACRO DASHBOARD (FRED) ==========
app.get('/api/fred/:seriesId', async (req, res) => {
    const { seriesId } = req.params;
    if (!FRED_API_KEY) return res.status(500).json({ error: 'FRED_API_KEY missing' });
    const cacheKey = `fred:${seriesId}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    try {
        const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_API_KEY}&file_type=json`;
        const response = await axios.get(url, { timeout: 10000 });
        const observations = response.data.observations.filter(o => o.value !== '.').map(o => ({
            date: o.date,
            value: parseFloat(o.value)
        }));
        const result = { seriesId, data: observations };
        await setCache(cacheKey, result, 86400); // cache 24h
        res.json(result);
    } catch (err) {
        console.error(`FRED error for ${seriesId}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ========== CORPORATE FUNDAMENTALS (Alpha Vantage) ==========
app.get('/api/fundamentals/:symbol', async (req, res) => {
    const { symbol } = req.params;
    if (!ALPHA_VANTAGE_KEY) return res.status(500).json({ error: 'ALPHA_VANTAGE_KEY missing' });
    const cacheKey = `fundamentals:${symbol}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json(cached);

    try {
        // Fetch overview data
        const overviewUrl = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`;
        const overviewRes = await axios.get(overviewUrl, { timeout: 10000 });
        const overview = overviewRes.data;
        if (!overview || Object.keys(overview).length === 0) throw new Error('No overview data');

        const fundamentals = {
            symbol: overview.Symbol,
            name: overview.Name,
            marketCap: overview.MarketCapitalization,
            peRatio: overview.PERatio,
            eps: overview.EPS,
            dividendYield: overview.DividendYield,
            beta: overview.Beta,
            fiftyTwoWeekHigh: overview['52WeekHigh'],
            fiftyTwoWeekLow: overview['52WeekLow'],
            revenueTTM: overview.RevenueTTM,
            grossProfitTTM: overview.GrossProfitTTM,
            profitMargin: overview.ProfitMargin,
            debtToEquity: overview.DebtToEquityRatio
        };

        await setCache(cacheKey, fundamentals, 86400);
        res.json(fundamentals);
    } catch (err) {
        console.error(`Fundamentals error for ${symbol}:`, err.message);
        res.status(500).json({ error: err.message });
    }
});

// ========== CONDITIONAL ORDERS ==========
app.post('/api/orders/conditional', authenticate, async (req, res) => {
    const { symbol, type, triggerPrice, quantity, trailingPercent } = req.body;
    if (!symbol || !type || !triggerPrice || !quantity) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    const order = {
        id: Date.now(),
        username: req.user.username,
        symbol: symbol.toUpperCase(),
        type,
        triggerPrice: parseFloat(triggerPrice),
        quantity: parseFloat(quantity),
        trailingPercent: trailingPercent ? parseFloat(trailingPercent) : null,
        status: 'active',
        createdAt: new Date(),
        highestPriceSinceActivation: null
    };
    const saved = await saveConditionalOrder(order);
    if (saved) res.json({ success: true, orderId: order.id });
    else res.status(500).json({ error: 'Failed to save order' });
});

app.get('/api/orders/conditional', authenticate, async (req, res) => {
    const orders = await getActiveConditionalOrders(req.user.username);
    res.json({ orders });
});

app.delete('/api/orders/conditional/:id', authenticate, async (req, res) => {
    const orderId = parseInt(req.params.id);
    const ok = await deleteConditionalOrder(orderId);
    res.json({ success: ok });
});

// ---------- Background Order Checker ----------
setInterval(async () => {
    try {
        const db = await connectDb();
        if (!db) return;
        const activeOrders = await db.collection('conditional_orders').find({ status: 'active' }).toArray();
        if (activeOrders.length === 0) return;

        const symbols = [...new Set(activeOrders.map(o => o.symbol))];
        const prices = {};
        for (const sym of symbols) {
            if (simulatedPrices.has(sym)) {
                prices[sym] = simulatedPrices.get(sym);
            } else {
                const cached = await getCache(`quote:${sym}`);
                if (cached && cached.price) {
                    prices[sym] = cached.price;
                } else {
                    try {
                        const yahooSym = toYahooSymbol(sym);
                        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`;
                        const resp = await axios.get(url, { params: { interval: '1d', range: '1d' }, headers: yahooHeaders, timeout: 5000 });
                        const lastClose = resp.data.chart.result[0]?.indicators.quote[0]?.close.slice(-1)[0];
                        if (lastClose) prices[sym] = lastClose;
                    } catch (e) { console.warn(`Order checker: cannot get price for ${sym}`); }
                }
            }
        }

        for (const order of activeOrders) {
            const currentPrice = prices[order.symbol];
            if (!currentPrice) continue;

            let triggered = false;
            let executedPrice = currentPrice;

            if (order.type === 'stop_loss') {
                if (currentPrice <= order.triggerPrice) triggered = true;
            } else if (order.type === 'take_profit') {
                if (currentPrice >= order.triggerPrice) triggered = true;
            } else if (order.type === 'trailing_stop') {
                let highest = order.highestPriceSinceActivation || currentPrice;
                if (currentPrice > highest) highest = currentPrice;
                const trailTrigger = highest * (1 - order.trailingPercent / 100);
                if (currentPrice <= trailTrigger) triggered = true;
                if (!triggered) {
                    await db.collection('conditional_orders').updateOne(
                        { id: order.id },
                        { $set: { highestPriceSinceActivation: highest } }
                    );
                }
            }

            if (triggered) {
                const user = await db.collection('users').findOne({ username: order.username });
                if (!user) continue;
                const portfolio = user.portfolio || { cash: 100000, holdings: {} };
                const holding = portfolio.holdings[order.symbol];
                if (!holding || holding.qty < order.quantity) {
                    await updateConditionalOrderStatus(order.id, 'cancelled_insufficient');
                    continue;
                }
                const total = executedPrice * order.quantity;
                const pnl = (executedPrice - holding.avgPrice) * order.quantity;
                portfolio.cash += total;
                holding.qty -= order.quantity;
                if (holding.qty === 0) delete portfolio.holdings[order.symbol];
                await db.collection('users').updateOne(
                    { username: order.username },
                    { $set: { portfolio } }
                );
                const tradeRecord = {
                    id: Date.now(),
                    timestamp: new Date().toISOString(),
                    symbol: order.symbol,
                    action: 'SELL',
                    qty: order.quantity,
                    price: executedPrice,
                    pnl,
                    triggeredBy: order.type
                };
                await db.collection('trade_history').insertOne({ ...tradeRecord, username: order.username });
                await updateConditionalOrderStatus(order.id, 'executed', executedPrice);
                console.log(`Executed ${order.type} for ${order.username} on ${order.symbol} @ ${executedPrice}`);
            }
        }
    } catch (err) {
        console.error('Order checker error:', err);
    }
}, 5000);

// ========== TRADE HISTORY ==========
app.get('/api/trade-history', authenticate, async (req, res) => {
    const history = await getTradeHistory(req.user.username);
    res.json({ history });
});
app.post('/api/trade-history', authenticate, async (req, res) => {
    const { trades } = req.body;
    const ok = await saveTradeHistory(req.user.username, trades);
    res.json({ success: ok });
});
app.get('/api/trade-history/verify/:id', authenticate, async (req, res) => {
    const tradeId = parseInt(req.params.id);
    const db = await connectDb();
    if (!db) return res.status(500).json({ error: 'Database error' });
    try {
        const trade = await db.collection('trade_history').findOne({ id: tradeId, username: req.user.username });
        if (!trade) return res.status(404).json({ error: 'Trade not found' });
        const data = `${req.user.username}|${trade.timestamp}|${trade.symbol}|${trade.action}|${trade.qty}|${trade.price}|${trade.pnl || ''}|${trade.prevHash}`;
        const recomputedHash = crypto.createHash('sha256').update(data).digest('hex');
        const isValid = recomputedHash === trade.hash;
        res.json({ valid: isValid });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PORTFOLIO VALUE HISTORY ==========
app.post('/api/portfolio-history', authenticate, async (req, res) => {
    const { timestamp, totalValue } = req.body;
    const ok = await savePortfolioHistory(req.user.username, timestamp, totalValue);
    res.json({ success: ok });
});
app.get('/api/portfolio-history', authenticate, async (req, res) => {
    const history = await getPortfolioHistory(req.user.username);
    res.json({ history });
});

// ========== LEADERBOARD ==========
// Helper: compute current portfolio value using live prices (cached or fetched)
async function computeCurrentPortfolioValue(portfolio, username) {
    let total = portfolio.cash || 0;
    const holdings = portfolio.holdings || {};
    for (const [symbol, holding] of Object.entries(holdings)) {
        if (!holding.qty) continue;
        let price = null;
        // Try to get cached quote from Redis
        const cached = await getCache(`quote:${symbol}`);
        if (cached && cached.price) {
            price = cached.price;
        } else {
            // Fallback: fetch fresh quote from Yahoo
            try {
                const yahooSym = toYahooSymbol(symbol);
                const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`;
                const response = await axios.get(url, { params: { interval: '1d', range: '1d' }, headers: yahooHeaders, timeout: 5000 });
                const lastClose = response.data.chart.result[0]?.indicators.quote[0]?.close.slice(-1)[0];
                if (lastClose) price = lastClose;
            } catch (e) { console.warn(`Leaderboard: cannot get price for ${symbol}`); }
        }
        if (price && !isNaN(price)) {
            total += holding.qty * price;
        }
    }
    return total;
}

app.get('/api/leaderboard', authenticate, async (req, res) => {
    try {
        const db = await connectDb();
        if (!db) return res.status(500).json({ error: 'Database error' });
        const users = await db.collection('users').find({}).toArray();
        const leaderboard = [];
        for (const user of users) {
            // Compute current total value using live prices (real-time)
            const currentTotal = await computeCurrentPortfolioValue(user.portfolio || { cash: 100000, holdings: {} }, user.username);
            // Get yesterday's value from portfolio_history (snapshot)
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            const yesterdayHistory = await db.collection('portfolio_history')
                .findOne({ username: user.username, timestamp: yesterdayStr });
            const previousValue = yesterdayHistory ? yesterdayHistory.totalValue : currentTotal;
            const dayChange = currentTotal - previousValue;
            const dayChangePct = previousValue !== 0 ? (dayChange / previousValue) * 100 : 0;
            leaderboard.push({ username: user.username, totalValue: currentTotal, dayChange, dayChangePct });
        }
        leaderboard.sort((a, b) => b.totalValue - a.totalValue);
        res.json({ leaderboard });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ========== USER LAYOUT ==========
app.post('/api/user/layout', authenticate, async (req, res) => {
    const db = await connectDb();
    if (!db) return res.status(500).json({ error: 'Database error' });
    try {
        await db.collection('users').updateOne(
            { username: req.user.username },
            { $set: { layout: req.body.layout } }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/user/layout', authenticate, async (req, res) => {
    const db = await connectDb();
    if (!db) return res.status(500).json({ error: 'Database error' });
    try {
        const user = await db.collection('users').findOne({ username: req.user.username });
        res.json({ layout: user?.layout || null });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== PROFILE MANAGEMENT ==========
app.post('/api/user/change-username', authenticate, async (req, res) => {
    const { newUsername } = req.body;
    if (!newUsername) return res.status(400).json({ error: 'New username required' });
    const db = await connectDb();
    if (!db) return res.status(500).json({ error: 'Database error' });
    const existing = await db.collection('users').findOne({ username: newUsername });
    if (existing) return res.status(400).json({ error: 'Username already taken' });
    await db.collection('users').updateOne(
        { username: req.user.username },
        { $set: { username: newUsername } }
    );
    await db.collection('trade_history').updateMany(
        { username: req.user.username },
        { $set: { username: newUsername } }
    );
    await db.collection('portfolio_history').updateMany(
        { username: req.user.username },
        { $set: { username: newUsername } }
    );
    res.json({ success: true });
});
app.post('/api/user/change-password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    const db = await connectDb();
    if (!db) return res.status(500).json({ error: 'Database error' });
    const user = await db.collection('users').findOne({ username: req.user.username });
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.collection('users').updateOne(
        { username: req.user.username },
        { $set: { password: hashed } }
    );
    res.json({ success: true });
});
app.delete('/api/user/delete', authenticate, async (req, res) => {
    const db = await connectDb();
    if (!db) return res.status(500).json({ error: 'Database error' });
    await db.collection('users').deleteOne({ username: req.user.username });
    await db.collection('trade_history').deleteMany({ username: req.user.username });
    await db.collection('portfolio_history').deleteMany({ username: req.user.username });
    await db.collection('conditional_orders').deleteMany({ username: req.user.username });
    res.json({ success: true });
});

// ========== YAHOO QUOTE (cached) ==========
app.get('/api/yahoo/quote', async (req, res) => {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    const cacheKey = `quote:${symbol}`;
    const cached = await getCache(cacheKey);
    if (cached && Date.now() - cached.timestamp < 5000) return res.json(cached);

    const yahooSym = toYahooSymbol(symbol);
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`;
        const response = await axios.get(url, { params: { interval: '1d', range: '1d' }, headers: yahooHeaders, timeout: 8000 });
        const result = response.data.chart.result[0];
        if (!result) throw new Error('No quote data');
        const quote = result.indicators.quote[0];
        const lastClose = quote.close[quote.close.length - 1];
        const previousClose = result.meta.previousClose;
        const quoteData = {
            success: true,
            price: lastClose,
            change: lastClose - previousClose,
            changePct: ((lastClose - previousClose) / previousClose) * 100,
            volume: quote.volume[quote.volume.length - 1] || 0,
            prevClose: previousClose,
            timestamp: Date.now()
        };
        await setCache(cacheKey, quoteData, 10);
        res.json(quoteData);
    } catch (err) {
        console.error(`Yahoo quote error ${symbol}:`, err.message);
        if (ALPHA_VANTAGE_KEY) {
            try {
                const alphaUrl = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`;
                const alphaRes = await axios.get(alphaUrl, { timeout: 5000 });
                const q = alphaRes.data['Global Quote'];
                if (q && q['05. price']) {
                    const price = parseFloat(q['05. price']);
                    const change = parseFloat(q['09. change'] || 0);
                    const changePct = parseFloat(q['10. change percent'] || 0);
                    const quoteData = {
                        success: true, price, change, changePct,
                        volume: parseInt(q['06. volume'] || 0),
                        prevClose: parseFloat(q['08. previous close'] || price),
                        timestamp: Date.now()
                    };
                    await setCache(cacheKey, quoteData, 10);
                    return res.json(quoteData);
                }
            } catch (e) {}
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== YAHOO HISTORICAL (cached) ==========
app.get('/api/yahoo', async (req, res) => {
    const { symbol, interval = '1d', range = '1mo' } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    const cacheKey = `historical:${symbol}:${range}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.json({ success: true, data: cached });

    const yahooSym = toYahooSymbol(symbol);
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`;
        const response = await axios.get(url, { params: { interval, range }, headers: yahooHeaders, timeout: 10000 });
        const result = response.data.chart.result[0];
        if (!result) throw new Error('No data');
        const timestamps = result.timestamp;
        const quotes = result.indicators.quote[0];
        const data = timestamps.map((t, i) => ({
            time: new Date(t * 1000).toISOString().split('T')[0],
            open: quotes.open[i],
            high: quotes.high[i],
            low: quotes.low[i],
            close: quotes.close[i],
            volume: quotes.volume[i]
        })).filter(d => d.close !== null);
        await setCache(cacheKey, data, 86400);
        res.json({ success: true, data });
    } catch (err) {
        console.error(`Yahoo chart error ${symbol}:`, err.message);
        if (ALPHA_VANTAGE_KEY) {
            try {
                const alphaUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${ALPHA_VANTAGE_KEY}`;
                const alphaRes = await axios.get(alphaUrl, { timeout: 10000 });
                const ts = alphaRes.data['Time Series (Daily)'];
                if (ts) {
                    const dates = Object.keys(ts).sort();
                    let days = 30;
                    if (range === '1mo') days = 30;
                    else if (range === '3mo') days = 90;
                    else if (range === '6mo') days = 180;
                    else if (range === '1y') days = 365;
                    const candles = dates.slice(-days).map(date => ({
                        time: date,
                        open: parseFloat(ts[date]['1. open']),
                        high: parseFloat(ts[date]['2. high']),
                        low: parseFloat(ts[date]['3. low']),
                        close: parseFloat(ts[date]['4. close']),
                        volume: parseInt(ts[date]['5. volume'])
                    }));
                    await setCache(cacheKey, candles, 86400);
                    return res.json({ success: true, data: candles });
                }
            } catch (e) {}
        }
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== DAILY PORTFOLIO HISTORY UPDATE FOR ALL USERS ==========
// Run every day at 23:59 UTC to snapshot all users' portfolios using current prices
cron.schedule('59 23 * * *', async () => {
    console.log('Running daily portfolio snapshot for all users...');
    try {
        const db = await connectDb();
        if (!db) return;
        const users = await db.collection('users').find({}).toArray();
        const today = new Date().toISOString().split('T')[0];
        let updated = 0;
        for (const user of users) {
            const portfolio = user.portfolio || { cash: 100000, holdings: {} };
            const totalValue = await computeCurrentPortfolioValue(portfolio, user.username);
            // Upsert today's snapshot
            await db.collection('portfolio_history').updateOne(
                { username: user.username, timestamp: today },
                { $set: { totalValue, username: user.username, timestamp: today } },
                { upsert: true }
            );
            updated++;
        }
        console.log(`Daily portfolio snapshot completed: ${updated} users updated.`);
    } catch (err) {
        console.error('Daily portfolio snapshot failed:', err);
    }
}, {
    timezone: "UTC"
});

// ========== FINNHUB PROXY ==========
app.get('/api/finnhub', async (req, res) => {
    if (!FINNHUB_API_KEY) return res.status(500).json({ error: 'No Finnhub key' });
    const { endpoint } = req.query;
    try {
        const url = `https://finnhub.io/api/v1/${endpoint}&token=${FINNHUB_API_KEY}`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== NEWS ==========
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
    } catch (err) { res.json({ news: [] }); }
});

// ========== GROQ AI ==========
app.post('/api/copilot/query', async (req, res) => {
    if (!GROQ_API_KEY) return res.status(500).json({ error: 'GROQ_API_KEY missing' });
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt required' });

    const slashMatch = prompt.match(/^\/(buy|sell)\s+(\d+(?:\.\d+)?)\s+([A-Z.^]+)$/i);
    if (slashMatch) {
        const action = slashMatch[1].toUpperCase();
        const qty = parseFloat(slashMatch[2]);
        const symbol = slashMatch[3].toUpperCase();
        if (!isNaN(qty) && qty > 0) {
            return res.json({
                text: `✓ Executed ${action} order: ${qty} shares of ${symbol}.`,
                action: { type: action, symbol, qty }
            });
        }
    }

    try {
        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'llama-3.3-70b-versatile',
                messages: [
                    {
                        role: 'system',
                        content: `You are a financial AI assistant. If the user asks to perform any of the following actions, respond ONLY with a JSON object:
- Buy/sell stock: {"action":"BUY" or "SELL","symbol":"AAPL","qty":10}
- Change chart interval: {"action":"SET_INTERVAL","value":"1D","1W","1M","3M"}
- Add symbol to watchlist: {"action":"ADD_TO_WATCHLIST","symbol":"BTC-USD"}
- Run a backtest: {"action":"RUN_BACKTEST","indicator":"sma_cross" or "rsi" or "bb","symbol":"AAPL","qty":10}
If the user asks a general question, respond with normal text. Do not add extra text.`
                    },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 200
            },
            { headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );

        let content = response.data.choices[0].message.content;
        try {
            const jsonMatch = content.match(/\{.*\}/s);
            if (jsonMatch) {
                const actionObj = JSON.parse(jsonMatch[0]);
                const supportedActions = ['BUY', 'SELL', 'SET_INTERVAL', 'ADD_TO_WATCHLIST', 'RUN_BACKTEST'];
                if (supportedActions.includes(actionObj.action)) {
                    return res.json({ text: `Executing ${actionObj.action}...`, action: actionObj });
                }
            }
        } catch(e) {}
        res.json({ text: content });
    } catch (err) {
        console.error('Groq error:', err.response?.data || err.message);
        res.status(500).json({ error: 'AI service error' });
    }
});

// ========== ARIMA FORECAST ==========
async function fetchHistoricalPrices(symbol, days = 60) {
    const yahooSym = toYahooSymbol(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`;
    const response = await axios.get(url, { params: { interval: '1d', range: days <= 90 ? '3mo' : '6mo' }, headers: yahooHeaders });
    const result = response.data.chart.result[0];
    const closes = result.indicators.quote[0].close;
    const timestamps = result.timestamp;
    return timestamps.map((t, i) => ({ time: new Date(t * 1000).toISOString().split('T')[0], close: closes[i] }))
        .filter(p => p.close !== null)
        .slice(-days);
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
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ========== MOMENTUM FORECAST ==========
app.get('/api/forecast/momentum', async (req, res) => {
    const { symbol, days = 20, forecastDays = 5 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    try {
        // Get enough historical data (e.g., 2x the lookback + forecast days)
        const historical = await fetchHistoricalPrices(symbol, days * 2);
        if (!historical || historical.length < days) throw new Error('Insufficient data');
        const closes = historical.map(c => c.close);
        const lastPrice = closes[closes.length - 1];
        // Calculate average daily return over the lookback period
        let totalReturn = 0;
        for (let i = closes.length - days; i < closes.length - 1; i++) {
            totalReturn += (closes[i+1] - closes[i]) / closes[i];
        }
        const avgDailyReturn = totalReturn / days;
        // Forecast next 'forecastDays' days
        const forecast = [];
        let price = lastPrice;
        for (let i = 0; i < forecastDays; i++) {
            price = price * (1 + avgDailyReturn);
            forecast.push(price);
        }
        res.json({ success: true, symbol, forecast, lastPrice, model: `Momentum (${days}d)` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== VOLATILITY FORECAST ==========
app.get('/api/forecast/volatility', async (req, res) => {
    const { symbol, days = 20, forecastDays = 5 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    try {
        const historical = await fetchHistoricalPrices(symbol, days + 5);
        if (!historical || historical.length < days) throw new Error('Insufficient data');
        const closes = historical.map(c => c.close);
        // Calculate daily returns over the lookback period
        const returns = [];
        for (let i = closes.length - days - 1; i < closes.length - 1; i++) {
            returns.push((closes[i+1] - closes[i]) / closes[i]);
        }
        const meanReturn = returns.reduce((a,b) => a+b,0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / returns.length;
        const dailyVol = Math.sqrt(variance);
        const annualizedVol = dailyVol * Math.sqrt(252);
        // Simple forecast: assume constant volatility for next 5 days
        res.json({ success: true, symbol, dailyVol: dailyVol.toFixed(4), annualizedVol: (annualizedVol * 100).toFixed(2) + '%', message: 'Historical volatility (last ' + days + ' days)' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== PAIR TRADING (Statistical Arbitrage) ==========
const stats = require('simple-statistics');

app.get('/api/pairs/analysis', async (req, res) => {
    const { symbol1, symbol2, days = 60 } = req.query;
    if (!symbol1 || !symbol2) return res.status(400).json({ error: 'Both symbols required' });
    try {
        const candles1 = await fetchHistoricalPrices(symbol1, days);
        const candles2 = await fetchHistoricalPrices(symbol2, days);
        if (!candles1.length || !candles2.length) throw new Error('Insufficient data');
        // Align dates (use the common dates)
        const dates1 = candles1.map(c => c.time);
        const dates2 = candles2.map(c => c.time);
        const commonDates = dates1.filter(d => dates2.includes(d));
        if (commonDates.length < 30) throw new Error('Not enough common trading days');
        const prices1 = [];
        const prices2 = [];
        for (const date of commonDates) {
            const p1 = candles1.find(c => c.time === date).close;
            const p2 = candles2.find(c => c.time === date).close;
            prices1.push(p1);
            prices2.push(p2);
        }
        // Linear regression: prices2 = alpha + beta * prices1
        const regression = stats.linearRegression(prices1.map((x,i) => [x, prices2[i]]));
        const beta = regression.m;
        const alpha = regression.b;
        // Calculate spread = prices2 - (alpha + beta * prices1)
        const spread = prices2.map((y, i) => y - (alpha + beta * prices1[i]));
        const meanSpread = stats.mean(spread);
        const stdSpread = stats.standardDeviation(spread);
        const currentPrice1 = prices1[prices1.length-1];
        const currentPrice2 = prices2[prices2.length-1];
        const currentSpread = currentPrice2 - (alpha + beta * currentPrice1);
        const zScore = (currentSpread - meanSpread) / stdSpread;
        const correlation = stats.sampleCorrelation(prices1, prices2);
        res.json({
            success: true,
            symbol1, symbol2,
            beta: beta.toFixed(4),
            alpha: alpha.toFixed(2),
            correlation: correlation.toFixed(4),
            meanSpread: meanSpread.toFixed(2),
            stdSpread: stdSpread.toFixed(2),
            currentSpread: currentSpread.toFixed(2),
            zScore: zScore.toFixed(2),
            signal: zScore > 1.5 ? 'Sell spread (mean reversion expected down)' : (zScore < -1.5 ? 'Buy spread (mean reversion expected up)' : 'Neutral'),
            dataPoints: commonDates.length
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== NEWS FARMER (Multi-level Sentiment) ==========
let predictStockDirection = null;
try {
    const newsFarmerModule = require('./newsFarmer');
    predictStockDirection = newsFarmerModule.predictStockDirection;
    console.log('✅ News Farmer module loaded successfully');
} catch (err) {
    console.error('❌ Failed to load newsFarmer.js:', err.message);
}

if (predictStockDirection) {
    app.get('/api/news/farmer', authenticate, async (req, res) => {
        const { symbol, days = 3 } = req.query;
        if (!symbol) return res.status(400).json({ error: 'Symbol required' });
        try {
            const cacheKey = `news_farmer:${symbol}:${days}`;
            const cached = await getCache(cacheKey);
            if (cached) return res.json(cached);

            const result = await predictStockDirection(symbol, parseInt(days));
            if (result.success) {
                await setCache(cacheKey, result, 7200);
                res.json(result);
            } else {
                res.status(404).json(result);
            }
        } catch (err) {
            console.error('News Farmer error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    });
    console.log('✅ News Farmer route registered at /api/news/farmer');
} else {
    console.warn('⚠️ News Farmer route not registered – module missing');
}

// ========== STATIC FILES (MUST BE LAST) ==========
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ========== WEBSOCKET SERVER ==========
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
const wss = new WebSocket.Server({ server });
const subscribers = new Map();
const simulatedPrices = new Map();

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
        simulatedPrices.set(symbol, newPrice);
        const msg = JSON.stringify({ type: 'trade', symbol, price: newPrice });
        clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }
}, 5000);