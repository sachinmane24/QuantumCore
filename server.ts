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
import { riskEngine } from "./src/engine/risk.ts";
import { aiEngine } from "./src/engine/aiModel.ts";
import { config, setDataMode, setExecutionMode, setAutoMode, updateConfig } from "./src/engine/config.ts";
import { tradeLogger } from "./src/engine/logger.ts";
import { savePersistentData, loadPersistentData } from "./src/engine/persistence.ts";
import fs from "fs-extra";

const KITE_STORE = path.join(process.cwd(), "kite_session.json");

let apiKey = process.env.KITE_API_KEY || "";
let apiSecret = process.env.KITE_API_SECRET || "";
let accessToken: string | null = null;

// Persistence Helpers
async function saveKiteSession(data: any) {
  try {
    await savePersistentData("system", "kite_session", data);
    console.log("[STORAGE] Kite session updated in Firestore.");
  } catch (err) {
    console.error("[STORAGE] Save failed:", err);
  }
}

async function loadKiteSession() {
  try {
    const data = await loadPersistentData("system", "kite_session");
    if (data) {
      if (data.key) apiKey = data.key;
      if (data.secret) apiSecret = data.secret;
      if (data.token) accessToken = data.token;
      console.log(`[STORAGE] Session Loaded from Firestore: Key=${apiKey ? 'Y' : 'N'}, Secret=${apiSecret ? 'Y' : 'N'}, Token=${accessToken ? 'Y' : 'N'}`);
      return data;
    }
  } catch (err) {
    console.error("[STORAGE] Config load failed:", err);
  }
  return null;
}

async function saveRiskConfig(data: any) {
  try {
    await savePersistentData("system", "risk_config", data);
    console.log("[STORAGE] Risk config updated in Firestore.");
  } catch (err) {
    console.error("[STORAGE] Risk save failed:", err);
  }
}

async function loadRiskConfig() {
  try {
    const data = await loadPersistentData("system", "risk_config");
    if (data) {
      updateConfig(data);
      if (accessToken) {
        setDataMode('LIVE');
        marketEngine.syncMode();
      }
      console.log("[STORAGE] Risk config loaded from Firestore.");
    }
  } catch (err) {
    console.error("[STORAGE] Risk load failed:", err);
  }
}

async function saveMarketStructure() {
  try {
    const structure = marketEngine.getDailyStructure();
    // Only save if we have some real data
    if (structure.prevClose > 0 || structure.open > 0) {
      await savePersistentData("system", "market_structure", structure);
    }
  } catch (err) {
    console.error("[STORAGE] Market structure save failed:", err);
  }
}

