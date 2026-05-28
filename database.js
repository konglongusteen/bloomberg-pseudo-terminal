/**
 * LOCAL DATABASE MANAGER
 * To ensure zero-configuration setup for cloning developers, we utilize a 
 * robust file-based database. User credentials, password hashes, and profiles
 * are safely written to a persistent JSON-file backup locally.
 */
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'user_database.json');

// Initialize local JSON flat-file database if missing
function initDb() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ users: [] }, null, 2));
    }
}

function readData() {
    initDb();
    try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch (e) {
        return { users: [] };
    }
}

function writeData(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = {
    getUsers: () => readData().users,
    saveUser: (user) => {
        const db = readData();
        db.users.push(user);
        writeData(db);
    },
    updateUserPortfolio: (username, portfolio) => {
        const db = readData();
        const idx = db.users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
        if (idx !== -1) {
            db.users[idx].portfolio = portfolio;
            writeData(db);
            return true;
        }
        return false;
    }
};