// =========================
// IMPORTS
// =========================

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Ensure uploads directory exists
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

// =========================
// SQLITE CONNECTION
// =========================

const db = new Database('./stakewin.db');
console.log('SQLITE CONNECTED');

// =========================
// SQLITE TABLES
// =========================

db.exec(`
CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT UNIQUE,
password TEXT,
uid INTEGER DEFAULT 0,
balance REAL DEFAULT 0,
totalDeposited REAL DEFAULT 0,
totalWithdrawn REAL DEFAULT 0,
totalWagered REAL DEFAULT 0,
totalWon REAL DEFAULT 0,
totalLost REAL DEFAULT 0,
ip TEXT,
loginTime TEXT,
bindName TEXT DEFAULT '',
bindNum TEXT DEFAULT '',
isLocked INTEGER DEFAULT 0,
registerDate TEXT,
lastSeen TEXT,
lastAction TEXT DEFAULT 'Registered'
);

CREATE TABLE IF NOT EXISTS deposits (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT,
amount REAL,
receipt TEXT,
status TEXT DEFAULT 'PENDING',
createdAt TEXT
);

CREATE TABLE IF NOT EXISTS withdrawals (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT,
amount REAL,
accountNumber TEXT,
accountType TEXT DEFAULT 'jazzcash',
status TEXT DEFAULT 'PENDING',
createdAt TEXT
);

CREATE TABLE IF NOT EXISTS bets (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT,
game TEXT,
amount REAL,
result TEXT,
payout REAL,
win REAL DEFAULT 0,
createdAt TEXT
);

CREATE TABLE IF NOT EXISTS settings (
key TEXT PRIMARY KEY,
value TEXT
);
`);

console.log('SQLITE TABLES READY');

// =========================
// SOCKET IO
// =========================

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// =========================
// MIDDLEWARE
// =========================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Multer Config for Deposits
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// =========================
// GAME STATE
// =========================

const gameState = {
    aviator: {
        phase: 'WAITING',
        timer: 5,
        startTime: 0,
        crashPoint: 1.0,
        forcedCrash: null,
        manipulationLevel: 0,
        lastCrashPoint: 1.0
    },
    wingo: {
        phase: 'BETTING',
        timer: 60,
        number: null,
        forcedNumber: null,
        periodId: 20231024001
    }
};

const liveState = {
    activePlayers: new Map(),
    recentEvents: [],
    wingoBets: new Map(),
    wingoHistory: []
};

function pushLiveEvent(event) {
    liveState.recentEvents.unshift({
        ...event,
        at: new Date().toISOString()
    });
    if (liveState.recentEvents.length > 80) liveState.recentEvents.pop();
}

function getWingoBetStats(periodId) {
    const bets = liveState.wingoBets.get(periodId) || [];
    const totals = {
        red: 0,
        green: 0,
        violet: 0,
        numbers: Array(10).fill(0),
        total: 0,
        count: bets.length
    };

    bets.forEach((bet) => {
        const amount = Number(bet.amount || 0);
        totals.total += amount;
        if (typeof bet.selection === 'number') {
            totals.numbers[bet.selection] += amount;
        } else if (totals[bet.selection] !== undefined) {
            totals[bet.selection] += amount;
        }
    });

    return totals;
}

function getAdminLivePayload() {
    const now = Date.now();
    for (const [id, player] of liveState.activePlayers.entries()) {
        if (now - player.lastSeen > 45000) liveState.activePlayers.delete(id);
    }

    const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get();
    const totalDeposits = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM deposits WHERE status='APPROVED'").get();
    const totalWithdrawals = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status='APPROVED'").get();
    const pendingDeposits = db.prepare("SELECT COUNT(*) as count FROM deposits WHERE status='PENDING'").get();
    const pendingWithdrawals = db.prepare("SELECT COUNT(*) as count FROM withdrawals WHERE status='PENDING'").get();
    const totalBets = db.prepare("SELECT COUNT(*) as count FROM bets").get();

    return {
        activePlayers: [...liveState.activePlayers.values()],
        recentEvents: liveState.recentEvents,
        wingo: {
            periodId: gameState.wingo.periodId,
            timer: gameState.wingo.timer,
            phase: gameState.wingo.phase,
            betStats: getWingoBetStats(gameState.wingo.periodId),
            history: liveState.wingoHistory
        },
        stats: {
            totalUsers: totalUsers.count,
            totalDeposits: totalDeposits.total,
            totalWithdrawals: totalWithdrawals.total,
            pendingDeposits: pendingDeposits.count,
            pendingWithdrawals: pendingWithdrawals.count,
            totalBets: totalBets.count
        }
    };
}

