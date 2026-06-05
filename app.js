// ============================================================
// 1. GLOBAL VARIABLES & AUTH
// ============================================================
let authToken = null, currentUser = null;
const loginOverlay = document.getElementById('login-overlay');
const terminalInterface = document.getElementById('terminal-interface');
const loginError = document.getElementById('login-error');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginConfirm = document.getElementById('login-confirm');
const loginSubmit = document.getElementById('login-submit');
const loginSwitch = document.getElementById('login-switch');
let isLoginMode = true;

const companyNamesMap = {
    'AAPL': 'Apple Inc.', 'MSFT': 'Microsoft Corp.', 'GOOGL': 'Alphabet Inc.', 'AMZN': 'Amazon.com Inc.',
    'NVDA': 'NVIDIA Corp.', 'META': 'Meta Platforms', 'TSLA': 'Tesla Inc.', 'BRK.B': 'Berkshire Hathaway',
    'JPM': 'JPMorgan Chase', 'JNJ': 'Johnson & Johnson', 'V': 'Visa Inc.', 'PG': 'Procter & Gamble',
    'UNH': 'UnitedHealth', 'HD': 'Home Depot', 'DIS': 'Walt Disney', 'MA': 'Mastercard Inc.',
    'BAC': 'Bank of America', 'NFLX': 'Netflix Inc.', 'ADBE': 'Adobe Inc.', 'CRM': 'Salesforce Inc.',
    'KO': 'Coca-Cola Co.', 'PEP': 'PepsiCo Inc.', 'TMO': 'Thermo Fisher', 'COST': 'Costco Wholesale',
    'ABT': 'Abbott Labs', 'DHR': 'Danaher Corp.', 'WMT': 'Walmart Inc.', 'NKE': 'Nike Inc.',
    'CVX': 'Chevron Corp.', 'MRK': 'Merck & Co.', 'ABBV': 'AbbVie Inc.', 'LLY': 'Eli Lilly',
    'AVGO': 'Broadcom Inc.', 'TXN': 'Texas Instruments', 'QCOM': 'Qualcomm Inc.', 'AMGN': 'Amgen Inc.',
    'SBUX': 'Starbucks Corp.', 'LOW': "Lowe's Cos", 'UPS': 'United Parcel Service', 'GE': 'General Electric',
    'IBM': 'IBM Corp.', 'CAT': 'Caterpillar Inc.', 'GS': 'Goldman Sachs', 'MS': 'Morgan Stanley',
    'C': 'Citigroup Inc.', 'PLD': 'Prologis Inc.', 'SPGI': 'S&P Global Inc.', 'BLK': 'BlackRock Inc.',
    'T': 'AT&T Inc.', 'VZ': 'Verizon Comm.',
    '^GSPC': 'S&P 500 Index',
    '^IXIC': 'NASDAQ Composite',
    '^N225': 'Nikkei 225',
    'ASHR': 'CSI 300 ETF'
};

// Fallback for toggleStrategyBuilder (in case backtester.js hasn't loaded yet)
window.toggleStrategyBuilder = window.toggleStrategyBuilder || function() {
    const content = document.getElementById('strategy-content');
    if (content) content.classList.toggle('hidden');
};
window.toggleCorrelation = window.toggleCorrelation || function() {
    const content = document.getElementById('correlation-content');
    if (content) content.classList.toggle('hidden');
};

function setAuthMode(login) { isLoginMode = login; if (login) { loginConfirm.style.display = 'none'; loginSubmit.innerText = 'Login'; loginSwitch.innerText = "Don't have an account? Register"; } else { loginConfirm.style.display = 'block'; loginSubmit.innerText = 'Register'; loginSwitch.innerText = "Already have an account? Login"; } loginError.innerText = ''; }
loginSwitch.onclick = () => setAuthMode(!isLoginMode);
loginSubmit.onclick = async () => {
    const username = loginUsername.value.trim(), password = loginPassword.value, confirm = loginConfirm.value;
    if (!username || !password) { loginError.innerText = 'Username and password required'; return; }
    if (!isLoginMode && password !== confirm) { loginError.innerText = 'Passwords do not match'; return; }
    const endpoint = isLoginMode ? '/api/auth/login' : '/api/auth/register';
    try {
        const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Authentication failed');
        if (isLoginMode) {
            authToken = data.token; currentUser = data.username;
            window.portfolio = data.portfolio || { cash: 100000, holdings: {} };
            loginOverlay.classList.add('hidden');
            terminalInterface.classList.remove('hidden');
            await loadPortfolioFromBackend();
            await loadTradeHistoryFromBackend();
            await loadPortfolioHistoryFromBackend();
            initTerminal();
            await savePortfolioValueSnapshot();
        } else {
            loginError.innerText = 'Registration successful! Please login.';
            setAuthMode(true);
            loginPassword.value = ''; loginConfirm.value = '';
        }
    } catch (err) { loginError.innerText = err.message; }
};
document.getElementById('logout-btn').onclick = () => { authToken = null; currentUser = null; terminalInterface.classList.add('hidden'); loginOverlay.classList.remove('hidden'); loginUsername.value = ''; loginPassword.value = ''; loginConfirm.value = ''; setAuthMode(true); };
async function syncPortfolioToBackend() { if (!authToken) return; try { await fetch('/api/portfolio/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ portfolio: portfolio }) }); } catch(e) {} }
async function loadPortfolioFromBackend() {
    if (!authToken) return;
    try {
        const response = await fetch('/api/portfolio', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (response.ok) {
            const data = await response.json();
            if (data.portfolio) {
                portfolio = data.portfolio;
                localStorage.setItem('bb_portfolio', JSON.stringify(portfolio));
                updatePortfolioDisplay();
                updatePortfolioComposition(0, true);
                setTimeout(() => updatePortfolioComposition(0, true), 3000);
                setTimeout(() => updatePortfolioComposition(0, true), 6000);
            }
        }
    } catch(e) {}
}

// ============================================================
// 2. TRADE HISTORY SYNC (MongoDB) with Audit Trail (Phase 4)
// ============================================================
let tradeHistory = [];
async function loadTradeHistoryFromBackend() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/trade-history', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) {
            const data = await res.json();
            tradeHistory = data.history || [];
            localStorage.setItem('trade_history', JSON.stringify(tradeHistory));
        }
    } catch(e) { console.warn('Failed to load trade history from backend'); }
}
async function syncTradeHistoryToBackend() {
    if (!authToken || !tradeHistory.length) return;
    try {
        await fetch('/api/trade-history', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` }, body: JSON.stringify({ trades: tradeHistory }) });
    } catch(e) {}
}
function addTradeRecord(symbol, action, qty, price, pnl = null) {
    const record = { id: Date.now(), timestamp: new Date().toISOString(), symbol, action, qty: parseFloat(qty.toFixed(4)), price, pnl: pnl !== null ? pnl : (action === 'SELL' ? (qty * price - (portfolio.holdings[symbol]?.avgPrice || price) * qty) : null) };
    tradeHistory.unshift(record);
    if (tradeHistory.length > 100) tradeHistory.pop();
    localStorage.setItem('trade_history', JSON.stringify(tradeHistory));
    syncTradeHistoryToBackend();
}

// Modified showTradeHistoryModal with Verify buttons (Phase 4)
async function showTradeHistoryModal() {
    const container = document.getElementById('trade-history-list');
    if (!tradeHistory.length) {
        container.innerHTML = '<div class="text-gray-500 text-center">No trades recorded.</div>';
    } else {
        let html = '<table class="history-table"><thead><tr><th>Date</th><th>Symbol</th><th>Action</th><th>Qty</th><th>Price</th><th>P&L</th><th>Verification</th></tr></thead><tbody>';
        for (const t of tradeHistory) {
            const pnlClass = t.pnl && t.pnl > 0 ? 'text-green-500' : (t.pnl && t.pnl < 0 ? 'text-red-500' : 'text-gray-400');
            const verifyBtn = `<button class="text-[9px] bg-bbAmber/20 text-bbAmber px-1 rounded verify-trade" data-id="${t.id}">Verify</button>`;
            html += `<tr>
                <td>${new Date(t.timestamp).toLocaleString()}</td>
                <td>${t.symbol}</td>
                <td class="${t.action === 'BUY' ? 'text-green-500' : 'text-red-500'}">${t.action}</td>
                <td>${t.qty}</td>
                <td>$${t.price.toFixed(2)}</td>
                <td class="${pnlClass}">${t.pnl ? `$${t.pnl.toFixed(2)}` : '—'}</td>
                <td>${verifyBtn}</td>
            </tr>`;
        }
        html += '</tbody></table>';
        container.innerHTML = html;
        // Attach event listeners to verify buttons
        document.querySelectorAll('.verify-trade').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = btn.getAttribute('data-id');
                try {
                    const res = await fetch(`/api/trade-history/verify/${id}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
                    const data = await res.json();
                    alert(data.valid ? '✓ Trade signature is valid (tamper-proof)' : '✗ Trade signature INVALID! Data may have been altered.');
                } catch (err) {
                    alert('Verification failed: ' + err.message);
                }
            });
        });
    }
    document.getElementById('trade-history-modal').classList.remove('hidden');
}
function closeTradeHistoryModal() { document.getElementById('trade-history-modal').classList.add('hidden'); }

// ============================================================
// 3. PORTFOLIO VALUE HISTORY (Chart) with interval selector
// ============================================================
let portfolioHistory = [];
let portfolioChart = null;
let portfolioHistoryRange = '1M';

async function savePortfolioValueSnapshot(retry = 0) {
    if (!authToken) return;
    let missingPrices = false;
    let totalValue = portfolio.cash;
    for (const [sym, h] of Object.entries(portfolio.holdings)) {
        const price = priceCache[sym]?.price;
        if (!price || isNaN(price)) {
            missingPrices = true;
            break;
        }
        totalValue += h.qty * price;
    }
    if (missingPrices && retry < 5) {
        console.log(`Missing prices for some holdings, retrying snapshot in 1 second... (attempt ${retry + 1})`);
        setTimeout(() => savePortfolioValueSnapshot(retry + 1), 1000);
        return;
    }
    const timestamp = new Date().toISOString().split('T')[0];
    try {
        await fetch('/api/portfolio-history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ timestamp, totalValue })
        });
        const existingIndex = portfolioHistory.findIndex(h => h.timestamp === timestamp);
        if (existingIndex !== -1) {
            portfolioHistory[existingIndex].totalValue = totalValue;
        } else {
            portfolioHistory.push({ timestamp, totalValue });
            portfolioHistory.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        }
        updatePortfolioChart();
    } catch(e) { console.warn('Failed to save portfolio snapshot:', e); }
}

async function loadPortfolioHistoryFromBackend() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/portfolio-history', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) {
            const data = await res.json();
            portfolioHistory = data.history || [];
            if (portfolioHistory.length === 0) {
                let totalValue = portfolio.cash;
                for (const [sym, h] of Object.entries(portfolio.holdings)) {
                    const price = priceCache[sym]?.price;
                    if (price && !isNaN(price)) totalValue += h.qty * price;
                }
                const today = new Date().toISOString().split('T')[0];
                portfolioHistory.push({ timestamp: today, totalValue });
            }
            updatePortfolioChart();
        }
    } catch(e) {}
}

