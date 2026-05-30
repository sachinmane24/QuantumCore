/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * server.ts — Quantum Core Server v5.5.0
 *
 * Changes from v5.4.4:
 *  1. Import calcIV, calcGreeks, dteYears, RISK_FREE_RATE from greeks.ts
 *  2. refreshNfoCache() now calls marketEngine.setCurrentExpiry(selectedExpiry)
 *     so DTE stays accurate everywhere
 *  3. Chain builder in marketLoop() uses real BSM IV + Greeks — all
 *     Math.random() gamma/theta/vega removed, fake `vix ± random` IV removed
 *  4. marketEngine.updateData() receives expiryStr as 7th argument
 *  5. WebSocket heartbeat guard: forces REST fetch if NIFTY 50 tick is >3s stale
 *  6. Version bump to 5.5.0
 */

import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import cookieParser from "cookie-parser";
import { KiteConnect, KiteTicker } from "kiteconnect";
import { marketEngine } from "./src/engine/market.ts";
import { strategyEngine } from "./src/engine/strategy.ts";
import { executionEngine } from "./src/engine/execution.ts";
import { riskEngine } from "./src/engine/risk.ts";
import { aiEngine } from "./src/engine/aiModel.ts";
import { config, setDataMode, setExecutionMode, setAutoMode, updateConfig, getStrikeStep } from "./src/engine/config.ts";
import { tradeLogger } from "./src/engine/logger.ts";
import { savePersistentData, loadPersistentData } from "./src/engine/persistence.ts";
import { NotificationService } from "./src/engine/notifications.ts";
import { calcIV, calcGreeks, dteYears, RISK_FREE_RATE } from "./src/engine/greeks.ts";
import fs from "fs-extra";

const KITE_STORE = path.join(process.cwd(), "kite_session.json");

let apiKey = process.env.KITE_API_KEY || "";
let apiSecret = process.env.KITE_API_SECRET || "";
let accessToken: string | null = null;

// ─── Persistence Helpers ──────────────────────────────────────────────────────

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

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

// ── Utility: wraps a promise in a hard timeout ──────────────────────────────
// Prevents hung Kite REST/WS awaits from locking isSyncing indefinitely.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[TIMEOUT] ${label} did not resolve within ${ms}ms`)), ms)
    ),
  ]);
}

