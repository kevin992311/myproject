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
        manipulationLevel: 0
    },
    wingo: {
        phase: 'BETTING',
        timer: 60,
        number: null,
        forcedNumber: null,
        periodId: 20231024001 // Matches frontend starting ID
    }
};

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
                // Standard random logic (simplified)
                const r = Math.random();
                if (r < 0.3) a.crashPoint = 1.00 + Math.random() * 0.5;
                else if (r < 0.7) a.crashPoint = 1.5 + Math.random() * 1.5;
                else a.crashPoint = 3 + Math.random() * 10;
            }
        }
    } else if (a.phase === 'FLYING') {
        const elapsed = (Date.now() - a.startTime) / 1000;
        const currentMult = Number((1 + (elapsed * 0.15)).toFixed(2));
        if (currentMult >= a.crashPoint) {
            a.phase = 'CRASHED';
            a.timer = 5;
        }
    } else if (a.phase === 'CRASHED') {
        a.timer -= 0.1;
        if (a.timer <= 0) {
            a.phase = 'WAITING';
            a.timer = 5;
        }
    }

    // Emit state update to frontend
    io.emit('stateUpdate', {
        aviator: {
            phase: a.phase,
            timer: a.timer,
            startTime: a.startTime,
            crashPoint: a.crashPoint
        },
        wingo: gameState.wingo
    });

}, 100);

// =========================
// WINGO LOOP
// =========================

setInterval(() => {
    const w = gameState.wingo;

    if (w.phase === 'BETTING') {
        w.timer--;
        if (w.timer <= 10) w.phase = 'LOCKING'; // Lock at 10s as per frontend
        
        if (w.timer <= 0) {
            w.phase = 'RESULT';
            if (w.forcedNumber !== null) {
                w.number = w.forcedNumber;
                w.forcedNumber = null;
            } else {
                w.number = Math.floor(Math.random() * 10);
            }

            setTimeout(() => {
                w.phase = 'BETTING';
                w.timer = 60;
                w.number = null;
                w.periodId++; // Increment period ID
            }, 5000);
        }
    }
}, 1000);

// =========================
// AUTH ROUTES
// =========================

app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        db.get("SELECT * FROM users WHERE username = ?", [username], async (err, row) => {
            if (row) return res.json({ success: false, message: 'Username taken' });

            const hashedPassword = await bcrypt.hash(password, 10);
            const uid = Math.floor(100000 + Math.random() * 900000);
            
            const sql = "INSERT INTO users (username, password, uid, balance, totalWagered, totalDeposited) VALUES (?, ?, ?, 0, 0, 0)";
            db.run(sql, [username, hashedPassword, uid], function(err) {
                if (err) return res.json({ success: false, message: err.message });
                res.json({ success: true, message: 'Account created' });
            });
        });
    } catch (err) {
        res.json({ success: false });
    }
});

app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
            if (!user) return res.json({ success: false, message: 'User not found' });

            const validPassword = await bcrypt.compare(password, user.password);
            if (!validPassword) return res.json({ success: false, message: 'Wrong password' });

            db.run("UPDATE users SET loginTime = ? WHERE username = ?", [new Date().toISOString(), username]);

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
        });
    } catch (err) {
        res.json({ success: false });
    }
});

// =========================
// DEPOSIT ROUTE
// =========================

app.post('/deposit', upload.single('receipt'), (req, res) => {
    try {
        const { username, amount } = req.body;
        const receiptFilename = req.file ? req.file.filename : null;

        const sql = "INSERT INTO deposits (username, amount, receipt, status, createdAt) VALUES (?, ?, ?, 'PENDING', ?)";
        db.run(sql, [username, Number(amount), receiptFilename, new Date().toISOString()], function(err) {
            if (err) return res.json({ success: false, error: err.message });
            res.json({ success: true, message: 'Deposit submitted' });
        });

    } catch (err) {
        console.log(err);
        res.json({ success: false });
    }
});

// =========================
// WITHDRAWAL ROUTE (2.6x WAGER CHECK)
// =========================