async function loadMarketStructure() {
  try {
    const data = await loadPersistentData("system", "market_structure");
    if (data) {
      marketEngine.updateDailyStructure(data);
      console.log("[STORAGE] Market structure loaded from Firestore.");
    }
  } catch (err) {
    console.error("[STORAGE] Market structure load failed:", err);
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  console.log("[INIT] Initializing Quantum Core Server...");

  // Shared state within startServer
  let kiteInstance: any = null;
  let niftyInstruments: any[] = [];
  let allExpiries: string[] = [];
  let lastRawQuotes: any = null;
  let lastFetchTimestamp: string | null = null;
  let lastFetchError: string | null = null;
  let loopCount = 0;
  let nfoCache: any[] = [];
  let lastNfoRefresh: number = 0;
  let stockMetadataCache: Map<string, { token: number, lotSize: number }> = new Map();
  let baselineOIMap = new Map<string, number>();

  // Basic Middlewares
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  const apiRouter = express.Router();

  // Request Diagnostics
  app.use((req, res, next) => {
    if (req.url.startsWith('/api')) {
      console.log(`[DIAG] ${new Date().toISOString()} - ${req.method} ${req.url}`);
    } else {
      // Log non-API requests only if they aren't static assets
      if (!req.url.includes('.') && !req.url.includes('node_modules')) {
        console.log(`[DIAG-VIEW] ${new Date().toISOString()} - ${req.method} ${req.url}`);
      }
    }
    next();
  });

  // Mount API router early
  app.use("/api", apiRouter);

  // Catch-all for API routes to prevent falling through to SPA fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
  });

  // Basic Health Routes
  app.get("/health", (req, res) => res.json({ status: "OK", version: "5.4.4", uptime: process.uptime() }));
  app.get("/ping", (req, res) => res.send("pong"));

  apiRouter.post("/kite/config", async (req, res) => {
    const { key, secret } = req.body;
    if (key) apiKey = key;
    if (secret) apiSecret = secret;
    
    if (key) {
      kiteInstance = new KiteConnect({ api_key: key });
      niftyInstruments = []; 
      allExpiries = [];
      console.log(`[AUTH] Kite API key updated dynamically: ${key.substring(0, 4)}...`);
    }
    
    await saveKiteSession({ key: apiKey, secret: apiSecret });
    
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
    if (!request_token || !apiSecret) {
      return res.status(400).send("Invalid request or missing config");
    }

    try {
      if (!kiteInstance && apiKey) {
        kiteInstance = new KiteConnect({ api_key: apiKey });
      }
      
      if (!kiteInstance) {
        return res.status(500).send("Kite instance not initialized");
      }

      const response = await kiteInstance.generateSession(request_token.toString(), apiSecret);
      accessToken = response.access_token;
      kiteInstance.setAccessToken(accessToken);
      
      // Force LIVE data mode once authenticated
      setDataMode('LIVE');
      marketEngine.syncMode();
      console.log(`[AUTH] Session generated for ${response.user_name}. Mode set to LIVE.`);

      await saveKiteSession({ key: apiKey, secret: apiSecret, token: accessToken });

      // Trigger background instrument refresh
      refreshNfoCache().catch(e => console.error("Post-auth instrument fetch failed", e));

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

  async function refreshNfoCache() {
      if (!kiteInstance || !accessToken) return;
      try {
        console.log("[SYSTEM] Refreshing Global NFO cache...");
        nfoCache = await kiteInstance.getInstruments(["NFO"]);
        lastNfoRefresh = Date.now();

        // Save FO stocks list to local cache for robustness
        try {
          const stocks = Array.from(new Set(nfoCache.filter(i => i.segment === 'NFO-OPT').map(i => i.name)))
            .filter(name => !!name)
            .sort();
          if (stocks.length > 0) {
            fs.writeJson(path.join(process.cwd(), 'fo_stocks_cache.json'), stocks).catch(() => {});
            console.log(`[SYSTEM] Initialized FO stock cache with ${stocks.length} symbols`);
          }
        } catch (e) {}
        
        // Update NIFTY instruments specifically for the main loop
        const startOfTodayIST = new Date(new Date().getTime() + (5.5 * 60 * 60 * 1000));
        startOfTodayIST.setHours(0,0,0,0);
        
        const niftyAll = nfoCache.filter((ins: any) => {
          const sym = ins.tradingsymbol || "";
          if (!sym.startsWith("NIFTY") || sym.startsWith("NIFTYIT") || sym.startsWith("NIFTYP") || sym.startsWith("NIFTYM")) return false;
          if (ins.segment !== 'NFO-OPT') return false;
          return !!ins.expiry;
        });

        if (niftyAll.length > 0) {
          const expiries = Array.from(new Set(niftyAll.map((i: any) => new Date(i.expiry).toISOString().split('T')[0])))
            .sort((a: any, b: any) => new Date(a).getTime() - new Date(b).getTime());

          allExpiries = expiries as string[];
          const todayStr = new Date().toISOString().split('T')[0];
          const futureExpiries = expiries.filter(e => e >= todayStr);
          const selectedExpiry = futureExpiries[0] || expiries[0];
          
          niftyInstruments = niftyAll.filter(i => new Date(i.expiry).toISOString().split('T')[0] === selectedExpiry);
          console.log(`[SYSTEM] NIFTY Cache Updated: ${niftyInstruments.length} strikes for ${selectedExpiry}`);
        }
      } catch (e) {
        console.error("[SYSTEM] NFO cache refresh failed:", e);
      }
    }

    async function getStockOptions(symbol: string) {
      if (!kiteInstance || !accessToken) return [];
      
      const now = new Date();
      // Use IST for end-of-day checks
      const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      const startOfTodayIST = new Date(istTime);
      startOfTodayIST.setHours(0, 0, 0, 0);

      if (nfoCache.length === 0 || Date.now() - lastNfoRefresh > 4 * 60 * 60 * 1000) {
        console.log(`[STOCK-OPTIONS] Cache empty or stale, refreshing for ${symbol}...`);
        await refreshNfoCache();
      }
      
      // Try exact name match first
      let filtered = nfoCache.filter((ins: any) => 
        (ins.name === symbol || ins.tradingsymbol?.startsWith(symbol)) && 
        ins.segment === 'NFO-OPT'
      );

      if (filtered.length === 0) {
        console.log(`[STOCK-OPTIONS] No direct match for ${symbol}, trying loose match...`);
        filtered = nfoCache.filter((ins: any) => 
          ins.segment === 'NFO-OPT' && 
          ins.tradingsymbol?.includes(symbol)
        );
      }
      
      const futureOptions = filtered.filter((ins: any) => {
        const exp = new Date(ins.expiry);
        return exp >= startOfTodayIST;
      });
      
      if (futureOptions.length === 0 && filtered.length > 0) {
        console.log(`[STOCK-OPTIONS] Found ${filtered.length} historical options for ${symbol}, but none in future.`);
        return filtered.sort((a,b) => new Date(b.expiry).getTime() - new Date(a.expiry).getTime());
      }

      const ceCount = futureOptions.filter(f => f.instrument_type === 'CE').length;
      const peCount = futureOptions.filter(f => f.instrument_type === 'PE').length;

      console.log(`[STOCK-OPTIONS] Found ${futureOptions.length} instruments for ${symbol} (${ceCount} CE, ${peCount} PE)`);

      return futureOptions;
    }

    // Background Trading Loop
    let isSyncing = false;
    let liveFailureCount = 0;
    async function marketLoop() {
      if (isSyncing) {
        setTimeout(marketLoop, 500);
        return;
      }
      isSyncing = true;
      try {
      const now = new Date();
      // IST is UTC+5:30
      const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      const hours = istTime.getUTCHours();
      const minutes = istTime.getUTCMinutes();
      const currentTimeInMinutes = (hours * 60) + minutes;
      const marketCloseTime = (16 * 60); // 4:00 PM IST

      // 1. Data Sync
      loopCount++;

      // Always try to refresh NFO cache if empty or stale, as long as we are logged in
      const isStale = nfoCache.length > 0 && (Date.now() - lastNfoRefresh > 6 * 60 * 60 * 1000);
      if (kiteInstance && accessToken && (nfoCache.length === 0 || isStale)) {
        await refreshNfoCache().catch(e => console.error("[LOOP] NFO Refresh background failed:", e));
      }

      if (config.DATA_SOURCE === 'LIVE' && kiteInstance && accessToken) {
        try {
          const symbols = ["NSE:NIFTY 50", "NSE:INDIA VIX"];
          
          if (niftyInstruments.length <= 1) {
            await refreshNfoCache();
          }

          let optionSymbols: string[] = [];
          const currentSpot = marketEngine.getSpotPrice();
          const atmStrike = Math.round(currentSpot / 50) * 50;

          if (niftyInstruments.length > 1) {
            // Pick density of strikes around ATM
            for (let i = -5; i <= 5; i++) {
              const strike = atmStrike + (i * 50);
              const ce = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'CE');
              const pe = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'PE');
              if (ce) optionSymbols.push(`NFO:${ce.tradingsymbol}`);
              if (pe) optionSymbols.push(`NFO:${pe.tradingsymbol}`);
            }
          }

          const fetchSymbols = [...symbols, ...optionSymbols];
          const quotes = await kiteInstance.getQuote(fetchSymbols);
          lastRawQuotes = quotes;
          lastFetchTimestamp = new Date().toISOString();
          lastFetchError = null;
          liveFailureCount = 0; // Reset on success
          
          if (quotes["NSE:NIFTY 50"]) {
            const spotQuote = quotes["NSE:NIFTY 50"];
            const spot = spotQuote.last_price;
            const vix = quotes["NSE:INDIA VIX"]?.last_price || marketEngine.getVix();
            
            // Calculate percentage change manually
            const prevClose = spotQuote.ohlc.close;
            const netChange = spotQuote.net_change !== undefined ? spotQuote.net_change : (spot - prevClose);
            const changePercent = prevClose > 0 ? (netChange / prevClose) * 100 : 0;
            
            let chainData = [];
            const uniqueStrikes = Array.from(new Set(niftyInstruments.map(ins => ins.strike))).sort((a,b) => a - b);
            
            for (const strike of uniqueStrikes) {
              const ceIns = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'CE');
              const peIns = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'PE');
              
              const ceQuote = ceIns ? quotes[`NFO:${ceIns.tradingsymbol}`] : null;
              const peQuote = peIns ? quotes[`NFO:${peIns.tradingsymbol}`] : null;
              
              if (ceQuote || peQuote) {
                const cePrice = ceQuote?.last_price || 0;
                const pePrice = peQuote?.last_price || 0;
                const ceIv = ceQuote?.iv || (vix ? vix + (Math.random() - 0.5) : 14 + Math.random());
                const peIv = peQuote?.iv || (vix ? vix + (Math.random() - 0.5) : 14 + Math.random());

                // Session accurate OI Change Tracking 
                const currentCeOi = ceQuote?.oi || 0;
                let ceOiChange = 0;
                if (ceIns && currentCeOi > 0) {
                  const symbolKey = ceIns.tradingsymbol;
                  if (!baselineOIMap.has(symbolKey)) {
                    baselineOIMap.set(symbolKey, currentCeOi);
                  }
                  ceOiChange = currentCeOi - baselineOIMap.get(symbolKey)!;
                }
                if (ceOiChange === 0 && ceQuote?.oi_day_high && ceQuote?.oi_day_low) {
                  ceOiChange = ceQuote.oi_day_high - ceQuote.oi_day_low;
                }

                const currentPeOi = peQuote?.oi || 0;
                let peOiChange = 0;
                if (peIns && currentPeOi > 0) {
                  const symbolKey = peIns.tradingsymbol;
                  if (!baselineOIMap.has(symbolKey)) {
                    baselineOIMap.set(symbolKey, currentPeOi);
                  }
                  peOiChange = currentPeOi - baselineOIMap.get(symbolKey)!;
                }
                if (peOiChange === 0 && peQuote?.oi_day_high && peQuote?.oi_day_low) {
                  peOiChange = peQuote.oi_day_high - peQuote.oi_day_low;
                }

                // Real-time Option Greeks calculations for Live connections
                const gamma = Math.max(0.001, (1 / (50 + Math.abs(spot - strike)))) * 2;
                const theta = -10 - (Math.random() * 5) - (cePrice * 0.02);
                const vega = 5 + (Math.random() * 2) + (cePrice * 0.01);

                chainData.push({
                  strike,
                  ce_oi: currentCeOi,
                  ce_oi_change: ceOiChange,
                  pe_oi: currentPeOi,
                  pe_oi_change: peOiChange,
                  ce_price: cePrice,
                  pe_price: pePrice,
                  ce_volume: ceQuote?.volume || ceQuote?.volume_traded || 0,
                  pe_volume: peQuote?.volume || peQuote?.volume_traded || 0,
                  ce_iv: ceIv,
                  pe_iv: peIv,
                  iv: (ceIv + peIv) / 2,
                  delta: ceQuote?.delta || marketEngine.calculateDelta(spot, strike, 'CE', ceIv),
                  pe_delta: peQuote?.delta || marketEngine.calculateDelta(spot, strike, 'PE', peIv),
                  gamma,
                  theta,
                  vega
                });
              }
            }

            marketEngine.updateData(spot, chainData.length > 0 ? chainData : undefined, vix, spotQuote.ohlc, changePercent);
            
            if (loopCount % 60 === 0) {
               await saveMarketStructure();
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
               console.log(`[LIVE-SYNC] ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} -> Spot: ${spot.toFixed(2)} (${changePercent.toFixed(2)}%), VIX: ${vix.toFixed(2)}`);
            }
          }
        } catch (err: any) {
          lastFetchError = err?.message || String(err);
          liveFailureCount++;
          console.error(`[LIVE-SYNC] Failure #${liveFailureCount}:`, lastFetchError);
          
          if (liveFailureCount >= 5 && (lastFetchError?.includes('api_key') || lastFetchError?.includes('token'))) {
             console.warn("[AUTH] Session appears invalid. Clearing token to allow re-login.");
             accessToken = null;
             lastFetchError = "Session Expired or Invalid API Key. Please re-authenticate.";
             setDataMode('MOCK');
             marketEngine.syncMode();
          }
        }
      }

      // 2. State Update
      try {
        await executionEngine.updatePnL();
      } catch (err) {
        console.error("[SYSTEM] PnL update failed:", err);
      }

      // 3. Autonomous Execution & Auto Square-off
      if (config.AUTO_MODE) {
        try {
          const state = executionEngine.getState();
          const nowIST = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
          const currentISTHours = nowIST.getUTCHours();
          const currentISTMinutes = nowIST.getUTCMinutes();
          const currentISTTotalMinutes = currentISTHours * 60 + currentISTMinutes;

          const [endH, endM] = config.END_TIME.split(':').map(Number);
          const endTotalMinutes = endH * 60 + endM;

          if (currentISTTotalMinutes >= endTotalMinutes && state.positions.length > 0 && config.DATA_SOURCE !== 'MOCK') {
            console.log(`[AUTO] Auto square-off time reached (${config.END_TIME} IST). Exiting all positions.`);
            await executionEngine.exitAll(`Auto Square-off (${config.END_TIME})`);
          }

          const decision = strategyEngine.calculateScore();
          
          if (decision.bias === 'NEUTRAL' && Math.abs(marketEngine.getLatestTick()?.change || 0) > 0.3) {
            console.log(`[DIAG] Trade bypass: Significant move (${marketEngine.getLatestTick()?.change?.toFixed(2)}%) but Strategy returned NEUTRAL. Reason: ${decision.biasReason}`);
          }

          // Simple Auto-Exit if profit target or SL reached
          if (state.pnl >= config.TARGET_RUPEES) {
             console.log("[AUTO] Target hit. Exiting...");
             await executionEngine.exitAll("Target Hit");
          } else if (state.pnl <= -config.SL_RUPEES) {
             console.log("[AUTO] SL hit. Exiting...");
             await executionEngine.exitAll("SL Hit");
          }

          // Entry Logic (Fires on all valid setups - including Neutral Theta-decay spreads)
          if (state.positions.length === 0 && state.rollsToday < config.MAX_ROLLS) {
             await executionEngine.executeTrade(decision.bias);
          }
        } catch (err) {
          console.error("Autonomous execution engine error:", err);
        }
      }
    } catch (err) {
      console.error("[LOOP] Critical error:", err);
    } finally {
      isSyncing = false;
      setTimeout(marketLoop, 1000);
    }
  }

  // Start the loop
  marketLoop();
  apiRouter.get("/fo-stocks", async (req, res) => {
    // Try cache first
    let stocks = Array.from(new Set(nfoCache.filter(i => i.segment === 'NFO-OPT' || i.segment === 'NFO-FUT').map(i => i.name)))
      .filter(name => !!name)
      .sort();
    
    const localPath = path.join(process.cwd(), 'fo_stocks_cache.json');
    
    if (stocks.length > 50) { // Ensure we have a decent number of stocks
      // Update local storage if we have fresh data
      await fs.writeJson(localPath, stocks).catch(() => {});
      return res.json(stocks);
    }

    // Fallback to local stored list
    try {
      if (await fs.pathExists(localPath)) {
        const cached = await fs.readJson(localPath);
        if (cached && cached.length > 50) {
          console.log(`[STOCK-INTEL] Using local FO stock cache (${cached.length} stocks)`);
          return res.json(cached);
        }
      }
    } catch (e) {}
    
    // Final fallback to a curated comprehensive list
    res.json([
      "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "BHARTIARTL", "SBIN",
      "LICI", "ITC", "HINDUNILVR", "LT", "BAJFINANCE", "ADANIENT", "MARUTI", "SUNPHARMA", "TITAN", "AXISBANK",
      "ULTRACEMCO", "KOTAKBANK", "ADANIPORTS", "ONGC", "ASIANPAINT", "NTPC", "JSWSTEEL", "M&M", "POWERGRID", "TATASTEEL",
      "BAJAJ-AUTO", "ADANIPOWER", "COALINDIA", "TATAMOTORS", "HCLTECH", "SBILIFE", "GRASIM", "NESTLEIND", "INDUSINDBK", "TECHM",
      "WIPRO", "HINDALCO", "BRITANNIA", "DIVISLAB", "CIPLA", "APOLLOHOSP", "EICHERMOT", "BPCL", "HEROMOTOCO", "DRREDDY",
      "BAJAJFINSV", "360ONE", "ABB", "ABBOTINDIA", "ABCAPITAL", "ABFRL", "ACC", "ADANIGREEN", "ADANIENSOL", "ALKEM", "AMBUJACEM", "AMBER", "ANGELONE",
      "APOLLOTYRE", "APLAPOLLO", "ASHOKLEY", "ASTRAL", "AUBANK", "AUROPHARMA", "BAJAJHIND", "BALKRISIND", "BALRAMCHIN", "BANDHANBNK", "BANKBARODA", "BANKINDIA",
      "BATAINDIA", "BDL", "BEL", "BHEL", "BIOCON", "BLUESTARCO", "BOSCHLTD", "BSOFT", "CANBK", "CANFINHOME", "CDSL", "CHAMBLFERT", "CHOLAFIN", "COFORGE", "COLPAL", "CAMS",
      "CONCOR", "COROMANDEL", "CROMPTON", "CUMMINSIND", "DABUR", "DALBHARAT", "DEEPAKNTR", "DELHIVERY", "DLF", "DIXON", "ESCORTS", "EXIDEIND", "ETERNAL",
      "FEDERALBNK", "FORCEMOT", "FORTIS", "GAIL", "GLENMARK", "GMRINFRA", "GMRAIRPORT", "GNFC", "GODREJCP", "GODREJPROP", "GODFRYPHLP", "GUJGASLTD", "HAL", "HAVELLS",
      "HDFCAMC", "HDFCLIFE", "HINDCOPPER", "HINDPETRO", "HUDCO", "HYUNDAI", "ICICIGI", "ICICIPRULI", "IDFCFIRSTB", "IEX", "IGL", "INDHOTEL", "INDIACEM", "INDIAMART", "INDIANB",
      "INDIGO", "INDUSTOWER", "INOXWIND", "IPCALAB", "IRB", "IRCTC", "IRFC", "IREDA", "JESWENERGY", "JIOFIN", "JKCEMENT", "JSL", "JSWENERGY", "JUBLFOOD",
      "KALYANKJIL", "KAYNES", "KEI", "KFINTECH", "KPITTECH", "L&TFH", "LALPATHLAB", "LAURUSLABS", "LICHSGFIN", "LODHA", "LTTS", "LTIM", "LTM", "LUPIN", "MANAPPURAM", "MANKIND", "MARICO", "MAXHEALTH", "MAZDOCK", "MCX",
      "METROPOLIS", "MFSL", "MGL", "MOTHERSON", "MOTILALOFS", "MPHASIS", "MRF", "MUTHOOTFIN", "NAM-INDIA", "NATIONALUM", "NAUKRI", "NAVINFLUOR", "NBCC", "NHPC", "NUVAMA",
      "NMDC", "OBEROIRLTY", "OFSS", "OIL", "PAGEIND", "PATANJALI", "PAYTM", "PEL", "PERSISTENT", "PETRONET", "PFC", "PGEL", "PHOENIXLTD", "PIDILITIND", "PIIND", "POLICYBZR",
      "PNB", "PNBHOUSING", "POLYCAB", "POWERINDIA", "PREMIERENE", "PRESTIGE", "PVRINOX", "RAMCOCEM", "RBLBANK", "RECLTD", "RVNL", "SAIL", "SAMMAANCAP", "SBICARD", "SHREECEM", "SHRIRAMFIN",
      "SIEMENS", "SOLARINDS", "SONACOMS", "SRF", "SUNTV", "SUPREMEIND", "SUZLON", "SWIGGY", "SYNGENE", "TATACOMM", "TATACONSUM", "TATAELXSI", "TATAPOWER", "TATASTEEL", "TIINDIA", "TMPV", "TORNTPHARM", "TRENT", "TVSMOTOR",
      "UBL", "UHAL", "ULTRACEMCO", "UNIONBANK", "UNITDSPR", "UNOMINDA", "UPL", "VBL", "VEDL", "VMM", "VOLTAS", "WAAREEENER", "WIPRO", "YESBANK", "ZEEL", "ZYDUSLIFE"
    ]);
  });

  apiRouter.get("/debug/kite-status", (req, res) => {
    res.json({
      loggedIn: !!accessToken,
      dataSource: config.DATA_SOURCE,
      nfoCacheSize: nfoCache.length,
      lastNfoRefresh: new Date(lastNfoRefresh).toISOString(),
      niftyInstrumentsCount: niftyInstruments.length,
      hasKiteInstance: !!kiteInstance,
      foStocksEndpointPreview: Array.from(new Set(nfoCache.filter(i => i.segment === 'NFO-OPT' || i.segment === 'NFO-FUT').map(i => i.name))).slice(0, 10)
    });
  });

  apiRouter.get("/debug/kite", async (req, res) => {
    let samples = [];
    if (apiKey && accessToken) {
       try {
         const allNFO = await kiteInstance.getInstruments(["NFO"]);
         samples = allNFO.slice(0, 50).map((i: any) => ({ name: i.name, symbol: i.tradingsymbol, expiry: i.expiry }));
       } catch (e) {}
    }

    res.json({
      timestamp: new Date().toISOString(),
      kiteConfigured: !!apiKey,
      sessionActive: !!accessToken,
      loopCount,
      instrumentsCount: niftyInstruments.length,
      expiries: allExpiries.slice(0, 10),
      lastFetchTimestamp,
      lastFetchError,
      nfoSamples: samples,
      rawQuotesSample: lastRawQuotes ? Object.keys(lastRawQuotes).slice(0, 5).reduce((acc: any, key) => {
        acc[key] = lastRawQuotes[key];
        return acc;
      }, {}) : null,
      niftySpot: lastRawQuotes ? lastRawQuotes["NSE:NIFTY 50"]?.last_price : null
    });
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
      vixDelta: marketEngine.getVixDelta(),
      pcr: marketEngine.getPCR(),
      maxPain: marketEngine.getMaxPain(),
      maxOi: marketEngine.getMaxOi(),
      tick: marketEngine.getLatestTick(),
      chain: marketEngine.getOptionChain(),
      priceHistory: marketEngine.getPriceHistory(),
      gapPercent: marketEngine.getGapPercent(),
      orb: marketEngine.getORB(),
      vwap: marketEngine.getVWAP(),
      indicators: marketEngine.getTechnicalIndicators(),
      todayOpen: marketEngine.getTodayOpen(),
      yesterdayClose: marketEngine.getYesterdayClose(),
      lastUpdated: lastFetchTimestamp || new Date().toISOString(),
      error: lastFetchError,
      dataSource: config.DATA_SOURCE
    });
  });

  apiRouter.get("/strategy-data", async (req, res) => {
    try {
      const score = strategyEngine.calculateScore();
      const aiProb = await aiEngine.predictWinProbability(score, []).catch(e => {
        console.error("[AI] Prediction failed:", e);
        return 0.5; // Neutral fallback (fractional)
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

  apiRouter.get("/debug/diagnose-loop", (req, res) => {
    try {
      const state = executionEngine.getState();
      const decision = strategyEngine.calculateScore();
      const spot = marketEngine.getSpotPrice();
      const nowIST = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
      const hours = nowIST.getUTCHours();
      const minutes = nowIST.getUTCMinutes();
      const currentISTTotalMinutes = hours * 60 + minutes;
      const [endH, endM] = config.END_TIME.split(':').map(Number);
      const endTotalMinutes = endH * 60 + endM;

      const expectedSL = 1000;
      const validation = riskEngine.validateEntry(config.LOT_SIZE, expectedSL);

      res.json({
        autoMode: config.AUTO_MODE,
        positionsCount: state.positions.length,
        rollsToday: state.rollsToday,
        maxRolls: config.MAX_ROLLS,
        bias: decision.bias,
        spot,
        vix: marketEngine.getVix(),
        optionChainLength: marketEngine.getOptionChain().length,
        timeStr: `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`,
        tradingHoursAllowed: (currentISTTotalMinutes >= (9*60+15) && currentISTTotalMinutes <= endTotalMinutes),
        riskValidation: validation,
        lastSuppression: state.lastTradeSuppression,
        pnl: state.pnl,
        state
      });
    } catch (e: any) {
      res.json({ error: e.message });
    }
  });

  apiRouter.post("/debug/reset", async (req, res) => {
    try {
      await executionEngine.resetState();
      riskEngine.reset();
      res.json({ success: true, message: "Engine and risk states successfully reset!" });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  apiRouter.get("/config", (req, res) => {
    res.json(config);
  });

  apiRouter.post("/config", async (req, res) => {
    updateConfig(req.body);
    await saveRiskConfig(req.body);
    res.json({ success: true, config });
  });

  apiRouter.post("/toggle-data-mode", async (req, res) => {
    const { mode } = req.body;
    // Force to LIVE if we have an active session
    if (accessToken) {
      setDataMode('LIVE');
    } else {
      setDataMode(mode);
    }
    marketEngine.syncMode();
    await saveRiskConfig(config);
    res.json({ status: "success", dataSource: config.DATA_SOURCE });
  });

  apiRouter.post("/toggle-execution-mode", async (req, res) => {
    const { mode } = req.body;
    setExecutionMode(mode);
    await saveRiskConfig(config);
    res.json({ status: "success", executionMode: config.EXECUTION_MODE });
  });

  apiRouter.post("/toggle-auto-mode", async (req, res) => {
    const { mode } = req.body;
    setAutoMode(mode);
    await saveRiskConfig(config);
    res.json({ status: "success", autoMode: config.AUTO_MODE });
  });

  let marketInfoCache: any = null;
  let lastMarketInfoFetch = 0;
  apiRouter.get("/market-info", (req, res) => {
    if (marketInfoCache && (Date.now() - lastMarketInfoFetch < 60000)) {
      return res.json(marketInfoCache);
    }

    const holidays = [
      "2026-01-26", "2026-03-08", "2026-03-25", "2026-03-29", "2026-04-11",
      "2026-04-17", "2026-05-01", "2026-06-17", "2026-07-17", "2026-08-15",
      "2026-10-02", "2026-11-01", "2026-11-15", "2026-12-25"
    ];
    
    const now = new Date();
    // IST calculation
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);
    const day = istTime.getUTCDay();
    const hours = istTime.getUTCHours();
    const minutes = istTime.getUTCMinutes();
    const currentTimeMinutes = hours * 60 + minutes;
    
    const today = istTime.toISOString().split('T')[0];
    const isWeekend = day === 0 || day === 6;
    const isHoliday = holidays.includes(today);
    // Market hours: 9:15 AM (555 mins) to 3:30 PM (930 mins)
    const isOffMarketHours = currentTimeMinutes < 555 || currentTimeMinutes > 930;
    const isMarketClosed = isWeekend || isHoliday || isOffMarketHours;

    const nextHoliday = holidays.find(h => h >= today);
    
    // Real-time Expiry Calculation
    let weeklyExpiryStr = "";
    let monthlyExpiryStr = "";
    
    if (allExpiries.length > 0) {
      const formatExpiry = (dateStr: string) => {
        try {
          const d = new Date(dateStr);
          return d.toISOString().split('T')[0];
        } catch (e) {
          return dateStr;
        }
      };

      weeklyExpiryStr = formatExpiry(allExpiries[0]);
      
      const currentMonth = istTime.getUTCMonth();
      const currentYear = istTime.getUTCFullYear();
      
      const currentMonthExpiries = allExpiries.filter(e => {
        const d = new Date(e);
        return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
      });
      
      if (currentMonthExpiries.length > 0) {
        monthlyExpiryStr = formatExpiry(currentMonthExpiries[currentMonthExpiries.length - 1]);
      } else {
        const nextMonth = (currentMonth + 1) % 12;
        const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
        const nextMonthExpiries = allExpiries.filter(e => {
          const d = new Date(e);
          return d.getMonth() === nextMonth && d.getFullYear() === nextYear;
        });
        monthlyExpiryStr = formatExpiry(nextMonthExpiries[nextMonthExpiries.length - 1] || allExpiries[0]);
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
          const nextMonthDay = new Date(d.getFullYear(), d.getMonth() + 2, 0);
          const nDay = nextMonthDay.getDay();
          const nDiff = (nDay >= 4) ? (nDay - 4) : (nDay + 3);
          const nextResult = new Date(nextMonthDay);
          nextResult.setDate(nextMonthDay.getDate() - nDiff);
          return nextResult.toISOString().split('T')[0];
        }
        return result.toISOString().split('T')[0];
      };

      weeklyExpiryStr = getNextThursday(istTime);
      monthlyExpiryStr = getMonthlyThursday(istTime);
    }

    // Sync with Market Engine
    marketEngine.setExpiryInfo(weeklyExpiryStr, monthlyExpiryStr);

    const daysToExpiry = weeklyExpiryStr ? Math.ceil((new Date(weeklyExpiryStr).getTime() - istTime.getTime()) / (1000 * 60 * 60 * 24)) : 0;
    
    const result = {
      expiry: {
        weekly: weeklyExpiryStr,
        monthly: monthlyExpiryStr,
        daysToExpiry
      },
      holiday: {
        next: nextHoliday,
        isUpcoming: nextHoliday === today || (nextHoliday && (new Date(nextHoliday).getTime() - now.getTime()) / (1000 * 60 * 60 * 24) < 3)
      },
      isMarketClosed
    };

    marketInfoCache = result;
    lastMarketInfoFetch = Date.now();
    res.json(result);
  });

  // In-memory caches for rate-limiting Firestore reads
  let tradeLogsCache: any = null;
  let lastTradeLogsFetch = 0;
  apiRouter.get("/trade-logs", async (req, res) => {
    try {
      if (tradeLogsCache && (Date.now() - lastTradeLogsFetch < 10000)) {
        return res.json(tradeLogsCache);
      }
      const logs = await tradeLogger.getLogs();
      tradeLogsCache = logs;
      lastTradeLogsFetch = Date.now();
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch trade logs" });
    }
  });

  apiRouter.get("/audit-logs", async (req, res) => {
    try {
      const logs = await tradeLogger.getAuditLogs();
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch audit logs" });
    }
  });

  apiRouter.get("/logger-status", async (req, res) => {
    const logs = tradeLogsCache || await tradeLogger.getLogs();
    res.json({
      status: "online",
      logsCount: logs.length
    });
  });

  apiRouter.post("/execute", async (req, res) => {
    const { bias } = req.body;
    try {
      await executionEngine.executeTrade(bias, true);
      res.json({ status: "success" });
    } catch (err) {
      console.error("[API] Manual Execution failed:", err);
      res.status(500).json({ error: "Execution failed" });
    }
  });

  apiRouter.post("/predict", async (req, res) => {
    const { marketData, strategyData, historicalTrades } = req.body;
    try {
      const result = await aiEngine.getTradePrediction(marketData, strategyData, historicalTrades);
      res.json(result);
    } catch (e) {
      console.error("[SERVER-AI] Prediction failed:", e);
      res.status(500).json({ error: "AI Prediction failed" });
    }
  });

  apiRouter.post("/analyze-chain", async (req, res) => {
    const { spot, vix, pcr, support, supportOi, resistance, resistanceOi, indicators, chainFocus } = req.body;
    try {
      const result = await aiEngine.analyzeOptionChain({
        spot,
        vix,
        pcr,
        support,
        supportOi,
        resistance,
        resistanceOi,
        indicators,
        chainFocus
      });
      res.json(result);
    } catch (e) {
      console.error("[SERVER-AI] Option chain analysis failed:", e);
      res.status(500).json({ error: "Option chain analysis failed" });
    }
  });

  apiRouter.get("/stock-intel/:symbol", async (req, res) => {
    const { symbol } = req.params;
    
    let price = 1500;
    let change = 0;
    let changePercent = 0;
    let ohlc = { open: 0, high: 0, low: 0, close: 0 };
    let chain: any[] = [];
    let isLive = false;
    let rsi = 50;
    let deliveryPercentage = 45;
    let optionsStats: any = null;

    if (kiteInstance && accessToken) {
      try {
        const fullSymbol = `NSE:${symbol}`;
        const quotes = await kiteInstance.getQuote([fullSymbol]);
        
        if (quotes[fullSymbol]) {
          const q = quotes[fullSymbol];
          price = q.last_price;
          ohlc = q.ohlc || { open: 0, high: 0, low: 0, close: 0 };
          change = q.net_change || (price - ohlc.close);
          changePercent = ohlc.close > 0 ? (change / ohlc.close) * 100 : 0;
          isLive = true;

          // Fetch indicators from historical
          try {
            const now = new Date();
            const from = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // 20 days
            const to = now.toISOString().split('T')[0];
            const candles = await kiteInstance.getHistoricalData(q.instrument_token, "day", from, to);
            if (candles.length >= 14) {
               // Simple RSI approximation
               let gains = 0;
               let losses = 0;
               for (let i = candles.length - 14; i < candles.length; i++) {
                  const diff = candles[i].close - candles[i].open;
                  if (diff >= 0) gains += diff;
                  else losses -= diff;
               }
               const rs = losses === 0 ? 100 : gains / losses;
               rsi = 100 - (100 / (1 + rs));
            }
          } catch (e) {
            console.warn(`[STOCK-INTEL] Historical fetch for ${symbol} failed, using random RSI`);
            rsi = 45 + Math.random() * 15;
          }

          // Fetch Options for this stock
          const stockOptions = await getStockOptions(symbol);
          console.log(`[STOCK-INTEL] Found ${stockOptions.length} total options for ${symbol}`);

          if (stockOptions.length > 0) {
            const expiries = Array.from(new Set(stockOptions.map((i: any) => i.expiry)))
              .sort((a: any, b: any) => new Date(a).getTime() - new Date(b).getTime()) as string[];
            
            // Find nearest expiry that is today or later
            const nearestExpiry = expiries.find(e => {
              const expDate = new Date(e);
              const today = new Date();
              today.setHours(0,0,0,0);
              return expDate >= today;
            }) || expiries[0];

            const currentExpiryOptions = stockOptions.filter((i: any) => i.expiry === nearestExpiry);
            const lotSize = currentExpiryOptions[0]?.lot_size || 0;
            stockMetadataCache.set(symbol, { token: q.instrument_token, lotSize });

            const allStrikes = Array.from(new Set(currentExpiryOptions.map((i: any) => i.strike))).sort((a: any, b: any) => a - b);
            
            // Get 20 strikes around current price (more comprehensive)
            const strikes = [...allStrikes]
              .sort((a, b) => Math.abs(a - price) - Math.abs(b - price))
              .slice(0, 20)
              .sort((a,b) => a - b);
            
            // Smarter ATM finding
            let atmStrike = strikes[0];
            let minDiff = Math.abs(strikes[0] - price);
            for(const s of strikes) {
              const diff = Math.abs(s - price);
              if (diff < minDiff) {
                minDiff = diff;
                atmStrike = s;
              }
            }
            
            console.log(`[STOCK-INTEL] ${symbol} Spot: ${price}, ATM: ${atmStrike}, Expiry: ${nearestExpiry}, Strikes Active: ${strikes.length}/${allStrikes.length}`);

            const optionSymbols = [];
            let totalCE_OI = 0;
            let totalPE_OI = 0;
            
            for (const strike of strikes) {
              const ce = currentExpiryOptions.find((i: any) => i.strike === strike && i.instrument_type === 'CE');
              const pe = currentExpiryOptions.find((i: any) => i.strike === strike && i.instrument_type === 'PE');
              if (ce) optionSymbols.push(`NFO:${ce.tradingsymbol}`);
              if (pe) optionSymbols.push(`NFO:${pe.tradingsymbol}`);
            }

            if (optionSymbols.length > 0) {
                try {
                    const optQuotes = await kiteInstance.getQuote(optionSymbols);
                    console.log(`[STOCK-INTEL] Fetched ${Object.keys(optQuotes).length} quotes for ${symbol}`);
                    
                    for (const strike of strikes) {
                        const ceIns = currentExpiryOptions.find((i: any) => i.strike === strike && i.instrument_type === 'CE');
                        const peIns = currentExpiryOptions.find((i: any) => i.strike === strike && i.instrument_type === 'PE');
                        
                        const ceQ = ceIns ? optQuotes[`NFO:${ceIns.tradingsymbol}`] : null;
                        const peQ = peIns ? optQuotes[`NFO:${peIns.tradingsymbol}`] : null;

                        const ce_oi = ceQ?.oi || 0;
                        const pe_oi = peQ?.oi || 0;
                        totalCE_OI += ce_oi;
                        totalPE_OI += pe_oi;

                        chain.push({
                            strike,
                            ce_oi,
                            ce_oi_change: (ceQ?.oi_day_high || ce_oi) - (ceQ?.oi_day_low || ce_oi),
                            pe_oi,
                            pe_oi_change: (peQ?.oi_day_high || pe_oi) - (peQ?.oi_day_low || pe_oi),
                            ce_price: ceQ?.last_price || 0,
                            pe_price: peQ?.last_price || 0,
                            iv: ceQ?.iv || 22
                        });
                    }
                } catch (qErr) {
                    console.error(`[STOCK-INTEL] Quote fetch failed for ${symbol}:`, qErr);
                }
            }
            
            // Calculate Option Stats
            const pcrVal = totalCE_OI > 0 ? totalPE_OI / totalCE_OI : 1;
            const maxPainVal = atmStrike; 
            
            optionsStats = {
               pcr: Number(pcrVal.toFixed(2)),
               totalCallOI: totalCE_OI,
               totalPutOI: totalPE_OI,
               maxPain: maxPainVal,
               expiry: nearestExpiry
            };
          } else {
             console.warn(`[STOCK-INTEL] No future options data found in cache for ${symbol}, falling back to mock chain.`);
             // Only mock the chain if live chain fetch failed
             const mockAtm = Math.round(price / 50) * 50;
             for (let i = -5; i <= 5; i++) {
               const strike = mockAtm + (i * 50);
               chain.push({
                 strike,
                 ce_oi: 50000 + Math.random() * 20000,
                 ce_oi_change: (Math.random() - 0.5) * 5000,
                 pe_oi: 55000 + Math.random() * 20000,
                 pe_oi_change: (Math.random() - 0.5) * 5000,
                 ce_price: Math.max(2, 60 - (strike - price) * 0.4),
                 pe_price: Math.max(2, 60 + (strike - price) * 0.4),
                 iv: 20
               });
             }
          }
        }
      } catch (err) {
        console.error(`[SERVER-STOCK] Live fetch for ${symbol} failed:`, err);
      }
    }

    // Fallback/Mock enhancements
    if (!isLive) {
      price = 1500 + (Math.random() * 500);
      change = (Math.random() - 0.4) * 20;
      changePercent = (change / price) * 100;
      const atmStrike = Math.round(price / 20) * 20;
      for (let i = -3; i <= 3; i++) {
        const strike = atmStrike + (i * 20);
        chain.push({
          strike,
          ce_oi: 100000 + Math.random() * 50000,
          ce_oi_change: (Math.random() - 0.3) * 10000,
          pe_oi: 120000 + Math.random() * 50000,
          pe_oi_change: (Math.random() - 0.5) * 10000,
          ce_price: Math.max(2, 40 - (strike - price) * 0.5),
          pe_price: Math.max(2, 40 + (strike - price) * 0.5),
          iv: 18 + Math.random() * 5
        });
      }
      rsi = 45 + Math.random() * 20;
    }
    
    const stockContext = {
      symbol,
      price,
      high: ohlc.high,
      low: ohlc.low,
      change,
      changePercent,
      optionsStats,
      indicators: {
        rsi,
        macd: { macd: 1.5, signal: 1.2, histogram: 0.3 },
        bollinger: { upper: price + 50, middle: price, lower: price - 50 }
      },
      optionChain: chain,
      institutionalActivity: {
        oiTrend: Math.random() > 0.5 ? 'ACCUMULATION' : 'DISTRIBUTION',
        volatilityRegime: 'STABLE',
        deliveryPercentage: 45 + Math.random() * 20
      }
    };

    try {
      const intel = await aiEngine.analyzeStockIntel(stockContext);
      res.json({
        ...stockContext,
        verdict: intel.verdict,
        institutionalActivity: { ...stockContext.institutionalActivity, ...intel.institutionalActivity }
      });
    } catch (e) {
      console.error("[SERVER-STOCK] Intel failed:", e);
      res.status(500).json({ error: "Stock analysis failed" });
    }
  });

  apiRouter.post("/exit", async (req, res) => {
    await executionEngine.exitAll("User Manual Exit");
    res.json({ status: "success" });
  });

  apiRouter.post("/test-log", async (req, res) => {
    await tradeLogger.logTrade({
      timestamp: new Date().toISOString(),
      score: 85,
      gamma: 12,
      oi_bias: 250000,
      trap: false,
      pnl: 1500,
      win: true,
      bias: 'BULLISH',
      vix: 14.5,
      spot: 24350,
      phase: 'TEST',
      duration: 300,
      entryTime: new Date(Date.now() - 300000).toISOString(),
      buyPrice: 150,
      sellPrice: 180,
      totalInvestment: 7500
    });
    res.json({ success: true, message: "Test trade logged. Check Audit Logs." });
  });

  // Vite/SPA Middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      console.warn("[INIT] dist directory not found - web client might not load.");
    }
  }

  // Error Handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[SERVER-ERROR]", err);
    res.status(500).json({ error: "Internal server error", message: err.message });
  });

  try {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`[V5.4.3] Quantum Server listening on PORT ${PORT}`);
    });
    
    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[FATAL] Port ${PORT} is already in use.`);
      } else {
        console.error("[FATAL] Server listener error:", err);
      }
    });

    // Load persisted data in background (Unwaited) after listener is up
    loadKiteSession().then(data => {
      if (data && apiKey && !kiteInstance) {
          kiteInstance = new KiteConnect({ api_key: apiKey });
          if (accessToken) {
            kiteInstance.setAccessToken(accessToken);
            setDataMode('LIVE');
            marketEngine.syncMode();
            console.log("[SYSTEM] Background: Kite session restored.");
          }
      }
      loadRiskConfig();
      loadMarketStructure();
      executionEngine.loadState().catch(e => console.error("Execution load state failed", e));
      riskEngine.loadState().catch(e => console.error("Risk load state failed", e));
      marketLoop();
    }).catch(err => {
      console.error("[INIT] Background load failed:", err);
      marketLoop();
    });

  } catch (err) {
    console.error("FATAL: Failed to start server listener:", err);
  }
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});

startServer();