function emitAdminLive() {
    io.emit('adminLive', getAdminLivePayload());
}

// =========================
// AVIATOR LOOP
// =========================

setInterval(() => {
    const a = gameState.aviator;

    if (a.phase === 'WAITING') {
        a.timer -= 0.1;
        if (a.timer <= 0) {
            a.phase = 'FLYING';
            a.startTime = Date.now();
            a.timer = 0;
            if (a.forcedCrash) {
                a.crashPoint = parseFloat(a.forcedCrash);
                a.forcedCrash = null;
            } else {
                const wVeryLow = 45;
                const wModerate = 55;
                const wMid = 33;
                const wHigh = 2;
                const totalW = wVeryLow + wModerate + wMid + wHigh;

                if (a.lastCrashPoint > 2.2) {
                    a.crashPoint = 1.00 + Math.random() * 0.35;
                } else {
                    const r = Math.random() * totalW;
                    if (r < wVeryLow) {
                        a.crashPoint = 1.00 + Math.random() * 0.30;
                    } else if (r < wVeryLow + wModerate) {
                        a.crashPoint = 1.20 + Math.random() * 0.80;
                    } else if (r < wVeryLow + wModerate + wMid) {
                        a.crashPoint = 2.00 + Math.random() * 1.00;
                    } else {
                        a.crashPoint = 3.00 + Math.random() * 2.00;
                    }
                }
            }
        }
    } else if (a.phase === 'FLYING') {
        const elapsed = (Date.now() - a.startTime) / 1000;
        const currentMult = Number((1 + (elapsed * 0.15)).toFixed(2));
        if (currentMult >= a.crashPoint) {
            a.phase = 'CRASHED';
            a.lastCrashPoint = a.crashPoint;
            a.timer = 5;
        }
    } else if (a.phase === 'CRASHED') {
        a.timer -= 0.1;
        if (a.timer <= 0) {
            a.phase = 'WAITING';
            a.timer = 5;
        }
    }

    io.emit('stateUpdate', {
        aviator: {
            phase: a.phase,
            timer: a.timer,
            startTime: a.startTime,
            crashPoint: a.crashPoint
        }
    });

}, 100);

// =========================
// WINGO LOOP
// =========================

const WINGO_EPOCH = 1700000000;
const WINGO_PERIOD_DURATION = 60;
const WINGO_RESULT_DURATION = 5;

function getCurrentWingoPeriodId() {
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.floor((nowSec - WINGO_EPOCH) / WINGO_PERIOD_DURATION);
}

function getWingoElapsedFromClock() {
    const nowSec = Math.floor(Date.now() / 1000);
    return (nowSec - WINGO_EPOCH) % WINGO_PERIOD_DURATION;
}

function getWingoTimerFromClock() {
    const elapsed = getWingoElapsedFromClock();
    if (elapsed < WINGO_RESULT_DURATION) return 0;
    return WINGO_PERIOD_DURATION - elapsed;
}

function getWingoPhaseFromClock() {
    const elapsed = getWingoElapsedFromClock();
    if (elapsed < WINGO_RESULT_DURATION) return 'RESULT';
    return getWingoTimerFromClock() > 10 ? 'BETTING' : 'LOCKING';
}

function pickWingoNumber(w) {
    if (w.forcedNumber !== null && !isNaN(parseInt(w.forcedNumber, 10))) {
        const num = parseInt(w.forcedNumber, 10);
        w.forcedNumber = null;
        return num;
    }
    // House edge: bias toward 0 (red+violet) and non-green numbers
    const r = Math.random();
    if (r < 0.20) return 0;
    if (r < 0.38) return 5;
    if (r < 0.52) return 2;
    if (r < 0.65) return 4;
    if (r < 0.76) return 6;
    if (r < 0.85) return 8;
    if (r < 0.92) return 1;
    return [3, 7, 9][Math.floor(Math.random() * 3)];
}

