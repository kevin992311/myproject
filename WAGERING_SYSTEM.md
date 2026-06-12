# STAKE WIN - WAGERING SYSTEM & HOUSE EDGE DOCUMENTATION

## 1. STRICT WAGERING SYSTEM (3X)

### How It Works
- When a user makes a deposit (approved by admin), `totalDeposited` is tracked
- To withdraw, user must wager (totalWagered) at least **3x the totalDeposited amount**
- Example: Deposit ₨1000 → Must wager ₨3000+ before withdrawal allowed
- Wagering requirement is displayed in profile: `"Wager 75% Complete"` etc.

### Admin Wager Management
- Admin Panel has "ADD WAGER" button in PLAYER COMMAND section
- Admin enters target UID and amount, clicks "ADD WAGER"
- Adds to `user.totalWagered` directly - bypasses actual betting
- Admin can also "RESET WAGER" to 0 for any user

### Withdrawal Flow
1. User enters amount, bank details, and password
2. System checks: balance, 3x wagering requirement, password match
3. If approved (by admin in panel), balance is deducted
4. If rejected, balance is refunded

---

## 2. HOUSE EDGE SETTINGS (ALL GAMES)

### Tower of Power (EXTREME - 98% House Win)
- **98% mine rate** on valid tiles (was 95%)
- **Forced loss after step 3**: Any tile clicked at step 3+ automatically dies
- Virtually unwinnable - max possible steps: 2 safe tiles

### Mines
- 3-5 random bombs in 25 tiles (no protection)
- **First click CAN be a bomb** - no safety net
- 3-5 bombs out of 25 = 12% to 20% instant death rate

### Wingo (Smart Unpredictable Engine)
- When socket connected: server dictates results
- When local: results use **anti-popular-bet logic**
- If most players bet GREEN → result favors RED
- If most bet RED → result favors GREEN
- If most bet VIOLET → result avoids Violet (pure green/red)
- **Streak breaker**: 3 same-color results in a row forces opposite color
- Peak anti-pattern: no predictable streaks

### Dragon Tiger (Controlled 30% Win Rate)
- Admin sets win rate (default 30%) and payout (default 1.55x)
- Player cards are rigged: player gets LOW card (2-8) when they should lose
- Admin can FORCE: Dragon win, Tiger win, or Player loss

### Slots (Brutal Profiles)
- 4 modes: Classic (18%), Turbo (16%), Vault (12%), Jackpot (10%)
- Profile penalty: -6% brutal, 0% tight, +4% normal
- Minimum 2% win rate, maximum 35%
- Double-rigged: first RNG check (win/loss), then outcome tier (small/medium/big)

### Aviator
- Managed server-side by Railway
- Admin can set crash point or force instant crash
- Bets only accepted during WAITING phase (not during CRASHED state)

### Other Games (Coin, Wheel, Plinko, Keno, Sicbo, Blackjack)
- Coin: 50% base with streak breaker (can't win same side twice)
- Wheel: 30% win rate
- Plinko: weighted toward center (low multiplier 0.5x-1x)
- Keno: low payout per hit
- Sicbo: 50% base
- Blackjack: standard house edge

---

## 3. GAME LAWS OF PREDICTABILITY

### Player Can NEVER:
- Bypass 3x wagering for withdrawal
- Win Tower past level 3
- Win Dragon/Tiger more than admin-set win rate
- Predict Wingo results (anti-most-bet engine)
- Get first-click protection in Mines
- Abuse Aviator bet placement after crash

### Admin Can ALWAYS:
- Set any balance for any user
- Force Wingo number (0-9)
- Force Dragon/Tiger outcome
- Crash Aviator instantly
- Add wager to any user
- Lock/unlock any user
- Delete any user
- View all live data, bets, and history

---

## 4. ADMIN PANEL FEATURES

### Live Admin Panel
- **LIVE tab**: Shows online players with balance, game, IP, activity
- **Wingo heatmap**: Visual bar chart of Green/Red/Violet bets per period
- **Live feed**: Last 50 events (bets, wins, losses) with timestamps
- **Wingo bet stats**: Count and volume per period

### Player Management
- Search by UID or username
- Add/remove/set balance
- Lock/unlock accounts
- Add wager (bypass betting)
- Impersonate user
- Delete user
- Reset wager to 0
- Credit/Bonus ALL users

### Game Controls
- Set Aviator crash point / force crash
- Set next Wingo number
- Set Dragon Tiger win rate, payout, force winner
- Set Slot profile (brutal/tight/normal) and force next result

### Finance
- View deposits with receipt images from Railway API
- Approve/reject withdrawals
- Approve deposits (credits balance + totalDeposited)
- Export CSV for users and transactions

### System Tools
- Lock/unlock all users
- Delete all users (nuclear)
- Send announcement
- Toggle maintenance mode
- View raw database tables (users, deposits, withdrawals, bets, settings)

---

## 5. TECHNICAL SUMMARY OF ALL CHANGES

### What Was Fixed:
1. **Aviator bet bug**: Bets can only be placed during WAITING phase, not CRASHED
2. **Towers house edge**: Reduced safe chance from 5% to 2%, forced loss at step 3
3. **Mines first-click protection removed**: First click can now be a bomb
4. **Wingo unpredictability**: Uses anti-popular-bet logic + streak breaker
5. **3x wagering enforcement**: Fully implemented in withdrawal flow
6. **Admin wager addition**: ADD WAGER button works
7. **Big/Small added**: Wingo now has Big (5-9) and Small (0-4) options

### What Was Added:
- Complete admin live panel with online players table
- Wingo bet heatmap (visual bars for Green/Red/Violet)
- Live feed event system (last 50 events)
- Admin can add wager to any user by UID
- Wingo Big/Small betting options (x1.9 each)