function getPortfolioHistoryFiltered() {
    if (!portfolioHistory.length) return [];
    const now = new Date();
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    let startDate = new Date(todayUTC);
    switch (portfolioHistoryRange) {
        case '1W': startDate.setUTCDate(todayUTC.getUTCDate() - 7); break;
        case '1M': startDate.setUTCMonth(todayUTC.getUTCMonth() - 1); break;
        case '3M': startDate.setUTCMonth(todayUTC.getUTCMonth() - 3); break;
        default: return portfolioHistory;
    }
    const startStr = startDate.toISOString().split('T')[0];
    const filtered = portfolioHistory.filter(h => h.timestamp >= startStr);
    if (filtered.length === 0 && portfolioHistory.length > 0) return [portfolioHistory[portfolioHistory.length - 1]];
    return filtered;
}

// FIXED: updatePortfolioChart now updates existing chart instead of destroying/recreating
function updatePortfolioChart() {
    const canvas = document.getElementById('portfolio-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
        setTimeout(() => updatePortfolioChart(), 100);
        return;
    }
    const filtered = getPortfolioHistoryFiltered();
    const labels = filtered.map(h => h.timestamp);
    const values = filtered.map(h => h.totalValue);
    const isLightTheme = document.body.classList.contains('light-theme');
    const textColor = isLightTheme ? '#000000' : '#e2e2e2';
    const gridColor = isLightTheme ? '#dddddd' : '#282828';

    if (portfolioChart) {
        // Update existing chart
        portfolioChart.data.labels = labels;
        portfolioChart.data.datasets[0].data = values;
        portfolioChart.options.plugins.legend.labels.color = textColor;
        portfolioChart.options.scales.y.ticks.color = textColor;
        portfolioChart.options.scales.x.ticks.color = textColor;
        portfolioChart.options.scales.y.grid.color = gridColor;
        portfolioChart.options.scales.x.grid.color = gridColor;
        portfolioChart.update();
        portfolioChart.resize();
    } else {
        // Create new chart
        portfolioChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Portfolio Value ($)',
                    data: values,
                    borderColor: '#dfb257',
                    backgroundColor: 'rgba(223,178,87,0.1)',
                    fill: true,
                    tension: 0.1,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                    pointBackgroundColor: '#dfb257',
                    pointBorderColor: isLightTheme ? '#000000' : '#ffffff',
                    pointBorderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { labels: { color: textColor, font: { size: 10 } } },
                    tooltip: { enabled: true, mode: 'index', intersect: false }
                },
                scales: {
                    y: { ticks: { color: textColor }, grid: { color: gridColor } },
                    x: { ticks: { color: textColor, maxRotation: 45, autoSkip: true }, grid: { color: gridColor } }
                }
            }
        });
    }
}

function setPortfolioHistoryRange(range) {
    portfolioHistoryRange = range;
    updatePortfolioChart();
}

// ============================================================
// 4. QUOTE CACHING & TIMESTAMP
// ============================================================
let quoteCache = {};
const QUOTE_CACHE_TTL = 5000;
let lastQuoteTimestamp = null;
function updateLastUpdatedTimestamp() {
    const el = document.getElementById('last-updated-timestamp');
    if (el && lastQuoteTimestamp) el.innerText = new Date(lastQuoteTimestamp).toLocaleTimeString();
}

// ============================================================
// 5. WEBSOCKET
// ============================================================
let ws = null;
let reconnectAttempts = 0;
let wsRafId = null;
let pendingWsUpdates = {};
function applyWsUpdates() {
    for (const [sym, price] of Object.entries(pendingWsUpdates)) {
        if (priceCache[sym]) {
            const old = priceCache[sym].price;
            priceCache[sym].price = price;
            priceCache[sym].change = price - old;
            priceCache[sym].changePct = (priceCache[sym].change / old) * 100;
        } else {
            priceCache[sym] = { price, change: 0, changePct: 0 };
        }
        if (sym === currentSymbol) updateQuotePanel(priceCache[sym]);
        updateWatchlistRow(sym, priceCache[sym]);
        const row = document.getElementById(`wst-row-${sym}`);
        if (row) row.classList.add(priceCache[sym].change >= 0 ? 'tick-up' : 'tick-down');
        setTimeout(() => row && row.classList.remove('tick-up', 'tick-down'), 800);
    }
    pendingWsUpdates = {};
    wsRafId = null;
}
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);
    ws.onopen = () => { 
        reconnectAttempts = 0; 
        watchlistSymbols.forEach(sym => ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }))); 
    };
    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'trade') {
            pendingWsUpdates[data.symbol] = data.price;
            if (wsRafId === null) wsRafId = requestAnimationFrame(applyWsUpdates);
        }
    };
    ws.onerror = (err) => console.warn('WebSocket error', err);
    ws.onclose = () => {
        const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));
        setTimeout(connectWebSocket, delay);
        reconnectAttempts++;
    };
}

// ============================================================
// 6. HISTORICAL DATA CACHE
// ============================================================
const CACHE_TTL = 60 * 60 * 1000;
function getCachedCandles(symbol, days) { const key = `candles_${symbol}_${days}`; const cached = localStorage.getItem(key); if (cached) { const { timestamp, data } = JSON.parse(cached); if (Date.now() - timestamp < CACHE_TTL) return data; } return null; }
function setCachedCandles(symbol, days, candles) { localStorage.setItem(`candles_${symbol}_${days}`, JSON.stringify({ timestamp: Date.now(), data: candles })); }

// ============================================================
// 7. HAPTIC FEEDBACK
// ============================================================
function haptic() { if (window.navigator && window.navigator.vibrate) window.navigator.vibrate(100); }

// ============================================================
// 8. PORTFOLIO COMPOSITION PIE CHART
// ============================================================
let compositionChart = null;
let lastPortfolioState = null;
function updatePortfolioComposition(retry = 0, force = false) {
    const currentState = JSON.stringify({ cash: portfolio.cash, holdings: portfolio.holdings });
    if (!force && lastPortfolioState === currentState && compositionChart !== null) return;
    if (!force) lastPortfolioState = currentState;
    const canvas = document.getElementById('portfolio-composition-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const totalCash = portfolio.cash;
    let totalHoldingsValue = 0;
    const holdingsData = [];
    const labels = [];
    let missingPrices = false;
    for (const [sym, h] of Object.entries(portfolio.holdings)) {
        const price = priceCache[sym]?.price;
        if (!price || isNaN(price)) {
            missingPrices = true;
            continue;
        }
        const value = h.qty * price;
        if (value > 0) {
            holdingsData.push(value);
            labels.push(sym);
            totalHoldingsValue += value;
        }
    }
    const total = totalCash + totalHoldingsValue;
    if (Object.keys(portfolio.holdings).length > 0 && total === 0 && missingPrices && retry < 15) {
        setTimeout(() => updatePortfolioComposition(retry + 1, force), 1000);
        return;
    }
    if (total === 0) {
        if (compositionChart) compositionChart.destroy();
        compositionChart = null;
        return;
    }
    const percentages = holdingsData.map(v => (v / total) * 100);
    const dataValues = [...holdingsData];
    const dataLabels = [...labels];
    if (totalCash > 0) {
        dataValues.unshift(totalCash);
        dataLabels.unshift('Cash');
        percentages.unshift((totalCash / total) * 100);
    }
    const isLightTheme = document.body.classList.contains('light-theme');
    const textColor = isLightTheme ? '#000000' : '#e2e2e2';
    if (compositionChart) compositionChart.destroy();
    compositionChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: dataLabels,
            datasets: [{
                data: dataValues,
                backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec489a', '#06b6d4'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { position: 'bottom', labels: { color: textColor, font: { size: 9 } } },
                tooltip: { callbacks: { label: (ctx) => `${ctx.label}: $${ctx.raw.toFixed(2)} (${ctx.raw === totalCash ? 'Cash' : percentages[ctx.dataIndex].toFixed(1)}%)` } }
            }
        }
    });
}

// ============================================================
// 9. WATCHLIST FILTERS
// ============================================================
function applyWatchlistFilters() {
    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    const filterType = document.getElementById('filter-type').value;
    const filterVal = parseFloat(document.getElementById('filter-value').value);
    const showFavOnly = document.getElementById('favourite-filter').checked;
    const assetFilter = document.getElementById('asset-filter')?.value || 'all';
    const tbody = document.getElementById('watchlist-tbody');
    if (!tbody) return;
    const rows = Array.from(tbody.children);
    for (const row of rows) {
        const sym = row.getAttribute('data-symbol');
        const assetType = row.getAttribute('data-asset-type');
        const data = priceCache[sym];
        const company = companyNamesMap[sym] || sym;
        let show = true;
        if (searchTerm && !sym.toLowerCase().includes(searchTerm) && !company.toLowerCase().includes(searchTerm)) show = false;
        if (show && showFavOnly && !isFavourite(sym)) show = false;
        if (show && assetFilter !== 'all' && assetType !== assetFilter) show = false;
        if (show && filterType !== 'all') {
            if (filterType === 'gainers') show = data && data.changePct >= (isNaN(filterVal) ? 0 : filterVal);
            else if (filterType === 'losers') show = data && data.changePct <= (isNaN(filterVal) ? 0 : -filterVal);
        }
        row.style.display = show ? '' : 'none';
    }
}

// ============================================================
// 10. CORE VARIABLES
// ============================================================
const YAHOO_PROXY = '/api/yahoo?'; const YAHOO_QUOTE_PROXY = '/api/yahoo/quote?symbol='; const ALPHA_VANTAGE_PROXY = '/api/alphavantage?function=TIME_SERIES_DAILY&symbol='; const AI_PROXY = '/api/copilot/query'; const NEWS_PROXY = '/api/news'; const FORECAST_ARIMA_PROXY = '/api/forecast/arima?';
let currentSymbol = 'AAPL', currentInterval = '1M'; let chart = null, candleSeries = null, volumeSeries = null, lineSeries = null, isLineMode = false, forecastSeries = null, showForecast = false; let priceCache = {}; let watchlistSymbols = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'BRK.B', 'JPM', 'JNJ',
    'V', 'PG', 'UNH', 'HD', 'DIS', 'MA', 'BAC', 'NFLX', 'ADBE', 'CRM', 'KO', 'PEP',
    'TMO', 'COST', 'ABT', 'DHR', 'WMT', 'NKE', 'CVX', 'MRK', 'ABBV', 'LLY', 'AVGO',
    'TXN', 'QCOM', 'AMGN', 'SBUX', 'LOW', 'UPS', 'GE', 'IBM', 'CAT', 'GS', 'MS', 'C',
    'PLD', 'SPGI', 'BLK', 'T', 'VZ', '^GSPC', '^IXIC', '^N225', 'ASHR'
]; let portfolio = { cash: 100000.00, holdings: {} }; let currentCandles = [];

const assetTypeMap = { '^GSPC': 'index', '^IXIC': 'index', '^N225': 'index', 'ASHR': 'index' };
function getAssetType(sym) { return assetTypeMap[sym] || 'stock'; }

// Total price preview
function updateTotalPreview() {
    const sym = document.getElementById('trade-symbol').value.trim().toUpperCase();
    const qty = parseFloat(document.getElementById('trade-qty').value);
    const price = priceCache[sym]?.price;
    const totalSpan = document.getElementById('trade-total-preview');
    if (!totalSpan) return;
    if (!sym || isNaN(qty) || qty <= 0 || !price || isNaN(price)) {
        totalSpan.innerText = '$0.00';
        return;
    }
    const total = price * qty;
    totalSpan.innerText = `$${total.toFixed(2)}`;
}