// Initialize from clock on startup
gameState.wingo.periodId = getCurrentWingoPeriodId();
gameState.wingo.timer = getWingoTimerFromClock();
gameState.wingo.phase = getWingoPhaseFromClock();
gameState.wingo.number = gameState.wingo.phase === 'RESULT' ? pickWingoNumber(gameState.wingo) : null;
gameState.wingo.forcedNumber = null;

let _wingoLastPeriod = gameState.wingo.periodId;
let _wingoResultSent = gameState.wingo.phase === 'RESULT';

setInterval(() => {
    const w = gameState.wingo;
    const nowPeriodId = getCurrentWingoPeriodId();
    const nowTimer = getWingoTimerFromClock();
    const nowPhase = getWingoPhaseFromClock();

    if (nowPeriodId !== _wingoLastPeriod) {
        _wingoLastPeriod = nowPeriodId;
        _wingoResultSent = false;
        w.number = null;
    }

    w.periodId = nowPeriodId;
    w.timer = nowTimer;
    w.phase = nowPhase;

    if (nowPhase === 'RESULT' && !_wingoResultSent) {
        _wingoResultSent = true;
        w.number = pickWingoNumber(w);
        liveState.wingoHistory.unshift({
            periodId: w.periodId,
            number: w.number,
            createdAt: new Date().toISOString()
        });
        if (liveState.wingoHistory.length > 100) liveState.wingoHistory.pop();
        pushLiveEvent({
            type: 'wingo_result',
            game: 'wingo',
            periodId: w.periodId,
            result: w.number
        });
        
        // Process all wingo bets from this period
        const periodBets = liveState.wingoBets.get(w.periodId) || [];
        periodBets.forEach(bet => {
            const resultNum = w.number;
            let colorRes = getWingoColorStr(resultNum);
            let won = false;
            let multiplier = 0;
            const sel = bet.selection;

            if (typeof sel === 'number') {
                if (sel === resultNum) { won = true; multiplier = 9; }
            } else if (sel === 'green') {
                if (colorRes === 'green' || colorRes === 'green+violet') { won = true; multiplier = 1.9; }
            } else if (sel === 'red') {
                if (colorRes === 'red' || colorRes === 'red+violet') { won = true; multiplier = 1.9; }
            } else if (sel === 'violet') {
                if (colorRes === 'red+violet' || colorRes === 'green+violet') { won = true; multiplier = 4.5; }
            } else if (sel === 'big') {
                if (resultNum >= 5 && resultNum <= 9) { won = true; multiplier = 1.9; }
            } else if (sel === 'small') {
                if (resultNum >= 0 && resultNum <= 4) { won = true; multiplier = 1.9; }
            }

            if (won) {
                const winAmt = bet.amount * multiplier;
                const user = db.prepare("SELECT * FROM users WHERE username = ?").get(bet.username);
                if (user) {
                    db.prepare("UPDATE users SET balance = balance + ?, totalWon = COALESCE(totalWon,0) + ? WHERE username = ?")
                        .run(winAmt, winAmt, bet.username);
                    // Send win notification to the user
                    io.emit('wingoWin', {
                        username: bet.username,
                        amount: winAmt,
                        periodId: w.periodId,
                        number: resultNum,
                        selection: sel,
                        multiplier: multiplier
                    });
                    io.emit('depositApproved', {
                        username: bet.username,
                        amount: winAmt,
                        depositId: 0,
                        isWingoWin: true,
                        periodId: w.periodId,
                        result: resultNum
                    });
                }
                db.prepare("INSERT INTO bets (username, game, amount, result, payout, win, createdAt) VALUES (?, 'wingo', ?, 'win', ?, ?, ?)")
                    .run(bet.username, bet.amount, multiplier, winAmt, new Date().toISOString());
            } else {
                db.prepare("INSERT INTO bets (username, game, amount, result, payout, win, createdAt) VALUES (?, 'wingo', ?, 'loss', 0, 0, ?)")
                    .run(bet.username, bet.amount, new Date().toISOString());
            }
        });
        
        // Clear processed bets
        liveState.wingoBets.delete(w.periodId);
        
    } else if (nowPhase !== 'RESULT') {
        w.number = null;
    }

    io.emit('stateUpdate', {
        aviator: {
            phase: gameState.aviator.phase,
            timer: gameState.aviator.timer,
            startTime: gameState.aviator.startTime,
            crashPoint: gameState.aviator.crashPoint
        },
        wingo: {
            phase: w.phase,
            timer: w.timer,
            number: w.phase === 'RESULT' ? w.number : null,
            periodId: w.periodId,
            history: liveState.wingoHistory,
            betStats: getWingoBetStats(w.periodId),
            resultHandled: _wingoResultSent
        }
    });
    emitAdminLive();
}, 500);