app.post('/withdraw', (req, res) => {
    try {
        const { username, amount, accountNumber, name } = req.body;

        db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
            if (!user) return res.json({ success: false, message: 'User not found' });

            const withdrawAmount = Number(amount);
            const requiredWager = withdrawAmount * 2.6; // 2.6x Rule

            // Check 1: Balance
            if (user.balance < withdrawAmount) {
                return res.json({ success: false, message: 'Insufficient balance' });
            }

            // Check 2: Wagering Requirement
            if (user.totalWagered < requiredWager) {
                return res.json({ success: false, message: `Wagering requirement not met! Required: ${requiredWager.toFixed(0)} PKR.` });
            }

            // Deduct balance immediately
            db.run("UPDATE users SET balance = balance - ?, totalWithdrawn = totalWithdrawn + ? WHERE username = ?", [withdrawAmount, withdrawAmount, username], (err) => {
                if (err) return res.json({ success: false, message: err.message });

                // Insert withdrawal request
                const sql = "INSERT INTO withdrawals (username, amount, accountNumber, status, createdAt) VALUES (?, ?, ?, 'PENDING', ?)";
                db.run(sql, [username, withdrawAmount, `${name} - ${accountNumber}`, new Date().toISOString()], function(err) {
                    if (err) return res.json({ success: false, message: err.message });
                    res.json({ success: true, message: 'Withdrawal requested' });
                });
            });

        });
    } catch (err) {
        console.log(err);
        res.json({ success: false });
    }
});

// =========================
// ADMIN ROUTES
// =========================

// Get All Deposits
app.get('/api/deposits', (req, res) => {
    db.all("SELECT * FROM deposits ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.json({ success: false, error: err.message });
        res.json(rows);
    });
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
    db.all("SELECT * FROM withdrawals ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            console.log("WITHDRAW ERROR:", err);
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }

        res.json(rows);
    });
});

// Approve Deposit
app.post('/approve-deposit/:id', (req, res) => {
    const depositId = req.params.id;

    db.get("SELECT * FROM deposits WHERE id = ?", [depositId], (err, deposit) => {
        if (!deposit || deposit.status !== 'PENDING') {
            return res.json({ success: false, message: 'Invalid deposit' });
        }

        // Update Deposit Status
        db.run("UPDATE deposits SET status = 'APPROVED' WHERE id = ?", [depositId], (err) => {
            if (err) return res.json({ success: false });

            // Update User Balance
            const sql = "UPDATE users SET balance = balance + ?, totalDeposited = totalDeposited + ? WHERE username = ?";
            db.run(sql, [deposit.amount, deposit.amount, deposit.username], function(err) {
                if (err) return res.json({ success: false });
                res.json({ success: true });
            });
        });
    });
});

// Handle Withdrawal (Approve/Reject)
app.post('/handle-withdrawal/:id', (req, res) => {
    const { action } = req.body; // 'approved' or 'rejected'
    const withdrawId = req.params.id;

    db.get("SELECT * FROM withdrawals WHERE id = ?", [withdrawId], (err, withdraw) => {
        if (!withdraw || withdraw.status !== 'PENDING') return res.json({ success: false });

        const newStatus = action === 'approved' ? 'APPROVED' : 'REJECTED';

        if (action === 'rejected') {
            // Refund user
            db.run("UPDATE users SET balance = balance + ? WHERE username = ?", [withdraw.amount, withdraw.username], (err) => {
                if (err) return res.json({ success: false });
                db.run("UPDATE withdrawals SET status = ? WHERE id = ?", [newStatus, withdrawId]);
                res.json({ success: true });
            });
        } else {
            // Just mark approved
            db.run("UPDATE withdrawals SET status = ? WHERE id = ?", [newStatus, withdrawId]);
            res.json({ success: true });
        }
    });
});

// =========================
// SOCKET CONTROL
// =========================

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    socket.emit('stateUpdate', gameState);

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
        gameState.wingo.forcedNumber = val;
    });

    socket.on('disconnect', () => {
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