// Portfolio display & top movers
function updateTopMovers() { const gainers = [], losers = []; for (const sym of watchlistSymbols) { const data = priceCache[sym]; if (data && typeof data.changePct === 'number' && !isNaN(data.changePct)) { if (data.changePct >= 0) gainers.push({ sym, pct: data.changePct }); else losers.push({ sym, pct: data.changePct }); } } gainers.sort((a,b) => b.pct - a.pct); losers.sort((a,b) => a.pct - b.pct); document.getElementById('gainers-list').innerHTML = gainers.slice(0,5).map(g => `<div class="mover-item"><span>${g.sym}</span><span class="text-green-500">+${g.pct.toFixed(2)}%</span></div>`).join('') || 'None'; document.getElementById('losers-list').innerHTML = losers.slice(0,5).map(l => `<div class="mover-item"><span>${l.sym}</span><span class="text-red-500">${l.pct.toFixed(2)}%</span></div>`).join('') || 'None'; }

// Sell all
function sellAllShares() {
    const sym = document.getElementById('trade-symbol').value.trim().toUpperCase();
    const errorDiv = document.getElementById('trade-error-message');
    if (!portfolio.holdings[sym] || portfolio.holdings[sym].qty <= 0) { errorDiv.innerText = `No shares of ${sym} to sell.`; errorDiv.classList.remove('hidden'); setTimeout(() => errorDiv.classList.add('hidden'), 3000); return; }
    const qty = portfolio.holdings[sym].qty;
    const price = priceCache[sym]?.price;
    if (!price || isNaN(price)) { errorDiv.innerText = `Cannot get current price for ${sym}.`; errorDiv.classList.remove('hidden'); setTimeout(() => errorDiv.classList.add('hidden'), 3000); return; }
    const total = price * qty;
    const avgPrice = portfolio.holdings[sym].avgPrice;
    const pnl = (price - avgPrice) * qty;
    portfolio.cash += total;
    delete portfolio.holdings[sym];
    addTradeRecord(sym, 'SELL', qty, price, pnl);
    localStorage.setItem('bb_portfolio', JSON.stringify(portfolio));
    updatePortfolioDisplay();
    syncPortfolioToBackend();
    savePortfolioValueSnapshot();
    errorDiv.innerText = `Sold ${qty.toFixed(4)} shares of ${sym}.`;
    errorDiv.classList.remove('hidden');
    setTimeout(() => errorDiv.classList.add('hidden'), 3000);
    haptic();
}

// Buy / Sell trades (fractional)
function executeQuickTrade(action) {
    const sym = document.getElementById('trade-symbol').value.trim().toUpperCase();
    let qty = parseFloat(document.getElementById('trade-qty').value);
    const errorDiv = document.getElementById('trade-error-message');
    if (!priceCache[sym] || isNaN(qty) || qty <= 0) { errorDiv.innerText = 'Invalid symbol or quantity'; errorDiv.classList.remove('hidden'); setTimeout(() => errorDiv.classList.add('hidden'), 3000); return; }
    qty = parseFloat(qty.toFixed(4));
    const price = priceCache[sym].price;
    const total = price * qty;
    if (action === 'BUY') {
        if (portfolio.cash < total) { errorDiv.innerText = `INSUFFICIENT FUNDS: Need $${total.toFixed(2)}, available $${portfolio.cash.toFixed(2)}`; errorDiv.classList.remove('hidden'); setTimeout(() => errorDiv.classList.add('hidden'), 4000); return; }
        portfolio.cash -= total;
        if (!portfolio.holdings[sym]) portfolio.holdings[sym] = { qty: 0, avgPrice: 0 };
        const h = portfolio.holdings[sym];
        const newTotalCost = (h.avgPrice * h.qty) + total;
        h.qty += qty;
        h.avgPrice = newTotalCost / h.qty;
        addTradeRecord(sym, 'BUY', qty, price);
    } else {
        const h = portfolio.holdings[sym];
        if (!h || h.qty < qty) { errorDiv.innerText = `INSUFFICIENT HOLDINGS: You own ${h?.qty || 0} shares of ${sym}`; errorDiv.classList.remove('hidden'); setTimeout(() => errorDiv.classList.add('hidden'), 4000); return; }
        const pnl = (price - h.avgPrice) * qty;
        portfolio.cash += total;
        h.qty -= qty;
        if (h.qty === 0) delete portfolio.holdings[sym];
        addTradeRecord(sym, 'SELL', qty, price, pnl);
    }
    localStorage.setItem('bb_portfolio', JSON.stringify(portfolio));
    updatePortfolioDisplay();
    syncPortfolioToBackend();
    savePortfolioValueSnapshot();
    errorDiv.classList.add('hidden');
    haptic();
}

function executeAIAction(action, symbol, qty) {
    document.getElementById('trade-symbol').value = symbol;
    document.getElementById('trade-qty').value = qty;
    executeQuickTrade(action);
}
window.executeQuickTrade = executeQuickTrade;
document.getElementById('buy-btn').onclick = () => executeQuickTrade('BUY');
document.getElementById('sell-btn').onclick = () => executeQuickTrade('SELL');
document.getElementById('sell-all-btn').onclick = sellAllShares;

