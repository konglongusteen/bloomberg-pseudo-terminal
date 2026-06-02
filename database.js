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
            serverSelectionTimeoutMS: 15000, // 15 seconds
            connectTimeoutMS: 15000,
        });
        await client.connect();
        db = client.db('financial_terminal');
        await db.collection('users').createIndex({ username: 1 }, { unique: true });
        console.log('✅ MongoDB connected');
        return db;
    } catch (err) {
        console.error('❌ MongoDB connection error:', err.message);
        // If SRV fails, try a fallback by constructing a direct connection string (requires manual fix)
        if (err.message.includes('querySrv') && uri.includes('mongodb+srv')) {
            console.warn('⚠️ SRV lookup failed – check your network or use a non‑SRV connection string.');
            console.warn('   Replace MONGODB_URI in .env with the standard format:');
            console.warn('   mongodb://<user>:<pass>@cluster0.xxxxx.mongodb.net:27017/?retryWrites=true&w=majority');
        }
        return null;
    }
}

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

module.exports = { getUsers, saveUser, updateUserPortfolio };