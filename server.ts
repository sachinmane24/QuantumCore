/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import cookieParser from "cookie-parser";
import { KiteConnect } from "kiteconnect";
import { marketEngine } from "./src/engine/market.ts";
import { strategyEngine } from "./src/engine/strategy.ts";
import { executionEngine } from "./src/engine/execution.ts";
import { aiEngine } from "./src/engine/aiModel.ts";
import { config, setDataMode, setExecutionMode, setAutoMode } from "./src/engine/config.ts";
import { tradeLogger } from "./src/engine/logger.ts";

let apiKey = process.env.KITE_API_KEY;
let apiSecret = process.env.KITE_API_SECRET;

async function startServer() {
  try {
    const app = express();
    const PORT = process.env.PORT || 3000;

    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json());
    app.use(cookieParser());

    // Request Logger with Versioning
    app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      console.log(`[V5.2-DIAG] ${timestamp} - ${req.method} ${req.url}`);
      next();
    });

  // Kite instance (single session for this dev app)
  let kiteInstance: any = null;
  let accessToken: string | null = null;
  let niftyInstruments: any[] = [];
  let allExpiries: string[] = [];

  if (apiKey) {
    kiteInstance = new KiteConnect({ api_key: apiKey });
  }

    // Background Trading Loop
    setInterval(async () => {
      const now = new Date();
      // IST is UTC+5:30
      const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      const hours = istTime.getUTCHours();
      const minutes = istTime.getUTCMinutes();
      const currentTimeInMinutes = (hours * 60) + minutes;
      const marketCloseTime = (16 * 60); // 4:00 PM IST

      if (currentTimeInMinutes >= marketCloseTime) {
        if (config.AUTO_MODE) {
          console.log("[SYSTEM] Market hours ended (4 PM IST). Disabling Auto Mode.");
          setAutoMode(false);
        }
        // Optionally stop the data sync too
        if (config.DATA_SOURCE === 'LIVE') {
          console.log("[SYSTEM] Market hours ended. Reverting to MOCK data for simulation.");
          setDataMode('MOCK');
          marketEngine.syncMode();
        }
      }

      // 1. Data Sync
      if (config.DATA_SOURCE === 'LIVE' && kiteInstance && accessToken) {
        try {
          const symbols = ["NSE:NIFTY 50", "NSE:INDIA VIX"];
          
          // Ensure we have regular instrument refreshes if empty or contains stale data
          const nowCheck = new Date();
          nowCheck.setHours(0,0,0,0);
          
          const isStale = niftyInstruments.length > 0 && new Date(niftyInstruments[0].expiry) < nowCheck;

          if (niftyInstruments.length === 0 || isStale) {
            console.log("[SYSTEM] niftyInstruments empty or stale, pulling fresh from Kite...");
            const instruments = await kiteInstance.getInstruments(["NFO"]);
            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            const niftyAll = instruments.filter((ins: any) => 
              ins.name === 'NIFTY' && 
              ins.segment === 'NFO-OPT' &&
              new Date(ins.expiry) >= startOfToday
            );
            allExpiries = Array.from(new Set(niftyAll.map((i: any) => i.expiry))).sort((a,b) => new Date(a).getTime() - new Date(b).getTime());
            const nearestExpiry = allExpiries[0];
            niftyInstruments = niftyAll.filter((i: any) => i.expiry === nearestExpiry);
            console.log(`[SYSTEM] Refreshed ${niftyInstruments.length} instruments. Nearest expiry: ${nearestExpiry}`);
          }

          let optionSymbols: string[] = [];
          const spotPrice = marketEngine.getSpotPrice();
          const atmStrike = Math.round(spotPrice / 50) * 50;

          if (niftyInstruments.length > 0) {
            // Find 10 strikes around ATM
            for (let i = -5; i <= 5; i++) {
              const strike = atmStrike + (i * 50);
              const ce = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'CE');
              const pe = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'PE');
              if (ce) optionSymbols.push(`NFO:${ce.tradingsymbol}`);
              if (pe) optionSymbols.push(`NFO:${pe.tradingsymbol}`);
            }
          }

          const fetchSymbols = [...symbols, ...optionSymbols];
          const quotes = await kiteInstance.getQuotes(fetchSymbols);
          
          if (quotes["NSE:NIFTY 50"]) {
            const spot = quotes["NSE:NIFTY 50"].last_price;
            const vix = quotes["NSE:INDIA VIX"]?.last_price || marketEngine.getVix();
            
            let chainData = [];
            if (optionSymbols.length > 0) {
              const fetchStrikes = Array.from(new Set(niftyInstruments.map(ins => ins.strike)));
              fetchStrikes.sort((a, b) => a - b);
              
              for (const strike of fetchStrikes) {
                const ceIns = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'CE');
                const peIns = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'PE');
                
                const ceQuote = ceIns ? quotes[`NFO:${ceIns.tradingsymbol}`] : null;
                const peQuote = peIns ? quotes[`NFO:${peIns.tradingsymbol}`] : null;
                
                if (ceQuote || peQuote) {
                  chainData.push({
                    strike,
                    ce_oi: ceQuote?.oi || 0,
                    ce_oi_change: ceQuote?.oi_day_high - ceQuote?.oi_day_low || 0,
                    pe_oi: peQuote?.oi || 0,
                    pe_oi_change: peQuote?.oi_day_high - peQuote?.oi_day_low || 0,
                    ce_price: ceQuote?.last_price || 0,
                    pe_price: peQuote?.last_price || 0,
                    iv: vix || 14,
                    delta: 0.5,
                  });
                }
              }
            }

            marketEngine.updateData(spot, chainData.length > 0 ? chainData : undefined, vix);
            // Log every 30 seconds approx if loop is 1s (30 ticks)
            if (Math.floor(Date.now() / 1000) % 30 === 0) {
               console.log(`[LIVE-SYNC] Spot: ${spot}, VIX: ${vix}, Chain: ${chainData.length} strikes. Expiry: ${allExpiries[0]}`);
            }
          }
        } catch (err) {
          console.error("Real-time data sync failed:", err);
        }
      }

      // 2. State Update
      try {
        await executionEngine.updatePnL();
      } catch (err) {
        console.error("[SYSTEM] PnL update failed:", err);
      }

      // 3. Autonomous Execution
      if (config.AUTO_MODE) {
        try {
          const decision = strategyEngine.calculateScore();
          const state = executionEngine.getState();

          // Simple Auto-Exit if profit target or SL reached
          if (state.pnl >= config.TARGET_RUPEES) {
             console.log("[AUTO] Target hit. Exiting...");
             await executionEngine.exitAll("Target Hit");
          } else if (state.pnl <= -config.SL_RUPEES) {
             console.log("[AUTO] SL hit. Exiting...");
             await executionEngine.exitAll("SL Hit");
          }

          // Entry Logic (Only if no active position)
          if (state.positions.length === 0 && state.rollsToday < config.MAX_ROLLS) {
             if (decision.bias === 'BULLISH' && decision.total >= 70) {
                console.log("[AUTO] Bulls dominance detected. Entering PE Short...");
                await executionEngine.executeTrade('BULLISH');
             } else if (decision.bias === 'BEARISH' && decision.total >= 70) {
                console.log("[AUTO] Bears dominance detected. Entering CE Short...");
                await executionEngine.executeTrade('BEARISH');
             }
          }
        } catch (err) {
          console.error("Autonomous execution engine error:", err);
        }
      }
    }, 1000);

  app.get("/ping", (req, res) => res.send("pong"));

  const apiRouter = express.Router();

  apiRouter.post("/kite/config", (req, res) => {
    const { key, secret } = req.body;
    if (key) apiKey = key;
    if (secret) apiSecret = secret;
    
    if (key) {
      kiteInstance = new KiteConnect({ api_key: key });
      console.log(`[AUTH] Kite API key updated dynamically: ${key.substring(0, 4)}...`);
    }
    
    res.json({ 
      success: true, 
      hasConfig: !!(apiKey && apiSecret) 
    });
  });

  // Kite Auth Routes
  apiRouter.get("/kite/url", (req, res) => {
    if (!apiKey) {
      return res.status(400).json({ error: "KITE_API_KEY not configured" });
    }
    
    // AI Studio uses proxies, so we check for forwarded headers first
    const host = req.get("x-forwarded-host") || req.get("host");
    const protocol = req.get("x-forwarded-proto") || (host?.includes("localhost") ? "http" : "https");
    
    const redirectUrl = process.env.KITE_REDIRECT_URL || `${protocol}://${host}/api/kite/callback`;
    console.log(`[AUTH] Generating login URL with redirect: ${redirectUrl}`);
    
    const loginUrl = `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}&redirect_url=${encodeURIComponent(redirectUrl)}`;
    res.json({ url: loginUrl });
  });

  apiRouter.get("/kite/callback", async (req, res) => {
    const { request_token } = req.query;
    if (!request_token || !kiteInstance || !apiSecret) {
      return res.status(400).send("Invalid request or missing config");
    }

    try {
      const response = await kiteInstance.generateSession(request_token.toString(), apiSecret);
      accessToken = response.access_token;
      kiteInstance.setAccessToken(accessToken);

      // Background Fetch Instruments
      try {
        console.log("[SYSTEM] Fetching NFO instruments for NIFTY...");
        const instruments = await kiteInstance.getInstruments(["NFO"]);
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);

        const niftyAll = instruments.filter((ins: any) => 
          ins.name === 'NIFTY' && 
          ins.segment === 'NFO-OPT' &&
          new Date(ins.expiry) >= startOfToday
        );
        
        allExpiries = Array.from(new Set(niftyAll.map((i: any) => i.expiry))).sort();
        const nearestExpiry = allExpiries[0];
        niftyInstruments = niftyAll.filter((i: any) => i.expiry === nearestExpiry);
        
        console.log(`[SYSTEM] Cached ${niftyInstruments.length} NIFTY instruments for nearest expiry ${nearestExpiry}`);
        console.log(`[SYSTEM] Detected expiries: ${allExpiries.slice(0, 3).join(', ')}...`);
      } catch (e) {
        console.error("Failed to fetch instruments:", e);
      }

      res.send(`
        <html>
          <body style="background: #070b14; color: #3b82f6; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; gap: 20px;">
            <div style="text-align: center;">
              <h2 style="margin-bottom: 8px;">Authentication Successful</h2>
              <p style="color: #64748b; font-size: 14px;">Synchronizing with Quantum Core...</p>
            </div>
            <script>
              setTimeout(() => {
                try {
                  if (window.opener) {
                    window.opener.postMessage({ type: 'KITE_AUTH_SUCCESS', user: ${JSON.stringify(response.user_name)} }, '*');
                    window.close();
                  }
                } catch (e) {
                  console.error("Popup communication failed", e);
                }
                // Fallback redirect if window didn't close or wasn't a popup
                window.location.href = '/';
              }, 1500);
            </script>
          </body>
        </html>
      `);
    } catch (err) {
      console.error("Kite session error:", err);
      res.status(500).send("Authentication failed");
    }
  });

  apiRouter.get("/kite/status", (req, res) => {
    res.json({ 
      connected: !!accessToken,
      hasConfig: !!(apiKey && apiSecret)
    });
  });

  apiRouter.get("/backtest/historical", async (req, res) => {
    const { from, to, interval = "minute" } = req.query;
    
    if (!accessToken || !kiteInstance) {
      return res.status(401).json({ error: "Kite Connect not authorized. Please log in first." });
    }
    
    try {
      // Instrument token for NSE:NIFTY 50 is 256265
      const instrumentToken = 256265; 
      console.log(`[BACKTEST] Fetching historical data from ${from} to ${to}`);
      
      const candles = await kiteInstance.getHistoricalData(
        instrumentToken, 
        interval.toString(), 
        from?.toString(), 
        to?.toString()
      );
      
      res.json({
        symbol: "NIFTY 50",
        instrument_token: instrumentToken,
        candles
      });
    } catch (err) {
      console.error("[BACKTEST] Zerodha historical fetch failed:", err);
      res.status(500).json({ error: "Failed to fetch historical data from Zerodha. Ensure you have the 'Historical Data' add-on active." });
    }
  });

  // Data Routes
  apiRouter.get("/market-data", (req, res) => {
    res.json({
      spot: marketEngine.getSpotPrice(),
      vix: marketEngine.getVix(),
      pcr: marketEngine.getPCR(),
      tick: marketEngine.getLatestTick(),
      chain: marketEngine.getOptionChain(),
    });
  });

  apiRouter.get("/strategy-data", async (req, res) => {
    try {
      const score = strategyEngine.calculateScore();
      const aiProb = await aiEngine.predictWinProbability(score, []).catch(e => {
        console.error("[AI] Prediction failed:", e);
        return 50; // Neutral fallback
      });
      res.json({ score, aiProb });
    } catch (err) {
      console.error("[API] Strategy data route failed:", err);
      res.status(500).json({ error: "Failed to calculate strategy score" });
    }
  });

  apiRouter.get("/execution-state", (req, res) => {
    res.json({
      ...executionEngine.getState(),
      dataSource: config.DATA_SOURCE,
      executionMode: config.EXECUTION_MODE,
      autoMode: config.AUTO_MODE
    });
  });

  apiRouter.post("/toggle-data-mode", (req, res) => {
    const { mode } = req.body;
    setDataMode(mode);
    marketEngine.syncMode();
    res.json({ status: "success", dataSource: config.DATA_SOURCE });
  });

  apiRouter.post("/toggle-execution-mode", (req, res) => {
    const { mode } = req.body;
    setExecutionMode(mode);
    res.json({ status: "success", executionMode: config.EXECUTION_MODE });
  });

  apiRouter.post("/toggle-auto-mode", (req, res) => {
    const { mode } = req.body;
    setAutoMode(mode);
    res.json({ status: "success", autoMode: config.AUTO_MODE });
  });

  apiRouter.get("/market-info", (req, res) => {
    const holidays = [
      "2026-01-26", "2026-03-08", "2026-03-25", "2026-03-29", "2026-04-11",
      "2026-04-17", "2026-05-01", "2026-06-17", "2026-07-17", "2026-08-15",
      "2026-10-02", "2026-11-01", "2026-11-15", "2026-12-25"
    ];
    
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const nextHoliday = holidays.find(h => h >= today);
    
    // If we have real expiries from Zerodha, use them
    let weeklyExpiry = "";
    let monthlyExpiry = "";
    
    if (allExpiries.length > 0) {
      const formatExpiry = (dateStr: string) => {
        try {
          const d = new Date(dateStr);
          return d.toISOString().split('T')[0];
        } catch (e) {
          return dateStr;
        }
      };

      weeklyExpiry = formatExpiry(allExpiries[0]);
      
      // Find the last expiry of the current month
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      
      const currentMonthExpiries = allExpiries.filter(e => {
        const d = new Date(e);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      });
      
      if (currentMonthExpiries.length > 0) {
        monthlyExpiry = formatExpiry(currentMonthExpiries[currentMonthExpiries.length - 1]);
      } else {
        // If no more expiries this month, find the last of the next month
        const nextMonth = (currentMonth + 1) % 12;
        const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
        const nextMonthExpiries = allExpiries.filter(e => {
          const d = new Date(e);
          return d.getMonth() === nextMonth && d.getFullYear() === nextYear;
        });
        monthlyExpiry = formatExpiry(nextMonthExpiries[nextMonthExpiries.length - 1] || allExpiries[0]);
      }
      
      // Safety: If weekly is monthly (last week of month), monthly is the next one
      if (weeklyExpiry === monthlyExpiry && allExpiries.length > 1) {
         // This is fine, but maybe user wants "Actual Monthly Continous"
      }
    } else {
      // Fallback calculation
      const getNextThursday = (d: Date) => {
        const day = d.getDay();
        const diff = (day <= 4) ? (4 - day) : (11 - day);
        const next = new Date(d);
        next.setDate(d.getDate() + diff);
        return next.toISOString().split('T')[0];
      };

      const getMonthlyThursday = (d: Date) => {
        const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        const day = lastDay.getDay();
        const diff = (day >= 4) ? (day - 4) : (day + 3);
        const result = new Date(lastDay);
        result.setDate(lastDay.getDate() - diff);
        
        if (result.getTime() < d.getTime()) {
          const nextMonth = new Date(d.getFullYear(), d.getMonth() + 2, 0);
          const nDay = nextMonth.getDay();
          const nDiff = (nDay >= 4) ? (nDay - 4) : (nDay + 3);
          const nextResult = new Date(nextMonth);
          nextResult.setDate(nextMonth.getDate() - nDiff);
          return nextResult.toISOString().split('T')[0];
        }
        return result.toISOString().split('T')[0];
      };

      weeklyExpiry = getNextThursday(now);
      monthlyExpiry = getMonthlyThursday(now);
    }

    res.json({
      expiry: {
        weekly: weeklyExpiry,
        monthly: monthlyExpiry,
        daysToExpiry: weeklyExpiry ? Math.ceil((new Date(weeklyExpiry).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 0
      },
      holiday: {
        next: nextHoliday,
        isUpcoming: nextHoliday === today || (nextHoliday && (new Date(nextHoliday).getTime() - now.getTime()) / (1000 * 60 * 60 * 24) < 3)
      }
    });
  });

  apiRouter.get("/trade-logs", async (req, res) => {
    const logs = await tradeLogger.getLogs();
    res.json(logs);
  });

  apiRouter.post("/execute", (req, res) => {
    const { bias } = req.body;
    executionEngine.executeTrade(bias);
    res.json({ status: "success" });
  });

  apiRouter.post("/exit", async (req, res) => {
    await executionEngine.exitAll("User Manual Exit");
    res.json({ status: "success" });
  });

  app.use("/api", apiRouter);

  // Catch-all for API routes to prevent falling through to SPA fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`[V5.2] Quantum Server listening on port ${PORT}`);
  });

  } catch (err) {
    console.error("FATAL: Server failed to start:", err);
  }
}

startServer();