window.updatePortfolioDisplay = function() {
    document.getElementById('portfolio-cash-lbl').innerText = `$${portfolio.cash.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const list = document.getElementById('portfolio-positions-list');
    list.innerHTML = `<span class="text-[#a0a0a0] font-bold uppercase">PORTFOLIO POSITIONS:</span>`;
    for (const [sym, h] of Object.entries(portfolio.holdings)) {
        const price = priceCache[sym]?.price || 0;
        const val = h.qty * price;
        const cost = h.qty * h.avgPrice;
        const dailyPnl = (price - (priceCache[sym]?.prevClose || price)) * h.qty;
        list.innerHTML += `<span class="inline-block border border-[#282828] bg-black px-2 py-0.5 rounded text-[10px] cursor-pointer hover:bg-[#282828] transition" onclick="changeActiveSymbol('${sym}')">
            <strong class="text-white">${sym}</strong>: ${h.qty.toFixed(4)} @ $${h.avgPrice.toFixed(2)} 
            (<span class="${val >= cost ? 'text-green-500' : 'text-red-500'}">$${val.toLocaleString('en', { maximumFractionDigits: 2 })}</span>)
            <span class="text-[8px] ml-1 ${dailyPnl >= 0 ? 'text-green-500' : 'text-red-500'}">Δday: $${dailyPnl.toFixed(2)}</span>
        </span>`;
    }
    updateTopMovers();
    updatePortfolioComposition();
};

// Favourites
let favourites = JSON.parse(localStorage.getItem('favourites')) || {};
function toggleFavourite(sym) { favourites[sym] = !favourites[sym]; localStorage.setItem('favourites', JSON.stringify(favourites)); renderWatchlist(); }
function isFavourite(sym) { return favourites[sym] === true; }

// Load quote (Yahoo)
async function loadQuote(symbol) {
    const now = Date.now();
    if (quoteCache[symbol] && (now - quoteCache[symbol].timestamp < QUOTE_CACHE_TTL)) {
        const cached = quoteCache[symbol].data;
        if (cached && typeof cached.price === 'number' && !isNaN(cached.price)) {
            priceCache[symbol] = cached;
            if (symbol === currentSymbol) updateQuotePanel(cached);
            updateTotalPreview();
            return cached;
        } else {
            delete quoteCache[symbol];
        }
    }
    try {
        const res = await fetchWithTimeout(YAHOO_QUOTE_PROXY + symbol, 8000);
        const data = await res.json();
        if (data.success && typeof data.price === 'number' && !isNaN(data.price)) {
            const quoteData = {
                price: data.price,
                change: data.change,
                changePct: data.changePct,
                volume: data.volume || 0,
                prevClose: data.prevClose || data.price
            };
            priceCache[symbol] = quoteData;
            quoteCache[symbol] = { timestamp: now, data: quoteData };
            if (symbol === currentSymbol) updateQuotePanel(quoteData);
            updateTotalPreview();
            lastQuoteTimestamp = now;
            updateLastUpdatedTimestamp();
            return quoteData;
        } else {
            throw new Error('Invalid Yahoo response');
        }
    } catch (err) {
        console.warn(`Yahoo quote failed for ${symbol}:`, err.message);
        if (symbol === currentSymbol) updateQuotePanel(null);
        updateTotalPreview();
        return null;
    }
}

// Technical indicators
function calculateRSI(prices, period) {
    if (prices.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i-1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    let rs = avgGain / avgLoss;
    let rsi = 100 - (100 / (1 + rs));
    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i-1];
        let gain = diff >= 0 ? diff : 0, loss = diff >= 0 ? 0 : -diff;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        rs = avgGain / avgLoss;
        rsi = 100 - (100 / (1 + rs));
    }
    return rsi;
}
function calculateSMA(prices, period) {
    if (prices.length < period) return null;
    return prices.slice(-period).reduce((a,b) => a + b, 0) / period;
}
function calculateMACD(prices) {
    if (prices.length < 26) return { macd: null, signal: null };
    let ema12 = 0, ema26 = 0;
    for (let i = 0; i < prices.length; i++) {
        if (i >= 12) ema12 = (prices[i] * 2 / 13) + (ema12 * 11 / 13);
        if (i >= 26) ema26 = (prices[i] * 2 / 27) + (ema26 * 25 / 27);
        if (i >= 25) return { macd: ema12 - ema26, signal: null };
    }
    return { macd: null, signal: null };
}
function calculateBollingerBands(prices, period = 20, stdDev = 2) {
    if (prices.length < period) return { upper: null, lower: null, middle: null };
    const middle = prices.slice(-period).reduce((a,b) => a + b, 0) / period;
    const variance = prices.slice(-period).reduce((sum, p) => sum + Math.pow(p - middle, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { upper: middle + stdDev * std, lower: middle - stdDev * std, middle };
}
function updateIndicators(candles) {
    const rsiValueEl = document.getElementById('rsi-value');
    const rsiSignalEl = document.getElementById('rsi-signal');
    const macdValueEl = document.getElementById('macd-value');
    const macdSignalEl = document.getElementById('macd-signal');
    const bbStatusEl = document.getElementById('bb-status');
    const bbSignalEl = document.getElementById('bb-signal');
    const maStatusEl = document.getElementById('ma-status');
    const maPredictionEl = document.getElementById('ma-prediction');
    if (!candles || candles.length < 30) {
        if (rsiValueEl) rsiValueEl.innerText = '--';
        if (rsiSignalEl) rsiSignalEl.innerText = '--';
        if (macdValueEl) macdValueEl.innerText = '--';
        if (macdSignalEl) macdSignalEl.innerText = '--';
        if (bbStatusEl) bbStatusEl.innerText = '--';
        if (bbSignalEl) bbSignalEl.innerText = '--';
        if (maStatusEl) maStatusEl.innerText = '--';
        if (maPredictionEl) maPredictionEl.innerText = '--';
        return;
    }
    const closes = candles.map(c => c.close);
    let rsi = calculateRSI(closes, 14);
    if (rsi !== null && rsiValueEl && rsiSignalEl) {
        rsiValueEl.innerHTML = rsi.toFixed(1);
        let signal = '';
        if (rsi > 70) signal = 'Overbought';
        else if (rsi < 30) signal = 'Oversold';
        else signal = 'Neutral';
        rsiSignalEl.innerHTML = signal;
        rsiSignalEl.className = `text-[9px] ${rsi > 70 ? 'signal-bearish' : (rsi < 30 ? 'signal-bullish' : 'signal-neutral')}`;
    }
    const macd = calculateMACD(closes);
    if (macd.macd !== null && macdValueEl && macdSignalEl) {
        macdValueEl.innerHTML = macd.macd.toFixed(2);
        macdSignalEl.innerHTML = macd.macd > 0 ? 'Bullish' : 'Bearish';
    }
    const bb = calculateBollingerBands(closes);
    const lastPrice = closes[closes.length - 1];
    if (bb.upper !== null && bbStatusEl && bbSignalEl) {
        let bbStatus = '';
        if (lastPrice > bb.upper) bbStatus = 'Overbought (Sell)';
        else if (lastPrice < bb.lower) bbStatus = 'Oversold (Buy)';
        else bbStatus = 'Neutral';
        bbStatusEl.innerHTML = bbStatus;
        bbSignalEl.innerHTML = `Upper: ${bb.upper.toFixed(2)} / Lower: ${bb.lower.toFixed(2)}`;
    }
    const sma20 = calculateSMA(closes, 20), sma50 = calculateSMA(closes, 50);
    if (sma20 !== null && sma50 !== null && maStatusEl && maPredictionEl) {
        const isBullish = sma20 > sma50;
        maStatusEl.innerHTML = isBullish ? 'Bullish (20 > 50)' : 'Bearish (20 < 50)';
        maStatusEl.className = `indicator-value ${isBullish ? 'signal-bullish' : 'signal-bearish'}`;
        maPredictionEl.innerHTML = isBullish ? 'Uptrend expected' : 'Downtrend expected';
        maPredictionEl.className = `text-[9px] ${isBullish ? 'signal-bullish' : 'signal-bearish'}`;
    }
}

function updateQuotePanel(data) {
    const priceEl = document.getElementById('stock-price');
    const changeEl = document.getElementById('stock-change');
    const changePctEl = document.getElementById('stock-change-pct');
    if (!priceEl || !changeEl || !changePctEl) return;
    try {
        const isValid = data && typeof data.price === 'number' && !isNaN(data.price) && typeof data.change === 'number' && !isNaN(data.change) && typeof data.changePct === 'number' && !isNaN(data.changePct);
        if (!isValid) {
            priceEl.innerText = '---';
            changeEl.innerText = '---';
            changePctEl.innerText = '---';
            priceEl.className = 'text-lg font-bold text-gray-500 font-mono';
            changeEl.className = 'text-gray-500 font-bold font-mono';
            changePctEl.className = 'text-gray-500 text-[10px] font-mono';
            updateTotalPreview();
            return;
        }
        priceEl.innerText = data.price.toFixed(2);
        changeEl.innerText = (data.change >= 0 ? '+' : '') + data.change.toFixed(2);
        changePctEl.innerText = (data.changePct >= 0 ? '+' : '') + data.changePct.toFixed(2) + '%';
        const cls = data.change >= 0 ? 'text-green-500' : 'text-red-500';
        priceEl.className = `text-lg font-bold ${cls} font-mono`;
        changeEl.className = `${cls} font-bold font-mono`;
        changePctEl.className = `${cls} text-[10px] font-mono`;
        updateTotalPreview();
    } catch (err) {
        console.warn('updateQuotePanel error:', err);
        priceEl.innerText = '---';
        changeEl.innerText = '---';
        changePctEl.innerText = '---';
        priceEl.className = 'text-lg font-bold text-gray-500 font-mono';
        changeEl.className = 'text-gray-500 font-bold font-mono';
        changePctEl.className = 'text-gray-500 text-[10px] font-mono';
        updateTotalPreview();
    }
}

// Forecast
function linearRegressionForecast(prices, daysAhead) {
    let n = prices.length;
    if (n < 3) return null;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += prices[i];
        sumXY += i * prices[i];
        sumX2 += i * i;
    }
    let slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    let intercept = (sumY - slope * sumX) / n;
    let lastX = n - 1;
    let future = [];
    for (let i = 1; i <= daysAhead; i++) future.push(intercept + slope * (lastX + i));
    return future;
}
async function fetchBackendForecast(symbol, days) {
    try {
        const res = await fetch(FORECAST_ARIMA_PROXY + `symbol=${symbol}&days=${days}`);
        const data = await res.json();
        if (data.success && data.forecast && data.forecast.length) {
            return { forecast: data.forecast, lastPrice: data.lastPrice, confidence: data.confidenceInterval };
        }
    } catch(e) { console.warn('ARIMA forecast failed:', e); }
    return null;
}
async function updateForecastPanel(candles) {
    const modelSelect = document.getElementById('forecast-model');
    const selectedModel = modelSelect ? modelSelect.value : 'linear';
    const forecastPriceSpan = document.getElementById('forecast-price');
    const forecastDirSpan = document.getElementById('forecast-dir');
    if (!candles || candles.length < 20) {
        forecastPriceSpan.innerText = '--';
        forecastDirSpan.innerText = '--';
        return null;
    }
    const closes = candles.map(c => c.close);
    if (selectedModel === 'arima') {
        const backendData = await fetchBackendForecast(currentSymbol, 5);
        if (backendData && backendData.forecast) {
            const lastPrice = backendData.lastPrice;
            const futurePrice = backendData.forecast[backendData.forecast.length - 1];
            const direction = futurePrice > lastPrice ? 'Bullish' : (futurePrice < lastPrice ? 'Bearish' : 'Neutral');
            forecastPriceSpan.innerHTML = `$${futurePrice.toFixed(2)}`;
            forecastDirSpan.innerHTML = `${direction} over 5 days (ARIMA)`;
            forecastDirSpan.className = `text-[9px] ${direction === 'Bullish' ? 'signal-bullish' : (direction === 'Bearish' ? 'signal-bearish' : 'signal-neutral')}`;
            if (backendData.confidence) forecastDirSpan.title = `95% CI: $${backendData.confidence.lower.toFixed(2)} – $${backendData.confidence.upper.toFixed(2)}`;
            return backendData.forecast;
        } else {
            forecastPriceSpan.innerText = '--';
            forecastDirSpan.innerText = 'ARIMA failed';
            forecastDirSpan.className = 'text-[9px] signal-neutral';
            return null;
        }
    } else {
        const forecast = linearRegressionForecast(closes, 5);
        if (forecast && forecast.length) {
            const lastPrice = closes[closes.length - 1];
            const futurePrice = forecast[forecast.length - 1];
            const direction = futurePrice > lastPrice ? 'Bullish' : (futurePrice < lastPrice ? 'Bearish' : 'Neutral');
            forecastPriceSpan.innerHTML = `$${futurePrice.toFixed(2)}`;
            forecastDirSpan.innerHTML = `${direction} over 5 days (Linear)`;
            forecastDirSpan.className = `text-[9px] ${direction === 'Bullish' ? 'signal-bullish' : (direction === 'Bearish' ? 'signal-bearish' : 'signal-neutral')}`;
            return forecast;
        }
    }
    return null;
}

// Chart initialization
function initChart() { const container = document.getElementById('chart-container'), parent = document.getElementById('chart-parent-container'); if (!container || !parent) return; container.innerHTML = ''; const width = parent.clientWidth || 600, height = parent.clientHeight - 80 || 400; chart = LightweightCharts.createChart(container, { width, height, layout: { background: { color: '#000000' }, textColor: '#a0a0a0' }, grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } }, crosshair: { mode: LightweightCharts.CrosshairMode.Normal }, rightPriceScale: { borderColor: '#282828' }, timeScale: { borderColor: '#282828', timeVisible: true } }); candleSeries = chart.addCandlestickSeries({ upColor: '#00ff00', downColor: '#ff3333', borderDownColor: '#ff3333', borderUpColor: '#00ff00', wickDownColor: '#ff3333', wickUpColor: '#00ff00' }); volumeSeries = chart.addHistogramSeries({ color: '#26a69a', priceFormat: { type: 'volume' }, priceScaleId: 'volume', lineWidth: 1, priceLineVisible: false }); chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } }); lineSeries = chart.addLineSeries({ color: '#dfb257', lineWidth: 2, priceLineVisible: false }); if (lineSeries && typeof lineSeries.applyOptions === 'function') lineSeries.applyOptions({ visible: false }); else if (lineSeries && typeof lineSeries.setVisible === 'function') lineSeries.setVisible(false); forecastSeries = chart.addLineSeries({ color: '#ffaa00', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, priceLineVisible: false, title: 'Forecast' }); if (forecastSeries && typeof forecastSeries.applyOptions === 'function') forecastSeries.applyOptions({ visible: showForecast }); else if (forecastSeries && typeof forecastSeries.setVisible === 'function') forecastSeries.setVisible(showForecast); new ResizeObserver(() => { if (chart) { const newWidth = parent.clientWidth, newHeight = parent.clientHeight - 80; if (newWidth > 0 && newHeight > 0) chart.resize(newWidth, newHeight); } }).observe(parent); }
function toggleChartType() { isLineMode = document.getElementById('line-mode-toggle').checked; if (candleSeries && lineSeries) { if (typeof candleSeries.applyOptions === 'function') candleSeries.applyOptions({ visible: !isLineMode }); else if (typeof candleSeries.setVisible === 'function') candleSeries.setVisible(!isLineMode); if (typeof lineSeries.applyOptions === 'function') lineSeries.applyOptions({ visible: isLineMode }); else if (typeof lineSeries.setVisible === 'function') lineSeries.setVisible(isLineMode); } }
async function toggleForecastLine() { showForecast = document.getElementById('forecast-toggle').checked; if (forecastSeries) { if (typeof forecastSeries.applyOptions === 'function') forecastSeries.applyOptions({ visible: showForecast }); else if (typeof forecastSeries.setVisible === 'function') forecastSeries.setVisible(showForecast); } if (showForecast && currentCandles.length) { const forecastValues = await updateForecastPanel(currentCandles); if (forecastValues && currentCandles.length) { const lastCandle = currentCandles[currentCandles.length-1]; const lastDate = new Date(lastCandle.time); const forecastData = []; for (let i = 1; i <= 5; i++) { const futureDate = new Date(lastDate); futureDate.setDate(lastDate.getDate() + i); forecastData.push({ time: futureDate.toISOString().split('T')[0], value: forecastValues[i-1] }); } forecastSeries.setData(forecastData); } } else { forecastSeries.setData([]); } }
function refreshChartSize() { if (!chart) return; const parent = document.getElementById('chart-parent-container'); if (parent) { const newWidth = parent.clientWidth; const newHeight = parent.clientHeight - 80; if (newWidth > 0 && newHeight > 0) { chart.resize(newWidth, newHeight); chart.timeScale().fitContent(); } } }
function showChartSpinner(show) { const spinner = document.getElementById('chart-spinner'); if (spinner) spinner.classList.toggle('hidden', !show); }
async function loadHistorical(symbol, days) { let range = '1mo'; if (days <= 1) range = '1d'; else if (days <= 7) range = '5d'; else if (days <= 31) range = '1mo'; else if (days <= 93) range = '3mo'; else if (days <= 186) range = '6mo'; else range = '1y'; const cached = getCachedCandles(symbol, days); if (cached) return cached; const yahooUrl = `${YAHOO_PROXY}symbol=${symbol}&interval=1d&range=${range}`; try { const res = await fetchWithTimeout(yahooUrl, 15000); const json = await res.json(); if (json.success && json.data && json.data.length) { let candles = json.data.slice(-days); setCachedCandles(symbol, days, candles); return candles; } throw new Error('No data from Yahoo'); } catch (err) { try { const alphaUrl = `${ALPHA_VANTAGE_PROXY}${symbol}&outputsize=compact`; const res = await fetchWithTimeout(alphaUrl, 15000); const data = await res.json(); if (data && data['Time Series (Daily)']) { const ts = data['Time Series (Daily)']; const dates = Object.keys(ts).sort().slice(-days); const candles = dates.map(date => ({ time: date, open: parseFloat(ts[date]['1. open']), high: parseFloat(ts[date]['2. high']), low: parseFloat(ts[date]['3. low']), close: parseFloat(ts[date]['4. close']), volume: parseInt(ts[date]['5. volume']) })); setCachedCandles(symbol, days, candles); return candles; } throw new Error('No Alpha Vantage data'); } catch (alphaErr) { console.warn(`Alpha Vantage failed for ${symbol}`, alphaErr); return []; } } }
async function loadChartData(symbol, days) {
    if (!candleSeries) return;
    showChartSpinner(true);
    try {
        const candles = await loadHistorical(symbol, days);
        currentCandles = candles;
        if (candles.length) {
            candleSeries.setData(candles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
            volumeSeries.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? '#00ff00' : '#ff3333' })));
            if (lineSeries && typeof lineSeries.setData === 'function') lineSeries.setData(candles.map(c => ({ time: c.time, value: c.close })));
            if (candleSeries && lineSeries) {
                if (typeof candleSeries.applyOptions === 'function') candleSeries.applyOptions({ visible: !isLineMode });
                else if (typeof candleSeries.setVisible === 'function') candleSeries.setVisible(!isLineMode);
                if (typeof lineSeries.applyOptions === 'function') lineSeries.applyOptions({ visible: isLineMode });
                else if (typeof lineSeries.setVisible === 'function') lineSeries.setVisible(isLineMode);
            }
            chart.timeScale().fitContent();
            const errorDiv = document.querySelector('#chart-container .chart-error');
            if (errorDiv) errorDiv.remove();
            updateIndicators(candles);
            try {
                const forecastValues = await updateForecastPanel(candles);
                if (showForecast && forecastValues) {
                    const lastCandle = candles[candles.length-1];
                    const lastDate = new Date(lastCandle.time);
                    const forecastData = [];
                    for (let i = 1; i <= 5; i++) {
                        const futureDate = new Date(lastDate);
                        futureDate.setDate(lastDate.getDate() + i);
                        forecastData.push({ time: futureDate.toISOString().split('T')[0], value: forecastValues[i-1] });
                    }
                    forecastSeries.setData(forecastData);
                } else {
                    forecastSeries.setData([]);
                }
            } catch (forecastErr) {
                console.warn('Forecast update failed:', forecastErr);
                forecastSeries.setData([]);
            }
        } else {
            const container = document.getElementById('chart-container');
            let errorDiv = container.querySelector('.chart-error');
            if (!errorDiv) {
                errorDiv = document.createElement('div');
                errorDiv.className = 'chart-error';
                errorDiv.innerText = `No historical data for ${symbol}. Check API keys.`;
                container.appendChild(errorDiv);
            }
            candleSeries.setData([]);
            volumeSeries.setData([]);
            if (lineSeries) lineSeries.setData([]);
            forecastSeries.setData([]);
        }
    } catch (err) {
        console.error('loadChartData error:', err);
    } finally {
        showChartSpinner(false);
    }
}

// Watchlist rendering
function showWatchlistSkeleton() {
    const container = document.getElementById('watchlist-container');
    if (!container) return;
    const skeletonHtml = `<div class="animate-pulse"><div class="h-8 bg-neutral-800 rounded mb-2"></div><div class="h-8 bg-neutral-800 rounded mb-2"></div><div class="h-8 bg-neutral-800 rounded mb-2"></div><div class="h-8 bg-neutral-800 rounded mb-2"></div><div class="h-8 bg-neutral-800 rounded"></div></div>`;
    container.innerHTML = skeletonHtml;
}
async function renderWatchlist() {
    showWatchlistSkeleton();
    const table = document.createElement('table');
    table.className = "w-full text-left text-xs font-mono";
    table.innerHTML = `<thead><tr class="text-[#a0a0a0] text-[10px] border-b border-[#282828]/40"><th class="pb-1">★</th><th class="pb-1">SYMBOL / COMPANY</th><th class="pb-1 text-right">LAST</th><th class="pb-1 text-right">NET CHG</th><th class="pb-1 text-right">% CHG</th></tr></thead><tbody id="watchlist-tbody"></tbody>`;
    const container = document.getElementById('watchlist-container');
    container.innerHTML = '';
    container.appendChild(table);
    const tbody = document.getElementById('watchlist-tbody');
    const results = await Promise.allSettled(watchlistSymbols.map(sym => loadQuote(sym)));
    for (let i = 0; i < watchlistSymbols.length; i++) {
        const sym = watchlistSymbols[i];
        const data = results[i].status === 'fulfilled' && results[i].value ? results[i].value : null;
        const priceText = data && typeof data.price === 'number' ? data.price.toFixed(2) : '--';
        const changeText = data && typeof data.change === 'number' ? (data.change >= 0 ? '+' : '') + data.change.toFixed(2) : '--';
        const pctText = data && typeof data.changePct === 'number' ? (data.changePct >= 0 ? '+' : '') + data.changePct.toFixed(2) + '%' : '--';
        const priceClass = data && data.change !== undefined ? (data.change >= 0 ? 'text-green-500' : 'text-red-500') : 'text-gray-500';
        const changeClass = data && data.change !== undefined ? (data.change >= 0 ? 'text-green-500' : 'text-red-500') : 'text-gray-500';
        const tr = document.createElement('tr');
        tr.id = `wst-row-${sym}`;
        tr.setAttribute('data-symbol', sym);
        tr.setAttribute('data-asset-type', getAssetType(sym));
        tr.className = "border-b border-[#282828]/20 hover:bg-white/5 cursor-pointer transition align-middle touch-manipulation";
        tr.onclick = (e) => { if (!e.target.closest('.favourite-star')) changeActiveSymbol(sym); };
        const company = companyNamesMap[sym] || sym;
        const star = isFavourite(sym) ? '⭐' : '☆';
        tr.innerHTML = `
            <td class="py-1.5 text-center favourite-star" onclick="event.stopPropagation(); toggleFavourite('${sym}')" style="cursor:pointer;">${star}</td>
            <td class="py-1.5 align-middle"><div class="font-bold text-white text-sm watchlist-symbol-name">${sym}</div><div class="text-[9px] text-neutral-400 watchlist-company">${company}</div></td>
            <td class="py-1.5 text-right align-middle font-bold ${priceClass}">${priceText}</td>
            <td class="py-1.5 text-right align-middle ${changeClass}">${changeText}</td>
            <td class="py-1.5 text-right align-middle font-bold ${changeClass}">${pctText}</td>
        `;
        tbody.appendChild(tr);
    }
    applyWatchlistFilters();
    if (tbody.children.length === 0) container.innerHTML = '<div class="watchlist-placeholder">No quote data – check Finnhub API key and backend.</div>';
}
function refreshAllQuotes() { quoteCache = {}; renderWatchlist(); }
function updateWatchlistRow(sym, data) {
    const row = document.getElementById(`wst-row-${sym}`);
    if (!row || !data) return;
    const cells = row.cells;
    if (cells.length >= 5) {
        cells[2].innerText = data.price.toFixed(2);
        cells[3].innerHTML = (data.change >= 0 ? '+' : '') + data.change.toFixed(2);
        cells[4].innerHTML = (data.changePct >= 0 ? '+' : '') + data.changePct.toFixed(2) + '%';
        const cls = data.change >= 0 ? 'text-green-500' : 'text-red-500';
        cells[2].className = `py-1.5 text-right align-middle font-bold ${cls}`;
        cells[3].className = `py-1.5 text-right align-middle ${cls}`;
        cells[4].className = `py-1.5 text-right align-middle font-bold ${cls}`;
    }
}
async function changeActiveSymbol(symbol) { currentSymbol = symbol; document.getElementById('stock-symbol').innerText = symbol; document.getElementById('trade-symbol').value = symbol; await loadQuote(symbol); let days = 30; if (currentInterval === '1D') days = 1; else if (currentInterval === '1W') days = 7; else if (currentInterval === '3M') days = 90; else days = 30; await loadChartData(symbol, days); updateTotalPreview(); }
function changeInterval(interval) { currentInterval = interval; ['1D','1W','1M','3M'].forEach(btn => { const el = document.getElementById(`btn-${btn}`); if (el) el.className = btn === interval ? 'px-1.5 py-0.5 bg-bbAmber text-black rounded font-bold text-[10px]' : 'px-1.5 py-0.5 bg-[#111] hover:bg-neutral-800 rounded text-[10px]'; }); let days = 30; if (interval === '1D') days = 1; else if (interval === '1W') days = 7; else if (interval === '3M') days = 90; else days = 30; loadChartData(currentSymbol, days); }

// Theme toggle
function setTheme(theme) {
    try {
        if (theme === 'light') {
            document.body.classList.add('light-theme');
            if (chart) {
                chart.applyOptions({
                    layout: {
                        background: { color: '#ffffff' },
                        textColor: '#000000'
                    },
                    grid: {
                        vertLines: { color: '#e0e0e0' },
                        horzLines: { color: '#e0e0e0' }
                    },
                    rightPriceScale: { textColor: '#000000' },
                    timeScale: { textColor: '#000000' }
                });
                const container = document.getElementById('chart-container');
                if (container && container.clientWidth > 0 && container.clientHeight > 0) {
                    chart.resize(container.clientWidth, container.clientHeight);
                }
                chart.timeScale().fitContent();
            }
            if (portfolioChart) {
                portfolioChart.options.plugins.legend.labels.color = '#000000';
                portfolioChart.options.scales.y.ticks.color = '#000000';
                portfolioChart.options.scales.x.ticks.color = '#000000';
                portfolioChart.options.scales.y.grid.color = '#dddddd';
                portfolioChart.options.scales.x.grid.color = '#dddddd';
                portfolioChart.update();
            }
            if (compositionChart) {
                compositionChart.options.plugins.legend.labels.color = '#000000';
                compositionChart.update();
            }
        } else {
            document.body.classList.remove('light-theme');
            if (chart) {
                chart.applyOptions({
                    layout: {
                        background: { color: '#000000' },
                        textColor: '#a0a0a0'
                    },
                    grid: {
                        vertLines: { color: '#1a1a1a' },
                        horzLines: { color: '#1a1a1a' }
                    },
                    rightPriceScale: { textColor: '#a0a0a0' },
                    timeScale: { textColor: '#a0a0a0' }
                });
                const container = document.getElementById('chart-container');
                if (container && container.clientWidth > 0 && container.clientHeight > 0) {
                    chart.resize(container.clientWidth, container.clientHeight);
                }
                chart.timeScale().fitContent();
            }
            if (portfolioChart) {
                portfolioChart.options.plugins.legend.labels.color = '#e2e2e2';
                portfolioChart.options.scales.y.ticks.color = '#e2e2e2';
                portfolioChart.options.scales.x.ticks.color = '#e2e2e2';
                portfolioChart.options.scales.y.grid.color = '#282828';
                portfolioChart.options.scales.x.grid.color = '#282828';
                portfolioChart.update();
            }
            if (compositionChart) {
                compositionChart.options.plugins.legend.labels.color = '#e2e2e2';
                compositionChart.update();
            }
        }
        localStorage.setItem('theme', theme);
    } catch (err) {
        console.warn('Theme toggle error:', err);
        if (theme === 'light') document.body.classList.add('light-theme');
        else document.body.classList.remove('light-theme');
    }
}
function toggleTheme() { const current = localStorage.getItem('theme') || 'dark'; setTheme(current === 'dark' ? 'light' : 'dark'); }
document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
setTheme(localStorage.getItem('theme') || 'dark');

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); executeQuickTrade('BUY'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); executeQuickTrade('SELL'); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'a') { e.preventDefault(); sellAllShares(); }
});

// Helper functions
async function fetchWithTimeout(url, timeoutMs = 20000) { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs); try { const res = await fetch(url, { signal: controller.signal }); clearTimeout(timeout); return res; } catch (err) { clearTimeout(timeout); throw err; } }
function safeString(value) { if (value === null || value === undefined) return ''; if (typeof value === 'string') return value; if (typeof value === 'object') { if (Array.isArray(value) && value.length > 0) return safeString(value[0]); if (value._) return safeString(value._); return ''; } return String(value); }
async function fetchNews() { const container = document.getElementById('news-container'); container.innerHTML = '<div class="text-gray-500 text-center py-4">Loading news...</div>'; try { const res = await fetchWithTimeout(NEWS_PROXY, 15000); const data = await res.json(); if (data.news && data.news.length) { container.innerHTML = ''; data.news.forEach(item => { const title = safeString(item.title) || 'No title'; const link = safeString(item.link) || '#'; const source = safeString(item.source) || 'Yahoo Finance'; let pubDate; try { pubDate = new Date(safeString(item.pubDate)); if (isNaN(pubDate)) throw new Error(); } catch(e) { pubDate = new Date(); } const timeAgo = getTimeAgo(pubDate); const div = document.createElement('div'); div.className = 'news-item'; div.innerHTML = `<div class="news-title"><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a></div><div class="news-meta"><span>${escapeHtml(source)}</span><span>${timeAgo}</span></div>`; container.appendChild(div); }); } else container.innerHTML = '<div class="text-gray-500 text-center py-4">No news available</div>'; } catch (err) { console.error('News fetch error:', err); container.innerHTML = '<div class="text-red-500 text-center py-4">Failed to load news</div>'; } }
function getTimeAgo(date) { const seconds = Math.floor((new Date() - date) / 1000); if (seconds < 60) return 'just now'; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes} min ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''} ago`; const days = Math.floor(hours / 24); return `${days} day${days > 1 ? 's' : ''} ago`; }
function escapeHtml(str) { if (!str) return ''; return String(str).replace(/[&<>]/g, m => m === '&' ? '&amp;' : (m === '<' ? '&lt;' : (m === '>' ? '&gt;' : m))); }
function appendCopilotMessage(sender, text, colorClass = '') { const chat = document.getElementById('copilot-chat'); const div = document.createElement('div'); div.className = `p-2 rounded ${colorClass} bg-neutral-900/50 mb-1`; div.innerHTML = `<strong class="text-bbCyan block text-[10px]">${sender}</strong><div class="whitespace-pre-wrap">${text}</div>`; chat.appendChild(div); chat.scrollTop = chat.scrollHeight; }

