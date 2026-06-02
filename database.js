const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) console.error('❌ MONGODB_URI not defined');

let client = null;
let db = null;

async function connectDb() {
    if (db) return db;
    if (!uri) return null;
    try {
        client = new MongoClient(uri, {
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
        });
        await client.connect();
        db = client.db('financial_terminal');
        await db.collection('users').createIndex({ username: 1 }, { unique: true });
        await db.collection('trade_history').createIndex({ username: 1, timestamp: -1 });
        await db.collection('portfolio_history').createIndex({ username: 1, timestamp: 1 });
        console.log('✅ MongoDB connected');
        return db;
    } catch (err) {
        console.error('❌ MongoDB connection error:', err.message);
        return null;
    }
}

// ---------- Users ----------
async function getUsers() {
    const database = await connectDb();
    if (!database) return [];
    return await database.collection('users').find({}).toArray();
}

async function saveUser(user) {
    const database = await connectDb();
    if (!database) return false;
    try {
        await database.collection('users').insertOne(user);
        return true;
    } catch (err) { return false; }
}

async function updateUserPortfolio(username, portfolio) {
    const database = await connectDb();
    if (!database) return false;
    try {
        const result = await database.collection('users').updateOne(
            { username: username.toLowerCase() },
            { $set: { portfolio } }
        );
        return result.modifiedCount > 0;
    } catch (err) { return false; }
}

// ---------- Trade History ----------
async function getTradeHistory(username, limit = 100) {
    const database = await connectDb();
    if (!database) return [];
    return await database.collection('trade_history')
        .find({ username: username.toLowerCase() })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();
}

async function saveTradeHistory(username, trades) {
    const database = await connectDb();
    if (!database) return false;
    try {
        for (const trade of trades) {
            await database.collection('trade_history').updateOne(
                { id: trade.id, username: username.toLowerCase() },
                { $set: { ...trade, username: username.toLowerCase() } },
                { upsert: true }
            );
        }
        return true;
    } catch (err) { return false; }
}

// ---------- Portfolio Value History ----------
async function getPortfolioHistory(username) {
    const database = await connectDb();
    if (!database) return [];
    return await database.collection('portfolio_history')
        .find({ username: username.toLowerCase() })
        .sort({ timestamp: 1 })
        .toArray();
}

async function savePortfolioHistory(username, timestamp, totalValue) {
    const database = await connectDb();
    if (!database) return false;
    try {
        await database.collection('portfolio_history').updateOne(
            { username: username.toLowerCase(), timestamp },
            { $set: { totalValue } },
            { upsert: true }
        );
        return true;
    } catch (err) { return false; }
}

module.exports = {
    connectDb,
    getUsers,
    saveUser,
    updateUserPortfolio,
    getTradeHistory,
    saveTradeHistory,
    getPortfolioHistory,
    savePortfolioHistory
};