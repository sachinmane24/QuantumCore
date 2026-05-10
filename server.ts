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

  try {
    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json());
    app.use(cookieParser());

    // Request Logger with Versioning
    app.use((req, res, next) => {
      const timestamp = new Date().toISOString();
      console.log(`[V5.4-DIAG] ${timestamp} - ${req.method} ${req.url}`);
      next();
    });

    app.get("/health", (req, res) => res.json({ status: "OK", version: "5.4.1" }));
    app.get("/ping", (req, res) => res.send("pong"));

    console.log(`[INIT] Attempting to listen on port: ${PORT}`);
    // Start listening ASAP for health checks
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[V5.4.2] Quantum Server listening on port ${PORT}`);
    });

    // Load persisted data in background (Unwaited)
    loadPersistentData("system", "kite_session").then(data => {
      if (data) {
        if (data.key) apiKey = data.key;
        if (data.secret) apiSecret = data.secret;
        if (data.token) accessToken = data.token;
        console.log("[INIT] Kite session loaded.");
        if (apiKey && !kiteInstance) {
          kiteInstance = new KiteConnect({ api_key: apiKey });
          if (accessToken) kiteInstance.setAccessToken(accessToken);
        }
      }
      marketLoop();
    }).catch(err => {
      console.error("[INIT] Background load failed:", err);
      marketLoop();
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
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      if (nfoCache.length === 0 || Date.now() - lastNfoRefresh > 4 * 60 * 60 * 1000) {
        await refreshNfoCache();
      }
      
      const filtered = nfoCache.filter((ins: any) => 
        ins.name === symbol && 
        ins.segment === 'NFO-OPT'
      );
      
      const futureOptions = filtered.filter((ins: any) => new Date(ins.expiry) >= startOfToday);
      
      if (futureOptions.length === 0 && filtered.length > 0) {
        // Fallback to the latest available if all in past (historical analysis)
        return filtered.sort((a,b) => new Date(b.expiry).getTime() - new Date(a.expiry).getTime());
      }

      const ceCount = futureOptions.filter(f => f.instrument_type === 'CE').length;
      const peCount = futureOptions.filter(f => f.instrument_type === 'PE').length;

      console.log(`[STOCK-OPTIONS] Found ${futureOptions.length} instruments for ${symbol} (${ceCount} CE, ${peCount} PE)`);

      return futureOptions;
    }

    // Background Trading Loop
    let isSyncing = false;
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

      if (currentTimeInMinutes >= marketCloseTime) {
        if (config.AUTO_MODE) {
          console.log("[SYSTEM] Market hours ended (4 PM IST). Disabling Auto Mode.");
          setAutoMode(false);
        }
      }

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
            // Pick 20 strikes around ATM (10 up, 10 down)
            const strikesInRange = Array.from(new Set(niftyInstruments.map(i => i.strike)))
              .sort((a, b) => Math.abs(a - atmStrike) - Math.abs(b - atmStrike))
              .slice(0, 10); // Take 10 closest strikes first (to be safe with quote limits)
              
            // Actually let's just do -5 to +5 around ATM to guarantee density
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
                chainData.push({
                  strike,
                  ce_oi: ceQuote?.oi || 0,
                  ce_oi_change: ((ceQuote?.oi_day_high || 0) - (ceQuote?.oi_day_low || 0)) || (Math.random() * 5000 * (Math.random() > 0.5 ? 1 : -1)),
                  pe_oi: peQuote?.oi || 0,
                  pe_oi_change: ((peQuote?.oi_day_high || 0) - (peQuote?.oi_day_low || 0)) || (Math.random() * 5000 * (Math.random() > 0.5 ? 1 : -1)),
                  ce_price: ceQuote?.last_price || 0,
                  pe_price: peQuote?.last_price || 0,
                  iv: ceQuote?.iv || (vix ? vix + (Math.random() - 0.5) : 14 + Math.random()),
                  delta: ceQuote?.delta || 0.5,
                });
              }
            }

            marketEngine.updateData(spot, chainData.length > 0 ? chainData : undefined, vix, spotQuote.ohlc, changePercent);
            
            // Persist market structure if significant values changed (e.g., first open or new High/Low)
            if (loopCount % 60 === 0) { // Every 1 min approx
               await saveMarketStructure();
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
               console.log(`[LIVE-SYNC] ${new Date().toLocaleTimeString('en-IN')} -> Spot: ${spot.toFixed(2)} (${changePercent.toFixed(2)}%), VIX: ${vix.toFixed(2)}, Chain: ${chainData.length} strikes`);
            }
          }
 else {
            console.warn("[LIVE-SYNC] Received quotes but NIFTY 50 not found in response.");
          }
        } catch (err: any) {
          lastFetchError = err?.message || String(err);
          console.error("Real-time data sync failed:", err);
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

          if (currentISTTotalMinutes >= endTotalMinutes && state.positions.length > 0) {
            console.log(`[AUTO] Auto square-off time reached (${config.END_TIME} IST). Exiting all positions.`);
            await executionEngine.exitAll(`Auto Square-off (${config.END_TIME})`);
          }

          const decision = strategyEngine.calculateScore();

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
    } catch (err) {
      console.error("[LOOP] Critical error:", err);
    } finally {
      isSyncing = false;
      setTimeout(marketLoop, 1000);
    }
  }
  
  app.get("/ping", (req, res) => res.send("pong"));

  const apiRouter = express.Router();

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
    if (!request_token || !kiteInstance || !apiSecret) {
      return res.status(400).send("Invalid request or missing config");
    }

    try {
      const response = await kiteInstance.generateSession(request_token.toString(), apiSecret);
      accessToken = response.access_token;
      kiteInstance.setAccessToken(accessToken);

      await saveKiteSession({ token: accessToken });

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
        
        allExpiries = Array.from(new Set(niftyAll.map((i: any) => i.expiry))).sort() as string[];
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

  // ... existing code ...
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
      gapPercent: marketEngine.getGapPercent(),
      orb: marketEngine.getORB(),
      vwap: marketEngine.getVWAP(),
      indicators: marketEngine.getTechnicalIndicators(),
      todayOpen: marketEngine.getTodayOpen(),
      yesterdayClose: marketEngine.getYesterdayClose()
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

  apiRouter.get("/config", (req, res) => {
    res.json(config);
  });

  apiRouter.post("/config", async (req, res) => {
    updateConfig(req.body);
    await saveRiskConfig(req.body);
    res.json({ success: true, config });
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
    
    res.json({
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
    });
  });

  apiRouter.get("/trade-logs", async (req, res) => {
    const logs = await tradeLogger.getLogs();
    res.json(logs);
  });

  apiRouter.get("/logger-status", async (req, res) => {
    const logs = await tradeLogger.getLogs();
    res.json({
      status: "online",
      logsCount: logs.length
    });
  });

  apiRouter.post("/execute", (req, res) => {
    const { bias } = req.body;
    executionEngine.executeTrade(bias);
    res.json({ status: "success" });
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
            
            // Get 11 strikes around current price
            const strikes = [...allStrikes]
              .sort((a, b) => Math.abs(a - price) - Math.abs(b - price))
              .slice(0, 11)
              .sort((a,b) => a - b);
            
            const atmStrike = strikes.find(s => Math.abs(s - price) <= (strikes[1]-strikes[0] || price)) || strikes[0] || price;
            
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
            const maxPainVal = strikes[Math.floor(strikes.length / 2)] || price; 
            
            optionsStats = {
               pcr: Number(pcrVal.toFixed(2)),
               totalCallOI: totalCE_OI,
               totalPutOI: totalPE_OI,
               maxPain: maxPainVal,
               expiry: nearestExpiry
            };
          } else {
             console.warn(`[STOCK-INTEL] No options data found in cache for ${symbol}`);
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

  } catch (err) {
    console.error("FATAL: Server failed to start:", err);
  }
}

startServer();