// Advanced AI Copilot with actions (Phase 4)
const RATE_LIMIT_COUNT = 3, RATE_LIMIT_WINDOW = 60000;
let aiTimestamps = [];
function isRateLimited() { const now = Date.now(); aiTimestamps = aiTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW); return aiTimestamps.length >= RATE_LIMIT_COUNT; }

async function sendCopilotMessage() {
    const input = document.getElementById('copilot-input');
    const prompt = input.value.trim();
    if (!prompt) return;
    if (isRateLimited()) {
        appendCopilotMessage('SYSTEM', 'Rate limit (3 queries per minute). Please wait.', 'text-red-500');
        return;
    }
    aiTimestamps.push(Date.now());
    appendCopilotMessage('YOU', prompt, 'text-bbAmber');
    input.value = '';
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
        });
        const data = await res.json();
        if (data.action) {
            const { action, symbol, qty, value, indicator } = data.action;
            switch (action) {
                case 'BUY':
                case 'SELL':
                    document.getElementById('trade-symbol').value = symbol;
                    document.getElementById('trade-qty').value = qty;
                    executeQuickTrade(action);
                    appendCopilotMessage('AI', data.text, 'text-bbCyan');
                    break;
                case 'SET_INTERVAL':
                    if (value && ['1D','1W','1M','3M'].includes(value)) {
                        changeInterval(value);
                        appendCopilotMessage('AI', `Chart interval changed to ${value}.`, 'text-bbCyan');
                    } else {
                        appendCopilotMessage('AI', 'Invalid interval. Use 1D, 1W, 1M, or 3M.', 'text-bbCyan');
                    }
                    break;
                case 'ADD_TO_WATCHLIST':
                    if (symbol && !watchlistSymbols.includes(symbol)) {
                        watchlistSymbols.push(symbol);
                        renderWatchlist();
                        appendCopilotMessage('AI', `Added ${symbol} to watchlist.`, 'text-bbCyan');
                    } else {
                        appendCopilotMessage('AI', `${symbol} already in watchlist or invalid.`, 'text-bbCyan');
                    }
                    break;
                case 'RUN_BACKTEST':
                    if (symbol && qty && indicator) {
                        const strategySymbolSelect = document.getElementById('strategy-symbol');
                        const strategyIndicatorSelect = document.getElementById('strategy-indicator');
                        const strategyQtyInput = document.getElementById('strategy-qty');
                        if (strategySymbolSelect && strategyIndicatorSelect && strategyQtyInput) {
                            strategySymbolSelect.value = symbol;
                            strategyIndicatorSelect.value = indicator;
                            strategyQtyInput.value = qty;
                            if (typeof window.runBacktest === 'function') {
                                window.runBacktest();
                                appendCopilotMessage('AI', `Running backtest for ${symbol} using ${indicator}...`, 'text-bbCyan');
                            } else {
                                appendCopilotMessage('AI', 'Backtest function not available.', 'text-red-500');
                            }
                        } else {
                            appendCopilotMessage('AI', 'Backtest UI elements missing.', 'text-red-500');
                        }
                    } else {
                        appendCopilotMessage('AI', 'Backtest requires symbol, indicator, and quantity.', 'text-red-500');
                    }
                    break;
                default:
                    appendCopilotMessage('AI', data.text, 'text-bbCyan');
            }
        } else if (data.text) {
            let html = data.text;
            const tradeMatch = html.match(/(?:buy|sell)\s+(\d+(?:\.\d+)?)\s+([A-Z.^]+)/gi);
            if (tradeMatch) {
                html += '<div class="flex flex-wrap gap-2 mt-2">';
                for (const match of tradeMatch) {
                    const parts = match.split(' ');
                    const action = parts[0].toUpperCase();
                    const qty = parseFloat(parts[1]);
                    const symbol = parts[2].toUpperCase();
                    html += `<button class="bg-bbAmber text-black px-2 py-1 rounded text-[9px] hover:bg-bbAmber/80 transition" onclick="executeAIAction('${action}', '${symbol}', ${qty})">${match}</button>`;
                }
                html += '</div>';
            }
            appendCopilotMessage('AI', html, 'text-bbCyan');
        } else {
            appendCopilotMessage('ERROR', data.error || 'No response.', 'text-red-500');
        }
    } catch (err) {
        console.error(err);
        appendCopilotMessage('ERROR', 'AI proxy error.', 'text-red-500');
    }
}

