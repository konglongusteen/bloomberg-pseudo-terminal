// ============================================================
// BACKTESTER MODULE (No-Code Strategy Builder)
// ============================================================

let backtestStrategies = JSON.parse(localStorage.getItem('backtest_strategies')) || [];

// Populate symbol dropdown with watchlist symbols
function updateStrategySymbols() {
    const select = document.getElementById('strategy-symbol');
    if (!select) return;
    select.innerHTML = '';
    watchlistSymbols.forEach(sym => {
        const option = document.createElement('option');
        option.value = sym;
        option.textContent = `${sym} - ${companyNamesMap[sym] || sym}`;
        select.appendChild(option);
    });
    select.value = currentSymbol || 'AAPL';
}

// Core backtesting engine
async function runBacktest() {
    const symbol = document.getElementById('strategy-symbol').value;
    const indicator = document.getElementById('strategy-indicator').value;
    const qty = parseFloat(document.getElementById('strategy-qty').value);
    const resultsDiv = document.getElementById('backtest-results');
    const metricsDiv = document.getElementById('bt-metrics');
    const tradesDiv = document.getElementById('bt-trades');

    if (!symbol || isNaN(qty) || qty <= 0) {
        alert('Invalid symbol or quantity');
        return;
    }

    resultsDiv.classList.remove('hidden');
    metricsDiv.innerHTML = '<div class="text-gray-400">Loading historical data...</div>';
    tradesDiv.innerHTML = '';

    // Fetch 6 months of daily data
    const candles = await loadHistorical(symbol, 180);
    if (!candles || candles.length < 50) {
        metricsDiv.innerHTML = '<div class="text-red-500">Insufficient historical data</div>';
        return;
    }

    const closes = candles.map(c => c.close);
    const dates = candles.map(c => c.time);
    const positions = []; // { date, action, price, qty, pnl }
    let inPosition = false;
    let entryPrice = 0;
    let entryDate = '';
    let totalPnl = 0;
    let wins = 0, losses = 0;

    // Helper indicators
    function calcSMA(prices, period) {
        const sma = [];
        for (let i = period - 1; i < prices.length; i++) {
            const sum = prices.slice(i - period + 1, i + 1).reduce((a,b) => a + b, 0);
            sma.push(sum / period);
        }
        return sma;
    }

    function calcRSI(prices, period = 14) {
        const rsi = [];
        for (let i = period; i < prices.length; i++) {
            let gains = 0, losses = 0;
            for (let j = i - period + 1; j <= i; j++) {
                const diff = prices[j] - prices[j-1];
                if (diff >= 0) gains += diff;
                else losses -= diff;
            }
            const avgGain = gains / period;
            const avgLoss = losses / period;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            const rsiVal = 100 - (100 / (1 + rs));
            rsi.push(rsiVal);
        }
        return rsi;
    }

    function calcBB(prices, period = 20, stdDev = 2) {
        const upper = [], lower = [], middle = [];
        for (let i = period - 1; i < prices.length; i++) {
            const slice = prices.slice(i - period + 1, i + 1);
            const mean = slice.reduce((a,b) => a + b, 0) / period;
            const variance = slice.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / period;
            const std = Math.sqrt(variance);
            upper.push(mean + stdDev * std);
            lower.push(mean - stdDev * std);
            middle.push(mean);
        }
        return { upper, lower, middle };
    }

    // Strategy evaluation loop
    if (indicator === 'sma_cross') {
        const sma20 = calcSMA(closes, 20);
        const sma50 = calcSMA(closes, 50);
        // Align indices (SMA arrays start at index period-1)
        const startIdx = 49; // 50 - 1
        for (let i = startIdx; i < closes.length - 1; i++) {
            const sma20now = sma20[i - 19]; // offset: i - (20-1)
            const sma50now = sma50[i - 49];
            const sma20next = sma20[i - 18];
            const sma50next = sma50[i - 48];
            const price = closes[i];
            const nextPrice = closes[i+1];
            const date = dates[i];
            
            if (!inPosition && sma20now > sma50now && sma20next <= sma50next) {
                // BUY signal
                inPosition = true;
                entryPrice = price;
                entryDate = date;
                positions.push({ date, action: 'BUY', price, qty, pnl: null });
            } else if (inPosition && sma20now < sma50now && sma20next >= sma50next) {
                // SELL signal
                const pnl = (price - entryPrice) * qty;
                totalPnl += pnl;
                if (pnl > 0) wins++; else if (pnl < 0) losses++;
                positions.push({ date, action: 'SELL', price, qty, pnl });
                inPosition = false;
                entryPrice = 0;
            }
        }
        // Close any open position at last price
        if (inPosition) {
            const lastPrice = closes[closes.length-1];
            const pnl = (lastPrice - entryPrice) * qty;
            totalPnl += pnl;
            if (pnl > 0) wins++; else if (pnl < 0) losses++;
            positions.push({ date: dates[dates.length-1], action: 'SELL (close)', price: lastPrice, qty, pnl });
        }
    } 
    else if (indicator === 'rsi') {
        const rsi = calcRSI(closes, 14);
        const startIdx = 14;
        for (let i = startIdx; i < closes.length - 1; i++) {
            const rsiVal = rsi[i - 14];
            const price = closes[i];
            const date = dates[i];
            if (!inPosition && rsiVal < 30) {
                inPosition = true;
                entryPrice = price;
                entryDate = date;
                positions.push({ date, action: 'BUY', price, qty, pnl: null });
            } else if (inPosition && rsiVal > 70) {
                const pnl = (price - entryPrice) * qty;
                totalPnl += pnl;
                if (pnl > 0) wins++; else if (pnl < 0) losses++;
                positions.push({ date, action: 'SELL', price, qty, pnl });
                inPosition = false;
            }
        }
        if (inPosition) {
            const lastPrice = closes[closes.length-1];
            const pnl = (lastPrice - entryPrice) * qty;
            totalPnl += pnl;
            if (pnl > 0) wins++; else if (pnl < 0) losses++;
            positions.push({ date: dates[dates.length-1], action: 'SELL (close)', price: lastPrice, qty, pnl });
        }
    }
    else if (indicator === 'bb') {
        const { upper, lower } = calcBB(closes, 20, 2);
        const startIdx = 19;
        for (let i = startIdx; i < closes.length - 1; i++) {
            const price = closes[i];
            const upperVal = upper[i - 19];
            const lowerVal = lower[i - 19];
            const date = dates[i];
            if (!inPosition && price < lowerVal) {
                inPosition = true;
                entryPrice = price;
                entryDate = date;
                positions.push({ date, action: 'BUY', price, qty, pnl: null });
            } else if (inPosition && price > upperVal) {
                const pnl = (price - entryPrice) * qty;
                totalPnl += pnl;
                if (pnl > 0) wins++; else if (pnl < 0) losses++;
                positions.push({ date, action: 'SELL', price, qty, pnl });
                inPosition = false;
            }
        }
        if (inPosition) {
            const lastPrice = closes[closes.length-1];
            const pnl = (lastPrice - entryPrice) * qty;
            totalPnl += pnl;
            if (pnl > 0) wins++; else if (pnl < 0) losses++;
            positions.push({ date: dates[dates.length-1], action: 'SELL (close)', price: lastPrice, qty, pnl });
        }
    }

    // Calculate metrics
    const totalTrades = positions.filter(p => p.action.startsWith('SELL')).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    
    // Calculate max drawdown from equity curve
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (let i = 0; i < positions.length; i++) {
        if (positions[i].action === 'BUY') {
            equity -= positions[i].price * positions[i].qty;
        } else if (positions[i].action.startsWith('SELL')) {
            equity += positions[i].price * positions[i].qty;
        }
        if (equity > peak) peak = equity;
        const drawdown = peak - equity;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    metricsDiv.innerHTML = `
        <div>Total P&L: <span class="${totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}">$${totalPnl.toFixed(2)}</span></div>
        <div>Total Trades: ${totalTrades}</div>
        <div>Win Rate: ${winRate.toFixed(1)}%</div>
        <div>Avg P&L per Trade: $${avgPnl.toFixed(2)}</div>
        <div>Max Drawdown: $${maxDrawdown.toFixed(2)}</div>
    `;

    if (positions.length) {
        tradesDiv.innerHTML = '<div class="font-bold mt-2">Trade Log:</div>' + 
            positions.map(p => `<div class="text-[9px] border-b border-[#282828]/30 py-1">${p.date} ${p.action} ${p.qty} @ $${p.price.toFixed(2)} ${p.pnl !== null ? `(P&L: $${p.pnl.toFixed(2)})` : ''}</div>`).join('');
    } else {
        tradesDiv.innerHTML = '<div class="text-gray-500 mt-2">No trades generated.</div>';
    }
}

// Collapse function
function toggleStrategyBuilder() {
    const content = document.getElementById('strategy-content');
    if (content) content.classList.toggle('hidden');
}

// Initialization (called from initTerminal later)
function initBacktester() {
    updateStrategySymbols();
    document.getElementById('run-backtest')?.addEventListener('click', runBacktest);
    // Watch for symbol changes in the main terminal to update dropdown
    const originalChangeActiveSymbol = window.changeActiveSymbol;
    if (originalChangeActiveSymbol) {
        window.changeActiveSymbol = async function(symbol) {
            await originalChangeActiveSymbol(symbol);
            const select = document.getElementById('strategy-symbol');
            if (select) select.value = symbol;
        };
    }
}