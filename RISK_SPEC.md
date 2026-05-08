# Strategic Risk & Target Intelligence Specification (NIFTY)

## 1. Mathematical Formulas

### 1.1 Dynamic ATR Stop Loss (Buying)
$$SL_{points} = ATR_{14} \times 1.2 \times (VIX / 15) \times ExpiryMultiplier$$
*   **ExpiryMultiplier**: 0.7 on Expiry Day (Thursday) to account for rapid theta decay.
*   **Cap**: Max 45 points for NIFTY Buying.

### 1.2 Structural Stop Loss (Selling)
$$SL_{points} = \max(ATR_{14} \times 1.5, |Spot - VWAP| + 10) \times ExpiryMultiplier$$
*   **ExpiryMultiplier**: 1.3 on Expiry Day (Thursday) to buffer against gamma spikes.

### 1.3 Target Projection
$$Target = SL_{points} \times RR_{ratio}$$
*   **Buying RR**: 2.0 (Normal) / 3.0 (Expiry)
*   **Selling RR**: 1.2 (Fixed for high win-rate spreads)

---

## 2. Pine Script Implementation Logic (TradingView)

```pinescript
//@version=5
strategy("Intelligent Dynamic SL/TGT", overlay=true)

// Inputs
atrPeriod = input.int(14, "ATR Period")
vixVal = input.float(15.0, "VIX Value (Manual or External)")
isExpiry = dayofweek == dayofweek.thursday

// ATR Derivations
atr = ta.atr(atrPeriod)
vixFactor = math.max(0.8, math.min(1.5, vixVal / 15))

// SL Calculation
buyingSL = atr * 1.2 * vixFactor * (isExpiry ? 0.7 : 1.0)
sellingSL = math.max(atr * 1.5, math.abs(close - ta.vwap)) * (isExpiry ? 1.3 : 1.0)

// Execution
if (longCondition)
    strategy.entry("Buy", strategy.long)
    strategy.exit("Exit", "Buy", stop=close - buyingSL, limit=close + (buyingSL * 2.0))
```

---

## 3. Workflow Diagram

1.  **Entry Trigger**: Strategy Score > 75
2.  **Intelligence Pass**: 
    - Fetch current ATR (14)
    - Fetch INDIA VIX
    - Check Today's Day (Expiry vs Normal)
3.  **Derivation**:
    - Calculate Point-based SL
    - Apply VIX Over-ride
    - Project Target based on RR Vector
4.  **Monitoring**:
    - If PnL > 50% of Target, move SL to Break-Even.
    - If Duration > 45 mins (Buying), exit at next resistance.