function toggleHelpModal() { document.getElementById('help-modal').classList.toggle('hidden'); }
function updateClock() { document.getElementById('terminal-clock').innerText = new Date().toUTCString().replace('GMT', 'UTC'); }
setInterval(updateClock, 1000); updateClock();

// Resizable panes
function initResizablePanes() {
    const leftPane = document.getElementById('left-pane');
    const centerPane = document.getElementById('center-pane');
    const rightPane = document.getElementById('right-pane');
    const handle1 = document.getElementById('handle1');
    const handle2 = document.getElementById('handle2');
    const grid = document.getElementById('main-resizable-grid');
    let startX = 0, startLeftWidth = 0, startCenterWidth = 0, startRightWidth = 0;
    let activeHandle = null;
    let rafId = null;
    function applyResizeAndRefresh(newLeft, newCenter, newRight) {
        leftPane.style.flex = newLeft;
        centerPane.style.flex = newCenter;
        rightPane.style.flex = newRight;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => { refreshChartSize(); rafId = null; });
    }
    function onResizeMove(clientX) {
        if (!activeHandle) return;
        const dx = clientX - startX;
        const totalFlex = startLeftWidth + startCenterWidth + startRightWidth;
        const gridWidth = grid.clientWidth;
        if (activeHandle === handle1) {
            let newLeft = startLeftWidth + dx * (totalFlex / gridWidth);
            let newCenter = startCenterWidth - dx * (totalFlex / gridWidth);
            if (newLeft >= 1.5 && newCenter >= 2) applyResizeAndRefresh(newLeft, newCenter, startRightWidth);
        } else if (activeHandle === handle2) {
            let newCenter = startCenterWidth + dx * (totalFlex / gridWidth);
            let newRight = startRightWidth - dx * (totalFlex / gridWidth);
            if (newCenter >= 2 && newRight >= 1.5) applyResizeAndRefresh(startLeftWidth, newCenter, newRight);
        }
    }
    function startResize(e, handle) {
        e.preventDefault();
        activeHandle = handle;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        startX = clientX;
        const leftFlex = parseFloat(getComputedStyle(leftPane).flex);
        const centerFlex = parseFloat(getComputedStyle(centerPane).flex);
        const rightFlex = parseFloat(getComputedStyle(rightPane).flex);
        startLeftWidth = leftFlex;
        startCenterWidth = centerFlex;
        startRightWidth = rightFlex;
        activeHandle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }
    function onMouseMove(e) { onResizeMove(e.clientX); }
    function onTouchMove(e) { onResizeMove(e.touches[0].clientX); }
    function stopResize() {
        if (!activeHandle) return;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', stopResize);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', stopResize);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        activeHandle.classList.remove('active');
        if (rafId) cancelAnimationFrame(rafId);
        refreshChartSize();
        savePanelSizes();
        activeHandle = null;
    }
    function addDragEvents(handle) {
        handle.addEventListener('mousedown', (e) => { startResize(e, handle); document.addEventListener('mousemove', onMouseMove); document.addEventListener('mouseup', stopResize); });
        handle.addEventListener('touchstart', (e) => { startResize(e, handle); document.addEventListener('touchmove', onTouchMove); document.addEventListener('touchend', stopResize); });
    }
    addDragEvents(handle1);
    addDragEvents(handle2);
}
function savePanelSizes() {
    const left = document.getElementById('left-pane')?.style.flex;
    const center = document.getElementById('center-pane')?.style.flex;
    const right = document.getElementById('right-pane')?.style.flex;
    if (left && center && right) localStorage.setItem('panel_sizes', JSON.stringify({ left, center, right }));
}
function restorePanelSizes() {
    const saved = localStorage.getItem('panel_sizes');
    if (saved) {
        try {
            const { left, center, right } = JSON.parse(saved);
            if (left) document.getElementById('left-pane').style.flex = left;
            if (center) document.getElementById('center-pane').style.flex = center;
            if (right) document.getElementById('right-pane').style.flex = right;
        } catch(e) {}
    }
}
function enableHorizontalScroll() {
    const footer = document.getElementById('footer-container');
    if (!footer) return;
    footer.addEventListener('wheel', (e) => { if (e.deltaY !== 0) { e.preventDefault(); footer.scrollLeft += e.deltaY; } });
}

