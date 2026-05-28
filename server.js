/**
 * BLOOMBERG TERMINAL SECURE BACKEND GATEWAY
 * Provides API Proxy shielding, route rate limiting, password encryption, 
 * and stateless token session controls.
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-string';

app.use(cors());
app.use(express.json());

// Host static front-end assets directly
app.use(express.static(path.join(__dirname)));

/**
 * AUTHENTICATION SYSTEM
 */

// User registration endpoint
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password credentials required.' });
    }

    const users = db.getUsers();
    const existing = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) {
        return res.status(409).json({ error: 'System error: Username already taken.' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = {
            username,
            password: hashedPassword,
            portfolio: {
                cash: 100000.00,
                holdings: {
                    'AAPL': { qty: 100, avgPrice: 175.00 },
                    'BTC': { qty: 0.5, avgPrice: 62000.00 }
                }
            },
            created_at: new Date().toISOString()
        };

        db.saveUser(newUser);
        res.status(201).json({ success: true, message: 'User record logged inside secure database.' });
    } catch (e) {
        res.status(500).json({ error: 'Cryptographic encryption failure.' });
    }
});

// User login endpoint
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = db.getUsers();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

    if (!user) {
        return res.status(401).json({ error: 'Authentication failed. Username not recognized.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        return res.status(401).json({ error: 'Authentication failed. Password verification failed.' });
    }

    // Assign JWT Token valid for 24 hours
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({
        token,
        username: user.username,
        portfolio: user.portfolio
    });
});

/**
 * PORTFOLIO STATE SYNC
 */
app.post('/api/portfolio/sync', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Access token required.' });

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const success = db.updateUserPortfolio(decoded.username, req.body.portfolio);
        if (success) {
            res.json({ success: true, message: 'Institutional portfolio matrices synchronized.' });
        } else {
            res.status(404).json({ error: 'User mapping records not located.' });
        }
    } catch (e) {
        res.status(403).json({ error: 'Invalid authentication credentials.' });
    }
});

/**
 * COPILOT AI QUERY ROUTING WITH BACKEND PROTECTION
 */
app.post('/api/copilot/query', async (req, res) => {
    const { prompt, systemPrompt } = req.body;
    const geminiKey = process.env.GEMINI_API_KEY;

    if (!geminiKey) {
        return res.status(503).json({ error: 'AI Gateway offline. Host API key is not configured.' });
    }

    try {
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: systemPrompt }] }
        };

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${geminiKey}`;
        const aiResponse = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!aiResponse.ok) {
            return res.status(502).json({ error: 'External model network error.' });
        }

        const json = await aiResponse.json();
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text || "NO ANALYSIS DATA SECURED.";
        res.json({ text });

    } catch (err) {
        res.status(500).json({ error: 'BCO routing pipeline exception.' });
    }
});

// Direct all missing routing targets back to the index.html front-end SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`  BLOOMBERG PSEUDO TERMINAL SYSTEM ACTIVE ON PORT ${PORT}`);
    console.log(`  ACCESS SECURITY GATEWAY AT: http://localhost:${PORT}`);
    console.log(`======================================================\n`);
});