// Ensures marketLoop is started exactly once even when multiple async init
// callbacks complete concurrently (prevents dual-engine / split-brain state).
let loopStarted = false;

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  console.log("[INIT] Initializing Quantum Core Server v5.5.0...");

  // Shared state within startServer
  let kiteInstance: any = null;
  let niftyInstruments: any[] = [];
  let allExpiries: string[] = [];
  let selectedExpiry: string = ""; // Active expiry date string "YYYY-MM-DD"
  let lastRawQuotes: any = null;
  let lastFetchTimestamp: string | null = null;
  let lastFetchError: string | null = null;
  let loopCount = 0;
  let nfoCache: any[] = [];
  let lastNfoRefresh: number = 0;
  let stockMetadataCache: Map<string, { token: number, lotSize: number }> = new Map();
  let baselineOIMap = new Map<string, number>();

  // VWAP accumulators — reset each IST calendar day
  let vwapCumPV = 0;       // cumulative (price × volume)
  let vwapCumVol = 0;      // cumulative volume
  let lastVwapResetDate = "";

  // OI baseline persistence — saves to Firestore at first capture each day
  let oiBaselineSavedDate = "";

  // Trade log cache — declared here so onTradeExit closure can reference it
  let tradeLogsCache: any = null;
  let lastTradeLogsFetch = 0;

  // Market info cache
  let marketInfoCache: any = null;
  let lastMarketInfoFetch = 0;

  // Kite Ticker and real-time WebSocket state
  let tickerInstance: any = null;
  let tickerConnected = false;
  const liveTicksCache = new Map<number, any>();
  // Track last tick timestamp per token for heartbeat guard
  const liveTickTimestamp = new Map<number, number>();
  const tokenToSymbolMap = new Map<number, string>();
  const symbolToTokenMap = new Map<string, number>();
  let lastSubscribedTokens: number[] = [];

  // Prepopulate index and VIX tokens
  tokenToSymbolMap.set(256265, "NSE:NIFTY 50");
  symbolToTokenMap.set("NSE:NIFTY 50", 256265);
  tokenToSymbolMap.set(264969, "NSE:INDIA VIX");
  symbolToTokenMap.set("NSE:INDIA VIX", 264969);

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
  app.get("/health", (req, res) => res.json({ status: "OK", version: "5.5.0", uptime: process.uptime() }));
  app.get("/ping", (req, res) => res.send("pong"));

  // ─── Kite Auth Routes ─────────────────────────────────────────────────────────

  apiRouter.post("/kite/config", async (req, res) => {
    const { key, secret } = req.body;
    if (key) apiKey = key;
    if (secret) apiSecret = secret;

    if (key) {
      kiteInstance = new KiteConnect({ api_key: key });
      niftyInstruments = [];
      allExpiries = [];
      selectedExpiry = "";
      console.log(`[AUTH] Kite API key updated dynamically: ${key.substring(0, 4)}...`);
    }

    await saveKiteSession({ key: apiKey, secret: apiSecret });
    res.json({ success: true, hasConfig: !!(apiKey && apiSecret) });
  });

  apiRouter.get("/kite/url", (req, res) => {
    if (!apiKey) {
      return res.status(400).json({ error: "KITE_API_KEY not configured" });
    }
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

      setDataMode('LIVE');
      marketEngine.syncMode();
      console.log(`[AUTH] Session generated for ${response.user_name}. Mode set to LIVE.`);

      await saveKiteSession({ key: apiKey, secret: apiSecret, token: accessToken });
      refreshNfoCache().catch(e => console.error("Post-auth instrument fetch failed", e));
      initKiteTicker();

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

  // ─── NFO Cache Refresh ────────────────────────────────────────────────────────

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
        selectedExpiry = (futureExpiries[0] || expiries[0]) as string;

        niftyInstruments = niftyAll.filter(i => new Date(i.expiry).toISOString().split('T')[0] === selectedExpiry);
        console.log(`[SYSTEM] NIFTY Cache Updated: ${niftyInstruments.length} strikes for ${selectedExpiry}`);

        // ── NEW: Sync expiry into market engine for accurate DTE calculations ──
        marketEngine.setCurrentExpiry(selectedExpiry);

        // Derive monthly expiry for the engine's expiry status tracking
        const istTime = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
        const currentMonth = istTime.getUTCMonth();
        const currentYear = istTime.getUTCFullYear();
        const currentMonthExpiries = allExpiries.filter(e => {
          const d = new Date(e);
          return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
        });
        const monthlyExpiry = currentMonthExpiries.length > 0
          ? currentMonthExpiries[currentMonthExpiries.length - 1]
          : selectedExpiry;
        marketEngine.setExpiryInfo(selectedExpiry, monthlyExpiry);

        // Hydrate the WebSocket token maps for options
        for (const ins of niftyInstruments) {
          const fullSymbol = `NFO:${ins.tradingsymbol}`;
          tokenToSymbolMap.set(Number(ins.instrument_token), fullSymbol);
          symbolToTokenMap.set(fullSymbol, Number(ins.instrument_token));
        }

        if (tickerConnected) {
          subscribeToMarketTokens();
        }
      }
    } catch (e) {
      console.error("[SYSTEM] NFO cache refresh failed:", e);
    }
  }

  // ─── Stock Options Helper ─────────────────────────────────────────────────────

  async function getStockOptions(symbol: string) {
    if (!kiteInstance || !accessToken) return [];

    const now = new Date();
    const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
    const startOfTodayIST = new Date(istTime);
    startOfTodayIST.setHours(0, 0, 0, 0);

    if (nfoCache.length === 0 || Date.now() - lastNfoRefresh > 4 * 60 * 60 * 1000) {
      console.log(`[STOCK-OPTIONS] Cache empty or stale, refreshing for ${symbol}...`);
      await refreshNfoCache();
    }

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
      return filtered.sort((a, b) => new Date(b.expiry).getTime() - new Date(a.expiry).getTime());
    }

    const ceCount = futureOptions.filter(f => f.instrument_type === 'CE').length;
    const peCount = futureOptions.filter(f => f.instrument_type === 'PE').length;
    console.log(`[STOCK-OPTIONS] Found ${futureOptions.length} instruments for ${symbol} (${ceCount} CE, ${peCount} PE)`);

    return futureOptions;
  }

  // ─── WebSocket Ticker ─────────────────────────────────────────────────────────

  function getQuoteFromTick(tick: any) {
    if (!tick) return null;
    const open = tick.ohlc?.open || 0;
    const close = tick.ohlc?.close || 0;
    const lastPrice = tick.last_price || 0;
    const netChange = tick.change !== undefined ? (lastPrice - close) : (tick.net_change || 0);

    return {
      instrument_token: tick.instrument_token,
      last_price: lastPrice,
      volume: tick.volume_traded !== undefined ? tick.volume_traded : (tick.volume || 0),
      oi: tick.oi || 0,
      oi_day_high: tick.oi_day_high || 0,
      oi_day_low: tick.oi_day_low || 0,
      ohlc: tick.ohlc || { open, high: tick.ohlc?.high || lastPrice, low: tick.ohlc?.low || lastPrice, close },
      net_change: netChange,
      change: tick.change || 0
    };
  }

  function subscribeToMarketTokens() {
    if (!tickerInstance || !tickerConnected) return;

    const tokens = new Set<number>([256265, 264969]);

    if (niftyInstruments && niftyInstruments.length > 0) {
      const currentSpot = marketEngine.getSpotPrice();
      const _step = getStrikeStep();
      const atmStrike = currentSpot > 0 ? Math.round(currentSpot / _step) * _step : 24300;

      for (let i = -7; i <= 7; i++) {
        const strike = atmStrike + (i * 50);
        const ce = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'CE');
        const pe = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'PE');
        if (ce && ce.instrument_token) tokens.add(Number(ce.instrument_token));
        if (pe && pe.instrument_token) tokens.add(Number(pe.instrument_token));
      }
    }

    const tokenList = Array.from(tokens).filter(token => !isNaN(token) && token > 0).sort((a, b) => a - b);

    const hasChanged = tokenList.length !== lastSubscribedTokens.length ||
      tokenList.some((t, idx) => t !== lastSubscribedTokens[idx]);

    if (!hasChanged) return;

    try {
      const unsubscribeList = lastSubscribedTokens.filter(t => !tokens.has(t));
      if (unsubscribeList.length > 0) {
        tickerInstance.unsubscribe(unsubscribeList);
      }

      console.log(`[TICKER] Subscribing to ${tokenList.length} instruments (Full mode)...`);
      tickerInstance.subscribe(tokenList);
      tickerInstance.setMode(tickerInstance.modeFull, tokenList);
      lastSubscribedTokens = tokenList;
    } catch (err) {
      console.error("[TICKER] Subscription failed:", err);
    }
  }

  function initKiteTicker() {
    if (!apiKey || !accessToken) {
      console.log("[TICKER] Cannot initialize Websocket: apiKey or accessToken is missing");
      return;
    }

    if (tickerInstance) {
      console.log("[TICKER] Existing ticker found, disconnecting first.");
      try { tickerInstance.disconnect(); } catch (e) {}
      tickerInstance = null;
    }

    console.log("[TICKER] Spawning real-time Kite Ticker WebSocket connection...");
    tickerConnected = false;

    tickerInstance = new KiteTicker({ api_key: apiKey, access_token: accessToken });
    tickerInstance.autoReconnect(true, 20, 5);

    tickerInstance.on("connect", () => {
      tickerConnected = true;
      console.log("[TICKER] WebSocket connected successfully! Real-time streaming ACTIVE.");
      subscribeToMarketTokens();
    });

    tickerInstance.on("ticks", (ticks: any[]) => {
      if (ticks && ticks.length > 0) {
        const now = Date.now();
        for (const tick of ticks) {
          liveTicksCache.set(Number(tick.instrument_token), tick);
          // ── NEW: record arrival timestamp for heartbeat guard ──
          liveTickTimestamp.set(Number(tick.instrument_token), now);
        }
      }
    });

    tickerInstance.on("disconnect", (error: any) => {
      tickerConnected = false;
      console.warn("[TICKER] WebSocket disconnected. Reason:", error);
    });

    tickerInstance.on("reconnecting", (interval: number, times: number) => {
      console.log(`[TICKER] WebSocket reconnecting (attempt ${times}, interval ${interval}ms)...`);
    });

    tickerInstance.on("noreconnect", () => {
      tickerConnected = false;
      console.error("[TICKER] WebSocket connection failed permanently. No more automatic reconnect retries.");
    });

    tickerInstance.on("error", (err: any) => {
      console.error("[TICKER] WebSocket error encountered:", err);
    });

    try {
      tickerInstance.connect();
    } catch (err) {
      console.error("[TICKER] Execution of WebSockets connection failed:", err);
    }
  }

  // ─── Market Loop ──────────────────────────────────────────────────────────────

  let isSyncing = false;
  let isSyncingStartedAt = 0;   // watchdog: tracks when isSyncing was set
  let liveFailureCount = 0;

  async function marketLoop() {
    if (isSyncing) {
      // Watchdog: if the lock has been held for >30 s, a network await has hung.
      // Force-release so the loop can recover. The hung call will eventually
      // reject via withTimeout() and be caught by the outer try/catch.
      if (isSyncingStartedAt > 0 && Date.now() - isSyncingStartedAt > 30_000) {
        console.error('[LOOP] isSyncing held >30s — force-releasing (hung network await detected). Resetting.');
        isSyncing = false;
        isSyncingStartedAt = 0;
      } else {
        setTimeout(marketLoop, 500);
        return;
      }
    }
    isSyncing = true;
    isSyncingStartedAt = Date.now();
    try {
      const now = new Date();
      const istTime = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
      const hours = istTime.getUTCHours();
      const minutes = istTime.getUTCMinutes();
      const currentTimeInMinutes = (hours * 60) + minutes;

      loopCount++;

      // Refresh NFO cache if empty or stale
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
          const strikeStep = getStrikeStep();
          const atmStrike = Math.round(currentSpot / strikeStep) * strikeStep;

          if (niftyInstruments.length > 1) {
            for (let i = -5; i <= 5; i++) {
              const strike = atmStrike + (i * 50);
              const ce = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'CE');
              const pe = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'PE');
              if (ce) optionSymbols.push(`NFO:${ce.tradingsymbol}`);
              if (pe) optionSymbols.push(`NFO:${pe.tradingsymbol}`);
            }
          }

          if (tickerConnected) {
            subscribeToMarketTokens();
          }

          let quotes: any = null;
          let loadedFromWebsocket = false;

          // ── WebSocket heartbeat guard ──────────────────────────────────────────
          // If the NIFTY 50 tick hasn't arrived in 3 seconds, treat WebSocket as stale
          // and force a REST fetch even if tickerConnected is true. This catches the
          // "silent freeze" failure mode where the socket stays open but stops ticking.
          const spotLastTick = liveTickTimestamp.get(256265) || 0;
          const wsTickAge = Date.now() - spotLastTick;
          const isWebSocketFresh = tickerConnected && liveTicksCache.has(256265) && wsTickAge < 3000;

          if (!isWebSocketFresh && tickerConnected && spotLastTick > 0) {
            console.warn(`[TICKER] Heartbeat: NIFTY tick is ${(wsTickAge / 1000).toFixed(1)}s old — forcing REST fetch.`);
          }

          const needsRestFetch = !lastRawQuotes || (loopCount % 15 === 0) || !isWebSocketFresh;

          if (needsRestFetch) {
            try {
              const fetchSymbols = [...symbols, ...optionSymbols];
              const restQuotes = await withTimeout(
                kiteInstance.getQuote(fetchSymbols),
                8_000,
                'kiteInstance.getQuote'
              );
              lastRawQuotes = { ...(lastRawQuotes || {}), ...restQuotes };
              lastFetchTimestamp = new Date().toISOString();
              lastFetchError = null;
              liveFailureCount = 0;
            } catch (restErr: any) {
              console.error("[LIVE-SYNC] Background REST quote fetch failed:", restErr?.message || restErr);
              if (!lastRawQuotes) {
                throw restErr;
              }
            }
          }

          if (lastRawQuotes) {
            // Deep copy to avoid unintended reference mutations
            quotes = {};
            for (const key of Object.keys(lastRawQuotes)) {
              if (lastRawQuotes[key]) {
                quotes[key] = { ...lastRawQuotes[key] };
              }
            }

            // Overlay real-time WebSocket ticks if fresh
            if (isWebSocketFresh) {
              const spotTick = liveTicksCache.get(256265);
              if (spotTick) quotes["NSE:NIFTY 50"] = getQuoteFromTick(spotTick);

              const vixTick = liveTicksCache.get(264969);
              if (vixTick) quotes["NSE:INDIA VIX"] = getQuoteFromTick(vixTick);

              for (const sym of optionSymbols) {
                const cleanedSym = sym.startsWith("NFO:") ? sym.substring(4) : sym;
                const ins = niftyInstruments.find(i => i.tradingsymbol === cleanedSym);
                if (ins && ins.instrument_token) {
                  const tick = liveTicksCache.get(Number(ins.instrument_token));
                  if (tick) quotes[sym] = getQuoteFromTick(tick);
                }
              }

              // Update baseline cache with real-time values
              for (const key of Object.keys(quotes)) {
                if (quotes[key]) lastRawQuotes[key] = { ...quotes[key] };
              }

              loadedFromWebsocket = true;
            }
          }

          if (quotes && quotes["NSE:NIFTY 50"]) {
            const spotQuote = quotes["NSE:NIFTY 50"];
            const spot = spotQuote.last_price;
            const vix = quotes["NSE:INDIA VIX"]?.last_price || marketEngine.getVix();

            const prevClose = spotQuote.ohlc.close;
            const netChange = spotQuote.net_change !== undefined ? spotQuote.net_change : (spot - prevClose);
            const changePercent = prevClose > 0 ? (netChange / prevClose) * 100 : 0;

            // ── Live VWAP — cumulative (price×volume) / volume, resets each IST day ──
            const todayISTStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
            if (todayISTStr !== lastVwapResetDate) {
              vwapCumPV = 0;
              vwapCumVol = 0;
              lastVwapResetDate = todayISTStr;
              // Also reset OI baseline at day start so OI changes are session-accurate
              baselineOIMap.clear();
              oiBaselineSavedDate = "";
              console.log(`[MARKET] New day (${todayISTStr}): VWAP and OI baseline reset.`);
            }
            const tickVol = spotQuote.volume || 0;
            if (tickVol > 0) {
              vwapCumPV += spot * tickVol;
              vwapCumVol += tickVol;
            }
            const liveVwap = vwapCumVol > 0 ? vwapCumPV / vwapCumVol : spot;

            // ── Persist OI baseline to Firestore once at market open (9:15–9:20 IST) ──
            // This means a server restart mid-session can reload it and OI changes stay accurate
            const istMins = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
            const istTotalMins = istMins.getUTCHours() * 60 + istMins.getUTCMinutes();
            if (istTotalMins >= 555 && istTotalMins <= 560 && oiBaselineSavedDate !== todayISTStr && baselineOIMap.size > 0) {
              const baselineObj: Record<string, number> = {};
              baselineOIMap.forEach((v, k) => { baselineObj[k] = v; });
              savePersistentData("system", "oi_baseline", { date: todayISTStr, data: baselineObj })
                .then(() => { oiBaselineSavedDate = todayISTStr; console.log(`[OI] Baseline saved to Firestore (${baselineOIMap.size} symbols).`); })
                .catch(e => console.error("[OI] Baseline save failed:", e));
            }

            // ── Resolve active expiry string for DTE calculations ──────────────
            // Use server-level selectedExpiry first; fall back to marketEngine's stored value
            const activeExpiry = selectedExpiry || marketEngine.getCurrentExpiry();

            // Pre-compute DTE once for the whole chain (same expiry for all strikes)
            const T_dte = dteYears(activeExpiry);

            let chainData: any[] = [];
            const uniqueStrikes = Array.from(new Set(niftyInstruments.map(ins => ins.strike))).sort((a, b) => a - b);

            for (const strike of uniqueStrikes) {
              const ceIns = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'CE');
              const peIns = niftyInstruments.find(ins => ins.strike === strike && ins.instrument_type === 'PE');

              const ceQuote = ceIns ? quotes[`NFO:${ceIns.tradingsymbol}`] : null;
              const peQuote = peIns ? quotes[`NFO:${peIns.tradingsymbol}`] : null;

              if (ceQuote || peQuote) {
                const cePrice = ceQuote?.last_price || 0;
                const pePrice = peQuote?.last_price || 0;

                // ── Session-accurate OI change tracking (unchanged) ────────────
                const currentCeOi = ceQuote?.oi || 0;
                let ceOiChange = 0;
                if (ceIns && currentCeOi > 0) {
                  const symbolKey = ceIns.tradingsymbol;
                  if (!baselineOIMap.has(symbolKey)) baselineOIMap.set(symbolKey, currentCeOi);
                  ceOiChange = currentCeOi - baselineOIMap.get(symbolKey)!;
                }
                if (ceOiChange === 0 && ceQuote?.oi_day_high && ceQuote?.oi_day_low) {
                  ceOiChange = ceQuote.oi_day_high - ceQuote.oi_day_low;
                }

                const currentPeOi = peQuote?.oi || 0;
                let peOiChange = 0;
                if (peIns && currentPeOi > 0) {
                  const symbolKey = peIns.tradingsymbol;
                  if (!baselineOIMap.has(symbolKey)) baselineOIMap.set(symbolKey, currentPeOi);
                  peOiChange = currentPeOi - baselineOIMap.get(symbolKey)!;
                }
                if (peOiChange === 0 && peQuote?.oi_day_high && peQuote?.oi_day_low) {
                  peOiChange = peQuote.oi_day_high - peQuote.oi_day_low;
                }

                // ── REAL BSM IV from Kite option prices ───────────────────────
                // calcIV() inverts Black-Scholes using Newton-Raphson.
                // Returns annualised fraction (e.g. 0.153 = 15.3%).
                // Falls back to VIX/100 only if price is zero or below intrinsic.
                const ceIv_raw = (cePrice > 0.5)
                  ? calcIV(cePrice, spot, strike, T_dte, RISK_FREE_RATE, 'CE')
                  : (vix / 100);

                const peIv_raw = (pePrice > 0.5)
                  ? calcIV(pePrice, spot, strike, T_dte, RISK_FREE_RATE, 'PE')
                  : (vix / 100);

                // ── REAL BSM Greeks from solved IV ────────────────────────────
                // All values are deterministic — no Math.random() anywhere.
                const ceGreeks = calcGreeks(spot, strike, T_dte, RISK_FREE_RATE, ceIv_raw, 'CE');
                const peGreeks = calcGreeks(spot, strike, T_dte, RISK_FREE_RATE, peIv_raw, 'PE');

                // IV skew: negative means puts richer than calls (normal for NIFTY)
                const ivSkew = (ceIv_raw - peIv_raw) * 100;

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
                  // IV stored as percentage (e.g. 15.3 not 0.153)
                  ce_iv: ceIv_raw * 100,
                  pe_iv: peIv_raw * 100,
                  iv: ((ceIv_raw + peIv_raw) / 2) * 100,
                  iv_skew: ivSkew,
                  // Real BSM Greeks
                  delta: ceGreeks.delta,         // CE: [0, 1]
                  pe_delta: peGreeks.delta,      // PE: [-1, 0]
                  gamma: ceGreeks.gamma,         // per ₹1 spot move (same for CE/PE)
                  theta: ceGreeks.theta,         // ₹/calendar day
                  vega: ceGreeks.vega,           // ₹ per 1% IV change
                  // BSM theoretical prices — useful for P&L cross-check
                  ce_theoretical: ceGreeks.theoreticalPrice,
                  pe_theoretical: peGreeks.theoreticalPrice,
                });
              }
            }

            // Pass expiryStr as 7th arg so marketEngine keeps DTE in sync
            marketEngine.updateData(
              spot,
              chainData.length > 0 ? chainData : undefined,
              vix,
              spotQuote.ohlc,
              changePercent,
              liveVwap,
              activeExpiry
            );

            if (loopCount % 60 === 0) {
              await saveMarketStructure();
            }

            if (Math.floor(Date.now() / 1000) % 15 === 0) {
              console.log(`[LIVE-SYNC] ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} -> Spot: ${spot.toFixed(2)} (${changePercent.toFixed(2)}%), VIX: ${vix.toFixed(2)}, WS: ${loadedFromWebsocket ? 'YES' : 'REST'}`);
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
            config.AUTO_MODE = false;
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

          const isClosed = marketEngine.isMarketClosed();

          if (isClosed) {
            if (loopCount % 30 === 0) {
              console.log("[AUTO] Market is closed (Weekend, Holiday, or Off-Market Hours). Suspended execution.");
            }
          } else {
            const decision = strategyEngine.calculateScore();

            if (decision.bias === 'NEUTRAL' && Math.abs(marketEngine.getLatestTick()?.change || 0) > 0.3) {
              console.log(`[DIAG] Trade bypass: Significant move (${marketEngine.getLatestTick()?.change?.toFixed(2)}%) but Strategy returned NEUTRAL. Reason: ${decision.biasReason}`);
            }

            // Auto-Exit: use per-trade params when available, fall back to global config.
            // This prevents the global config.TARGET_RUPEES / SL_RUPEES from fighting
            // the per-trade premium-aware SL/Target set in execution.ts.
            const _tradeTarget = state.params?.targetRupees   ?? config.TARGET_RUPEES;
            const _tradeSL     = state.params?.stopLossRupees ?? config.SL_RUPEES;
            if (state.pnl >= _tradeTarget && state.positions.length > 0) {
              console.log(`[AUTO] Target hit (₹${state.pnl} >= ₹${_tradeTarget}). Exiting...`);
              await executionEngine.exitAll('Target Hit');
            } else if (state.pnl <= -_tradeSL && state.positions.length > 0) {
              console.log(`[AUTO] SL hit (₹${state.pnl} <= -₹${_tradeSL}). Exiting...`);
              await executionEngine.exitAll('SL Hit');
            }

            // Entry Logic
            if (state.positions.length === 0 && state.rollsToday < config.MAX_ROLLS) {
              await executionEngine.executeTrade(decision.bias);
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
      isSyncingStartedAt = 0;
      setTimeout(marketLoop, 1000);
    }
  }

  // Start the loop — guarded so only ONE instance of the loop ever runs,
  // even if multiple async init callbacks try to call marketLoop().
  if (!loopStarted) { loopStarted = true; marketLoop(); }

  // Wire trade-exit callback so tradeLogsCache is invalidated the moment a trade closes
  executionEngine.onTradeExit = () => {
    tradeLogsCache = null;
    lastTradeLogsFetch = 0;
    console.log("[CACHE] tradeLogsCache invalidated on trade exit.");
  };

  // ─── API Routes ───────────────────────────────────────────────────────────────

  apiRouter.get("/fo-stocks", async (req, res) => {
    let stocks = Array.from(new Set(nfoCache.filter(i => i.segment === 'NFO-OPT' || i.segment === 'NFO-FUT').map(i => i.name)))
      .filter(name => !!name)
      .sort();

    const localPath = path.join(process.cwd(), 'fo_stocks_cache.json');

    if (stocks.length > 50) {
      await fs.writeJson(localPath, stocks).catch(() => {});
      return res.json(stocks);
    }

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
    const spotTickAge = liveTickTimestamp.has(256265)
      ? ((Date.now() - liveTickTimestamp.get(256265)!) / 1000).toFixed(1) + "s"
      : "never";
    res.json({
      loggedIn: !!accessToken,
      dataSource: config.DATA_SOURCE,
      tickerConnected: tickerConnected,
      tickerCachedTicksCount: liveTicksCache.size,
      lastSubscribedTokensCount: lastSubscribedTokens.length,
      nfoCacheSize: nfoCache.length,
      lastNfoRefresh: new Date(lastNfoRefresh).toISOString(),
      niftyInstrumentsCount: niftyInstruments.length,
      selectedExpiry,
      hasKiteInstance: !!kiteInstance,
      wsSpotTickAge: spotTickAge,  // NEW: heartbeat diagnostic
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
      selectedExpiry,
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
      hasConfig: !!(apiKey && apiSecret),
      tickerConnected: tickerConnected,
      tickerCachedTicksCount: liveTicksCache.size
    });
  });

  apiRouter.get("/backtest/historical", async (req, res) => {
    const { from, to, interval = "minute" } = req.query;
    if (!accessToken || !kiteInstance) {
      return res.status(401).json({ error: "Kite Connect not authorized. Please log in first." });
    }
    try {
      const instrumentToken = 256265;
      console.log(`[BACKTEST] Fetching historical data from ${from} to ${to}`);
      const candles = await kiteInstance.getHistoricalData(
        instrumentToken,
        interval.toString(),
        from?.toString(),
        to?.toString()
      );
      res.json({ symbol: "NIFTY 50", instrument_token: instrumentToken, candles });
    } catch (err) {
      console.error("[BACKTEST] Zerodha historical fetch failed:", err);
      res.status(500).json({ error: "Failed to fetch historical data from Zerodha. Ensure you have the 'Historical Data' add-on active." });
    }
  });

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
      dataSource: config.DATA_SOURCE,
      selectedExpiry,
      // Movement prediction — cached from last marketLoop tick; zero extra compute cost
      movementPrediction: strategyEngine.getLastMovementPrediction(),
    });
  });

  apiRouter.get("/strategy-data", async (req, res) => {
    try {
      const score = strategyEngine.calculateScore();
      const aiProb = await aiEngine.predictWinProbability(score, []).catch(e => {
        console.error("[AI] Prediction failed:", e);
        return 0.5;
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
      autoMode: config.AUTO_MODE,
      movementPrediction: strategyEngine.getLastMovementPrediction(),
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
        tradingHoursAllowed: (currentISTTotalMinutes >= (9 * 60 + 15) && currentISTTotalMinutes <= endTotalMinutes),
        riskValidation: validation,
        lastSuppression: state.lastTradeSuppression,
        pnl: state.pnl,
        selectedExpiry,
        // Daily gate status from revised execution engine
        isDailyLimitHit: state.isDailyLimitHit,
        isDailyProfitLocked: state.isDailyProfitLocked,
        dailyRealizedPnL: state.dailyRealizedPnL,
        state
      });
    } catch (e: any) {
      res.json({ error: e.message });
    }
  });

  apiRouter.post("/debug/reset", async (req, res) => {
    try {
      // Reset execution engine first (awaited — persists to Firestore)
      await executionEngine.resetState();
      // Risk engine reset second — if this throws, execution is already reset
      // which is safe (no open positions). Log the discrepancy but don't rollback.
      try {
        riskEngine.reset();
      } catch (riskErr: any) {
        console.error("[RESET] riskEngine.reset() failed after executionEngine reset:", riskErr);
      }
      // Invalidate trade log cache so the UI reflects the reset immediately
      tradeLogsCache = null;
      lastTradeLogsFetch = 0;
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
    // Save the FULL merged config (not just req.body which may be partial).
    // Saving req.body was overwriting Firestore with a single-field object,
    // wiping all other settings on the next server restart.
    await saveRiskConfig(config);
    res.json({ success: true, config });
  });

  apiRouter.post("/test-telegram", async (req, res) => {
    const { token, chatId } = req.body;
    const botToken = token || config.TELEGRAM_BOT_TOKEN;
    const cid = chatId || config.TELEGRAM_CHAT_ID;

    if (!botToken || !cid) {
      return res.status(400).json({ error: "Telegram Bot Token and Chat ID are required." });
    }

    try {
      const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cid,
          text: `⚡ <b>QUANTUM CORE TEST</b>\n\nYour Telegram Channel / Chat has been successfully connected! Current System Status: <b>ONLINE</b>\n\nLocal Server Time: <code>${new Date().toISOString()}</code>`,
          parse_mode: "HTML"
        })
      });

      const resJson = await response.json();
      if (!response.ok) {
        return res.status(400).json({
          success: false,
          status: response.status,
          error: resJson.description || "Telegram API error",
          response: resJson
        });
      }

      res.json({ success: true, message: "Test message sent successfully!", response: resJson });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || "Failed to contact Telegram API" });
    }
  });

  apiRouter.post("/toggle-data-mode", async (req, res) => {
    const { mode } = req.body;
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
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);
    const day = istTime.getUTCDay();
    const hours = istTime.getUTCHours();
    const minutes = istTime.getUTCMinutes();
    const currentTimeMinutes = hours * 60 + minutes;
    const today = istTime.toISOString().split('T')[0];
    const isWeekend = day === 0 || day === 6;
    const isHoliday = holidays.includes(today);
    const isOffMarketHours = currentTimeMinutes < 555 || currentTimeMinutes > 930;
    const isMarketClosed = isWeekend || isHoliday || isOffMarketHours;
    const nextHoliday = holidays.find(h => h >= today);

    let weeklyExpiryStr = "";
    let monthlyExpiryStr = "";

    if (allExpiries.length > 0) {
      const formatExpiry = (dateStr: string) => {
        try { return new Date(dateStr).toISOString().split('T')[0]; }
        catch (e) { return dateStr; }
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

    marketEngine.setExpiryInfo(weeklyExpiryStr, monthlyExpiryStr);

    const daysToExpiry = weeklyExpiryStr
      ? Math.ceil((new Date(weeklyExpiryStr).getTime() - istTime.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    const result = {
      expiry: { weekly: weeklyExpiryStr, monthly: monthlyExpiryStr, daysToExpiry },
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

  apiRouter.delete("/trade-logs/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await tradeLogger.deleteLog(id);
      tradeLogsCache = null;
      lastTradeLogsFetch = 0;
      res.json({ success: true });
    } catch (err) {
      console.error("Delete trade log error:", err);
      res.status(500).json({ error: "Failed to delete trade log" });
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
    res.json({ status: "online", logsCount: logs.length });
  });

  apiRouter.post("/execute", async (req, res) => {
    const { bias } = req.body;
    try {
      await executionEngine.executeTrade(bias, true);
      res.json({ status: "success" });
    } catch (err: any) {
      console.error("[API] Manual Execution failed:", err);
      res.status(400).json({ error: err?.message || "Execution failed" });
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
        spot, vix, pcr, support, supportOi, resistance, resistanceOi, indicators, chainFocus
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

          try {
            const fromDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const toDate = new Date().toISOString().split('T')[0];
            const candles = await kiteInstance.getHistoricalData(q.instrument_token, "day", fromDate, toDate);
            if (candles.length >= 14) {
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

          const stockOptions = await getStockOptions(symbol);
          console.log(`[STOCK-INTEL] Found ${stockOptions.length} total options for ${symbol}`);

          if (stockOptions.length > 0) {
            const expiries = Array.from(new Set(stockOptions.map((i: any) => i.expiry)))
              .sort((a: any, b: any) => new Date(a).getTime() - new Date(b).getTime()) as string[];

            const nearestExpiry = expiries.find(e => {
              const expDate = new Date(e);
              const today = new Date();
              today.setHours(0, 0, 0, 0);
              return expDate >= today;
            }) || expiries[0];

            const currentExpiryOptions = stockOptions.filter((i: any) => i.expiry === nearestExpiry);
            const lotSize = currentExpiryOptions[0]?.lot_size || 0;
            stockMetadataCache.set(symbol, { token: q.instrument_token, lotSize });

            const allStrikes = Array.from(new Set(currentExpiryOptions.map((i: any) => i.strike))).sort((a: any, b: any) => a - b);
            const strikes = [...allStrikes]
              .sort((a, b) => Math.abs(a - price) - Math.abs(b - price))
              .slice(0, 20)
              .sort((a, b) => a - b);

            let atmStrike = strikes[0];
            let minDiff = Math.abs(strikes[0] - price);
            for (const s of strikes) {
              const diff = Math.abs(s - price);
              if (diff < minDiff) { minDiff = diff; atmStrike = s; }
            }

            console.log(`[STOCK-INTEL] ${symbol} Spot: ${price}, ATM: ${atmStrike}, Expiry: ${nearestExpiry}, Strikes: ${strikes.length}/${allStrikes.length}`);

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

                  const cePrice_s = ceQ?.last_price || 0;
                  const pePrice_s = peQ?.last_price || 0;
                  // Real BSM IV from option price — same solver used for NIFTY chain
                  const stockExpiryStr = nearestExpiry
                    ? new Date(nearestExpiry).toISOString().split('T')[0]
                    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                  const T_stock = dteYears(stockExpiryStr);
                  const ceIv_s = cePrice_s > 0.5 ? calcIV(cePrice_s, price, strike, T_stock, RISK_FREE_RATE, 'CE') : 0.20;
                  const peIv_s = pePrice_s > 0.5 ? calcIV(pePrice_s, price, strike, T_stock, RISK_FREE_RATE, 'PE') : 0.20;
                  const midIv_s = ((ceIv_s + peIv_s) / 2) * 100; // as percentage

                  chain.push({
                    strike,
                    ce_oi,
                    ce_oi_change: (ceQ?.oi_day_high || ce_oi) - (ceQ?.oi_day_low || ce_oi),
                    pe_oi,
                    pe_oi_change: (peQ?.oi_day_high || pe_oi) - (peQ?.oi_day_low || pe_oi),
                    ce_price: cePrice_s,
                    pe_price: pePrice_s,
                    ce_iv: ceIv_s * 100,
                    pe_iv: peIv_s * 100,
                    iv: midIv_s || 22,
                  });
                }
              } catch (qErr) {
                console.error(`[STOCK-INTEL] Quote fetch failed for ${symbol}:`, qErr);
              }
            }

            const pcrVal = totalCE_OI > 0 ? totalPE_OI / totalCE_OI : 1;
            optionsStats = {
              pcr: Number(pcrVal.toFixed(2)),
              totalCallOI: totalCE_OI,
              totalPutOI: totalPE_OI,
              maxPain: atmStrike,
              expiry: nearestExpiry
            };
          } else {
            console.warn(`[STOCK-INTEL] No future options data found for ${symbol}, falling back to mock chain.`);
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

  // ─── Vite / SPA Middleware ────────────────────────────────────────────────────

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

  // ─── Start Listening ──────────────────────────────────────────────────────────

  try {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`[V5.5.0] Quantum Server listening on PORT ${PORT}`);
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[FATAL] Port ${PORT} is already in use.`);
      } else {
        console.error("[FATAL] Server listener error:", err);
      }
    });

    // Load persisted data in background after listener is up
    loadKiteSession().then(data => {
      if (data && apiKey && !kiteInstance) {
        kiteInstance = new KiteConnect({ api_key: apiKey });
        if (accessToken) {
          kiteInstance.setAccessToken(accessToken);
          setDataMode('LIVE');
          marketEngine.syncMode();
          console.log("[SYSTEM] Background: Kite session restored.");
          initKiteTicker();
        }
      }
      loadRiskConfig();
      loadMarketStructure();
      executionEngine.loadState().catch(e => console.error("Execution load state failed", e));
      riskEngine.loadState().catch(e => console.error("Risk load state failed", e));
      // Restore OI baseline if saved today — keeps OI change data accurate after mid-session restart
      loadPersistentData("system", "oi_baseline").then((saved: any) => {
        if (saved && saved.date) {
          const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
          if (saved.date === todayStr && saved.data) {
            let count = 0;
            for (const [k, v] of Object.entries(saved.data)) {
              baselineOIMap.set(k, v as number);
              count++;
            }
            oiBaselineSavedDate = todayStr;
            console.log(`[OI] Baseline restored from Firestore: ${count} symbols for ${todayStr}.`);
          } else {
            console.log(`[OI] Firestore baseline is from ${saved.date}, today is ${new Date(Date.now() + 5.5*60*60*1000).toISOString().split('T')[0]} — skipping restore.`);
          }
        }
      }).catch(e => console.error("[OI] Baseline load failed:", e));
      if (!loopStarted) { loopStarted = true; marketLoop(); }
    }).catch(err => {
      console.error("[INIT] Background load failed:", err);
      if (!loopStarted) { loopStarted = true; marketLoop(); }
    });

  } catch (err) {
    console.error("FATAL: Failed to start server listener:", err);
  }
}

// ─── Process Guards ───────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
});

startServer();