// ============================================================
// PERSISTENT LAYOUT (Phase 4)
// ============================================================
function captureLayout() {
    const leftPane = document.getElementById('left-pane');
    const centerPane = document.getElementById('center-pane');
    const rightPane = document.getElementById('right-pane');
    const strategyContent = document.getElementById('strategy-content');
    const correlationContent = document.getElementById('correlation-content');
    return {
        panelSizes: {
            left: leftPane?.style.flex || '3',
            center: centerPane?.style.flex || '6',
            right: rightPane?.style.flex || '3'
        },
        collapsedModules: {
            strategy: strategyContent ? strategyContent.classList.contains('hidden') : false,
            correlation: correlationContent ? correlationContent.classList.contains('hidden') : false
        }
    };
}
function applyLayout(layout) {
    if (!layout) return;
    if (layout.panelSizes) {
        const left = document.getElementById('left-pane');
        const center = document.getElementById('center-pane');
        const right = document.getElementById('right-pane');
        if (left) left.style.flex = layout.panelSizes.left;
        if (center) center.style.flex = layout.panelSizes.center;
        if (right) right.style.flex = layout.panelSizes.right;
        setTimeout(() => refreshChartSize(), 100);
    }
    if (layout.collapsedModules) {
        const strategyContent = document.getElementById('strategy-content');
        const correlationContent = document.getElementById('correlation-content');
        if (strategyContent && layout.collapsedModules.strategy !== undefined) {
            if (layout.collapsedModules.strategy) strategyContent.classList.add('hidden');
            else strategyContent.classList.remove('hidden');
        }
        if (correlationContent && layout.collapsedModules.correlation !== undefined) {
            if (layout.collapsedModules.correlation) correlationContent.classList.add('hidden');
            else correlationContent.classList.remove('hidden');
        }
    }
}
async function saveLayoutToBackend() {
    const layout = captureLayout();
    try {
        await fetch('/api/user/layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ layout })
        });
        console.log('Layout saved');
    } catch (err) { console.warn('Failed to save layout', err); }
}
async function loadLayoutFromBackend() {
    try {
        const res = await fetch('/api/user/layout', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (data.layout) applyLayout(data.layout);
    } catch (err) { console.warn('Failed to load layout', err); }
}

// ============================================================
// PORTRAIT MODE REORDERING (includes correlation & strategy modules)
// ============================================================
function reorderMobileLayout() {
    const isPortrait = window.innerHeight > window.innerWidth;
    const terminalWorkspace = document.getElementById('terminal-workspace');
    if (!terminalWorkspace) return;
    if (isPortrait && window.innerWidth <= 768) {
        const watchlist = document.querySelector('.watchlist-module');
        const chart = document.querySelector('.chart-module');
        const trade = document.querySelector('.trade-module');
        const strategy = document.querySelector('.strategy-module');
        const portfolioLineChart = document.getElementById('portfolio-history-container');
        const portfolioPieChart = document.getElementById('portfolio-composition-container');
        const correlation = document.querySelector('.correlation-module');
        const ai = document.querySelector('.ai-module');
        const news = document.querySelector('.news-module');
        let mobileContainer = document.getElementById('mobile-portrait-container');
        if (!mobileContainer) {
            mobileContainer = document.createElement('div');
            mobileContainer.id = 'mobile-portrait-container';
            mobileContainer.style.display = 'flex';
            mobileContainer.style.flexDirection = 'column';
            mobileContainer.style.gap = '1rem';
            mobileContainer.style.padding = '1rem';
            const grid = document.getElementById('main-resizable-grid');
            grid.parentNode.insertBefore(mobileContainer, grid);
        }
        // Append modules in desired order
        if (watchlist && watchlist.parentNode !== mobileContainer) mobileContainer.appendChild(watchlist);
        if (chart && chart.parentNode !== mobileContainer) mobileContainer.appendChild(chart);
        if (trade && trade.parentNode !== mobileContainer) mobileContainer.appendChild(trade);
        if (strategy && strategy.parentNode !== mobileContainer) mobileContainer.appendChild(strategy);
        if (correlation && correlation.parentNode !== mobileContainer) mobileContainer.appendChild(correlation);
        if (portfolioLineChart && portfolioLineChart.parentNode !== mobileContainer) mobileContainer.appendChild(portfolioLineChart);
        if (portfolioPieChart && portfolioPieChart.parentNode !== mobileContainer) mobileContainer.appendChild(portfolioPieChart);
        if (ai && ai.parentNode !== mobileContainer) mobileContainer.appendChild(ai);
        if (news && news.parentNode !== mobileContainer) mobileContainer.appendChild(news);
        const grid = document.getElementById('main-resizable-grid');
        if (grid) grid.style.display = 'none';
        if (mobileContainer) mobileContainer.style.display = 'flex';
    } else {
        const mobileContainer = document.getElementById('mobile-portrait-container');
        if (mobileContainer) {
            const watchlist = document.querySelector('.watchlist-module');
            const chart = document.querySelector('.chart-module');
            const trade = document.querySelector('.trade-module');
            const strategy = document.querySelector('.strategy-module');
            const portfolioLineChart = document.getElementById('portfolio-history-container');
            const portfolioPieChart = document.getElementById('portfolio-composition-container');
            const correlation = document.querySelector('.correlation-module');
            const ai = document.querySelector('.ai-module');
            const news = document.querySelector('.news-module');
            const leftPane = document.getElementById('left-pane');
            const centerPane = document.getElementById('center-pane');
            const rightPane = document.getElementById('right-pane');
            const leftContent = leftPane?.querySelector('.pane-content');
            const centerContent = centerPane?.querySelector('.pane-content');
            const rightContent = rightPane?.querySelector('.pane-content');
            if (watchlist && leftContent && watchlist.parentNode !== leftContent) leftContent.insertBefore(watchlist, leftContent.firstChild);
            if (chart && centerContent) centerContent.insertBefore(chart, centerContent.firstChild);
            if (trade && leftContent) leftContent.appendChild(trade);
            if (strategy && leftContent && strategy.parentNode !== leftContent) leftContent.appendChild(strategy);
            if (correlation && rightContent && correlation.parentNode !== rightContent) rightContent.insertBefore(correlation, rightContent.firstChild);
            if (portfolioLineChart && rightContent && portfolioLineChart.parentNode !== rightContent) rightContent.insertBefore(portfolioLineChart, correlation ? correlation.nextSibling : rightContent.firstChild);
            if (portfolioPieChart && rightContent && portfolioPieChart.parentNode !== rightContent) rightContent.insertBefore(portfolioPieChart, portfolioLineChart?.nextSibling || rightContent.firstChild);
            if (ai && rightContent) rightContent.insertBefore(ai, portfolioPieChart?.nextSibling || rightContent.firstChild);
            if (news && rightContent) rightContent.appendChild(news);
            mobileContainer.remove();
        }
        const grid = document.getElementById('main-resizable-grid');
        if (grid) grid.style.display = 'flex';
    }
}

// ============================================================
// INITIALISE TERMINAL
// ============================================================
async function initTerminal() {
    restorePanelSizes();
    await loadLayoutFromBackend();  // Phase 4: load saved workspace
    initChart();
    await renderWatchlist();
    await changeActiveSymbol('AAPL');
    const holdingsSymbols = Object.keys(portfolio.holdings);
    if (holdingsSymbols.length > 0) await Promise.all(holdingsSymbols.map(sym => loadQuote(sym)));
    await savePortfolioValueSnapshot();
    connectWebSocket();
    setInterval(() => updatePortfolioDisplay(), 3000);
    fetchNews();
    setInterval(fetchNews, 120000);
    setInterval(() => savePortfolioValueSnapshot(), 3600000);
    document.getElementById('terminal-mode-badge').innerText = 'LIVE DATA';
    document.getElementById('trade-history-btn').onclick = showTradeHistoryModal;
    document.getElementById('leaderboard-btn')?.addEventListener('click', showLeaderboard);
    document.getElementById('asset-filter')?.addEventListener('change', applyWatchlistFilters);
    document.getElementById('refresh-quotes-btn')?.addEventListener('click', refreshAllQuotes);
    document.getElementById('refresh-correlation')?.addEventListener('click', () => updateCorrelationMatrix());
    setTimeout(() => updateCorrelationMatrix(), 5000);
    setInterval(() => updateCorrelationMatrix(), 60000);
    document.getElementById('portfolio-range-1w')?.addEventListener('click', () => setPortfolioHistoryRange('1W'));
    document.getElementById('portfolio-range-1m')?.addEventListener('click', () => setPortfolioHistoryRange('1M'));
document.getElementById('asset-search-input')?.addEventListener('input', updatePortfolioAssetsList);
updatePortfolioAssetsList();
    document.getElementById('portfolio-range-3m')?.addEventListener('click', () => setPortfolioHistoryRange('3M'));
    document.getElementById('forecast-model')?.addEventListener('change', async () => {
        if (currentCandles.length) {
            try {
                const forecastValues = await updateForecastPanel(currentCandles);
                if (showForecast && forecastValues) {
                    const lastCandle = currentCandles[currentCandles.length-1];
                    const lastDate = new Date(lastCandle.time);
                    const forecastData = [];
                    for (let i = 1; i <= 5; i++) {
                        const futureDate = new Date(lastDate);
                        futureDate.setDate(lastDate.getDate() + i);
                        forecastData.push({ time: futureDate.toISOString().split('T')[0], value: forecastValues[i-1] });
                    }
                    forecastSeries.setData(forecastData);
                } else forecastSeries.setData([]);
            } catch (err) { console.warn('Forecast model change error:', err); forecastSeries.setData([]); }
        }
    });
    if (window.innerWidth >= 769) initResizablePanes();
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 769 && !document.getElementById('handle1').hasListener) initResizablePanes();
        refreshChartSize();
        if (portfolioChart) setTimeout(() => updatePortfolioChart(), 100);
        reorderMobileLayout(); // re-run layout on resize
    });
    enableHorizontalScroll();
    document.getElementById('apply-filter')?.addEventListener('click', applyWatchlistFilters);
    document.getElementById('favourite-filter')?.addEventListener('change', applyWatchlistFilters);
    document.getElementById('search-input')?.addEventListener('input', applyWatchlistFilters);
    
    // Portfolio chart resize observer with debounce
    const portfolioContainer = document.getElementById('portfolio-history-container');
    let portfolioChartResizeTimeout;
    if (portfolioContainer && window.ResizeObserver) {
        new ResizeObserver(() => {
            if (portfolioChartResizeTimeout) clearTimeout(portfolioChartResizeTimeout);
            portfolioChartResizeTimeout = setTimeout(() => {
                if (portfolioChart) portfolioChart.resize();
            }, 100);
        }).observe(portfolioContainer);
    }
    
    reorderMobileLayout();
    updatePortfolioComposition(0, true);
    setTimeout(() => updatePortfolioComposition(0, true), 3000);
    setTimeout(() => updatePortfolioComposition(0, true), 6000);
    const tradeQtyInput = document.getElementById('trade-qty');
    if (tradeQtyInput) tradeQtyInput.addEventListener('input', updateTotalPreview);
    const tradeSymbolInput = document.getElementById('trade-symbol');
    if (tradeSymbolInput) tradeSymbolInput.addEventListener('change', updateTotalPreview);
    updateTotalPreview();
    if (typeof initBacktester === 'function') initBacktester();
    // Save workspace button
    const saveWsBtn = document.getElementById('save-workspace-btn');
    if (saveWsBtn) saveWsBtn.addEventListener('click', saveLayoutToBackend);
}