function getWingoColorStr(resultNum) {
    if (resultNum === 0) return 'red+violet';
    if (resultNum === 5) return 'green+violet';
    if ([1, 3, 7, 9].includes(Number(resultNum))) return 'green';
    return 'red';
}

// =========================
// AUTH ROUTES
// =========================

app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const existing = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (existing) {
            return res.json({ success: false, message: 'Username taken' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const uid = Math.floor(100000 + Math.random() * 900000);
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '127.0.0.1';
        const sql = "INSERT INTO users (username, password, uid, balance, totalWagered, totalDeposited, totalWon, totalLost, ip, registerDate, lastSeen, lastAction) VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, 'Registered')";
        db.prepare(sql).run(username, hashedPassword, uid, ip, new Date().toISOString(), new Date().toISOString());
        res.json({ success: true, message: 'Account created', uid: uid });
    } catch (err) {
        console.error('Register error', err);
        res.json({ success: false, message: err.message });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (!user) return res.json({ success: false, message: 'User not found' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.json({ success: false, message: 'Wrong password' });

        if (user.isLocked) return res.json({ success: false, message: 'Account locked' });

        db.prepare("UPDATE users SET loginTime = ?, lastSeen = ?, lastAction = 'Logged In' WHERE username = ?").run(new Date().toISOString(), new Date().toISOString(), username);
        const token = jwt.sign({ username: user.username }, 'SECRET_KEY_123');

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                balance: user.balance,
                totalDeposited: user.totalDeposited,
                totalWithdrawn: user.totalWithdrawn,
                totalWagered: user.totalWagered,
                totalWon: user.totalWon,
                totalLost: user.totalLost,
                uid: user.uid,
                bindName: user.bindName || '',
                bindNum: user.bindNum || '',
                ip: user.ip,
                isLocked: user.isLocked
            }
        });
    } catch (err) {
        console.error('Login error', err);
        res.json({ success: false, message: err.message });
    }
});

// =========================
// DEPOSIT ROUTE
// =========================

app.post('/deposit', upload.single('receipt'), (req, res) => {
    try {
        const { username, amount } = req.body;
        const receiptFilename = req.file ? req.file.filename : null;

        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (!user) return res.json({ success: false, message: 'User not found. Please login first.' });

        db.prepare(`
            INSERT INTO deposits
            (username, amount, receipt, status, createdAt)
            VALUES (?, ?, ?, 'PENDING', ?)
        `).run(
            username,
            Number(amount),
            receiptFilename,
            new Date().toISOString()
        );

        res.json({
            success: true,
            message: 'Deposit submitted for approval'
        });

        io.emit('newDeposit', { username, amount });

    } catch (err) {
        console.log(err);
        res.json({
            success: false,
            error: err.message
        });
    }
});

// =========================
// WITHDRAWAL ROUTE
// =========================

app.post('/withdraw', (req, res) => {
    try {
        const { username, amount, accountNumber, name, accountType } = req.body;
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (!user) return res.json({ success: false, message: 'User not found' });

        const withdrawAmount = Number(amount);
        const requiredWager = user.totalDeposited * 3;

        if (withdrawAmount <= 0) {
            return res.json({ success: false, message: 'Invalid withdrawal amount' });
        }

        if (user.totalDeposited <= 0) {
            return res.json({ success: false, message: 'Withdrawals require an approved deposit and 3x wagering.' });
        }

        if (user.balance < withdrawAmount) {
            return res.json({ success: false, message: 'Insufficient balance' });
        }

        if (user.totalWagered < requiredWager) {
            const stillNeed = Math.max(0, requiredWager - user.totalWagered).toFixed(0);
            return res.json({
                success: false,
                message: `Wagering requirement not met! Deposited: ${user.totalDeposited.toFixed(0)} | Wagered: ${user.totalWagered.toFixed(0)} | Required: ${requiredWager.toFixed(0)} | Still need: ${stillNeed} PKR.`
            });
        }

        db.prepare("UPDATE users SET balance = balance - ?, totalWithdrawn = COALESCE(totalWithdrawn,0) + ? WHERE username = ?").run(withdrawAmount, withdrawAmount, username);
        const sql = "INSERT INTO withdrawals (username, amount, accountNumber, accountType, status, createdAt) VALUES (?, ?, ?, ?, 'PENDING', ?)";
        db.prepare(sql).run(username, withdrawAmount, `${name} - ${accountNumber}`, accountType || 'jazzcash', new Date().toISOString());
        res.json({ success: true, message: 'Withdrawal requested' });
    } catch (err) {
        console.error('Withdraw error', err);
        res.json({ success: false, message: err.message });
    }
});

