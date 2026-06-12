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
balance REAL DEFAULT 0,
totalDeposited REAL DEFAULT 0,
totalWithdrawn REAL DEFAULT 0,
totalWagered REAL DEFAULT 0,
ip TEXT,
loginTime TEXT
);

CREATE TABLE IF NOT EXISTS deposits (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT,
amount REAL,
receipt TEXT,
status TEXT,
createdAt TEXT
);

CREATE TABLE IF NOT EXISTS withdrawals (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT,
amount REAL,
accountNumber TEXT,
status TEXT,
createdAt TEXT
);

CREATE TABLE IF NOT EXISTS bets (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT,
game TEXT,
amount REAL,
createdAt TEXT
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
        periodId: 20231024001 // Matches frontend starting ID
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

    return {
        activePlayers: [...liveState.activePlayers.values()],
        recentEvents: liveState.recentEvents,
        wingo: {
            periodId: gameState.wingo.periodId,
            timer: gameState.wingo.timer,
            phase: gameState.wingo.phase,
            betStats: getWingoBetStats(gameState.wingo.periodId),
            history: liveState.wingoHistory
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
                // Use relative weights provided by the operator and normalize via a summed weight roll.
                // Requested weights: 45 (very low), 55 (moderate low), 33 (mid-range), 2 (high)
                const wVeryLow = 45;
                const wModerate = 55;
                const wMid = 33;
                const wHigh = 2;
                const totalW = wVeryLow + wModerate + wMid + wHigh; // 135

                // If previous round was a large payout, bias next round very low to break streaks.
                if (a.lastCrashPoint > 2.2) {
                    a.crashPoint = 1.00 + Math.random() * 0.35;
                } else {
                    const r = Math.random() * totalW; // 0 .. totalW
                    if (r < wVeryLow) {
                        // Very low outcome
                        a.crashPoint = 1.00 + Math.random() * 0.30; // ~1.00 - 1.30
                    } else if (r < wVeryLow + wModerate) {
                        // Moderate low outcome
                        a.crashPoint = 1.20 + Math.random() * 0.80; // ~1.20 - 2.00
                    } else if (r < wVeryLow + wModerate + wMid) {
                        // Mid-range outcome
                        a.crashPoint = 2.00 + Math.random() * 1.00; // ~2.00 - 3.00
                    } else {
                        // High outcome (rare)
                        a.crashPoint = 3.00 + Math.random() * 2.00; // ~3.00 - 5.00
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

    // Emit Aviator state update to frontend
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
// WINGO LOOP (FIXED - 24/7, serial period IDs, no skipping)
// =========================
// Fixed epoch: all clients derive the same periodId from real clock time.
// Period = 60 seconds. PeriodId = number of 60s intervals since epoch.
const WINGO_EPOCH = 1700000000; // Unix seconds fixed reference point
const WINGO_PERIOD_DURATION = 60; // seconds per period
const WINGO_RESULT_DURATION = 5; // seconds to show result at period boundary

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
    return Math.floor(Math.random() * 10);
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

    // Detect period rollover.
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
    } else if (nowPhase !== 'RESULT') {
        w.number = null;
    }

    // Emit to all clients.
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
            betStats: getWingoBetStats(w.periodId)
        }
    });
    emitAdminLive();
}, 500);

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
        const sql = "INSERT INTO users (username, password, uid, balance, totalWagered, totalDeposited) VALUES (?, ?, ?, 0, 0, 0)";
        db.prepare(sql).run(username, hashedPassword, uid);
        res.json({ success: true, message: 'Account created' });
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

        db.prepare("UPDATE users SET loginTime = ? WHERE username = ?").run(new Date().toISOString(), username);
        const token = jwt.sign({ username: user.username }, 'SECRET_KEY_123');

        res.json({
            success: true,
            token,
            user: {
                username: user.username,
                balance: user.balance,
                totalDeposited: user.totalDeposited,
                totalWagered: user.totalWagered,
                uid: user.uid,
                bindName: user.bindName,
                bindNum: user.bindNum
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
            message: 'Deposit submitted'
        });

    } catch (err) {
        console.log(err);

        res.json({
            success: false,
            error: err.message
        });
    }
});

// =========================
// WITHDRAWAL ROUTE (3x WAGER CHECK)
// =========================

app.post('/withdraw', (req, res) => {
    try {
        const { username, amount, accountNumber, name } = req.body;
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

        db.prepare("UPDATE users SET balance = balance - ?, totalWithdrawn = totalWithdrawn + ? WHERE username = ?").run(withdrawAmount, withdrawAmount, username);
        const sql = "INSERT INTO withdrawals (username, amount, accountNumber, status, createdAt) VALUES (?, ?, ?, 'PENDING', ?)";
        db.prepare(sql).run(username, withdrawAmount, `${name} - ${accountNumber}`, new Date().toISOString());
        res.json({ success: true, message: 'Withdrawal requested' });
    } catch (err) {
        console.error('Withdraw error', err);
        res.json({ success: false, message: err.message });
    }
});

// =========================
// ADMIN ROUTES
// =========================

// Get All Deposits
app.get('/api/deposits', (req, res) => {
    try {
        const rows = db.prepare(
            "SELECT * FROM deposits ORDER BY id DESC"
        ).all();

        res.json(rows);
    } catch (err) {
        console.log(err);
        res.json({
            success: false,
            error: err.message
        });
    }
});

app.get('/health', (req, res) => {
    res.json({
        success: true,
        status: 'alive'
    });
});

app.get('/', (req, res) => {
    res.send('StakeWin Backend Alive');
});

// withdrawals
app.get('/api/withdrawals', (req, res) => {
    try {
        const rows = db.prepare(
            "SELECT * FROM withdrawals ORDER BY id DESC"
        ).all();

        res.json(rows);
    } catch (err) {
        console.log(err);
        res.json({
            success: false,
            error: err.message
        });
    }
});

// Approve Deposit
app.post('/approve-deposit/:id', (req, res) => {
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
        db.prepare("UPDATE users SET balance = balance + ?, totalDeposited = totalDeposited + ? WHERE username = ?").run(deposit.amount, deposit.amount, deposit.username);

        if (typeof io !== 'undefined') {
            io.emit('depositApproved', {
                username: deposit.username,
                amount: deposit.amount,
                depositId
            });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Approve deposit error', err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

// Handle Withdrawal (Approve/Reject)
app.post('/handle-withdrawal/:id', (req, res) => {
    const { action } = req.body; // 'approved' or 'rejected'
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

// =========================
// SOCKET CONTROL
// =========================

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.emit('stateUpdate', gameState);
    socket.emit('adminLive', getAdminLivePayload());

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

        // Keep only recent period buckets.
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
