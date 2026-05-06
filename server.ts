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

const apiKey = process.env.KITE_API_KEY;
const apiSecret = process.env.KITE_API_SECRET;

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
      if (config.DATA_SOURCE === 'LIVE' && kiteInstance && accessToken && currentTimeInMinutes < marketCloseTime) {
        try {
          const symbols = ["NSE:NIFTY 50"];
          const quotes = await kiteInstance.getQuotes(symbols);
          if (quotes["NSE:NIFTY 50"]) {
            const spot = quotes["NSE:NIFTY 50"].last_price;
            marketEngine.updateData(spot, marketEngine.getOptionChain());
          }
        } catch (err) {
          console.error("Real-time data sync failed:", err);
        }
      }

      // 2. State Update
      try {
        executionEngine.updatePnL();
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

      res.send(`
        <html>
          <body style="background: #070b14; color: #3b82f6; font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh;">
            <script>
              window.opener.postMessage({ type: 'KITE_AUTH_SUCCESS', user: ${JSON.stringify(response.user_name)} }, '*');
              window.close();
            </script>
            <div style="text-align: center;">
              <h2>Authentication Successful</h2>
              <p>Synchronizing with Quantum Core...</p>
            </div>
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

  // Data Routes
  apiRouter.get("/market-data", (req, res) => {
    res.json({
      spot: marketEngine.getSpotPrice(),
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
      "2024-01-26", "2024-03-08", "2024-03-25", "2024-03-29", "2024-04-11",
      "2024-04-17", "2024-05-01", "2024-06-17", "2024-07-17", "2024-08-15",
      "2024-10-02", "2024-11-01", "2024-11-15", "2024-12-25"
    ];
    
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const nextHoliday = holidays.find(h => h >= today);
    
    // Simple Next Thursday Weekly Expiry
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

    res.json({
      expiry: {
        weekly: getNextThursday(now),
        monthly: getMonthlyThursday(now),
        daysToExpiry: Math.ceil((new Date(getNextThursday(now)).getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      },
      holiday: {
        next: nextHoliday,
        isUpcoming: nextHoliday === today || (nextHoliday && (new Date(nextHoliday).getTime() - now.getTime()) / (1000 * 60 * 60 * 24) < 3)
      }
    });
  });

  apiRouter.get("/trade-logs", (req, res) => {
    res.json(tradeLogger.getLogs());
  });

  apiRouter.post("/execute", (req, res) => {
    const { bias } = req.body;
    executionEngine.executeTrade(bias);
    res.json({ status: "success" });
  });

  apiRouter.post("/exit", (req, res) => {
    executionEngine.exitAll("User Manual Exit");
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