// =========================
// ADMIN ROUTES
// =========================

// Admin Login
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === 'admin123') {
        const token = jwt.sign({ admin: true, role: 'admin' }, 'ADMIN_SECRET_456');
        return res.json({ success: true, token });
    }
    res.json({ success: false, message: 'Wrong admin password' });
});

// Middleware to verify admin token
function verifyAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'No token' });
    try {
        const token = authHeader.split(' ')[1];
        jwt.verify(token, 'ADMIN_SECRET_456');
        next();
    } catch (e) {
        res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

// Get All Users (for admin)
app.get('/api/users', verifyAdmin, (req, res) => {
    try {
        const users = db.prepare("SELECT id, username, uid, balance, totalDeposited, totalWithdrawn, totalWagered, totalWon, totalLost, ip, bindName, bindNum, isLocked, registerDate, lastSeen, lastAction FROM users ORDER BY id DESC").all();
        res.json({ success: true, users });
    } catch (err) {
        console.log(err);
        res.json({ success: false, error: err.message });
    }
});

// Get Single User
app.get('/api/users/:uid', (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        const user = db.prepare("SELECT id, username, uid, balance, totalDeposited, totalWithdrawn, totalWagered, totalWon, totalLost, ip, bindName, bindNum, isLocked FROM users WHERE uid = ? OR id = ?").get(uid, uid);
        if (!user) return res.json({ success: false, message: 'User not found' });
        res.json({ success: true, user });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Update User (admin)
app.put('/api/users/:id', verifyAdmin, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { balance, totalDeposited, totalWagered, totalWon, totalLost, isLocked, bindName, bindNum } = req.body;
        
        const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
        if (!user) return res.json({ success: false, message: 'User not found' });

        const updates = [];
        const params = [];
        
        if (balance !== undefined) { updates.push("balance = ?"); params.push(balance); }
        if (totalDeposited !== undefined) { updates.push("totalDeposited = ?"); params.push(totalDeposited); }
        if (totalWagered !== undefined) { updates.push("totalWagered = ?"); params.push(totalWagered); }
        if (totalWon !== undefined) { updates.push("totalWon = ?"); params.push(totalWon); }
        if (totalLost !== undefined) { updates.push("totalLost = ?"); params.push(totalLost); }
        if (isLocked !== undefined) { updates.push("isLocked = ?"); params.push(isLocked ? 1 : 0); }
        if (bindName !== undefined) { updates.push("bindName = ?"); params.push(bindName); }
        if (bindNum !== undefined) { updates.push("bindNum = ?"); params.push(bindNum); }

        if (updates.length > 0) {
            params.push(id);
            db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);
        }

        res.json({ success: true, message: 'User updated' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Delete User
app.delete('/api/users/:id', verifyAdmin, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        db.prepare("DELETE FROM users WHERE id = ?").run(id);
        res.json({ success: true, message: 'User deleted' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Get All Deposits
app.get('/api/deposits', verifyAdmin, (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM deposits ORDER BY id DESC").all();
        res.json({ success: true, deposits: rows });
    } catch (err) {
        console.log(err);
        res.json({ success: false, error: err.message });
    }
});

// Get withdrawals
app.get('/api/withdrawals', verifyAdmin, (req, res) => {
    try {
        const rows = db.prepare("SELECT * FROM withdrawals ORDER BY id DESC").all();
        res.json({ success: true, withdrawals: rows });
    } catch (err) {
        console.log(err);
        res.json({ success: false, error: err.message });
    }
});

// Get bets
app.get('/api/bets', verifyAdmin, (req, res) => {
    try {
        const { game, username, limit } = req.query;
        let sql = "SELECT * FROM bets";
        const conditions = [];
        const params = [];
        
        if (game) { conditions.push("game = ?"); params.push(game); }
        if (username) { conditions.push("username = ?"); params.push(username); }
        if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
        sql += " ORDER BY id DESC";
        if (limit) sql += " LIMIT ?";
        
        const rows = db.prepare(sql).all(...params, ...(limit ? [parseInt(limit)] : []));
        res.json({ success: true, bets: rows });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Approve Deposit
app.post('/approve-deposit/:id', verifyAdmin, (req, res) => {
    const depositId = parseInt(req.params.id, 10);
    if (Number.isNaN(depositId)) {
        return res.status(400).json({ success: false, message: 'Invalid deposit id' });
    }

    try {
        const deposit = db.prepare("SELECT * FROM deposits WHERE id = ?").get(depositId);
        if (!deposit || deposit.status !== 'PENDING') {
            return res.status(400).json({ success: false, message: 'Invalid deposit' });
        }

        db.prepare("UPDATE deposits SET status = 'APPROVED' WHERE id = ?").run(depositId);
        db.prepare("UPDATE users SET balance = balance + ?, totalDeposited = COALESCE(totalDeposited,0) + ? WHERE username = ?").run(deposit.amount, deposit.amount, deposit.username);

        io.emit('depositApproved', {
            username: deposit.username,
            amount: deposit.amount,
            depositId
        });
        res.json({ success: true });
    } catch (err) {
        console.error('Approve deposit error', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Handle Withdrawal
app.post('/handle-withdrawal/:id', verifyAdmin, (req, res) => {
    const { action } = req.body;
    const withdrawId = parseInt(req.params.id, 10);
    if (Number.isNaN(withdrawId)) {
        return res.status(400).json({ success: false, message: 'Invalid withdrawal id' });
    }

    try {
        const withdraw = db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(withdrawId);
        if (!withdraw || withdraw.status !== 'PENDING') {
            return res.json({ success: false, message: 'Invalid withdrawal' });
        }

        const newStatus = action === 'approved' ? 'APPROVED' : 'REJECTED';

        if (action === 'rejected') {
            db.prepare("UPDATE users SET balance = balance + ? WHERE username = ?").run(withdraw.amount, withdraw.username);
        }

        db.prepare("UPDATE withdrawals SET status = ? WHERE id = ?").run(newStatus, withdrawId);
        res.json({ success: true });
    } catch (err) {
        console.error('Handle withdrawal error', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Get user's own transaction history
app.get('/api/my/history', (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.json({ success: false, message: 'Username required' });
        
        const deposits = db.prepare("SELECT * FROM deposits WHERE username = ? ORDER BY id DESC LIMIT 20").all(username);
        const withdrawals = db.prepare("SELECT * FROM withdrawals WHERE username = ? ORDER BY id DESC LIMIT 20").all(username);
        const bets = db.prepare("SELECT * FROM bets WHERE username = ? ORDER BY id DESC LIMIT 20").all(username);
        
        res.json({ success: true, deposits, withdrawals, bets });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Bind account
app.post('/api/bind', (req, res) => {
    try {
        const { username, bindName, bindNum } = req.body;
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (!user) return res.json({ success: false, message: 'User not found' });
        
        db.prepare("UPDATE users SET bindName = ?, bindNum = ? WHERE username = ?").run(bindName, bindNum, username);
        res.json({ success: true, message: 'Account bound' });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Refresh user balance
app.get('/api/user/balance', (req, res) => {
    try {
        const { username } = req.query;
        if (!username) return res.json({ success: false, message: 'Username required' });
        const user = db.prepare("SELECT balance, totalDeposited, totalWagered, totalWon, totalLost, totalWithdrawn FROM users WHERE username = ?").get(username);
        if (!user) return res.json({ success: false, message: 'User not found' });
        res.json({ success: true, balance: user.balance, totalDeposited: user.totalDeposited, totalWagered: user.totalWagered, totalWon: user.totalWon, totalLost: user.totalLost, totalWithdrawn: user.totalWithdrawn });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Record bet (game settled)
app.post('/api/bet', (req, res) => {
    try {
        const { username, game, amount, result, payout, win } = req.body;
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (!user) return res.json({ success: false, message: 'User not found' });

        db.prepare("UPDATE users SET totalWagered = COALESCE(totalWagered,0) + ? WHERE username = ?").run(amount, username);
        
        if (result === 'win' && win > 0) {
            db.prepare("UPDATE users SET balance = balance + ?, totalWon = COALESCE(totalWon,0) + ? WHERE username = ?").run(win, win, username);
        } else if (result === 'loss') {
            db.prepare("UPDATE users SET totalLost = COALESCE(totalLost,0) + ? WHERE username = ?").run(amount, username);
        }

        db.prepare("INSERT INTO bets (username, game, amount, result, payout, win, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .run(username, game, amount, result, payout || 0, win || 0, new Date().toISOString());

        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Health
app.get('/health', (req, res) => {
    res.json({ success: true, status: 'alive' });
});

app.get('/', (req, res) => {
    res.send('StakeWin Backend Alive');
});

// =========================
// SOCKET CONTROL
// =========================

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.emit('stateUpdate', {
        aviator: gameState.aviator,
        wingo: {
            phase: gameState.wingo.phase,
            timer: gameState.wingo.timer,
            number: gameState.wingo.number,
            periodId: gameState.wingo.periodId,
            history: liveState.wingoHistory,
            betStats: getWingoBetStats(gameState.wingo.periodId)
        }
    });
    socket.emit('adminLive', getAdminLivePayload());

    socket.on('authenticate', (data) => {
        if (data && data.username) {
            socket.username = data.username;
        }
    });

    // Admin: Set Crash Point
    socket.on('updateAviatorCrash', (val) => {
        if (gameState.aviator.phase === 'FLYING') {
             const elapsed = (Date.now() - gameState.aviator.startTime) / 1000;
             const currentMult = Number((1 + (elapsed * 0.15)).toFixed(2));
             gameState.aviator.crashPoint = currentMult;
        } else {
            gameState.aviator.forcedCrash = val;
        }
    });

    // Admin: Set Wingo Number
    socket.on('updateWingoNumber', (val) => {
        const num = parseInt(val, 10);
        if (!isNaN(num) && num >= 0 && num <= 9) {
            gameState.wingo.forcedNumber = num;
            console.log('Admin forced wingo number:', num);
        }
    });

    socket.on('playerActivity', (data = {}) => {
        const player = {
            socketId: socket.id,
            username: String(data.username || 'Guest'),
            uid: data.uid || '',
            game: data.game || 'unknown',
            balance: Number(data.balance || 0),
            lastWin: Number(data.lastWin || 0),
            location: data.location || 'Unknown',
            lastSeen: Date.now()
        };
        liveState.activePlayers.set(socket.id, player);
        emitAdminLive();
    });

    socket.on('wingoBetPlaced', (bet = {}) => {
        const periodId = Number(bet.periodId || gameState.wingo.periodId);
        const amount = Number(bet.amount || 0);
        const selection = typeof bet.selection === 'number' ? bet.selection : String(bet.selection || '');

        if (!liveState.wingoBets.has(periodId)) liveState.wingoBets.set(periodId, []);
        liveState.wingoBets.get(periodId).push({
            username: String(bet.username || 'Guest'),
            uid: bet.uid || '',
            selection,
            amount,
            location: bet.location || 'Unknown',
            at: Date.now()
        });

        for (const key of liveState.wingoBets.keys()) {
            if (key < periodId - 20) liveState.wingoBets.delete(key);
        }

        pushLiveEvent({
            type: 'bet',
            game: 'wingo',
            username: String(bet.username || 'Guest'),
            uid: bet.uid || '',
            selection,
            amount,
            periodId,
            location: bet.location || 'Unknown'
        });
        emitAdminLive();
    });

    socket.on('gameSettled', (event = {}) => {
        pushLiveEvent({
            type: event.won ? 'win' : 'loss',
            game: event.game || 'unknown',
            username: String(event.username || 'Guest'),
            uid: event.uid || '',
            amount: Number(event.amount || 0),
            result: event.result,
            location: event.location || 'Unknown'
        });
        emitAdminLive();
    });

    socket.on('disconnect', () => {
        liveState.activePlayers.delete(socket.id);
        emitAdminLive();
        console.log('User disconnected');
    });
});

// =========================
// START SERVER
// =========================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log('====================');
    console.log('SERVER RUNNING');
    console.log('PORT:', PORT);
    console.log('====================');
});