# Strict Wagering System (2.6x) Implementation

## Overview
Users must wager **2.6 times their total deposits** before they can request a withdrawal.

---

## Database Schema
Located in `server.js`, users table includes:
- `totalDeposited` REAL - Tracks cumulative deposits
- `totalWagered` REAL - Tracks cumulative bets placed
- `totalWithdrawn` REAL - Tracks approved withdrawals
- `balance` REAL - Current account balance

## Frontend Validation (`public/KEVIN.html`)

### Withdrawal Request (`initiateWithdraw()`)
```javascript
// Wagering requirement: must wager 2.6x their TOTAL DEPOSITS before withdrawal
const requiredWager = currentUser.totalDeposited * 2.6;
if(currentUser.totalWagered < requiredWager) {
    const stillNeed = (requiredWager - currentUser.totalWagered).toFixed(0);
    return errDiv.innerText = `Wagering requirement not met! 
        Deposited: ${currentUser.totalDeposited.toFixed(0)} | 
        Wagered: ${currentUser.totalWagered.toFixed(0)} | 
        Required: ${requiredWager.toFixed(0)} | 
        Still need: ${stillNeed} PKR`;
}
```

### Wagering Tracking
Games automatically track bets by incrementing `totalWagered`:
- Aviator: `currentUser.totalWagered += bet;`
- Wingo: `currentUser.totalWagered += amount;` (when bet placed)
- Mines, Towers, etc: Same pattern

### Profile Display
Shows wagering progress:
```javascript
const requiredWagerDisplay = currentUser.totalDeposited * 2.6;
const wagerPercent = (currentUser.totalWagered / requiredWagerDisplay * 100).toFixed(0);
const wagerStatus = currentUser.totalWagered >= requiredWagerDisplay ? 
    "✓ Completed" : `${wagerPercent}% Complete`;
```

---

## Backend Validation (`server.js`)

### Deposit Approval Route (`/approve-deposit/:id`)
When admin approves a deposit:
```javascript
// Update User Balance AND totalDeposited
const sql = "UPDATE users SET balance = balance + ?, totalDeposited = totalDeposited + ? WHERE username = ?";
db.run(sql, [deposit.amount, deposit.amount, deposit.username], ...);
```

### Withdrawal Route (`/withdraw`)
Strict validation BEFORE allowing withdrawal:
```javascript
// STRICT WAGERING: Must wager 2.6x their TOTAL DEPOSITS before withdrawal
const requiredWager = user.totalDeposited * 2.6;

// Check 2: Wagering Requirement (2.6x of total deposits)
if (user.totalWagered < requiredWager) {
    const stillNeed = Math.max(0, requiredWager - user.totalWagered).toFixed(0);
    return res.json({ 
        success: false, 
        message: `Wagering requirement not met! 
            Deposited: ${user.totalDeposited.toFixed(0)} | 
            Wagered: ${user.totalWagered.toFixed(0)} | 
            Required: ${requiredWager.toFixed(0)} | 
            Still need: ${stillNeed} PKR.` 
    });
}
```

---

## Workflow

1. **User Deposits 1000 PKR**
   - `totalDeposited = 1000`
   - `balance = 1000`
   - Wagering requirement = 1000 × 2.6 = **2600 PKR**

2. **User Plays Games**
   - Plays Aviator, loses 500 → `totalWagered = 500`
   - Plays Wingo, loses 300 → `totalWagered = 800`
   - Plays Mines, wins 1200 → `totalWagered = 2000`
   - Plays Towers, wins 800 → `totalWagered = 2800` ✓ **Requirement Met!**

3. **User Requests Withdrawal**
   - Frontend checks: `totalWagered (2800) >= requiredWager (2600)` ✓
   - Backend double-checks same logic ✓
   - Withdrawal allowed, balance deducted, request created

---

## Error Messages

### Not Met
```
Wagering requirement not met! 
Deposited: 1000 | 
Wagered: 1500 | 
Required: 2600 | 
Still need: 1100 PKR
```

### Met
```
✓ Completed
```

---

## Security Notes

✓ Frontend + Backend validation (defense in depth)
✓ Database tracks all values independently
✓ SQLite persistence (not localStorage for critical data)
✓ No way to bypass: withdrawal requires BOTH checks to pass
✓ Admin approval increments `totalDeposited` atomically

---

## Testing

To verify the system:

1. Create account
2. "Deposit" 1000 PKR (submit form)
3. Admin approves deposit → `totalDeposited = 1000`, `balance = 1000`
4. Play games and lose/win until `totalWagered >= 2600`
5. Try to withdraw - should now be allowed
6. Monitor console for wagering calculations