// ============================================================
// LEADERBOARD & CORRELATION MATRIX (keep existing implementations)
// ============================================================
async function showLeaderboard() {
    const modal = document.getElementById('leaderboard-modal');
    const listContainer = document.getElementById('leaderboard-list');
    if (!modal || !listContainer) return;
    listContainer.innerHTML = '<div class="text-center py-4 text-gray-400">Loading leaderboard...</div>';
    modal.classList.remove('hidden');
    try {
        const res = await fetch('/api/leaderboard', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (!data.leaderboard.length) { listContainer.innerHTML = '<div class="text-center py-4 text-gray-400">No other users yet.</div>'; return; }
        let html = '<div class="overflow-x-auto"><table class="w-full text-sm border-collapse"><thead><tr class="border-b border-gray-600"><th class="text-left py-2 px-3 text-bbAmber">#</th><th class="text-left py-2 px-3 text-bbAmber">User</th><th class="text-right py-2 px-3 text-bbAmber">Portfolio Value</th><th class="text-right py-2 px-3 text-bbAmber">24h Change</th></tr></thead><tbody>';
        data.leaderboard.forEach((user, idx) => {
            const changeClass = user.dayChange >= 0 ? 'text-green-500' : 'text-red-500';
            const changeSign = user.dayChange >= 0 ? '+' : '';
            html += `<tr class="border-b border-gray-700 hover:bg-gray-800/30"><td class="py-2 px-3 align-middle">${idx + 1}<tr><td class="py-2 px-3 align-middle font-medium">${escapeHtml(user.username)}</td><td class="py-2 px-3 text-right font-mono align-middle">$${user.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td class="py-2 px-3 text-right font-mono ${changeClass} align-middle">${changeSign}$${user.dayChange.toFixed(2)} (${changeSign}${user.dayChangePct.toFixed(2)}%)</td></tr>`;
        });
        html += '</tbody></table></div>';
        listContainer.innerHTML = html;
    } catch (err) { listContainer.innerHTML = '<div class="text-red-500 text-center py-4">Failed to load leaderboard.</div>'; }
}
function closeLeaderboardModal() { document.getElementById('leaderboard-modal')?.classList.add('hidden'); }

async function getTopHoldingsSymbols(limit = 5) {
    const holdings = Object.entries(portfolio.holdings).map(([sym, h]) => ({ sym, value: h.qty * (priceCache[sym]?.price || 0) })).sort((a,b) => b.value - a.value).slice(0, limit).map(item => item.sym);
    if (!holdings.includes('^GSPC')) holdings.push('^GSPC');
    return holdings;
}
async function fetchHistoricalCloses(symbol, days = 30) {
    const candles = await loadHistorical(symbol, days);
    if (!candles || !candles.length) return [];
    return candles.map(c => c.close);
}
function pearsonCorrelation(x, y) {
    const n = x.length;
    if (n !== y.length || n === 0) return 0;
    const sumX = x.reduce((a,b) => a + b, 0);
    const sumY = y.reduce((a,b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);
    const sumY2 = y.reduce((sum, yi) => sum + yi * yi, 0);
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return denominator === 0 ? 0 : numerator / denominator;
}
async function updateCorrelationMatrix() {
    const container = document.getElementById('correlation-content');
    if (!container) return;
    container.innerHTML = '<div class="text-center text-[10px] text-gray-400 py-2">Loading correlation data...</div>';
    try {
        const symbols = await getTopHoldingsSymbols(5);
        const closesMap = new Map();
        for (const sym of symbols) {
            const closes = await fetchHistoricalCloses(sym, 30);
            if (closes.length < 10) { container.innerHTML = `<div class="text-red-500 text-[10px]">Insufficient data for ${sym}</div>`; return; }
            closesMap.set(sym, closes);
        }
        const n = symbols.length;
        const matrix = Array(n).fill().map(() => Array(n).fill(0));
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) matrix[i][j] = pearsonCorrelation(closesMap.get(symbols[i]), closesMap.get(symbols[j]));
        let html = '<div class="overflow-x-auto"><table class="w-full text-[10px] border-collapse"><thead><tr><th class="p-1"></th>';
        for (let j = 0; j < n; j++) html += `<th class="p-1 font-bold text-bbAmber">${symbols[j]}</th>`;
        html += '</tr></thead><tbody>';
        for (let i = 0; i < n; i++) {
            html += `<tr><td class="p-1 font-bold text-bbAmber">${symbols[i]}</td>`;
            for (let j = 0; j < n; j++) {
                const corr = matrix[i][j];
                // Pure red-green spectrum (no blue)
const intensity = (corr + 1) / 2; // 0 = red, 1 = green
const red = Math.floor(255 * (1 - intensity));
const green = Math.floor(255 * intensity);
const blue = 0; // Remove blue entirely
const color = `rgb(${red}, ${green}, ${blue})`;
// Choose text color for contrast: white on dark backgrounds, black on light backgrounds
const brightness = (red * 0.299 + green * 0.587 + blue * 0.114);
const textColor = brightness > 140 ? '#000000' : '#ffffff';
html += `<td class="p-1 text-center" style="background-color: ${color}; color: ${textColor}">${corr.toFixed(2)}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        container.innerHTML = html;
    } catch (err) { console.error('Correlation error:', err); container.innerHTML = '<div class="text-red-500 text-[10px]">Failed to compute correlations</div>'; }
}

// ============================================================
// PORTFOLIO ASSETS MODULE (with search)
// ============================================================
function updatePortfolioAssetsList() {
    const container = document.getElementById('portfolio-assets-list');
    if (!container) return;
    const searchTerm = document.getElementById('asset-search-input')?.value.toLowerCase() || '';
    const holdings = Object.entries(portfolio.holdings);
    if (holdings.length === 0) {
        container.innerHTML = '<div class="text-gray-500 text-center">No holdings yet. Buy some shares!</div>';
        return;
    }
    let html = '';
    for (const [sym, h] of holdings) {
        if (searchTerm && !sym.toLowerCase().includes(searchTerm)) continue;
        const price = priceCache[sym]?.price || 0;
        const value = h.qty * price;
        const dailyPnl = (price - (priceCache[sym]?.prevClose || price)) * h.qty;
        html += `<div class="flex justify-between items-center border-b border-[#282828]/30 py-1 hover:bg-white/5 cursor-pointer" onclick="changeActiveSymbol('${sym}')">
            <div><span class="font-bold text-bbAmber">${sym}</span><span class="text-[8px] text-gray-400 ml-1">${h.qty.toFixed(4)} shrs</span></div>
            <div class="text-right">
                <div class="${dailyPnl >= 0 ? 'text-green-500' : 'text-red-500'}">$${value.toFixed(2)}</div>
                <div class="text-[8px] ${dailyPnl >= 0 ? 'text-green-500' : 'text-red-500'}">${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)}</div>
            </div>
        </div>`;
    }
    if (html === '') html = '<div class="text-gray-500 text-center">No matching assets</div>';
    container.innerHTML = html;
}

// ============================================================
// PROFILE MODAL & ACCOUNT MANAGEMENT
// ============================================================
async function showProfileModal() {
    document.getElementById('profile-username').innerText = currentUser;
    document.getElementById('profile-modal').classList.remove('hidden');
}
function closeProfileModal() {
    document.getElementById('profile-modal').classList.add('hidden');
}

document.getElementById('profile-btn')?.addEventListener('click', showProfileModal);
document.getElementById('change-username-btn')?.addEventListener('click', async () => {
    const newUsername = document.getElementById('new-username').value.trim();
    if (!newUsername) { alert('Please enter a new username'); return; }
    try {
        const res = await fetch('/api/user/change-username', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ newUsername })
        });
        const data = await res.json();
        if (res.ok) {
            alert('Username changed. Please log in again.');
            document.getElementById('logout-btn').click();
        } else {
            alert(data.error || 'Failed to change username');
        }
    } catch (err) { alert('Error: ' + err.message); }
});

document.getElementById('change-password-btn')?.addEventListener('click', async () => {
    const current = document.getElementById('current-password').value;
    const newPwd = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    if (!current || !newPwd) { alert('Please fill in all password fields'); return; }
    if (newPwd !== confirm) { alert('New passwords do not match'); return; }
    try {
        const res = await fetch('/api/user/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ currentPassword: current, newPassword: newPwd })
        });
        const data = await res.json();
        if (res.ok) {
            alert('Password changed. Please log in again.');
            document.getElementById('logout-btn').click();
        } else {
            alert(data.error || 'Failed to change password');
        }
    } catch (err) { alert('Error: ' + err.message); }
});

document.getElementById('delete-account-btn')?.addEventListener('click', async () => {
    if (!confirm('WARNING: This will permanently delete your account and all data. Are you sure?')) return;
    try {
        const res = await fetch('/api/user/delete', {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await res.json();
        if (res.ok) {
            alert('Account deleted. Goodbye.');
            document.getElementById('logout-btn').click();
        } else {
            alert(data.error || 'Failed to delete account');
        }
    } catch (err) { alert('Error: ' + err.message); }
});

// Update portfolio composition legend
function updateCompositionLegend() {
    const legendContainer = document.getElementById('composition-legend');
    if (!legendContainer || !compositionChart) return;
    const labels = compositionChart.data.labels;
    const colors = compositionChart.data.datasets[0].backgroundColor;
    const data = compositionChart.data.datasets[0].data;
    const total = data.reduce((a,b) => a + b, 0);
    let html = '';
    for (let i = 0; i < labels.length; i++) {
        const percentage = ((data[i] / total) * 100).toFixed(1);
        html += `<div class="flex items-center gap-2">
            <div style="width: 10px; height: 10px; background-color: ${colors[i]}; border-radius: 2px;"></div>
            <span class="font-mono">${labels[i]}</span>
            <span class="ml-auto">${percentage}%</span>
        </div>`;
    }
    legendContainer.innerHTML = html;
}

// Override updatePortfolioComposition to also update legend
const originalUpdateComposition = updatePortfolioComposition;
updatePortfolioComposition = function(retry, force) {
    originalUpdateComposition(retry, force);
    setTimeout(() => updateCompositionLegend(), 100);
};

// Also update portfolio assets list when portfolio changes
const originalUpdateDisplay = window.updatePortfolioDisplay;
window.updatePortfolioDisplay = function() {
    originalUpdateDisplay();
    updatePortfolioAssetsList();
};

// Expose necessary functions globally
window.changeActiveSymbol = changeActiveSymbol;
window.executeAIAction = executeAIAction;
window.toggleStrategyBuilder = toggleStrategyBuilder;
// window.runBacktest = runBacktest; // REMOVED - defined in backtester.js
window.toggleCorrelation = toggleCorrelation;
window.toggleHelpModal = toggleHelpModal;
window.closeLeaderboardModal = closeLeaderboardModal;
window.closeTradeHistoryModal = closeTradeHistoryModal;
window.fetchNews = fetchNews;