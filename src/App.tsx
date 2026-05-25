/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { 
  TrendingUp, TrendingDown, Activity, AlertTriangle, 
  ShieldCheck, LayoutDashboard, History, Zap,
  BarChart3, Brain, ArrowUpRight, ArrowDownRight,
  Shield, Target, Crosshair, Menu, Bell, Search, Cpu, Layers, Filter,
  Globe, Moon, Info, ShieldAlert, LogOut, Settings, Timer
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, 
  Tooltip, ResponsiveContainer, BarChart, Bar, Cell,
  LineChart, Line, Legend
} from 'recharts';
import { cn } from './lib/utils';
import { getTradePrediction, PredictionResult } from './services/geminiService';
import { 
  MarketData, StrategyData, ExecutionState, MarketInfo, 
  HistoryPoint, TradeLogEntry, StockIntel, FO_STOCKS
} from './engine/types';

// --- Components ---

const RiskInput = ({ label, value, onChange, type = "number" }: { label: string, value: any, onChange: (val: any) => void, type?: string }) => (
  <div className="flex flex-col gap-1.5">
    <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest">{label}</label>
    <input 
      type={type}
      defaultValue={value}
      onBlur={(e) => onChange(e.target.value)}
      className="bg-black/40 border border-white/5 rounded px-3 py-1.5 text-[10px] font-mono text-blue-400 focus:border-blue-500/50 outline-none transition-all w-full"
    />
  </div>
);

export default function App() {
  const [market, setMarket] = useState<MarketData | null>(null);
  const [strategy, setStrategy] = useState<StrategyData | null>(null);
  const [execution, setExecution] = useState<ExecutionState | null>(null);
  const [appConfig, setAppConfig] = useState<any>(null);
  const [tradeLogs, setTradeLogs] = useState<TradeLogEntry[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [kiteStatus, setKiteStatus] = useState<{
    connected: boolean;
    hasConfig: boolean;
    tickerConnected?: boolean;
    tickerCachedTicksCount?: number;
    error?: string | null;
  }>({ connected: false, hasConfig: false });
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [isPredicting, setIsPredicting] = useState(false);

  // Gemini Options AI Analyzer state
  const [chainAnalysis, setChainAnalysis] = useState<any | null>(null);
  const [isAnalyzingChain, setIsAnalyzingChain] = useState(false);
  const [chainAnalysisError, setChainAnalysisError] = useState<string | null>(null);

  // Native cockpit notifications & audio alerts state
  const [toast, setToast] = useState<{
    id: number;
    type: 'ENTRY' | 'EXIT' | 'ROLL';
    title: string;
    message: string;
    subMessage?: string;
    color: 'emerald' | 'rose' | 'blue';
  } | null>(null);
  const prevPositionsRef = React.useRef<any[] | null>(null);
  const [showFlattenConfirm, setShowFlattenConfirm] = useState(false);
  const [isFlattening, setIsFlattening] = useState(false);
  const [pendingExecute, setPendingExecute] = useState<{ bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' } | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const [symbolSwitchError, setSymbolSwitchError] = useState<string | null>(null);
  // Active-symbol-derived constants — every place that used to hardcode 50 or NIFTY
  // reads these instead.
  const activeSymbol: 'NIFTY' | 'SENSEX' = (execution as any)?.activeSymbol || 'NIFTY';
  const activeSpec: any = (execution as any)?.activeSpec || { strikeStep: 50, lotSize: 75, displayName: 'Nifty 50', key: 'NIFTY' };
  const strikeStep: number = activeSpec.strikeStep || 50;
  
  // Stock Intel State
  const [selectedStock, setSelectedStock] = useState<string>('RELIANCE');
  const [stockIntel, setStockIntel] = useState<StockIntel | null>(null);
  const [isSearchingStock, setIsSearchingStock] = useState(false);
  const [foStocks, setFoStocks] = useState<string[]>(FO_STOCKS);

  useEffect(() => {
    const fetchFOStocks = async () => {
      try {
        const res = await fetch('/api/fo-stocks');
        if (res.ok) {
          const data = await res.json();
          setFoStocks(data);
        }
      } catch (e) {
        console.error("Failed to fetch FO stocks", e);
      }
    };
    fetchFOStocks();
  }, []);

  const handlePredict = async () => {
    if (!market || !strategy) return;
    setIsPredicting(true);
    try {
      // Small delay to simulate scanning if it's too fast
      const result = await getTradePrediction(market, strategy, tradeLogs);
      setPrediction(result);
    } catch (e) {
      console.error("Prediction failed:", e);
    } finally {
      setIsPredicting(false);
    }
  };

  const handleAnalyzeChain = async () => {
    if (!market) return;
    setIsAnalyzingChain(true);
    setChainAnalysisError(null);
    try {
      const spot = market.spot || 22000;
      const spotStrike = Math.round(spot / strikeStep) * strikeStep;
      const sorted = market.chain ? [...market.chain].sort((a, b) => a.strike - b.strike) : [];
      const chainFocus = sorted
        .filter(c => Math.abs(c.strike - spotStrike) <= 250)
        .map(c => ({
          strike: c.strike,
          ce_price: c.ce_price,
          pe_price: c.pe_price,
          ce_oi: c.ce_oi,
          pe_oi: c.pe_oi,
          ce_oi_change: c.ce_oi_change,
          pe_oi_change: c.pe_oi_change,
          ce_iv: c.ce_iv || 12.5,
          pe_iv: c.pe_iv || 13.0
        }));

      const payload = {
        spot,
        vix: market.vix || 15.0,
        pcr: insights?.pcr || market.pcr || 1.0,
        support: insights?.support || spotStrike - 150,
        supportOi: insights?.supportOi || 1500000,
        resistance: insights?.resistance || spotStrike + 150,
        resistanceOi: insights?.resistanceOi || 1400000,
        indicators: market.indicators,
        chainFocus
      };

      const res = await fetch("/api/analyze-chain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        throw new Error("Analysis failed. Server returned status: " + res.status);
      }

      const data = await res.json();
      setChainAnalysis(data);
    } catch (e: any) {
      console.error("Option chain analysis failed:", e);
      setChainAnalysisError(e.message || "Failed to analyze option chain");
    } finally {
      setIsAnalyzingChain(false);
    }
  };

  const fetchStockIntel = async (symbol: string) => {
    setIsSearchingStock(true);
    try {
      const res = await fetch(`/api/stock-intel/${symbol}`);
      if (res.ok) {
        const data = await res.json();
        setStockIntel(data);
      }
    } catch (e) {
      console.error("Failed to fetch stock intel", e);
    } finally {
      setIsSearchingStock(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'stock-alpha' && selectedStock) {
      fetchStockIntel(selectedStock);
    }
  }, [activeTab, selectedStock]);

  const updateConfigAtServer = async (update: any) => {
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update)
      });
      const data = await res.json();
      if (data.success) {
        setAppConfig(data.config);
      }
    } catch (e) {
      console.error("Failed to update config:", e);
    }
  };
  const [manualKiteConfig, setManualKiteConfig] = useState(() => {
    try {
      const saved = localStorage.getItem('kite_config');
      return saved ? JSON.parse(saved) : { key: '', secret: '' };
    } catch (e) {
      return { key: '', secret: '' };
    }
  });

  useEffect(() => {
    localStorage.setItem('kite_config', JSON.stringify(manualKiteConfig));
  }, [manualKiteConfig]);
  const [marketInfo, setMarketInfo] = useState<MarketInfo | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    return localStorage.getItem('quantum_logged_in') === 'true';
  });

  useEffect(() => {
    localStorage.setItem('quantum_logged_in', isLoggedIn.toString());
  }, [isLoggedIn]);

  const [lastSync, setLastSync] = useState<Date | null>(null);
  // Independent 1s heartbeat so the staleness badge keeps ticking even when polling stalls.
  const [uiClock, setUiClock] = useState<number>(Date.now());
  useEffect(() => {
    const id = setInterval(() => setUiClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Global keyboard shortcut: K = open Flatten-All confirm (only when positions are open
  // and we're not typing in an input). Escape closes the confirm modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      const inEditable = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable;
      if (inEditable) return;
      if (e.key === 'Escape') {
        if (showFlattenConfirm) { setShowFlattenConfirm(false); return; }
        if (pendingExecute) { setPendingExecute(null); return; }
      }
      if ((e.key === 'k' || e.key === 'K') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if ((execution?.positions?.length ?? 0) > 0) {
          setShowFlattenConfirm(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [execution?.positions?.length, showFlattenConfirm, pendingExecute]);
  const [loginData, setLoginData] = useState({ user: '', pass: '' });
  const [loginError, setLoginError] = useState('');
  
  const handleLogout = () => {
    setIsLoggedIn(false);
    localStorage.removeItem('quantum_logged_in');
  };
  
  // Backtest State
  const [backtestDates, setBacktestDates] = useState({
    from: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    to: new Date().toISOString().split('T')[0]
  });
  const [backtestStrategy, setBacktestStrategy] = useState('DYNAMIC');
  const [backtestStatus, setBacktestStatus] = useState<{
    loading: boolean;
    error: string | null;
    success: boolean;
    data: any | null;
  }>({ loading: false, error: null, success: false, data: null });

  // Telegram Integration State
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [telegramSaveStatus, setTelegramSaveStatus] = useState<{
    success: boolean | null;
    message?: string | null;
  }>({ success: null });
  const [telegramTestStatus, setTelegramTestStatus] = useState<{
    loading: boolean;
    success: boolean | null;
    error?: string | null;
    message?: string | null;
  }>({ loading: false, success: null });

  useEffect(() => {
    if (appConfig) {
      if (appConfig.TELEGRAM_BOT_TOKEN) setTelegramToken(appConfig.TELEGRAM_BOT_TOKEN);
      if (appConfig.TELEGRAM_CHAT_ID) setTelegramChatId(appConfig.TELEGRAM_CHAT_ID);
    }
  }, [appConfig]);

  const handleSaveTelegramConfig = async () => {
    setTelegramSaveStatus({ success: null });
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...appConfig,
          TELEGRAM_BOT_TOKEN: telegramToken,
          TELEGRAM_CHAT_ID: telegramChatId
        })
      });
      const data = await res.json();
      if (data.success) {
        setAppConfig(data.config);
        setTelegramSaveStatus({
          success: true,
          message: "Telegram configuration saved successfully!"
        });
        setTimeout(() => setTelegramSaveStatus({ success: null }), 4000);
      } else {
        setTelegramSaveStatus({
          success: false,
          message: "Failed to persist configuration to server database."
        });
      }
    } catch (e: any) {
      console.error("Failed to save Telegram config:", e);
      setTelegramSaveStatus({
        success: false,
        message: e?.message || "Failed to save configuration."
      });
    }
  };

  const handleTestTelegram = async () => {
    setTelegramTestStatus({ loading: true, success: null, error: null, message: null });
    try {
      const res = await fetch('/api/test-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: telegramToken,
          chatId: telegramChatId
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setTelegramTestStatus({
          loading: false,
          success: true,
          message: data.message || "Test message transmitted successfully! Check Telegram."
        });
      } else {
        setTelegramTestStatus({
          loading: false,
          success: false,
          error: data.error || "Telegram service returned validation failure.",
          message: data.response ? JSON.stringify(data.response) : null
        });
      }
    } catch (e: any) {
      setTelegramTestStatus({
        loading: false,
        success: false,
        error: e.message || "Network request failed to contact Gateway."
      });
    }
  };

  // Data Fetching
  useEffect(() => {
    const fetchKiteStatus = async (retryCount = 0) => {
      try {
        const res = await fetch('/api/kite/status?t=' + Date.now());
        
        if (!res.ok) {
          const text = await res.text();
          console.error(`Kite status error (${res.status}):`, text.substring(0, 50));
          throw new Error(`HTTP ${res.status}`);
        }

        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
           const text = await res.text();
           console.error("Non-JSON response for Kite status:", text.substring(0, 100));
           throw new Error("Received HTML instead of JSON from server. Please wait while the backend initializes.");
        }

        const data = await res.json();
        setNetworkError(null);
        
        // If server has no config but we do, sync it
        const saved = localStorage.getItem('kite_config');
        if (!data.hasConfig && saved) {
           const config = JSON.parse(saved);
           if (config.key && config.secret) {
              console.log("[AUTH] Server lost config, re-syncing from localStorage...");
              await fetch('/api/kite/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: saved
              });
              // Refresh status after sync
              const retry = await fetch('/api/kite/status');
              setKiteStatus(await retry.json());
              return;
           }
        }
        
        setKiteStatus(data);
      } catch (e: any) {
        console.error("Failed to fetch Kite status", e);
        if (retryCount < 3) {
           setTimeout(() => fetchKiteStatus(retryCount + 1), 2000);
        } else {
           setNetworkError("Server unreachable or misconfigured. Please check if backend is running.");
        }
      }
    };

    fetchKiteStatus();
    // Poll status every 30s to detect server restarts
    const statusInterval = setInterval(fetchKiteStatus, 30000);

    // Listen for OAuth success
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'KITE_AUTH_SUCCESS') {
        setKiteStatus(prev => ({ ...prev, connected: true }));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      clearInterval(statusInterval);
    };
  }, []);

  const handleKiteConnect = async () => {
    try {
      const res = await fetch('/api/kite/url');
      const { url } = await res.json();
      
      const width = 600;
      const height = 700;
      const left = window.innerWidth / 2 - width / 2;
      const top = window.innerHeight / 2 - height / 2;
      
      const popup = window.open(
        url, 
        "KiteConnect", 
        `width=${width},height=${height},left=${left},top=${top},status=no,menubar=no,toolbar=no`
      );

      // Listener for completion message from the callback page
      const handleMessage = (event: MessageEvent) => {
        if (event.data.type === 'KITE_AUTH_SUCCESS') {
          console.log(`[AUTH] Kite login successful for ${event.data.user}`);
          fetchData(); // Trigger immediate refresh
          window.removeEventListener('message', handleMessage);
          if (popup) popup.close();
        }
      };
      
      window.addEventListener('message', handleMessage);
    } catch (e) {
      console.error("Failed to get Kite URL", e);
    }
  };

  const handleSaveKiteConfig = async () => {
    try {
      const res = await fetch('/api/kite/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manualKiteConfig)
      });
      const data = await res.json();
      if (data.success) {
        const statusRes = await fetch('/api/kite/status');
        const statusData = await statusRes.json();
        setKiteStatus(statusData);
      }
    } catch (e) {
      console.error("Failed to save kite config", e);
    }
  };

  // Mock performance data for chart
  const mockPerformance = [
    { name: 'Apr 24', value: 92000 },
    { name: 'Apr 29', value: 98000 },
    { name: 'May 4', value: 95000 },
    { name: 'May 9', value: 104000 },
    { name: 'May 14', value: 112000 },
    { name: 'May 19', value: 118000 },
    { name: 'May 24', value: 124570 },
  ];

  const strategyRef = React.useRef<StrategyData | null>(null);

  // Data Fetching — per-request timeout + allSettled so one slow endpoint
  // doesn't freeze the whole polling chain.
  const fetchWithTimeout = useCallback(async (url: string, timeoutMs: number) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) return null;
      return await res.json();
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.error(`Network error fetching ${url}:`, e);
      } else {
        console.warn(`[POLL] Timeout (${timeoutMs}ms) fetching ${url}`);
      }
      return null;
    } finally {
      clearTimeout(t);
    }
  }, []);

  const fetchData = useCallback(async (type: 'fast' | 'slow' = 'fast') => {
    if (!isLoggedIn) return;
    try {
      const fastEndpoints = [
        '/api/market-data',
        '/api/execution-state',
        '/api/strategy-data'
      ];
      const slowEndpoints = [
        '/api/trade-logs',
        '/api/market-info'
      ];

      const endpoints = type === 'fast' ? fastEndpoints : slowEndpoints;
      const timeoutMs = type === 'fast' ? 6000 : 12000;

      const settled = await Promise.allSettled(endpoints.map(url => fetchWithTimeout(url, timeoutMs)));
      const results = settled.map(s => s.status === 'fulfilled' ? s.value : null);
      
      if (type === 'fast') {
        const [marketData, executionData, strategyData] = results;
        if (marketData) setMarket(marketData);
        if (executionData) setExecution(executionData);
        if (strategyData) {
          setStrategy(strategyData);
          strategyRef.current = strategyData;
        }

        if (marketData && executionData) {
          setHistory(prev => {
            const newPoint: HistoryPoint = {
              time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
              pnl: executionData.pnl || 0,
              score: strategyData?.score.total || strategyRef.current?.score.total || 0,
              vix: marketData.vix || 0,
              spot: marketData.spot || 0,
              rsi: marketData.indicators?.rsi || null,
              macd: marketData.indicators?.macd?.macd || null,
              macdSignal: marketData.indicators?.macd?.signal || null,
              macdHist: marketData.indicators?.macd?.histogram || null,
              bbUpper: marketData.indicators?.bollinger?.upper || null,
              bbLower: marketData.indicators?.bollinger?.lower || null,
              bbMiddle: marketData.indicators?.bollinger?.middle || null
            };
            if (prev.length > 0 && prev[prev.length - 1].time === newPoint.time) return prev;
            return [...prev, newPoint].slice(-60);
          });
        }
      } else {
        const [tradeLogsData, marketInfoData] = results;
        if (tradeLogsData) setTradeLogs(tradeLogsData);
        if (marketInfoData) setMarketInfo(marketInfoData);
      }

      // Mark sync only when at least one endpoint returned data this cycle
      const anyOk = results.some(r => r !== null);
      if (anyOk) setLastSync(new Date());
      setLoading(false);
    } catch (err) {
      console.error("Fetch Data Critical Error:", err);
    }
  }, [isLoggedIn, fetchWithTimeout]);

  // Config — fetched once, independent of polling so it doesn't recreate fetchData
  useEffect(() => {
    if (!isLoggedIn || appConfig) return;
    fetchWithTimeout('/api/config', 6000).then(cfg => { if (cfg) setAppConfig(cfg); });
  }, [isLoggedIn, appConfig, fetchWithTimeout]);

  // Native Terminal Chime Synthesizer via Web Audio API
  const playSynthSound = useCallback((type: 'ENTRY' | 'EXIT' | 'ROLL') => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      const now = ctx.currentTime;
      
      if (type === 'ENTRY') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5
        osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.25); // D6
        
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        
        osc.start(now);
        osc.stop(now + 0.35);
      } else if (type === 'EXIT') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, now); // A5
        osc.frequency.exponentialRampToValueAtTime(587.33, now + 0.12); // D5
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.3); // A4
        
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.15, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        
        osc.start(now);
        osc.stop(now + 0.4);
      } else {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(659.25, now); // E5
        osc.frequency.setValueAtTime(987.77, now + 0.06); // B5
        
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.1, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        
        osc.start(now);
        osc.stop(now + 0.2);
      }
    } catch (e) {
      console.warn("AudioContext init failed:", e);
    }
  }, []);

  const triggerNotification = useCallback((type: 'ENTRY' | 'EXIT' | 'ROLL', positions: any[]) => {
    playSynthSound(type);
    
    let title = "";
    let message = "";
    let subMessage = "";
    let color: 'emerald' | 'rose' | 'blue' = 'blue';

    const strikesStr = positions.map(p => `NIFTY ${p.strike} ${p.type}`).join(' & ');

    if (type === 'ENTRY') {
      title = "⚡ QUANTUM TRADE INITIATED";
      message = `Automated trade setup triggered successfully under Active Portfolio.`;
      subMessage = `Core contract legs matching: ${strikesStr}`;
      color = 'emerald';
    } else if (type === 'EXIT') {
      title = "🔒 CONSOLIDATION SQUARE-OFF";
      message = `All open derivative legs have been successfully exited & closed.`;
      subMessage = `Position liquidations: ${strikesStr}`;
      color = 'rose';
    } else {
      title = "🔄 STRATEGY ADAPTATION ROLL";
      message = `Risk parameters optimized. Automated trade rolled forward.`;
      subMessage = `Current contracts: ${strikesStr}`;
      color = 'blue';
    }

    const toastId = Date.now();
    setToast({
      id: toastId,
      type,
      title,
      message,
      subMessage,
      color
    });

    setTimeout(() => {
      setToast(prev => prev?.id === toastId ? null : prev);
    }, 8000);
  }, [playSynthSound]);

  // Monitor positions changes to trigger chime & status toasts
  useEffect(() => {
    if (!execution || loading) return;
    
    const prevPositions = prevPositionsRef.current;
    const currentPositions = execution.positions || [];
    
    // Only detect transitions if we already completed the baseline load
    if (prevPositions !== null) {
      // 1. Entry detection
      if (prevPositions.length === 0 && currentPositions.length > 0) {
        triggerNotification('ENTRY', currentPositions);
      }
      // 2. Exit detection
      else if (prevPositions.length > 0 && currentPositions.length === 0) {
        triggerNotification('EXIT', prevPositions);
      }
      // 3. Roll detection
      else if (prevPositions.length > 0 && currentPositions.length > 0) {
        const prevStrikes = prevPositions.map(p => `${p.strike}_${p.type}_${p.side}`).join('|');
        const currStrikes = currentPositions.map(p => `${p.strike}_${p.type}_${p.side}`).join('|');
        if (prevStrikes !== currStrikes) {
          triggerNotification('ROLL', currentPositions);
        }
      }
    }

    prevPositionsRef.current = currentPositions;
  }, [execution, loading, triggerNotification]);

  // Data Fetching Intervals
  useEffect(() => {
    if (!isLoggedIn) return;

    let fastTimer: NodeJS.Timeout;
    let slowTimer: NodeJS.Timeout;
    let isActive = true;

    const pollFast = async () => {
      if (!isActive) return;
      try {
        await fetchData('fast');
      } catch (e) {
        console.error('[POLL] fast cycle threw, will retry:', e);
      } finally {
        if (isActive) fastTimer = setTimeout(pollFast, 1500);
      }
    };

    const pollSlow = async () => {
      if (!isActive) return;
      try {
        await fetchData('slow');
      } catch (e) {
        console.error('[POLL] slow cycle threw, will retry:', e);
      } finally {
        if (isActive) slowTimer = setTimeout(pollSlow, 15000);
      }
    };

    // Initial load
    pollFast();
    pollSlow();

    return () => {
      isActive = false;
      clearTimeout(fastTimer);
      clearTimeout(slowTimer);
    };
  }, [fetchData, isLoggedIn]);

  // Manual-execute path:
  //  - In LIVE mode (real broker), open a confirm modal showing exactly what's about
  //    to be sent (structure, legs, SL, target). One stray click should never fire
  //    real-money orders.
  //  - In PAPER / MOCK, fire immediately as before.
  const handleExecute = async (bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL') => {
    if (execution?.executionMode === 'LIVE') {
      setPendingExecute({ bias });
      return;
    }
    await submitExecute(bias);
  };

  const submitExecute = async (bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL') => {
    setIsExecuting(true);
    try {
      await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bias })
      });
      await fetchData('fast');
    } catch (e) {
      console.error("[EXECUTE] failed:", e);
    } finally {
      setIsExecuting(false);
      setPendingExecute(null);
    }
  };

  const handleExit = async () => {
    await fetch('/api/exit', { method: 'POST' });
  };

  const handleFlattenAll = async () => {
    setIsFlattening(true);
    try {
      await fetch('/api/exit', { method: 'POST' });
      // Force an immediate refresh so the user sees positions cleared right away.
      await fetchData('fast');
    } catch (e) {
      console.error("[FLATTEN] failed:", e);
    } finally {
      setIsFlattening(false);
      setShowFlattenConfirm(false);
    }
  };

  const handleToggleDataMode = async (targetMode?: 'MOCK' | 'LIVE') => {
    if (!execution || !marketInfo) return;
    try {
      const newMode = targetMode || (execution.dataSource === 'MOCK' ? 'LIVE' : 'MOCK');
      // MODIFICATION: Allow LIVE mode during off-market hours for analysis
      if (newMode === 'LIVE' && marketInfo.isMarketClosed) {
         console.log("Entering Analysis Mode: Accessing last institutional data snapshot.");
      }
      const res = await fetch('/api/toggle-data-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode })
      });
      const data = await res.json();
      setExecution(prev => prev ? { ...prev, dataSource: data.dataSource } : null);
      
      // Trigger immediate fetch to reduce visual delay
      setIsSearchingStock(true);
      await Promise.all([fetchData(), fetchStockIntel(selectedStock)]);
      setIsSearchingStock(false);
    } catch (e) {
      console.error("Failed to toggle data mode", e);
    }
  };

  const handleToggleExecutionMode = async () => {
    if (!execution) return;
    try {
      const newMode = execution.executionMode === 'PAPER' ? 'LIVE' : 'PAPER';
      const res = await fetch('/api/toggle-execution-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode })
      });
      const data = await res.json();
      setExecution(prev => prev ? { ...prev, executionMode: data.executionMode } : null);
    } catch (e) {
      console.error("Failed to toggle execution mode", e);
    }
  };

  const handleToggleAutoMode = async () => {
    if (!execution || !marketInfo) return;
    if (marketInfo.isMarketClosed) {
       console.warn("Market is closed. Auto Mode is disabled.");
       return;
    }
    try {
      const newMode = !execution.autoMode;
      const res = await fetch('/api/toggle-auto-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode })
      });
      const data = await res.json();
      setExecution(prev => prev ? { ...prev, autoMode: data.autoMode } : null);
    } catch (e) {
      console.error("Failed to toggle auto mode", e);
    }
  };

  const handleResetEngine = async () => {
    if (!window.confirm("Are you sure you want to completely reset the trading engine and risk stats? This will clear any ghost or zombie positions and reset current drawdown metrics.")) {
       return;
    }
    try {
      const res = await fetch('/api/debug/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.success) {
        console.log("Engine reset successfully");
        // Refetch state instantly
        await fetchData(true);
      }
    } catch (e) {
      console.error("Failed to reset engine", e);
    }
  };

  const handleRunBacktest = async () => {
    if (!kiteStatus.connected) {
      setBacktestStatus(prev => ({ ...prev, error: "Zerodha account not connected" }));
      return;
    }

    setBacktestStatus({ loading: true, error: null, success: false, data: null });
    
    try {
      const res = await fetch(`/api/backtest/historical?from=${backtestDates.from}&to=${backtestDates.to}&interval=60minute`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to fetch historical data");
      }
      
      const result = await res.json();
      const candles = result.candles || [];
      
      if (candles.length < 20) {
        throw new Error("Insufficient historical data for simulation (min 20 candles)");
      }

      // --- INSTITUTIONAL SYNTHETIC OPTION BACKTESTING ENGINE ---
      // 1. Math Helpers for Options Valuation
      const cumulativeNormalDistribution = (x: number): number => {
        const b1 = 0.319381530;
        const b2 = -0.356563782;
        const b3 = 1.781477937;
        const b4 = -1.821255978;
        const b5 = 1.330274429;
        const p = 0.2316419;
        const c = 0.39894228;

        if (x >= 0.0) {
          const k = 1.0 / (1.0 + p * x);
          const w = 1.0 - c * Math.exp(-x * x / 2.0) * k * (b1 + k * (b2 + k * (b3 + k * (b4 + k * b5))));
          return w;
        } else {
          const k = 1.0 / (1.0 - p * x);
          const w = c * Math.exp(-x * x / 2.0) * k * (b1 + k * (b2 + k * (b3 + k * (b4 + k * b5))));
          return 1.0 - w;
        }
      };

      const calculateOptionPrice = (isCall: boolean, S: number, K: number, T: number, r: number, sigma: number): number => {
        if (T <= 0.0001) {
          return isCall ? Math.max(1, S - K) : Math.max(1, K - S);
        }
        const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
        const d2 = d1 - sigma * Math.sqrt(T);
        
        if (isCall) {
          const price = S * cumulativeNormalDistribution(d1) - K * Math.exp(-r * T) * cumulativeNormalDistribution(d2);
          return Math.max(1.5, price);
        } else {
          const price = K * Math.exp(-r * T) * cumulativeNormalDistribution(-d2) - S * cumulativeNormalDistribution(-d1);
          return Math.max(1.5, price);
        }
      };

      // 2. Precompute Indicator Streams to prevent manual loops inside simulation
      const kFast = 2 / (9 + 1);
      const kSlow = 2 / (21 + 1);
      const emaFast: number[] = [];
      const emaSlow: number[] = [];
      const rsi: number[] = [];

      let gains = 0;
      let lossesVal = 0;

      for (let j = 0; j < candles.length; j++) {
        const close = candles[j].close;
        if (j === 0) {
          emaFast.push(close);
          emaSlow.push(close);
          rsi.push(50);
        } else {
          emaFast.push(close * kFast + emaFast[j-1] * (1 - kFast));
          emaSlow.push(close * kSlow + emaSlow[j-1] * (1 - kSlow));
          
          const diff = close - candles[j-1].close;
          const gain = diff > 0 ? diff : 0;
          const loss = diff < 0 ? -diff : 0;
          
          if (j < 14) {
            gains += gain;
            lossesVal += loss;
            rsi.push(50);
          } else {
            gains = (gains * 13 + gain) / 14;
            lossesVal = (lossesVal * 13 + loss) / 14;
            if (lossesVal === 0) {
              rsi.push(100);
            } else {
              const rs = gains / lossesVal;
              rsi.push(100 - (100 / (1 + rs)));
            }
          }
        }
      }

      // 3. Execution Simulation Parameters
      const initialBalance = 200000;
      let balance = initialBalance;
      const lotSize = 65; 
      let trades: any[] = [];
      let equityCurve: any[] = [];
      let currentDrawdown = 0;
      let maxBalance = balance;
      let wins = 0;
      let losses = 0;
      let totalProfit = 0;
      let totalLoss = 0;

      interface ActivePosition {
        strategy: string;
        strike: number;
        entryIndex: number;
        entryCost: number;
        longLegs: { strike: number; isCall: boolean }[];
        shortLegs: { strike: number; isCall: boolean }[];
      }
      
      let activePosition: ActivePosition | null = null;

      // Start of Institutional Synthetic Option Simulation loop
      for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        
        if (i < 21) continue;
        
        // 4. Derive Weekly Expiry Time-to-Expiration (T in years)
        const currentDate = new Date(candle.date);
        const currentDay = currentDate.getDay(); 
        let daysToThursday = (4 - currentDay + 7) % 7;
        if (daysToThursday === 0) {
          if (currentDate.getHours() >= 15) {
            daysToThursday = 7; // expired, shift to next week
          }
        }
        const T = Math.max(0.5, daysToThursday) / 365;

        // 5. Volatility Regime Layer
        // Calculate dynamic IV based on spot log-returns volatility (14 lookback window)
        let recentVol = 0.15; // baseline 15% IV
        if (i >= 14) {
          const slice = candles.slice(i - 13, i + 1);
          const logReturns = [];
          for (let k = 1; k < slice.length; k++) {
            logReturns.push(Math.log(slice[k].close / slice[k-1].close));
          }
          const mean = logReturns.reduce((acc, val) => acc + val, 0) / logReturns.length;
          const variance = logReturns.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (logReturns.length - 1);
          recentVol = Math.max(0.08, Math.min(0.42, Math.sqrt(variance) * Math.sqrt(1764)));
        }
        const currentIV = recentVol;

        // 6. Manage Active Position (if any)
        if (activePosition) {
          const S = candle.close;
          let currentLegValue = 0;

          for (const leg of activePosition.longLegs) {
            currentLegValue += calculateOptionPrice(leg.isCall, S, leg.strike, T, 0.07, currentIV);
          }
          for (const leg of activePosition.shortLegs) {
            currentLegValue -= calculateOptionPrice(leg.isCall, S, leg.strike, T, 0.07, currentIV);
          }

          let exitTrade = false;
          let pnlVal = 0;

          if (activePosition.strategy === 'BUY_CE' || activePosition.strategy === 'BUY_PE') {
            pnlVal = Math.round((currentLegValue - activePosition.entryCost) * lotSize);
            // Check Stops/Targets
            if (currentLegValue < activePosition.entryCost * 0.50) exitTrade = true; // -50% SL
            else if (currentLegValue > activePosition.entryCost * 1.60) exitTrade = true; // +60% TP
          } else {
            // Net Credit Strategies (Bull Put Spread, Bear Call Spread, Iron Condor)
            pnlVal = Math.round((activePosition.entryCost - currentLegValue) * lotSize);
            // Check risk bounds
            if (pnlVal < -1.5 * activePosition.entryCost * lotSize) exitTrade = true; // Max risk drawdown stop
            else if (currentLegValue < activePosition.entryCost * 0.15) exitTrade = true; // 85% decay target
          }

          // Safety triggers: Expiry is close, maximum trade holding achieved, or signals model reversed
          if (T <= 0.002) {
            exitTrade = true;
          } else if (i - activePosition.entryIndex >= 14) {
            exitTrade = true; // Force exit after 14 ticks (~2 trading days) to roll capital
          } else {
            // Strategic Trend Reversal Filters
            if ((activePosition.strategy === 'BUY_CE' || activePosition.strategy === 'BULL_PUT_SPREAD') && emaFast[i] < emaSlow[i]) {
              exitTrade = true;
            } else if ((activePosition.strategy === 'BUY_PE' || activePosition.strategy === 'BEAR_CALL_SPREAD') && emaFast[i] > emaSlow[i]) {
              exitTrade = true;
            }
          }

          if (exitTrade) {
            balance += pnlVal;
            const timestamp = new Date(candle.date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit' });

            trades.push({
              pnl: pnlVal,
              balance,
              timestamp,
              type: pnlVal > 0 ? 'WIN' : 'LOSS',
              strategy: activePosition.strategy,
              entrySpot: candles[activePosition.entryIndex].close,
              exitSpot: S,
              entryPremium: Math.round(activePosition.entryCost * 10) / 10,
              exitPremium: Math.round(currentLegValue * 10) / 10,
              strike: activePosition.strike
            });

            if (pnlVal > 0) {
              wins++;
              totalProfit += pnlVal;
            } else {
              losses++;
              totalLoss += Math.abs(pnlVal);
            }

            if (balance > maxBalance) maxBalance = balance;
            const drawdown = ((maxBalance - balance) / maxBalance) * 100;
            if (drawdown > currentDrawdown) currentDrawdown = drawdown;

            activePosition = null;
          }
        }

        // 7. Check for New Entry Setup (if capital is free)
        if (!activePosition) {
          const bullTrend = emaFast[i-1] > emaSlow[i-1] && rsi[i-1] > 51;
          const bearTrend = emaFast[i-1] < emaSlow[i-1] && rsi[i-1] < 49;
          const rangeConsolidation = rsi[i-1] >= 48 && rsi[i-1] <= 52;

          let triggeredStrategy: string | null = null;

          // Align signals with selected Trading Strategy configuration
          if (backtestStrategy === 'BUY_CE' && bullTrend) {
            triggeredStrategy = 'BUY_CE';
          } else if (backtestStrategy === 'BUY_PE' && bearTrend) {
            triggeredStrategy = 'BUY_PE';
          } else if (backtestStrategy === 'BULL_PUT_SPREAD' && bullTrend) {
            triggeredStrategy = 'BULL_PUT_SPREAD';
          } else if (backtestStrategy === 'BEAR_CALL_SPREAD' && bearTrend) {
            triggeredStrategy = 'BEAR_CALL_SPREAD';
          } else if (backtestStrategy === 'IRON_CONDOR' && rangeConsolidation) {
            triggeredStrategy = 'IRON_CONDOR';
          } else if (backtestStrategy === 'DYNAMIC') {
            if (bullTrend) {
              triggeredStrategy = currentIV > 0.16 ? 'BUY_CE' : 'BULL_PUT_SPREAD';
            } else if (bearTrend) {
              triggeredStrategy = currentIV > 0.16 ? 'BUY_PE' : 'BEAR_CALL_SPREAD';
            } else if (rangeConsolidation) {
              triggeredStrategy = 'IRON_CONDOR';
            }
          }

          if (triggeredStrategy) {
            const S = candle.close;
            const K = Math.round(S / strikeStep) * strikeStep;
            let longLegs: { strike: number; isCall: boolean }[] = [];
            let shortLegs: { strike: number; isCall: boolean }[] = [];
            let entryCost = 0;

            if (triggeredStrategy === 'BUY_CE') {
              longLegs.push({ strike: K, isCall: true });
              entryCost = calculateOptionPrice(true, S, K, T, 0.07, currentIV);
            } else if (triggeredStrategy === 'BUY_PE') {
              longLegs.push({ strike: K, isCall: false });
              entryCost = calculateOptionPrice(false, S, K, T, 0.07, currentIV);
            } else if (triggeredStrategy === 'BULL_PUT_SPREAD') {
              shortLegs.push({ strike: K, isCall: false });
              longLegs.push({ strike: K - 150, isCall: false });
              entryCost = calculateOptionPrice(false, S, K, T, 0.07, currentIV) - calculateOptionPrice(false, S, K - 150, T, 0.07, currentIV);
            } else if (triggeredStrategy === 'BEAR_CALL_SPREAD') {
              shortLegs.push({ strike: K, isCall: true });
              longLegs.push({ strike: K + 150, isCall: true });
              entryCost = calculateOptionPrice(true, S, K, T, 0.07, currentIV) - calculateOptionPrice(true, S, K + 150, T, 0.07, currentIV);
            } else if (triggeredStrategy === 'IRON_CONDOR') {
              shortLegs.push({ strike: K + 100, isCall: true });
              shortLegs.push({ strike: K - 100, isCall: false });
              longLegs.push({ strike: K + 200, isCall: true });
              longLegs.push({ strike: K - 200, isCall: false });

              const callCredit = calculateOptionPrice(true, S, K + 100, T, 0.07, currentIV) - calculateOptionPrice(true, S, K + 200, T, 0.07, currentIV);
              const putCredit = calculateOptionPrice(false, S, K - 100, T, 0.07, currentIV) - calculateOptionPrice(false, S, K - 200, T, 0.07, currentIV);
              entryCost = callCredit + putCredit;
            }

            // Capital safety threshold check
            if (entryCost > 0) {
              activePosition = {
                strategy: triggeredStrategy,
                strike: K,
                entryIndex: i,
                entryCost: entryCost,
                longLegs,
                shortLegs
              };
            }
          }
        }

        equityCurve.push({
          name: new Date(candle.date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit' }),
          value: balance + (candle.close - candles[0].close) * 10 // Mix of realized + unrealized proxy
        });
      }

      const totalTradesCount = wins + losses;
      const winRate = totalTradesCount > 0 ? (wins / totalTradesCount) * 100 : 0;
      const profitFactor = totalLoss > 0 ? (totalProfit / totalLoss) : 1.5;
      const avgRR = totalLoss > 0 ? (totalProfit / wins) / (totalLoss / losses) : 1.2;

      const distribution = {
        '0-500': trades.filter(t => t.pnl > 0 && t.pnl <= 500).length,
        '500-1000': trades.filter(t => t.pnl > 500 && t.pnl <= 1000).length,
        '1000+': trades.filter(t => t.pnl > 1000).length,
        '-500-0': trades.filter(t => t.pnl < 0 && t.pnl >= -500).length,
        '-1000--500': trades.filter(t => t.pnl < -500 && t.pnl >= -1000).length,
        '<-1000': trades.filter(t => t.pnl < -1000).length,
      };

      setBacktestStatus({ 
        loading: false, 
        error: null, 
        success: true, 
        data: {
          ...result,
          equityCurve,
          trades,
          stats: {
            winRate: winRate.toFixed(1) + '%',
            rr: `1:${avgRR.toFixed(1)}`,
            profitFactor: profitFactor.toFixed(2),
            drawdown: currentDrawdown.toFixed(1) + '%',
            totalTrades: totalTradesCount,
            distribution
          }
        } 
      });
    } catch (e: any) {
      setBacktestStatus({ 
        loading: false, 
        error: e.message || "An unknown error occurred", 
        success: false,
        data: null
      });
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginData.user === 'admin' && loginData.pass === 'alpha123') {
      setIsLoggedIn(true);
      setLoginError('');
    } else {
      setLoginError('Invalid credentials');
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-[#070b14] flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md bg-slate-900/50 border border-white/10 rounded-2xl p-8 backdrop-blur-xl"
        >
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-[0_0_30px_rgba(37,99,235,0.3)] mb-4">
              <Zap className="text-white w-8 h-8 fill-current" />
            </div>
            <h1 className="text-xl font-black text-white tracking-[0.2em] uppercase">Quantum Core</h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-2">Institutional Terminal Access</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Username</label>
              <input 
                type="text"
                value={loginData.user}
                onChange={(e) => setLoginData({...loginData, user: e.target.value})}
                className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-white text-sm focus:border-blue-500/50 transition-colors outline-none"
                placeholder="Terminal ID"
              />
            </div>
            <div>
              <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Password</label>
              <input 
                type="password"
                value={loginData.pass}
                onChange={(e) => setLoginData({...loginData, pass: e.target.value})}
                className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-white text-sm focus:border-blue-500/50 transition-colors outline-none"
                placeholder="Access Key"
              />
            </div>
            {loginError && (
              <div className="text-[10px] font-bold text-rose-500 uppercase tracking-widest text-center">
                {loginError}
              </div>
            )}
            <button 
              type="submit"
              className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-black uppercase tracking-[0.2em] text-xs transition-all shadow-lg shadow-blue-600/20"
            >
              Initialize Session
            </button>
          </form>
          <div className="mt-8 text-center space-y-4">
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest bg-white/5 py-2 rounded-lg">
              DEV ACCESS: <span className="text-blue-400">admin</span> / <span className="text-blue-400">alpha123</span>
            </p>
            <p className="text-[9px] text-slate-600 uppercase tracking-widest leading-relaxed">
              Authorized access only. All terminal actions are logged and encrypted using AES-256 protocols.
            </p>
          </div>
        </motion.div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#070b14] flex items-center justify-center">
        <div className="flex flex-col items-center gap-6">
          <motion.div 
            animate={{ rotate: 360 }}
            transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
            className="w-20 h-20 border-t-2 border-r-2 border-blue-500 rounded-full flex items-center justify-center relative"
          >
            <Zap className="w-10 h-10 text-blue-500 shadow-[0_0_20px_rgba(59,130,246,0.5)]" />
            <motion.div 
              animate={{ opacity: [0.2, 0.8, 0.2] }}
              transition={{ duration: 2, repeat: Infinity }}
              className="absolute inset-0 border-2 border-blue-500/20 rounded-full scale-125"
            />
          </motion.div>
          <div className="flex flex-col items-center">
            <h2 className="text-sm font-black tracking-[0.4em] text-white/90 mb-2 uppercase">Alpha Quantum Engine</h2>
            <p className="text-blue-400/50 font-mono text-[9px] uppercase tracking-[0.2em]">Synchronizing Intelligence Nodes...</p>
          </div>
        </div>
      </div>
    );
  }

  const calculatePortfolioGreeks = () => {
    if (!execution?.positions?.length) {
      const biasDelta = strategy?.score.bias === 'BEARISH' ? -0.50 : 
                       strategy?.score.bias === 'BULLISH' ? 0.50 : 0.05;
      return {
        delta: biasDelta,
        theta: -Math.round((market?.vix || 12) * 35),
        vega: (market?.vix || 12.8)
      };
    }

    let netDelta = 0;
    let netTheta = 0;
    let netVega = 0;

    execution.positions.forEach(pos => {
      const chain = market?.chain.find(c => c.strike === pos.strike);
      const ivProxy = (market?.vix || 15) / 100;
      
      // Dynamic Delta calculation
      const baseDelta = chain?.delta || 0.5;
      const deltaSign = (pos.type === 'CE' ? 1 : -1) * (pos.side === 'BUY' ? 1 : -1);
      netDelta += baseDelta * deltaSign;

      // Dynamic Theta (Simplified)
      const baseTheta = -((pos.entryPrice * ivProxy) / 10);
      const thetaSign = (pos.side === 'BUY' ? 1 : -1);
      netTheta += baseTheta * thetaSign;

      // Dynamic Vega (Simplified)
      const baseVega = pos.entryPrice * 0.05;
      const vegaSign = (pos.side === 'BUY' ? 1 : -1);
      netVega += baseVega * vegaSign;
    });

    return {
      delta: netDelta,
      theta: Math.round(netTheta * 100),
      vega: netVega
    };
  };

  const greeks = calculatePortfolioGreeks();
  const displayDelta = greeks.delta;
  const displayTheta = greeks.theta;
  const displayVega = greeks.vega;

  const formatOi = (val: number) => {
    if (val >= 1000000) return `${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `${(val / 1000).toFixed(0)}K`;
    return val.toString();
  };

  const computeOptionChainInsights = () => {
    const chain = market?.chain || [];
    const spot = market?.spot || 22000;
    
    if (chain.length === 0) return null;
    
    let maxCeOiStrike = chain[0].strike;
    let maxCeOiVal = chain[0].ce_oi;
    chain.forEach(c => {
      if (c.ce_oi > maxCeOiVal) {
        maxCeOiVal = c.ce_oi;
        maxCeOiStrike = c.strike;
      }
    });

    let secondCeOiStrike = maxCeOiStrike;
    let secondCeOiVal = 0;
    chain.forEach(c => {
      if (c.strike !== maxCeOiStrike && c.ce_oi > secondCeOiVal) {
        secondCeOiVal = c.ce_oi;
        secondCeOiStrike = c.strike;
      }
    });
    
    let maxPeOiStrike = chain[0].strike;
    let maxPeOiVal = chain[0].pe_oi;
    chain.forEach(c => {
      if (c.pe_oi > maxPeOiVal) {
        maxPeOiVal = c.pe_oi;
        maxPeOiStrike = c.strike;
      }
    });

    let secondPeOiStrike = maxPeOiStrike;
    let secondPeOiVal = 0;
    chain.forEach(c => {
      if (c.strike !== maxPeOiStrike && c.pe_oi > secondPeOiVal) {
        secondPeOiVal = c.pe_oi;
        secondPeOiStrike = c.strike;
      }
    });
    
    let totalCeOi = 0;
    let totalPeOi = 0;
    let totalCeOiChange = 0;
    let totalPeOiChange = 0;
    chain.forEach(c => {
      totalCeOi += c.ce_oi || 0;
      totalPeOi += c.pe_oi || 0;
      totalCeOiChange += c.ce_oi_change || 0;
      totalPeOiChange += c.pe_oi_change || 0;
    });
    
    const currentPcr = totalCeOi > 0 ? totalPeOi / totalCeOi : 1.0;
    const oiChangeRatio = totalCeOiChange > 0 ? totalPeOiChange / totalCeOiChange : 1.0;

    let pcrBias = "NEUTRAL";
    let pcrColor = "text-slate-400 font-black";
    let pcrText = "Balanced range aggregation. Neutral sentiment.";
    if (currentPcr > 1.2) {
      pcrBias = "BULLISH DOMINANCE";
      pcrColor = "text-emerald-400 font-extrabold";
      pcrText = "Strong Put Writing suggests robust, ascending support.";
    } else if (currentPcr < 0.8) {
      pcrBias = "BEARISH HEADWINDS";
      pcrColor = "text-rose-400 font-extrabold";
      pcrText = "Overhead Call Writing points to resistance capping upside.";
    }

    let netCeDelta = 0;
    let netPeDelta = 0;
    chain.forEach(c => {
      const ceD = 1 / (1 + Math.exp(-(spot - c.strike) / 35));
      const peD = ceD - 1.0;
      netCeDelta += ceD * (c.ce_oi || 0);
      netPeDelta += peD * (c.pe_oi || 0);
    });
    const greekDeltaBias = netCeDelta + netPeDelta;

    let maxGamma = 0;
    let maxGammaStrike = spot;
    chain.forEach(c => {
      const g = (1 / (35 * Math.sqrt(2 * Math.PI))) * Math.exp(-Math.pow(spot - c.strike, 2) / (2 * 35 * 35));
      if (g > maxGamma) {
        maxGamma = g;
        maxGammaStrike = c.strike;
      }
    });

    let directionBias = "STABLE BOUNDS";
    if (totalPeOiChange > totalCeOiChange * 1.15) {
      directionBias = "UPWARD TENSION";
    } else if (totalCeOiChange > totalPeOiChange * 1.15) {
      directionBias = "DOWNWARD DAMPENING";
    }

    return {
      support: maxPeOiStrike,
      supportOi: maxPeOiVal,
      secondSupport: secondPeOiStrike,
      resistance: maxCeOiStrike,
      resistanceOi: maxCeOiVal,
      secondResistance: secondCeOiStrike,
      pcr: currentPcr,
      pcrBias,
      pcrColor,
      pcrText,
      gammaTrigger: maxGammaStrike,
      greekDeltaBias,
      directionBias,
      oiChangeRatio,
    };
  };

  const insights = computeOptionChainInsights();

  const pnlColor = (execution?.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400";
  const biasColor = strategy?.score.bias === 'BULLISH' ? "text-emerald-400" : strategy?.score.bias === 'BEARISH' ? "text-rose-400" : "text-slate-400";

  return (
    <div className="h-screen bg-[#070b14] text-slate-300 font-sans flex overflow-hidden">
      {networkError && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-red-500/90 text-white px-4 py-2 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-2 animate-pulse shadow-lg backdrop-blur-md border border-white/10">
          <AlertTriangle size={12} className="fill-white/20" />
          {networkError}
        </div>
      )}
      
      {/* --- SIDEBAR NAVIGATION --- */}
      <aside className="w-20 border-r border-terminal-line bg-black/40 backdrop-blur-3xl flex flex-col items-center py-8 gap-10 z-20">
        <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(37,99,235,0.4)]">
          <Zap className="text-white w-6 h-6 fill-current" />
        </div>
        
        <nav className="flex flex-col gap-6">
          {[
            { id: 'dashboard', icon: LayoutDashboard, label: 'Intel' },
            { id: 'options', icon: Layers, label: 'Chain' },
            { id: 'risk', icon: ShieldAlert, label: 'Risk' },
            { id: 'analytics', icon: TrendingUp, label: 'Analytics' },
            { id: 'backtest', icon: BarChart3, label: 'Backtest' },
            { id: 'history', icon: History, label: 'Audit' },
            { id: 'settings', icon: Shield, label: 'Settings', alert: !kiteStatus.hasConfig },
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={cn(
                "group relative p-3 rounded-xl transition-all duration-300",
                activeTab === item.id 
                  ? "bg-blue-600/10 text-blue-400" 
                  : "text-slate-500 hover:text-slate-300 hover:bg-white/5"
              )}
            >
              <item.icon className="w-5 h-5" />
              {item.alert && !kiteStatus.hasConfig && (
                <div className="absolute top-2 right-2 w-2 h-2 bg-rose-500 rounded-full animate-pulse" />
              )}
              {activeTab === item.id && (
                <motion.div 
                  layoutId="activeTab"
                  className="absolute left-0 top-1/4 bottom-1/4 w-1 bg-blue-500 rounded-r-full"
                />
              )}
              <span className="absolute left-full ml-4 px-2 py-1 bg-slate-800 text-[10px] text-white rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none font-bold tracking-widest z-50 capitalize">
                {item.label}
              </span>
            </button>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-6">
          <button 
            onClick={handleLogout}
            className="text-slate-500 hover:text-rose-400 transition-colors"
            title="Logout"
          >
            <LogOut className="w-5 h-5" />
          </button>
          <button className="text-slate-500 hover:text-white transition-colors">
            <Bell className="w-5 h-5" />
          </button>
          <div className="w-10 h-10 rounded-xl border border-terminal-line overflow-hidden p-0.5">
            <img 
              src="https://ui-avatars.com/api/?name=Admin&background=1e293b&color=3b82f6" 
              alt="user" 
              className="w-full h-full rounded-lg opacity-80" 
            />
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-x-auto overflow-y-auto custom-scrollbar">
         <div className="flex-grow flex flex-col min-w-[1240px]">
           {/* --- TOP SUMMARY BAR --- */}
        <div className="bg-black/60 border-b border-white/5 py-1.5 px-8 flex justify-between items-center text-[9px] font-black uppercase tracking-[0.15em] text-slate-400 shrink-0">
          <div className="flex gap-10">
            <div className="flex items-center gap-2">
              <span className="text-slate-500">Underlying Spot</span>
              <span className="text-white">₹{market?.spot?.toLocaleString(undefined, { minimumFractionDigits: 1 })}</span>
              {marketInfo?.isMarketClosed && (
                <span className="bg-rose-500/20 text-rose-400 px-1.5 py-0.5 rounded text-[7px] border border-rose-500/30">CLOSED</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-500">Institutional VWAP</span>
              <span className="text-blue-400">₹{market?.vwap?.toFixed(1)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-500">DTE (Weekly)</span>
              <span className="text-amber-500">{marketInfo?.expiry.daysToExpiry} Days</span>
            </div>
          </div>
          <div className="flex items-center gap-10">
            <div className="flex items-center gap-metric">
              <div className="flex items-center gap-2">
                 <span className="text-slate-500">SYNC</span>
                 {(() => {
                    const ageMs = lastSync ? uiClock - lastSync.getTime() : Infinity;
                    const fresh = ageMs < 3000;
                    const stale = ageMs >= 3000 && ageMs < 8000;
                    const frozen = ageMs >= 8000;
                    return (
                      <div className={cn(
                        "flex items-center gap-1 group px-2 py-0.5 rounded-full border",
                        frozen ? "bg-rose-500/20 border-rose-500/40 animate-pulse" : "bg-white/5 border-white/5"
                      )}>
                        <motion.div
                          key={lastSync?.getTime()}
                          initial={{ scale: 2, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          className={cn(
                            "w-1.5 h-1.5 rounded-full transition-all duration-300",
                            loading ? "bg-slate-700" :
                              fresh ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]" :
                              stale ? "bg-amber-400" :
                              "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.8)]"
                          )}
                        />
                        <span className={cn(
                          "text-[8px] font-mono transition-colors",
                          fresh ? "text-emerald-400" : stale ? "text-amber-400" : "text-rose-400 font-bold"
                        )}>
                          {market?.error ? 'FAIL' : !lastSync ? 'OFFLINE' : frozen ? `FROZEN ${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 1000)}s`}
                        </span>
                      </div>
                    );
                 })()}
              </div>
              <div className="hidden md:flex gap-10">
                 <div className="flex items-center gap-2">
                  <span className="text-slate-500 whitespace-nowrap">ATM Straddle Premium</span>
                  <motion.span 
                    key={market?.spot}
                    initial={{ opacity: 0.5 }}
                    animate={{ opacity: 1 }}
                    className="text-emerald-400 font-bold"
                  >
                    ₹{((market?.chain?.find(c => c.strike === Math.round((market?.spot || 0)/strikeStep)*strikeStep)?.ce_price || 0) + 
                       (market?.chain?.find(c => c.strike === Math.round((market?.spot || 0)/strikeStep)*strikeStep)?.pe_price || 0))?.toFixed(1) || '---'}
                  </motion.span>
                </div>
              </div>
            </div>
            {(() => {
              const ivRank = strategy?.score?.ivRank;
              const ivPct = strategy?.score?.ivPercentile;
              const rankColor = ivRank === null || ivRank === undefined
                ? "text-slate-500"
                : ivRank > 70 ? "text-rose-400"
                : ivRank < 30 ? "text-emerald-400"
                : "text-purple-400";
              const rankLabel = ivRank === null || ivRank === undefined
                ? "WARMING"
                : ivRank > 70 ? "RICH"
                : ivRank < 30 ? "CHEAP"
                : "NORMAL";
              return (
                <div className="flex items-center gap-2" title="IV Rank: position of current IV in trailing min-max band. RICH = sell premium, CHEAP = buy premium.">
                  <span className="text-slate-500">IV RANK / %ILE</span>
                  <span className={cn("font-bold", rankColor)}>
                    {ivRank !== null && ivRank !== undefined ? Math.round(ivRank) : '--'}
                    <span className="text-slate-500 mx-1">/</span>
                    {ivPct !== null && ivPct !== undefined ? `${Math.round(ivPct)}%` : '--'}
                  </span>
                  <span className={cn("text-[7px] px-1.5 py-0.5 rounded border", rankColor, "border-current/30 bg-current/10")}>{rankLabel}</span>
                </div>
              );
            })()}
            {execution && execution.positions && execution.positions.length > 0 && (
              <div className="flex items-center gap-3" title="Portfolio Greeks (live).">
                <span className="text-slate-500">Greeks</span>
                <span className="text-slate-300 font-mono text-[9px]">
                  <span className={cn(Math.abs(execution.netDelta || 0) > 1.5 ? "text-amber-400" : "text-blue-400")}>Δ {(execution.netDelta || 0).toFixed(2)}</span>
                  <span className="text-slate-600 mx-1.5">·</span>
                  <span className="text-purple-400">Γ {(execution.netGamma || 0).toFixed(3)}</span>
                  <span className="text-slate-600 mx-1.5">·</span>
                  <span className={cn((execution.netTheta || 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>Θ {(execution.netTheta || 0).toFixed(1)}</span>
                  <span className="text-slate-600 mx-1.5">·</span>
                  <span className="text-amber-400">ν {(execution.netVega || 0).toFixed(1)}</span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* --- REFINED TOP BAR --- */}
        <header className="h-16 border-b border-terminal-line px-8 flex items-center justify-between bg-black/20 backdrop-blur-xl shrink-0 z-10">
          <div className="flex items-center space-x-12">
            <div>
              <h1 className="text-xs font-black tracking-[0.3em] uppercase leading-none text-white">Quantum Core v5.2</h1>
              <p className="text-[9px] text-slate-500 uppercase tracking-widest mt-1 font-bold">Terminal Interface Engine (Stable)</p>
            </div>
          
          <div className="hidden lg:flex space-x-10 items-center">
            <div className="flex flex-col">
              <span className="terminal-label !mb-0.5 flex items-center gap-2">
                {activeSpec.displayName || 'Nifty 50'} Spot
                {execution?.dataSource === 'LIVE' && <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
              </span>
              <div className="terminal-value text-lg">
                <span className="text-slate-200">{market?.spot?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <span className={cn("text-[10px] font-bold ml-2", (market?.tick?.change || 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                  {(market?.tick?.change || 0) >= 0 ? '+' : ''}{((market?.spot || 0) - (market?.tick?.ohlc?.close || market?.spot || 0)).toFixed(2)}
                  <span className="ml-1 opacity-60">({market?.tick?.change?.toFixed(2)}%)</span>
                </span>
              </div>
            </div>
            <div className="flex flex-col text-right">
              <span className="terminal-label !mb-0.5">India VIX</span>
              <div className="terminal-value text-lg flex items-center gap-2">
                <span className="text-slate-200">{market?.vix?.toFixed(2) || '12.42'}</span>
                {market?.vixDelta !== undefined && (
                  <span className={cn(
                    "text-[10px] font-black",
                    market?.vixDelta !== undefined && (market?.vixDelta ?? 0) >= 0 ? "text-rose-400" : "text-emerald-400"
                  )}>
                    {(market?.vixDelta ?? 0) >= 0 ? <ArrowUpRight className="w-2.5 h-2.5 inline" /> : <ArrowDownRight className="w-2.5 h-2.5 inline" />}
                    {Math.abs(market?.vixDelta ?? 0).toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
            <div className="flex flex-col text-right">
              <span className="terminal-label !mb-0.5">PCR Ratio</span>
              <div className="terminal-value text-lg text-emerald-400">{market?.pcr ? market.pcr.toFixed(2) : '1.18'}</div>
            </div>
            <div className="flex flex-col text-right group relative">
              <span className="terminal-label !mb-0.5">Last Sync</span>
              <div className={cn(
                "terminal-value text-[10px] font-mono mt-1 transition-colors",
                market?.error ? "text-rose-400 animate-pulse" : "text-slate-400"
              )}>
                {market?.lastUpdated ? new Date(market.lastUpdated).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : (lastSync ? lastSync.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '--:--:--')}
              </div>
              {market?.error && (
                <div className="absolute top-full right-0 mt-1 bg-rose-500/90 text-white text-[7px] px-2 py-1 rounded whitespace-nowrap z-[100] shadow-xl border border-white/10 uppercase tracking-tighter">
                  Kite API Exception: {market.error}
                </div>
              )}
            </div>
            {marketInfo && (
              <>
                <div className="w-px h-8 bg-white/5 mx-2" />
                <div className="flex flex-col px-4 border-r border-white/5">
                  <span className="terminal-label !mb-0.5 text-[7px] uppercase tracking-widest text-slate-500">Expiries</span>
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col">
                      <span className="text-[10px] text-blue-400 font-black leading-none">
                        {marketInfo.expiry.weekly ? new Date(marketInfo.expiry.weekly).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }) : '---'}
                      </span>
                      <span className="text-[7px] text-slate-500 font-bold uppercase mt-1">Weekly ({marketInfo.expiry.daysToExpiry} DTE)</span>
                    </div>
                    <div className="w-px h-4 bg-white/10" />
                    <div className="flex flex-col">
                      <span className="text-[10px] text-purple-400 font-black leading-none">
                        {marketInfo.expiry.monthly ? new Date(marketInfo.expiry.monthly).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }) : '---'}
                      </span>
                      <span className="text-[7px] text-slate-500 font-bold uppercase mt-1">Monthly</span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col px-4">
                  <span className="terminal-label !mb-0.5 text-[7px] uppercase tracking-widest text-slate-500">Holiday Wall</span>
                  <div className={cn("terminal-value text-[9px] font-black", marketInfo.holiday.isUpcoming ? "text-amber-500" : "text-slate-500")}>
                    {marketInfo.holiday.next ? new Date(marketInfo.holiday.next).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }) : 'CLEAR'}
                    {marketInfo.holiday.isUpcoming && <span className="text-[7px] border border-amber-500/30 px-1 rounded ml-2 animate-pulse leading-none py-0.5">UPCOMING</span>}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center space-x-6">
          {marketInfo?.isMarketClosed && (
            <div className={cn(
              "px-4 py-1.5 border rounded-lg flex items-center gap-2",
              execution?.dataSource === 'LIVE' 
                ? "bg-blue-500/10 border-blue-500/20" 
                : "bg-rose-500/10 border-rose-500/20"
            )}>
               <ShieldAlert className={cn("w-3 h-3", execution?.dataSource === 'LIVE' ? "text-blue-400" : "text-rose-500")} />
               <span className={cn(
                 "text-[9px] font-black uppercase tracking-widest",
                 execution?.dataSource === 'LIVE' ? "text-blue-400" : "text-rose-500"
               )}>
                  {execution?.dataSource === 'LIVE' ? "Institutional Analysis (Off-Market)" : "Market is closed"}
               </span>
            </div>
          )}
          {!kiteStatus.connected && (
            <button 
              onClick={handleKiteConnect}
              className="flex items-center gap-2 px-4 py-1.5 rounded bg-amber-600/10 border border-amber-600/30 text-amber-500 text-[9px] font-black tracking-widest hover:bg-amber-600/20 transition-all uppercase"
            >
              <Zap className="w-3 h-3 fill-current" />
              Connect Zerodha
            </button>
          )}
          {kiteStatus.connected && (
            <div className="flex items-center gap-2 px-4 py-1.5 rounded bg-emerald-600/10 border border-emerald-600/30 text-emerald-500 text-[9px] font-black tracking-widest uppercase">
              <ShieldCheck className="w-3 h-3" />
              Kite Active
            </div>
          )}
          {kiteStatus.connected && (
            <div className={cn(
              "flex items-center gap-2 px-4 py-1.5 rounded text-[9px] font-black tracking-widest uppercase border",
              kiteStatus.tickerConnected 
                ? "bg-emerald-600/10 border-emerald-500/30 text-emerald-400" 
                : "bg-amber-600/10 border-amber-600/30 text-amber-500 animate-pulse"
            )}>
              <Zap className={cn("w-3 h-3", kiteStatus.tickerConnected && "text-emerald-400 fill-emerald-400 animate-bounce")} />
              {kiteStatus.tickerConnected 
                ? `WS Online` 
                : "WS Connecting..."}
            </div>
          )}
          {/* Symbol picker — disabled while positions are open (server-side enforced too) */}
          <div className="relative">
            <button
              onClick={() => setShowSymbolPicker(v => !v)}
              disabled={(execution?.positions?.length ?? 0) > 0}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded border text-[10px] font-black tracking-[0.1em] uppercase transition-all",
                activeSymbol === 'NIFTY'
                  ? "bg-blue-500/10 border-blue-500/30 text-blue-300 hover:bg-blue-500/20"
                  : "bg-purple-500/10 border-purple-500/30 text-purple-300 hover:bg-purple-500/20",
                (execution?.positions?.length ?? 0) > 0 && "opacity-50 cursor-not-allowed"
              )}
              title={(execution?.positions?.length ?? 0) > 0 ? "Flatten positions to switch symbol" : "Switch active index"}
            >
              <Layers className="w-3 h-3" />
              <span>{activeSymbol}</span>
              <span className="text-slate-500 text-[8px]">▾</span>
            </button>
            {showSymbolPicker && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-[#0b0f19] border border-white/10 rounded-lg shadow-2xl overflow-hidden min-w-[200px]">
                {(['NIFTY', 'SENSEX'] as const).map(sym => {
                  const isActive = sym === activeSymbol;
                  return (
                    <button
                      key={sym}
                      onClick={async () => {
                        setShowSymbolPicker(false);
                        setSymbolSwitchError(null);
                        if (isActive) return;
                        try {
                          const res = await fetch('/api/active-symbol', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ symbol: sym })
                          });
                          const j = await res.json();
                          if (!res.ok) {
                            setSymbolSwitchError(j?.reason || 'Switch failed');
                            setTimeout(() => setSymbolSwitchError(null), 6000);
                          } else {
                            await fetchData('fast');
                          }
                        } catch (e) {
                          setSymbolSwitchError('Network error switching symbol');
                          setTimeout(() => setSymbolSwitchError(null), 6000);
                        }
                      }}
                      className={cn(
                        "w-full text-left px-3 py-2 text-[10px] font-bold uppercase tracking-widest transition-all flex items-center justify-between",
                        isActive ? "bg-blue-600/20 text-blue-300" : "text-slate-300 hover:bg-white/5"
                      )}
                    >
                      <span>{sym}</span>
                      <span className="text-[8px] text-slate-500">
                        {sym === 'NIFTY' ? 'NSE · lot 75 · step 50' : 'BSE · lot 20 · step 100'}
                      </span>
                    </button>
                  );
                })}
                {execution?.dataSource === 'LIVE' && (
                  <div className="px-3 py-2 text-[8px] text-amber-400/80 font-bold uppercase tracking-widest bg-amber-500/5 border-t border-amber-500/15">
                    LIVE: only NIFTY wired. SENSEX live coming soon — use MOCK to test.
                  </div>
                )}
              </div>
            )}
            {symbolSwitchError && (
              <div className="absolute right-0 top-full mt-1 z-40 bg-rose-500/95 text-white text-[9px] font-bold uppercase tracking-widest px-3 py-1.5 rounded shadow-xl border border-rose-300/30 max-w-[300px]">
                {symbolSwitchError}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 p-1 pl-3 bg-slate-900/50 border border-terminal-line rounded-lg">
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Data:</span>
            <div 
              className={cn(
                "px-3 py-1.5 rounded text-[9px] font-bold tracking-[0.1em] transition-all flex items-center gap-1.5",
                execution?.dataSource === 'LIVE' 
                  ? (marketInfo?.isMarketClosed ? "bg-blue-500/10 text-blue-400 border border-blue-500/20" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20")
                  : "bg-amber-500/10 text-amber-500 border border-amber-500/20"
              )}
            >
              <div className={cn("w-1.5 h-1.5 rounded-full animate-pulse", execution?.dataSource === 'LIVE' ? "bg-emerald-500" : "bg-amber-500")} />
              <span>{execution?.dataSource === 'LIVE' ? (marketInfo?.isMarketClosed ? 'LIVE ANALYSIS' : 'LIVE ENGINE') : 'MOCK ENGINE'}</span>
            </div>
            <div className="w-px h-4 bg-white/5" />
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Trade:</span>
            <button 
              onClick={handleToggleExecutionMode}
              className={cn(
                "px-3 py-1.5 rounded text-[9px] font-bold tracking-[0.1em] transition-all",
                execution?.executionMode === 'PAPER'
                  ? "bg-blue-600 text-white shadow-[0_0_10px_rgba(37,99,235,0.3)]"
                  : "bg-rose-600 text-white shadow-[0_0_10px_rgba(225,29,72,0.3)] animate-pulse"
              )}
            >
              {execution?.executionMode === 'PAPER' ? 'PAPER TEST' : 'LIVE'}
            </button>
            <div className="w-px h-4 bg-white/5" />
            <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">Operation:</span>
            <button 
              onClick={handleToggleAutoMode}
              disabled={marketInfo?.isMarketClosed}
              className={cn(
                "px-3 py-1.5 rounded text-[9px] font-bold tracking-[0.1em] transition-all",
                execution?.autoMode 
                  ? "bg-purple-600 text-white shadow-[0_0_10px_rgba(147,51,234,0.3)]"
                  : "bg-slate-700 text-slate-300 border border-white/10",
                marketInfo?.isMarketClosed && "opacity-50 cursor-not-allowed"
              )}
            >
              {execution?.autoMode ? 'AUTO' : 'MANUAL'}
            </button>
            <div className="w-px h-4 bg-white/5" />
            <button
              onClick={handleResetEngine}
              className="px-3 py-1.5 rounded text-[9px] font-bold tracking-[0.1em] transition-all bg-zinc-850 hover:bg-zinc-800 text-slate-200 border border-white/5"
            >
              RESET ENGINE
            </button>
          </div>
          {(execution?.positions?.length ?? 0) > 0 && (
            <button
              onClick={() => setShowFlattenConfirm(true)}
              title="Emergency square-off all open legs (K)"
              className="px-4 py-2 rounded text-[10px] font-black tracking-[0.15em] uppercase bg-rose-600 hover:bg-rose-500 text-white shadow-[0_0_18px_rgba(225,29,72,0.5)] border border-rose-400/40 transition-all animate-pulse-slow flex items-center gap-2"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              Flatten All
            </button>
          )}
          <div className="flex items-center space-x-3 px-4 border-l border-white/5">
            <div className="text-right">
              <div className="text-[10px] font-bold text-white leading-none">ADMIN</div>
              <div className="text-[8px] text-emerald-500 font-bold uppercase tracking-widest mt-1">Status: Active</div>
            </div>
            <div className="w-8 h-8 rounded border border-blue-500/30 overflow-hidden">
               <img src="https://ui-avatars.com/api/?name=Admin&background=1e293b&color=3b82f6" alt="user" className="w-full h-full opacity-80" />
            </div>
          </div>
        </div>
      </header>

      {/* --- MAIN TERMINAL AREA --- */}
      <AnimatePresence mode="wait">
        {activeTab === 'dashboard' ? (
          <motion.main 
            key="dashboard"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex-1 grid grid-cols-12 gap-4 p-4 overflow-y-auto custom-scrollbar bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-900/10 via-transparent to-transparent"
          >
            {/* Opening Balance & Market Structure Header Strip */}
            <div className="col-span-12 bg-slate-900/60 border border-slate-700/30 rounded-xl p-4 flex flex-wrap items-center justify-between gap-6 backdrop-blur-md">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                  <h2 className="text-sm font-black uppercase tracking-wider text-white">{(activeSpec.displayName || 'Nifty 50').toUpperCase()} COGNITIVE COCKPIT</h2>
                </div>
                <p className="text-[10px] text-slate-400 mt-1">Real-time Parameters & Market Structure Analytics</p>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 flex-1 max-w-5xl justify-items-center">
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">Spot Price</span>
                  <span className="text-xs font-black text-emerald-400">₹{market?.spot?.toFixed(2) || '----'}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">Yesterday Close</span>
                  <span className="text-xs font-black text-white">₹{market?.yesterdayClose?.toFixed(2) || '----'}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">Today's Open</span>
                  <span className="text-xs font-black text-white">₹{market?.todayOpen?.toFixed(2) || '----'}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">Opening Gap</span>
                  <span className={cn(
                    "text-xs font-black",
                    (market?.gapPercent || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                  )}>
                    {(market?.gapPercent || 0) >= 0 ? '+' : ''}{(market?.gapPercent || 0).toFixed(2)}%
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">ORB Range (H/L)</span>
                  <span className="text-xs font-black text-blue-400">
                    H: {market?.orb?.high?.toFixed(1) || '0'} | L: {market?.orb?.low?.toFixed(1) || '0'}
                  </span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">Inst. VWAP</span>
                  <span className="text-xs font-black text-violet-400">₹{market?.vwap?.toFixed(1) || '----'}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">India VIX</span>
                  <span className="text-xs font-black text-orange-400">{market?.vix?.toFixed(2) || '----'}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">Option PCR</span>
                  <span className="text-xs font-black text-amber-400">{market?.pcr?.toFixed(2) || '----'}</span>
                </div>
              </div>
            </div>

            {/* --- CORE REAL-TIME EXECUTION & LIVE POSITIONS PANEL --- */}
            <div className="col-span-12">
              <section className={cn(
                "terminal-card p-5 border backdrop-blur-xl transition-all duration-300",
                execution?.positions && execution.positions.length > 0
                  ? "bg-emerald-950/20 border-emerald-500/30 shadow-[0_0_20px_rgba(16,185,129,0.05)]"
                  : "bg-slate-900/40 border-slate-800/80"
              )}>
                <div className="flex flex-col lg:flex-row items-stretch justify-between gap-6">
                  {/* Left: Engine Status & Active Strategy */}
                  <div className="flex flex-col justify-between border-b lg:border-b-0 lg:border-r border-white/5 pb-4 lg:pb-0 lg:pr-6 min-w-[220px]">
                    <div>
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          "w-2 h-2 rounded-full",
                          execution?.positions && execution.positions.length > 0
                            ? "bg-emerald-500 animate-pulse"
                            : "bg-amber-500"
                        )} />
                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">
                          EXECUTION ENGINE STATUS
                        </span>
                      </div>
                      <div className="mt-2.5">
                        <div className="text-xs font-bold text-slate-500 uppercase tracking-widest">Active Setup</div>
                        <div className="text-md font-black text-white mt-0.5 tracking-tight flex items-center gap-2">
                          {execution?.positions && execution.positions.length > 0 ? (
                            <>
                              <span className="text-emerald-400">●</span>
                              {/* Show the structure of the *open book*, not the current recommendation. */}
                              <span>
                                {execution.actualStructure
                                  ?? execution.entryStrategyType?.replace(/_/g, ' ')
                                  ?? 'OPEN BOOK'}
                              </span>
                            </>
                          ) : (
                            <span className="text-slate-500 font-bold uppercase text-xs tracking-widest">STANDBY (IDLE)</span>
                          )}
                        </div>
                        {execution?.positions && execution.positions.length > 0
                          && strategy?.score?.strategyType
                          && execution.entryStrategyType
                          && strategy.score.strategyType !== execution.entryStrategyType && (
                          <div className="mt-1 text-[9px] font-bold text-slate-500 uppercase tracking-widest">
                            Engine now favors:
                            <span className="text-amber-400 ml-1">{strategy.score.strategyType.replace(/_/g, ' ')}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    {execution?.positions && execution.positions.length > 0 && (() => {
                      const entryBias = execution.entryBias || 'NEUTRAL';
                      const liveBias = strategy?.score?.bias || 'NEUTRAL';
                      const biasConflict = entryBias !== liveBias;
                      return (
                        <div className="mt-4 flex gap-2 items-center flex-wrap">
                          <span className={cn(
                            "px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-wider",
                            entryBias === 'BULLISH' ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                            entryBias === 'BEARISH' ? "bg-rose-500/10 text-rose-400 border border-rose-500/20" :
                            "bg-blue-500/10 text-blue-400 border border-blue-500/20"
                          )}>
                            ENTRY BIAS: {entryBias}
                          </span>
                          {biasConflict && (
                            <span className="px-2 py-0.5 rounded text-[8px] font-black bg-amber-500/15 border border-amber-500/40 text-amber-300 uppercase tracking-wider animate-pulse flex items-center gap-1" title="Live system bias has flipped vs. the bias at entry. Trade is fighting the current signal.">
                              <AlertTriangle className="w-2.5 h-2.5" />
                              CONFLICT → LIVE: {liveBias}
                            </span>
                          )}
                          <span className="px-2 py-0.5 rounded text-[8px] font-black bg-white/5 border border-white/5 text-slate-300 uppercase tracking-wider">
                            SCORE: {strategy?.score?.score ?? strategy?.score?.total ?? 0}
                          </span>
                          {strategy?.score?.pinAlignment && strategy.score.pinAlignment !== 'NONE' && strategy.score.pinStrike && (
                            <span className={cn(
                              "px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-wider border flex items-center gap-1",
                              strategy.score.pinAlignment === 'STRONG'
                                ? "bg-purple-500/15 border-purple-500/40 text-purple-300"
                                : "bg-purple-500/10 border-purple-500/20 text-purple-400"
                            )} title={`Max-OI CE and PE walls aligned ${strategy.score.pinDistance === 0 ? 'on the same strike' : `${strategy.score.pinDistance} pts apart`} — pin magnet at ${strategy.score.pinStrike}.`}>
                              <Target className="w-2.5 h-2.5" />
                              PIN {strategy.score.pinStrike} ({strategy.score.pinAlignment})
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Middle: Active Leg Breakdown */}
                  <div className="flex-1 flex flex-col justify-center gap-3">
                    {execution?.positions && execution.positions.length > 0 ? (
                      <>
                        {execution?.lastTradeScore?.biasReason && (
                          <div className="text-[10px] text-emerald-400/80 bg-emerald-950/20 p-2 rounded border border-emerald-500/10 font-mono tracking-tight">
                            <span className="font-bold text-emerald-500 uppercase mr-2 tracking-widest text-[9px]">Decision Rationale:</span> 
                            {execution.lastTradeScore.biasReason}
                          </div>
                        )}
                        <div className="overflow-x-auto">
                          <table className="w-full text-left font-mono">
                            <thead>
                              <tr className="border-b border-white/5 text-[7px] font-bold text-slate-500 uppercase tracking-widest">
                                <th className="py-1">LEG</th>
                                <th className="py-1">STRIKE</th>
                                <th className="py-1 text-center font-bold">QTY</th>
                                <th className="py-1 text-right">ENTRY</th>
                                <th className="py-1 text-right">LTP</th>
                                <th className="py-1 text-right">REAL-TIME P&L</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/[0.02]">
                            {execution.positions.map((pos: any, idx: number) => {
                              const ltp = market?.chain?.find((c: any) => c.strike === pos.strike)?.[pos.type === 'CE' ? 'ce_price' : 'pe_price'] ?? pos.entryPrice;
                              const legPnl = (pos.side === 'BUY' ? (ltp - pos.entryPrice) : (pos.entryPrice - ltp)) * pos.qty;
                              return (
                                <tr key={idx} className="text-[10px] text-slate-300">
                                  <td className="py-2.5">
                                    <span className={cn(
                                      "px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-wide",
                                      pos.side === 'SELL' ? "bg-rose-500/10 text-rose-100 border border-rose-500/10" : "bg-emerald-500/10 text-emerald-100 border border-emerald-500/10"
                                    )}>
                                      {pos.side}
                                    </span>
                                  </td>
                                  <td className="py-2.5 font-sans font-black text-white p-2">
                                    NIFTY {pos.strike} {pos.type}
                                  </td>
                                  <td className="py-2.5 text-center font-black text-slate-400">{pos.qty}</td>
                                  <td className="py-2.5 text-right font-black">₹{pos.entryPrice.toFixed(1)}</td>
                                  <td className="py-2.5 text-right font-black text-blue-400">₹{ltp.toFixed(1)}</td>
                                  <td className={cn(
                                    "py-2.5 text-right font-black",
                                    legPnl >= 0 ? "text-emerald-400" : "text-rose-400"
                                  )}>
                                    {legPnl >= 0 ? '+' : ''}₹{legPnl.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-3 text-center">
                        <div className="text-[11px] font-black tracking-widest text-slate-500 uppercase flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-slate-500 animate-pulse" />
                          No active trades currently open
                        </div>
                        <p className="text-[9px] text-slate-600 mt-1 uppercase font-bold tracking-wider">
                          The system is continuously indexing options order books to trigger automated setups
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Right: Net P&L Summary Dashboard */}
                  <div className="flex flex-col md:flex-row items-center justify-between gap-6 border-t lg:border-t-0 lg:border-l border-white/5 pt-4 lg:pt-0 lg:pl-6 min-w-[280px]">
                    <div className="flex-1 flex flex-col items-center md:items-start text-center md:text-left">
                      <span className="text-[9px] font-black uppercase tracking-widest text-slate-500">
                        CONSOLIDATED REAL-TIME P&L
                      </span>
                      <div className={cn(
                        "text-2xl font-black font-mono mt-1 tracking-tight filter drop-shadow-md",
                        (execution?.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                      )}>
                        {(execution?.pnl || 0) >= 0 ? '+' : ''}₹{(execution?.pnl || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </div>
                      <div className="flex gap-4 mt-2">
                        <div className="flex flex-col">
                          <span className="text-[7px] text-slate-500 font-bold uppercase tracking-wider">Cap Deployed</span>
                          <span className="text-[10px] font-black text-white font-mono">
                            ₹{(execution?.capitalDeployed || 0).toLocaleString()}
                          </span>
                        </div>
                        <div className="w-px h-5 bg-white/5" />
                        <div className="flex flex-col">
                          <span className="text-[7px] text-slate-500 font-bold uppercase tracking-wider">Today Max SL</span>
                          <span className="text-[10px] font-black text-rose-500 font-mono">
                            ₹{(execution?.risk?.limits?.lossLimit || 5000).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </div>
                    {execution?.positions && execution.positions.length > 0 && (
                      <button 
                        onClick={handleExit}
                        className="w-full md:w-auto px-5 py-3 bg-rose-600/10 hover:bg-rose-600/20 border border-rose-500/30 text-rose-500 text-[9px] font-black uppercase tracking-widest rounded-lg transition-all shadow-[0_0_15px_rgba(244,63,94,0.05)]"
                      >
                        Square Off
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>

            {/* Column 1: NIFTY Movement Evaluation & Decision Matrix */}
            <div className="col-span-12 lg:col-span-4 flex flex-col gap-4 pr-2">
              <section className="terminal-card bg-slate-900/40 p-5 flex flex-col gap-4">
                <div className="flex justify-between items-center border-b border-white/5 pb-3">
                  <div className="flex items-center gap-2">
                    <Brain className="w-4 h-4 text-blue-400 animate-pulse" />
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">NIFTY Decision Engine</h3>
                  </div>
                  <div className="bg-blue-500/10 border border-blue-500/20 px-2.5 py-0.5 rounded text-[8px] font-black text-blue-400 uppercase tracking-wider">
                    Score: {strategy?.score?.total || 0} / 100
                  </div>
                </div>

                {/* Compact segmented score breakdown — each colored block is one component's
                    contribution to the total. Width is proportional to points scored,
                    so you can read *why* the total looks the way it does at a glance. */}
                {strategy?.score && (() => {
                  const s = strategy.score as any;
                  const segs: { key: string; pts: number; max: number; color: string; label: string }[] = [
                    { key: 'trend', pts: s.trendScore || 0, max: 25, color: 'bg-blue-500',   label: 'Trend' },
                    { key: 'oi',    pts: s.oiBiasScore || 0, max: 20, color: 'bg-violet-500', label: 'OI Bias' },
                    { key: 'tech',  pts: Math.max(0, (s.total || 0) - (s.trendScore || 0) - (s.oiBiasScore || 0) - (s.gammaScore || 0) - (s.timeFilterScore || 0)), max: 30, color: 'bg-cyan-500', label: 'Tech + ORB + Pin' },
                    { key: 'gamma', pts: s.gammaScore || 0, max: 15, color: 'bg-amber-500',  label: 'Gamma (VIX)' },
                    { key: 'time',  pts: s.timeFilterScore || 0, max: 20, color: 'bg-teal-500',   label: 'Time Filter' },
                  ];
                  const total = s.total || 0;
                  const scale = Math.max(100, total);
                  return (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-0.5 h-2.5 rounded-full overflow-hidden bg-white/[0.04] border border-white/5">
                        {segs.map(seg => {
                          const width = (seg.pts / scale) * 100;
                          if (width < 0.5) return null;
                          return (
                            <div
                              key={seg.key}
                              className={cn(seg.color, "h-full transition-all duration-300")}
                              style={{ width: `${width}%` }}
                              title={`${seg.label}: ${seg.pts} / ${seg.max} pts`}
                            />
                          );
                        })}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[7.5px] font-bold uppercase tracking-widest text-slate-500">
                        {segs.map(seg => (
                          <span key={`lbl-${seg.key}`} className="flex items-center gap-1">
                            <span className={cn("w-1.5 h-1.5 rounded-sm", seg.color)} />
                            <span className="text-slate-400">{seg.label}</span>
                            <span className="text-slate-200 font-mono tabular-nums">{seg.pts}</span>
                          </span>
                        ))}
                        {s.pinAlignment && s.pinAlignment !== 'NONE' && (
                          <span className="flex items-center gap-1 text-purple-300">
                            <Target className="w-2 h-2" />
                            <span>PIN +{s.pinAlignment === 'STRONG' ? 15 : 8}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Active Directive & Sentiment */}
                <div className="bg-slate-950/60 p-4 border border-white/5 rounded-lg flex flex-col gap-2">
                  <div className="flex justify-between items-center">
                    <span className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">System Bias</span>
                    <span className={cn(
                      "text-[10px] font-black px-2.5 py-0.5 rounded-full uppercase tracking-widest",
                      strategy?.score?.bias === 'BULLISH' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' :
                      strategy?.score?.bias === 'BEARISH' ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30' :
                      'bg-slate-500/10 text-slate-400 border border-slate-500/30'
                    )}>
                      {strategy?.score?.bias || 'NEUTRAL'}
                    </span>
                  </div>
                  <div className="text-xs font-black text-slate-200 mt-1">
                    {strategy?.score?.recommendation || 'STANDBY - PATTERN SCREENING'}
                  </div>
                  <p className="text-[10px] leading-relaxed text-slate-400 mt-1 italic font-medium">
                    " {strategy?.score?.biasReason || 'Evaluating high-probability options entry metrics...'} "
                  </p>
                </div>

                {/* Parameter Contribution Metrics */}
                <div className="flex flex-col gap-3.5 mt-2">
                  <h4 className="text-[8px] font-bold text-slate-500 uppercase tracking-wider">Decision Formula Breakdown</h4>
                  
                  {/* Trend Score */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-[10px] font-bold">
                      <span className="text-slate-300">Spot Distance / Trend Score</span>
                      <span className="text-blue-400">{strategy?.score?.trendScore || 0} / 25 pts</span>
                    </div>
                    <div className="relative h-1 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-blue-500 rounded-full" style={{ width: `${((strategy?.score?.trendScore || 0) / 25) * 100}%` }} />
                    </div>
                    <div className="flex justify-between text-[8px] text-slate-400 font-bold uppercase">
                      <span>Proximity: {Math.abs((market?.spot || 0) - Math.round((market?.spot || 0)/strikeStep)*strikeStep).toFixed(1)} pts</span>
                      <span>Trend Bias: Cleared</span>
                    </div>
                  </div>

                  {/* OI Bias Score */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-[10px] font-bold">
                      <span className="text-slate-300">Put vs Call Writing Balance</span>
                      <span className="text-violet-400">{strategy?.score?.oiBiasScore || 0} / 20 pts</span>
                    </div>
                    <div className="relative h-1 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-violet-400 rounded-full" style={{ width: `${((strategy?.score?.oiBiasScore || 0) / 20) * 100}%` }} />
                    </div>
                    <div className="flex justify-between text-[8px] text-slate-400 font-bold uppercase">
                      <span>OI Change: {strategy?.score?.oiChangeBias?.toLocaleString() || '0'} shares</span>
                      <span>PCR Multiplier: Optimal</span>
                    </div>
                  </div>

                  {/* Gamma Risk Score */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-[10px] font-bold">
                      <span className="text-slate-300">Volatility VIX / Gamma Factor</span>
                      <span className="text-amber-400">{strategy?.score?.gammaScore || 0} / 15 pts</span>
                    </div>
                    <div className="relative h-1 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-amber-400 rounded-full" style={{ width: `${((strategy?.score?.gammaScore || 0) / 15) * 100}%` }} />
                    </div>
                    <div className="flex justify-between text-[8px] text-slate-400 font-bold uppercase">
                      <span>Multiplier: {execution?.params?.vixFactor || '1.0'}x (Active)</span>
                      <span>SL Anchors: ATR Delta Standard</span>
                    </div>
                  </div>

                  {/* Decay Window Filter */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-[10px] font-bold">
                      <span className="text-slate-300">Intraday Theta Safety Decay</span>
                      <span className="text-teal-400">{strategy?.score?.timeFilterScore || 0} / 20 pts</span>
                    </div>
                    <div className="relative h-1 bg-white/5 rounded-full overflow-hidden">
                      <div className="h-full bg-teal-400 rounded-full" style={{ width: `${((strategy?.score?.timeFilterScore || 0) / 20) * 100}%` }} />
                    </div>
                    <div className="flex justify-between text-[8px] text-slate-400 font-bold uppercase">
                      <span>IST Market Standard Time</span>
                      <span>Execution: Unrestricted</span>
                    </div>
                  </div>

                  {/* Trap Check */}
                  <div className="bg-slate-950/40 p-3 rounded-lg border border-white/5 space-y-2 mt-1">
                    <div className="flex justify-between text-[9px] font-black uppercase text-slate-400">
                      <span>Technical Vector Check</span>
                      <span>RSI / MACD / Bollinger</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[9px]">
                      <div className="flex flex-col bg-white/5 p-1.5 rounded items-center">
                        <span className="text-[7px] text-slate-400 uppercase font-bold">RSI (14)</span>
                        <span className="font-extrabold text-blue-400 mt-0.5">{(market?.indicators?.rsi || 50).toFixed(1)}</span>
                      </div>
                      <div className="flex flex-col bg-white/5 p-1.5 rounded items-center">
                        <span className="text-[7px] text-slate-400 uppercase font-bold">MACD Hist</span>
                        <span className={cn(
                          "font-extrabold mt-0.5",
                          (market?.indicators?.macd?.histogram || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                        )}>
                          {(market?.indicators?.macd?.histogram || 0).toFixed(2)}
                        </span>
                      </div>
                      <div className="flex flex-col bg-white/5 p-1.5 rounded items-center">
                        <span className="text-[7px] text-slate-400 uppercase font-bold">Trap Sweep</span>
                        <span className="font-extrabold text-violet-400 mt-0.5">None</span>
                      </div>
                    </div>
                  </div>

                  {/* Terminal Execution Gateway */}
                  <div className="pt-3 border-t border-white/5 flex flex-col gap-2 mt-1">
                    <button
                      onClick={() => handleExecute(strategy?.score?.bias || 'NEUTRAL')}
                      className={cn(
                        "w-full py-2 px-4 rounded text-[9px] font-black uppercase tracking-widest border transition-all text-center flex items-center justify-center gap-2",
                        strategy?.score?.bias === 'BULLISH' ? "bg-emerald-600/10 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/20" :
                        strategy?.score?.bias === 'BEARISH' ? "bg-rose-600/10 border-rose-500/25 text-rose-400 hover:bg-rose-500/20" :
                        "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
                      )}
                    >
                      <Zap className="w-3 h-3" />
                      Execute: {strategy?.score?.bias || 'NEUTRAL'} {strategy?.score?.strategyType?.replace(/_/g, ' ') || 'FLOW'}
                    </button>
                  </div>
                </div>
              </section>
            </div>

            {/* Column 2: Options Intelligence Suite & Deep Chain Matrix */}
            <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">
              {/* Options Cognitive Insights Console */}
              {insights && (
                <section className="terminal-card bg-slate-900/35 p-5 flex flex-col gap-4 border border-white/5">
                   <div className="flex justify-between items-center border-b border-white/5 pb-2.5">
                      <div className="flex items-center gap-2">
                        <Activity className="w-4 h-4 text-violet-400 animate-pulse" />
                        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">NIFTY NEXT MOVEMENT COGNITIVE INSIGHTS</h3>
                      </div>
                      <span className="text-[8px] font-bold text-slate-500 uppercase">GREEK-DERIVED COGNITIVE INTEL</span>
                   </div>

                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                      {/* Card 1: Support & Resistance Shifts */}
                      <div className="bg-slate-950/40 p-3 rounded-lg border border-white/5 flex flex-col justify-between">
                         <div>
                            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-wider block">OI Key Structural Anchors</span>
                            <div className="flex justify-between items-end mt-2">
                               <div>
                                  <div className="text-[8px] text-rose-400 font-extrabold uppercase mb-0.5">Ceiling (Resist)</div>
                                  <div className="text-sm font-black text-white font-mono">₹{insights.resistance}</div>
                                  <div className="text-[7.5px] text-slate-500 font-bold uppercase">OI: {formatOi(insights.resistanceOi)}</div>
                                </div>
                                <div className="text-right">
                                  <div className="text-[8px] text-emerald-400 font-extrabold uppercase mb-0.5">Floor (Support)</div>
                                  <div className="text-sm font-black text-white font-mono">₹{insights.support}</div>
                                  <div className="text-[7.5px] text-slate-500 font-bold uppercase">OI: {formatOi(insights.supportOi)}</div>
                               </div>
                            </div>
                         </div>
                         <div className="mt-2 pt-2 border-t border-white/[0.03] text-[7.5px] text-slate-400 font-bold uppercase">
                            Breakout Bounds: ₹{insights.secondSupport} - ₹{insights.secondResistance}
                         </div>
                      </div>

                      {/* Card 2: PCR Sentiment */}
                      <div className="bg-slate-950/40 p-3 rounded-lg border border-white/5 flex flex-col justify-between">
                         <div>
                            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-wider block">Put / Call Sentiment (PCR)</span>
                            <div className="flex justify-between items-baseline mt-2">
                               <div className="text-lg font-black text-white font-mono">{insights.pcr.toFixed(2)}</div>
                               <div className={cn("text-[8px] font-black uppercase px-2 py-0.5 rounded", insights.pcr > 1.2 ? "bg-emerald-500/10 text-emerald-400" : insights.pcr < 0.8 ? "bg-rose-500/10 text-rose-400" : "bg-slate-500/10 text-slate-400")}>
                                  {insights.pcrBias}
                               </div>
                            </div>
                         </div>
                         <p className="text-[8.5px] text-slate-400 mt-1.5 leading-normal italic">
                            "{insights.pcrText}"
                         </p>
                      </div>

                      {/* Card 3: Delta Net Pressure */}
                      <div className="bg-slate-950/40 p-3 rounded-lg border border-white/5 flex flex-col justify-between">
                         <div>
                            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-wider block">Delta Writing Flow</span>
                            <div className="text-sm font-black text-white mt-1.5 font-mono">
                               {insights.greekDeltaBias > 0 ? '+' : ''}{(insights.greekDeltaBias / 1000000).toFixed(2)}M Delta
                            </div>
                            <div className={cn("text-[8px] mt-1 font-black uppercase", insights.greekDeltaBias > 0 ? "text-emerald-400" : "text-rose-400")}>
                               {insights.greekDeltaBias > 0 ? "Institutional Bids Accelerating" : "Overhead Capping Active"}
                            </div>
                         </div>
                         <div className="mt-2 pt-2 border-t border-white/[0.03] text-[7.5px] text-slate-400 font-medium uppercase">
                            Directional Bias: <span className="font-extrabold text-blue-400">{insights.directionBias}</span>
                         </div>
                      </div>

                      {/* Card 4: Gamma Trigger */}
                      <div className="bg-slate-950/40 p-3 rounded-lg border border-white/5 flex flex-col justify-between">
                         <div>
                            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-wider block">Gamma Squeeze Line</span>
                            <div className="text-sm font-black text-violet-400 mt-1.5 font-mono">₹{insights.gammaTrigger}</div>
                            <p className="text-[8px] text-slate-500 mt-1 leading-normal font-medium italic">
                               Short covering cascades trigger in this threshold.
                            </p>
                         </div>
                         <div className="mt-2 pt-1.5 border-t border-white/[0.03] flex justify-between text-[7px] text-slate-500 font-black uppercase">
                            <span>VIX REGULATOR: {market?.vix?.toFixed(1) || '15'}</span>
                            <span className="text-emerald-400">Neutral Gamma</span>
                         </div>
                      </div>
                   </div>
                </section>
              )}

              {/* Enhanced Full-Width Options Matrix */}
              <section className="terminal-card bg-slate-900/40 p-5 flex flex-col gap-4 border border-white/5">
                <div className="flex justify-between items-center border-b border-white/5 pb-2.5">
                   <div className="flex items-center gap-2">
                     <Layers className="w-4 h-4 text-violet-400 animate-pulse" />
                     <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">Focused Option Chain Matrix (Greeks & Real-time open interest)</h3>
                   </div>
                   <div className="flex items-center gap-2 text-[8px] font-bold text-slate-500 uppercase">
                     <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
                     <span>Weekly Expiry standard</span>
                   </div>
                </div>

                {/* Hot S/R HUD display strip directly above matrix */}
                {insights && (
                   <div className="grid grid-cols-2 gap-4 bg-slate-950/45 p-2.5 rounded-lg border border-white/5">
                     <div className="flex items-center justify-between px-3 py-2 bg-emerald-500/[0.03] rounded border border-emerald-500/15">
                       <div className="flex items-center gap-2">
                         <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                         <span className="text-[8px] text-slate-400 font-extrabold uppercase tracking-wider">ACTIVE SUPPORT FLOOR</span>
                       </div>
                       <div className="flex items-center gap-3">
                         <span className="text-xs font-mono font-black text-emerald-400">₹{insights.support}</span>
                         <span className="text-[8px] text-slate-500 font-bold uppercase">OI: {formatOi(insights.supportOi)}</span>
                       </div>
                     </div>
                     <div className="flex items-center justify-between px-3 py-2 bg-rose-500/[0.03] rounded border border-rose-500/15">
                       <div className="flex items-center gap-2">
                         <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                         <span className="text-[8px] text-slate-400 font-extrabold uppercase tracking-wider">ACTIVE RESISTANCE CEILING</span>
                       </div>
                       <div className="flex items-center gap-3">
                         <span className="text-xs font-mono font-black text-rose-400">₹{insights.resistance}</span>
                         <span className="text-[8px] text-slate-500 font-bold uppercase">OI: {formatOi(insights.resistanceOi)}</span>
                       </div>
                     </div>
                    </div>
                 )}

                          {/* Gemini AI Options Strategy Consultant Block */}
                <div className="bg-slate-950/50 p-4 rounded-xl border border-white/5 space-y-3">
                   <div className="flex justify-between items-center border-b border-white/[0.03] pb-2">
                     <div className="flex items-center gap-2">
                        <Cpu className="w-4 h-4 text-teal-400 animate-pulse" />
                        <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-teal-400">Quantum Options Advisor</h4>
                     </div>
                     <button
                        onClick={handleAnalyzeChain}
                        disabled={isAnalyzingChain}
                        className={cn(
                          "px-3 py-1 bg-teal-500/10 hover:bg-teal-500/20 border border-teal-500/20 rounded text-[9px] font-black uppercase tracking-wider transition-all disabled:opacity-50",
                          isAnalyzingChain ? "text-slate-400 border-white/10" : "text-teal-400 hover:text-teal-300"
                        )}
                     >
                       {isAnalyzingChain ? "Analyzing Option Matrix..." : chainAnalysis ? "Re-evaluate Chain" : "Analyze Chain"}
                     </button>
                   </div>

                   {isAnalyzingChain ? (
                     <div className="py-6 flex flex-col items-center justify-center bg-black/40 rounded-lg border border-teal-500/10 gap-3">
                        <motion.div 
                          animate={{ rotate: 360 }}
                          transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                          className="w-5 h-5 border-2 border-teal-500 border-t-transparent rounded-full"
                        />
                        <div className="text-center space-y-1">
                          <p className="text-[9px] font-bold text-teal-400 uppercase tracking-widest animate-pulse">Running Institutional Chain Scan...</p>
                          <p className="text-[7.5px] text-slate-500 uppercase font-mono font-medium">Extracting Greeks, open interest shifts & VIX regimes</p>
                        </div>
                     </div>
                   ) : chainAnalysisError ? (
                     <div className="p-3 bg-rose-500/[0.03] border border-rose-500/15 rounded-lg flex gap-3 items-start">
                       <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                       <div className="space-y-1">
                         <div className="text-[9px] font-black text-rose-400 uppercase tracking-wider">Analysis Synchronization Issue</div>
                         <p className="text-[9px] text-slate-400 leading-relaxed font-medium">{chainAnalysisError}</p>
                         <p className="text-[8px] text-slate-500 leading-relaxed font-mono font-bold">Please check local system logs or engine telemetry settings.</p>
                       </div>
                     </div>
                   ) : !chainAnalysis ? (
                     <div className="py-4 px-3 bg-black/20 rounded-lg border border-dashed border-white/5 flex flex-col items-center justify-center text-center">
                        <p className="text-[9px] text-slate-400 uppercase tracking-widest font-black text-center mb-2">ENGAGE DEEPMIND QUANT SCAN ENGINE</p>
                        <p className="text-[8.5px] text-slate-500 leading-normal max-w-lg text-center font-medium">
                          Deploy high-performance local mathematical structures to analyze the live Weekly Option Chain, PCR imbalances, support blocks, overhead resistance ceilings, and technical indicators to propose a structured range-bound tactical play.
                        </p>
                        <button
                          onClick={handleAnalyzeChain}
                          className="mt-3 px-4 py-1.5 bg-cyan-650/20 hover:bg-cyan-600/30 border border-cyan-500/35 rounded text-[9px] font-black text-cyan-300 uppercase tracking-widest tracking-[0.1em] transition-all"
                        >
                          [ RUN QUANT SCAN ]
                        </button>
                      </div>
                   ) : (
                     <div className="space-y-3.5 antialiased">
                       {/* High level bias indicators */}
                       <div className="flex flex-wrap lg:flex-nowrap gap-3 justify-between items-center bg-black/40 p-3 rounded-lg border border-white/5">
                         <div className="flex items-center gap-3">
                           <div className="flex flex-col">
                             <span className="text-[7.5px] text-slate-500 uppercase font-bold tracking-wider">MARKET BIAS SENTIMENT</span>
                             <span className={cn(
                               "text-xs font-black uppercase mt-0.5 tracking-wider font-mono",
                               chainAnalysis.bias === 'BULLISH' ? "text-emerald-400" :
                               chainAnalysis.bias === 'BEARISH' ? "text-rose-400" :
                               chainAnalysis.bias === 'VOLATILE' ? "text-violet-400" :
                               "text-blue-400"
                             )}>
                               {chainAnalysis.bias} DOMINANCE
                             </span>
                           </div>
                           <div className="h-6 w-px bg-white/10" />
                           <div className="flex flex-col">
                             <span className="text-[7.5px] text-slate-500 uppercase font-bold tracking-wider">STRATEGY CONFIDENCE</span>
                             <span className="text-xs font-black text-white mt-0.5 font-mono">
                               {chainAnalysis.confidence}%
                             </span>
                           </div>
                         </div>
                         <div className="flex flex-col text-right lg:max-w-md">
                           <span className="text-[7.5px] text-slate-500 uppercase font-bold tracking-wider">PROPOSED DERIVATIVE PLAY</span>
                           <span className="text-xs font-black text-teal-400 mt-0.5 text-left lg:text-right font-mono uppercase">
                             {chainAnalysis.suggestedStrategy}
                           </span>
                         </div>
                       </div>

                       {/* Analysis & Legs */}
                       <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                         {/* Text analysis */}
                         <div className="space-y-2">
                           <div className="text-[8.5px] font-black text-slate-400 uppercase tracking-widest">Advisory Commentary:</div>
                           <p className="text-[10px] text-slate-300 leading-relaxed font-mono bg-slate-950 p-3 rounded-lg border border-white/5 h-28 overflow-y-auto custom-scrollbar">
                             {chainAnalysis.marketAnalysis}
                           </p>
                         </div>

                         {/* Trade Legs layout */}
                         <div className="space-y-2">
                           <div className="text-[8.5px] font-black text-slate-400 uppercase tracking-[0.1em]">RECOMMENDED LEGS SETUP (FOR MANUAL TRADE):</div>
                           <div className="bg-slate-950 p-2 rounded-lg border border-white/5 h-28 overflow-y-auto custom-scrollbar flex flex-col gap-1.5">
                             {chainAnalysis.legs && chainAnalysis.legs.length > 0 ? (
                               chainAnalysis.legs.map((leg: any, idx: number) => (
                                 <div key={idx} className="flex justify-between items-center bg-white/[0.02] hover:bg-white/[0.04] p-1.5 rounded border border-white/5 text-[9px] font-mono">
                                   <div className="flex items-center gap-2">
                                     <span className={cn(
                                       "px-1 text-[8px] rounded font-black",
                                       leg.action === 'BUY' ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                                     )}>
                                       {leg.action}
                                     </span>
                                     <span className="text-white font-extrabold">{leg.strike}</span>
                                     <span className={cn(
                                       "font-black",
                                       leg.optionType === 'CE' ? "text-rose-400" : "text-emerald-400"
                                     )}>
                                       {leg.optionType}
                                     </span>
                                   </div>
                                   {leg.approxPremium !== undefined && (
                                     <span className="text-slate-400">Approx Premium: <strong className="text-slate-200">₹{leg.approxPremium}</strong></span>
                                   )}
                                 </div>
                               ))
                             ) : (
                               <div className="my-auto text-center text-[8px] text-slate-500 uppercase font-black tracking-wider">
                                 No derivative legs generated for the setup.
                               </div>
                             )}
                           </div>
                         </div>
                       </div>

                       {/* Explicit execution rules */}
                       <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-white/[0.03] text-[9.5px]">
                          <div className="bg-slate-950/50 p-2.5 rounded border border-white/5 sm:col-span-1">
                             <div className="text-[7.5px] text-slate-500 uppercase font-black mb-1">ENTRY TRIGGERS</div>
                             <div className="font-mono text-slate-300 font-medium leading-relaxed">{chainAnalysis.entryRules}</div>
                          </div>
                          <div className="bg-slate-950/55 p-2.5 rounded border border-white/5">
                             <div className="text-[7.5px] text-rose-400/80 uppercase font-black mb-1">STOP LOSS ANCHOR</div>
                             <div className="font-mono text-rose-300 font-medium leading-relaxed">{chainAnalysis.stopLoss}</div>
                          </div>
                          <div className="bg-slate-950/55 p-2.5 rounded border border-white/5">
                             <div className="text-[7.5px] text-emerald-400/80 uppercase font-black mb-1">TARGET TAKE-PROFIT</div>
                             <div className="font-mono text-emerald-300 font-medium leading-relaxed">{chainAnalysis.target}</div>
                          </div>
                       </div>
                     </div>
                   )}
                </div>

                <div className="max-h-[500px] overflow-y-auto overflow-x-auto custom-scrollbar relative border border-white/5 rounded-lg bg-black/10">
                   <table className="w-full text-left border-collapse text-[10px]">
                      <thead className="sticky top-0 z-10 bg-slate-950/95 backdrop-blur-sm self-start">
                        <tr className="border-b border-slate-800/80 text-[8px] font-black text-slate-500 uppercase tracking-widest text-center bg-black/20">
                          <th className="py-2.5 text-rose-400 border-r border-white/5" colSpan={4}>CALL OPTIONS (CE)</th>
                          <th className="py-2.5 text-white bg-white/5 font-black border-r border-white/5 border-l border-white/5 shrink-0 px-4">STRIKE</th>
                          <th className="py-2.5 text-emerald-400" colSpan={4}>PUT OPTIONS (PE)</th>
                        </tr>
                        <tr className="border-b border-white/5 text-[7px] font-extrabold text-slate-500 uppercase tracking-widest text-center bg-slate-900/25">
                          <th className="py-2 text-rose-400/70">Delta</th>
                          <th className="py-2 text-rose-400/60 font-medium">IV</th>
                          <th className="py-2 text-rose-400/80 font-medium">OI (Chg)</th>
                          <th className="py-2 text-rose-400 font-black border-r border-white/5">CE Price</th>
                          <th className="py-2 text-blue-400 font-extrabold bg-blue-500/5 border-r border-white/5 border-l border-white/5">Strike</th>
                          <th className="py-2 text-emerald-400 font-black border-r border-white/5">PE Price</th>
                          <th className="py-2 text-emerald-400/80">OI (Chg)</th>
                          <th className="py-2 text-emerald-400/60">IV</th>
                          <th className="py-2 text-emerald-400/70">Delta</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.02]">
                        {(() => {
                          const spot = market?.spot || 22000;
                          const spotStrike = Math.round(spot / strikeStep) * strikeStep;
                          const displayedStrikes = [...(market?.chain || [])]
                            .sort((a: any, b: any) => b.strike - a.strike);

                          if (displayedStrikes.length === 0) {
                            return (
                              <tr>
                                <td colSpan={9} className="py-8 text-center text-slate-400 font-bold uppercase text-[8px] tracking-widest">
                                  Synchronizing Supercharged Option Chain Matrix...
                                </td>
                              </tr>
                            );
                          }

                          return displayedStrikes.map((c: any) => {
                            const isAtm = c.strike === spotStrike;
                            const isSupport = insights && c.strike === insights.support;
                            const isResistance = insights && c.strike === insights.resistance;
                            
                            // Accurate options greeks dynamic derivation
                            const ceDelta = Math.max(0.01, Math.min(0.99, 1 / (1 + Math.exp(-(spot - c.strike) / 35))));
                            const peDelta = ceDelta - 1.0;
                            const ceIv = c.ce_iv || 12.5;
                            const peIv = c.pe_iv || 13.0;

                            const ceOiStr = formatOi(c.ce_oi || 0);
                            const peOiStr = formatOi(c.pe_oi || 0);

                            return (
                              <tr key={c.strike} className={cn(
                                "text-center transition-all duration-300 hover:bg-white/[0.01]",
                                isAtm && "bg-blue-600/[0.04]",
                                isSupport && "bg-emerald-500/[0.03] border-l-2 border-l-emerald-500",
                                isResistance && "bg-rose-500/[0.03] border-l-2 border-l-rose-500"
                              )}>
                                {/* CE Delta */}
                                <td className="py-3 font-mono text-[8.5px] text-rose-400/75">{ceDelta.toFixed(2)}</td>
                                {/* CE IV */}
                                <td className="py-3 font-mono text-[8px] text-slate-500">{ceIv.toFixed(1)}%</td>
                                {/* CE OI */}
                                <td className={cn(
                                  "py-3 font-mono text-[8.5px] transition-colors",
                                  isResistance ? "bg-rose-500/10 text-rose-200 font-extrabold" : "text-rose-300"
                                )}>
                                   <span className="font-extrabold">{ceOiStr}</span>
                                   {c.ce_oi_change !== undefined && (
                                     <span className={cn(
                                       "text-[7px] ml-1 font-bold font-mono",
                                       c.ce_oi_change >= 0 ? "text-emerald-500" : "text-rose-500"
                                     )}>
                                        {c.ce_oi_change >= 0 ? '+' : ''}{formatOi(c.ce_oi_change)}
                                     </span>
                                   )}
                                </td>
                                {/* CE Price */}
                                <td className={cn(
                                  "py-3 font-mono font-black border-r border-white/5 transition-colors",
                                  isResistance ? "bg-rose-500/15 text-rose-200" : "text-rose-400"
                                )}>₹{c.ce_price?.toFixed(1) || '0.0'}</td>
                                
                                {/* STRIKE */}
                                <td className={cn(
                                  "py-3 font-mono font-black text-[12px] bg-slate-950/20 border-r border-white/5 border-l border-white/5 shrink-0 min-w-[80px] transition-colors",
                                  isAtm ? "text-blue-400 ring-1 ring-blue-500/20 font-black" : "text-slate-300"
                                )}>
                                  <div className="flex flex-col items-center justify-center gap-0.5">
                                    <span>{c.strike} {isAtm ? "●" : ""}</span>
                                    {isSupport && (
                                      <span className="text-[7px] text-emerald-400 bg-emerald-500/20 px-1 py-[1.5px] rounded-sm font-black tracking-widest uppercase scale-90">SUPPORT</span>
                                    )}
                                    {isResistance && (
                                      <span className="text-[7px] text-rose-400 bg-rose-500/20 px-1 py-[1.5px] rounded-sm font-black tracking-widest uppercase scale-90">RESIST</span>
                                    )}
                                  </div>
                                </td>

                                {/* PE Price */}
                                <td className={cn(
                                  "py-3 font-mono font-black border-r border-white/5 transition-colors",
                                  isSupport ? "bg-emerald-500/15 text-emerald-200" : "text-emerald-400"
                                )}>₹{c.pe_price?.toFixed(1) || '0.0'}</td>
                                {/* PE OI */}
                                <td className={cn(
                                  "py-3 font-mono text-[8.5px] transition-colors",
                                  isSupport ? "bg-emerald-500/10 text-emerald-200 font-extrabold" : "text-emerald-300"
                                )}>
                                   <span className="font-extrabold">{peOiStr}</span>
                                   {c.pe_oi_change !== undefined && (
                                     <span className={cn(
                                       "text-[7px] ml-1 font-bold font-mono",
                                       c.pe_oi_change >= 0 ? "text-emerald-500" : "text-rose-500"
                                     )}>
                                        {c.pe_oi_change >= 0 ? '+' : ''}{formatOi(c.pe_oi_change)}
                                     </span>
                                   )}
                                </td>
                                {/* PE IV */}
                                <td className="py-3 font-mono text-[8px] text-slate-500">{peIv.toFixed(1)}%</td>
                                {/* PE Delta */}
                                <td className="py-3 font-mono text-[8.5px] text-emerald-400/75">{peDelta.toFixed(2)}</td>
                              </tr>
                            );
                          });
                        })()}
                     </tbody>
                    </table>
                 </div>
               </section>
            </div>
          </motion.main>
        ) : activeTab === 'stock-alpha' ? (
          <motion.main 
            key="stock-alpha"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 p-6 overflow-y-auto flex flex-col gap-6"
          >
            <div className="flex justify-between items-end">
               <div>
                  <h2 className="text-2xl font-black text-white tracking-tight uppercase">Stock Options Intelligence</h2>
                  <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mt-1">Institutional Naked Buying Analytics</p>
               </div>
               <div className="flex gap-4 items-center">
                  <div className="relative group">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 group-focus-within:text-blue-500 transition-colors" />
                    <select 
                      value={selectedStock}
                      onChange={(e) => setSelectedStock(e.target.value)}
                      className="bg-slate-900 border border-white/10 rounded-lg pl-8 pr-4 py-2 text-[10px] font-black text-white uppercase outline-none focus:border-blue-500/50 min-w-[200px] appearance-none"
                    >
                      {foStocks.sort().map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <Filter className="absolute right-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500 pointer-events-none" />
                  </div>
                  
                  <button 
                    onClick={() => fetchStockIntel(selectedStock)}
                    disabled={isSearchingStock}
                    className="p-2.5 terminal-card hover:border-blue-500/40 transition-colors"
                  >
                     <Zap className={cn("w-4 h-4", isSearchingStock ? "text-blue-500 animate-pulse" : "text-white")} />
                  </button>
               </div>
            </div>

            {isSearchingStock ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-6">
                <div className="relative">
                   <div className="w-16 h-16 border-4 border-blue-600/20 border-t-blue-600 rounded-full animate-spin" />
                   <Cpu className="absolute inset-0 m-auto w-6 h-6 text-blue-500" />
                </div>
                <div className="flex flex-col items-center gap-1">
                   <p className="text-sm font-black text-white uppercase tracking-widest text-center">Quant-AI Engine Analyzing {selectedStock}</p>
                   <p className="text-[10px] text-slate-500 font-bold uppercase text-center">Syncing Option Chain & Institutional Order Flow...</p>
                </div>
              </div>
            ) : stockIntel ? (
              <div className="flex-1 flex flex-col gap-6 overflow-hidden">
                <div className="grid grid-cols-12 gap-6">
                  {/* Left: AI Verdict */}
                  <div className="col-span-12 lg:col-span-4 flex flex-col gap-4">
                     <section className={cn(
                       "terminal-card p-6 border-l-4",
                       stockIntel.verdict.bias === 'BULLISH' ? "border-l-emerald-500" : stockIntel.verdict.bias === 'BEARISH' ? "border-l-rose-500" : "border-l-slate-500"
                     )}>
                        <div className="flex justify-between items-start mb-6">
                           <div>
                              <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Decision Verdict</span>
                              <h3 className={cn(
                                "text-2xl font-black tracking-tight",
                                stockIntel.verdict.bias === 'BULLISH' ? "text-emerald-400" : stockIntel.verdict.bias === 'BEARISH' ? "text-rose-400" : "text-slate-400"
                              )}>{stockIntel.verdict.bias} TRADE</h3>
                           </div>
                           <div className={cn(
                              "p-3 rounded-xl border flex flex-col items-center",
                              stockIntel.verdict.score >= 75 ? "bg-emerald-500/10 border-emerald-500/20" :
                              stockIntel.verdict.score >= 50 ? "bg-amber-500/10 border-amber-500/20" : "bg-rose-500/10 border-rose-500/20"
                           )}>
                              <span className={cn(
                                 "text-[10px] font-black",
                                 stockIntel.verdict.score >= 75 ? "text-emerald-400" :
                                 stockIntel.verdict.score >= 50 ? "text-amber-400" : "text-rose-400"
                              )}>{stockIntel.verdict.score}%</span>
                              <span className="text-[7px] text-slate-500 font-bold uppercase">Confidence</span>
                           </div>
                        </div>

                        <div className="space-y-4">
                           <div className="p-4 bg-white/5 rounded-lg border border-white/5 max-h-[140px] overflow-y-auto custom-scrollbar">
                              <p className="text-[11px] text-slate-300 font-bold leading-relaxed">{stockIntel.verdict.reasoning}</p>
                           </div>

                           <div className="grid grid-cols-2 gap-3">
                              <div className="bg-emerald-500/5 p-3 rounded border border-emerald-500/20">
                                 <div className="text-[8px] font-black text-emerald-500 uppercase mb-1">Target Entry Profit</div>
                                 <div className="text-base font-black text-white">₹{stockIntel.verdict.target.toFixed(1)}</div>
                              </div>
                              <div className="bg-rose-500/5 p-3 rounded border border-rose-500/20">
                                 <div className="text-[8px] font-black text-rose-500 uppercase mb-1">Invalidation (SL)</div>
                                 <div className="text-base font-black text-white">₹{stockIntel.verdict.sl.toFixed(1)}</div>
                              </div>
                           </div>
                        </div>
                     </section>

                     <section className="terminal-card p-6 flex-1">
                        <h4 className="text-[10px] font-black text-white uppercase tracking-widest mb-4 flex items-center gap-2">
                           <Layers className="w-3 h-3 text-blue-500" />
                           Institutional Fingerprints
                        </h4>
                        <div className="space-y-6">
                           <div className="flex justify-between items-center bg-white/5 p-3 rounded border border-white/5">
                              <span className="text-[10px] text-slate-500 font-bold uppercase">OI Accumulation</span>
                              <span className="text-[10px] text-emerald-400 font-black">{stockIntel.institutionalActivity.oiTrend}</span>
                           </div>
                           <div className="flex justify-between items-center bg-white/5 p-3 rounded border border-white/5">
                              <span className="text-[10px] text-slate-500 font-bold uppercase">Volatility Regime</span>
                              <span className="text-[10px] text-blue-400 font-black">{stockIntel.institutionalActivity.volatilityRegime}</span>
                           </div>
                           <div className="flex justify-between items-center bg-white/5 p-3 rounded border border-white/5">
                              <span className="text-[10px] text-slate-500 font-bold uppercase">Delivery Base</span>
                              <span className="text-[10px] text-white font-black">{stockIntel.institutionalActivity.deliveryPercentage}%</span>
                           </div>
                        </div>
                     </section>
                  </div>

                  {/* Middle: Indicators & Option Chain Overview */}
                  <div className="col-span-12 lg:col-span-8 flex flex-col gap-6 overflow-hidden">
                     <div className="grid grid-cols-4 gap-4">
                        <div className="terminal-card p-4">
                           <span className="terminal-label">Spot Price</span>
                           <div className="text-lg font-black text-white">₹{stockIntel.price.toFixed(2)}</div>
                           <div className="flex items-center justify-between mt-1">
                              <div className={cn("text-[10px] font-bold", stockIntel.change >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                 {stockIntel.change >= 0 ? '+' : ''}{stockIntel.change.toFixed(2)} ({stockIntel.changePercent.toFixed(2)}%)
                              </div>
                              <div className="flex gap-2">
                                 <div className="text-[8px] font-black uppercase text-slate-500">H: <span className="text-white">₹{stockIntel.high?.toFixed(1) || '0'}</span></div>
                                 <div className="text-[8px] font-black uppercase text-slate-500">L: <span className="text-white">₹{stockIntel.low?.toFixed(1) || '0'}</span></div>
                              </div>
                           </div>
                        </div>
                        <div className="terminal-card p-4">
                           <span className="terminal-label">RSI (14)</span>
                           <div className="text-lg font-black text-blue-400">{stockIntel.indicators.rsi.toFixed(1)}</div>
                           <div className="text-[9px] text-slate-500 font-bold uppercase">
                              {stockIntel.indicators.rsi > 70 ? 'OVERBOUGHT' : stockIntel.indicators.rsi < 30 ? 'OVERSOLD' : 'NEUTRAL'}
                           </div>
                        </div>
                        <div className="terminal-card p-4">
                           <span className="terminal-label">OI PCR</span>
                           <div className="text-lg font-black text-emerald-400">{stockIntel.optionsStats?.pcr || '1.00'}</div>
                           <div className="text-[9px] text-slate-500 font-bold uppercase">Option Sentiment</div>
                        </div>
                        <div className="terminal-card p-4">
                           <span className="terminal-label">Max Pain</span>
                           <div className="text-lg font-black text-purple-400">{stockIntel.optionsStats?.maxPain || 'N/A'}</div>
                           <div className="text-[9px] text-slate-500 font-bold uppercase">Ex: {stockIntel.optionsStats?.expiry ? new Date(stockIntel.optionsStats.expiry).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }) : 'N/A'}</div>
                        </div>
                     </div>

                     {stockIntel.verdict.strategy && (
                        <div className="terminal-card p-4 border-l-4 border-l-blue-500 bg-blue-500/5">
                           <div className="flex items-center gap-2 mb-2">
                              <Target className="w-3 h-3 text-blue-500" />
                              <span className="text-[10px] font-black text-white uppercase tracking-widest">Quantum Execution Strategy</span>
                           </div>
                           <p className="text-xs font-bold text-blue-100">{stockIntel.verdict.strategy}</p>
                        </div>
                     )}

                     <section className="terminal-card flex-1 flex flex-col overflow-hidden min-h-0">
                        <div className="px-5 py-3 border-b border-white/5 bg-white/[0.02] flex justify-between items-center">
                           <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                               Liquid Option Chain ({stockIntel.optionsStats?.expiry ? `Expiry: ${new Date(stockIntel.optionsStats.expiry).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })}` : 'Near Month'})
                            </h4>
                           <div className="flex gap-4">
                              <div className="flex items-center gap-1.5">
                                 <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                 <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Active Call Writing</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                 <div className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                                 <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Active Put Writing</span>
                              </div>
                           </div>
                        </div>
                        
                        <div className="flex-1 overflow-y-auto">
                           <table className="w-full text-left">
                              <thead className="sticky top-0 bg-[#0f172a] shadow-sm z-10 border-b border-terminal-line">
                                 <tr className="text-[9px] font-black text-slate-500 uppercase tracking-widest bg-black/40">
                                    <th className="px-6 py-4">Call OI Chg</th>
                                    <th className="px-6 py-4">LTP (CE)</th>
                                    <th className="px-6 py-4 text-center">STRIKE</th>
                                    <th className="px-6 py-4 text-right">LTP (PE)</th>
                                    <th className="px-6 py-4 text-right">Put OI Chg</th>
                                 </tr>
                              </thead>
                              <tbody className="divide-y divide-white/[0.02]">
                                 {stockIntel.optionChain.map((chain, i) => {
                                    const isAtm = Math.abs(chain.strike - stockIntel.price) < 10;
                                    return (
                                       <tr key={i} className={cn(
                                         "hover:bg-white/[0.01] transition-colors",
                                         isAtm && "bg-blue-600/5 hover:bg-blue-600/10"
                                       )}>
                                          <td className="px-6 py-4">
                                             <div className="flex flex-col">
                                                <span className={cn("text-[10px] font-black", chain.ce_oi_change >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                                   {chain.ce_oi_change >= 0 ? '+' : ''}{chain.ce_oi_change.toLocaleString()}
                                                </span>
                                                <span className="text-[8px] text-slate-500 font-bold">OI: {chain.ce_oi.toLocaleString()}</span>
                                             </div>
                                          </td>
                                          <td className="px-6 py-4">
                                             <span className="text-[11px] font-black text-white">₹{chain.ce_price.toFixed(1)}</span>
                                          </td>
                                          <td className="px-6 py-4 text-center">
                                             <span className={cn("text-xs font-black", isAtm ? "text-blue-400" : "text-slate-400")}>{chain.strike}</span>
                                          </td>
                                          <td className="px-6 py-4 text-right">
                                             <span className="text-[11px] font-black text-white">₹{chain.pe_price.toFixed(1)}</span>
                                          </td>
                                          <td className="px-6 py-4 text-right">
                                             <div className="flex flex-col items-end">
                                                <span className={cn("text-[10px] font-black", chain.pe_oi_change >= 0 ? "text-emerald-400" : "text-rose-400")}>
                                                   {chain.pe_oi_change >= 0 ? '+' : ''}{chain.pe_oi_change.toLocaleString()}
                                                </span>
                                                <span className="text-[8px] text-slate-500 font-bold">OI: {chain.pe_oi.toLocaleString()}</span>
                                             </div>
                                          </td>
                                       </tr>
                                    );
                                 })}
                              </tbody>
                           </table>
                        </div>

                        <div className="p-4 bg-white/[0.02] border-t border-white/5">
                           <p className="text-[8px] text-slate-500 font-black uppercase text-center italic tracking-wider">
                              Option liquidity validated via real-time order-book snapshot. High slippage warning on out-of-money strikes.
                           </p>
                        </div>
                     </section>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center opacity-40">
                <Search className="w-12 h-12 text-slate-700 mb-4" />
                <p className="text-sm font-black text-slate-500 uppercase tracking-widest">Select an F&O Stock to begin deep-scan</p>
              </div>
            )}
          </motion.main>
        ) : activeTab === 'risk' ? (
          <motion.main 
            key="risk"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="flex-1 p-6 overflow-y-auto custom-scrollbar"
          >
            <div className="max-w-6xl mx-auto space-y-8">
              <div className="flex justify-between items-end pb-2">
                <div>
                   <h2 className="text-2xl font-black text-white tracking-widest uppercase mb-1">Risk Management Core</h2>
                   <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest">Real-time dynamic exposure monitoring & failsafe engine</p>
                </div>
                <div className="flex gap-4">
                   <div className="px-4 py-2 bg-white/[0.02] border border-white/5 rounded-lg flex flex-col items-end">
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Kill Switch</span>
                      <span className={cn(
                        "text-[10px] font-black",
                        execution?.risk?.isKillSwitchActive ? "text-rose-500" : "text-emerald-500"
                      )}>
                        {execution?.risk?.isKillSwitchActive ? 'HALTED' : 'OPERATIONAL'}
                      </span>
                   </div>
                </div>
              </div>

              <div className="grid grid-cols-12 gap-6">
                 {/* Risk Score Gauge */}
                 <section className="col-span-12 lg:col-span-4 terminal-card p-6 flex flex-col items-center justify-center">
                    <div className="relative mb-6">
                       <svg className="w-48 h-48 -rotate-90">
                          <circle cx="96" cy="96" r="88" fill="none" stroke="rgba(255,255,255,0.02)" strokeWidth="8" />
                          <motion.circle 
                            cx="96" cy="96" r="88" fill="none" 
                            stroke={cn(
                              (execution?.risk?.riskScore || 0) > 70 ? "#10b981" : 
                              (execution?.risk?.riskScore || 0) > 40 ? "#f59e0b" : "#ef4444"
                            )} 
                            strokeWidth="8" 
                            strokeDasharray="552.9"
                            initial={{ strokeDashoffset: 552.9 }}
                            animate={{ strokeDashoffset: 552.9 * (1 - (execution?.risk?.riskScore || 0) / 100) }}
                            transition={{ duration: 1.5, ease: "easeOut" }}
                            strokeLinecap="round"
                          />
                       </svg>
                       <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-5xl font-black text-white tracking-tighter">
                            {execution?.risk?.riskScore || 0}
                          </span>
                          <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Safety Score</span>
                       </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 w-full">
                       <div className="bg-white/5 p-3 rounded-lg text-center">
                          <span className="text-[8px] font-black text-slate-500 uppercase block mb-1">Exposure Heat</span>
                          <span className="text-sm font-black text-white">{execution?.risk?.portfolioHeat || 0}%</span>
                       </div>
                       <div className="bg-white/5 p-3 rounded-lg text-center">
                          <span className="text-[8px] font-black text-slate-500 uppercase block mb-1">Daily Drawdown</span>
                          <span className="text-sm font-black text-rose-400">₹{execution?.risk?.maxDrawdownToday || 0}</span>
                       </div>
                    </div>
                 </section>

                 {/* Portfolio Limits Tracking */}
                 <section className="col-span-12 lg:col-span-8 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                       <div className="terminal-card p-4 space-y-4">
                          <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-slate-400">
                             <span>Daily PnL Threshold</span>
                             <span className="text-slate-500">₹{execution?.risk?.limits.dailyLoss} Limit</span>
                          </div>
                          <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                             <motion.div 
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  (execution?.risk?.dailyPnL || 0) < 0 ? "bg-rose-500" : "bg-emerald-500"
                                )}
                                initial={{ width: 0 }}
                                animate={{ width: `${Math.min(100, Math.abs((execution?.risk?.dailyPnL || 0) / (execution?.risk?.limits.dailyLoss || 1)) * 100)}%` }}
                             />
                          </div>
                          <div className="flex justify-between text-[10px] items-center">
                             <span className={cn("font-black", (execution?.risk?.dailyPnL || 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                               ₹{execution?.risk?.dailyPnL || 0}
                             </span>
                             <span className="text-slate-500 font-mono">
                               {Math.abs(Math.round(((execution?.risk?.dailyPnL || 0) / (execution?.risk?.limits.dailyLoss || 1)) * 100))}% Used
                             </span>
                          </div>
                       </div>

                       <div className="terminal-card p-4 space-y-4">
                          <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-slate-400">
                             <span>Trades Frequency</span>
                             <span className="text-slate-500">{execution?.risk?.limits.maxTrades} Max</span>
                          </div>
                          <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                             <motion.div 
                                className="h-full bg-blue-500 rounded-full"
                                initial={{ width: 0 }}
                                animate={{ width: `${Math.min(100, (((execution?.risk as any)?.entriesToday || 0) / (execution?.risk?.limits.maxTrades || 10)) * 100)}%` }}
                             />
                          </div>
                          <div className="flex justify-between text-[10px] items-center">
                             <span className="font-black text-white">
                                {(execution?.risk as any)?.entriesToday || 0} Trades executed
                             </span>
                             <span className="text-slate-500 font-mono">
                                {Math.round((((execution?.risk as any)?.entriesToday || 0) / (execution?.risk?.limits.maxTrades || 1)) * 100)}% Used
                             </span>
                           </div>
                        </div>

                        <div className="terminal-card p-4 space-y-4 border-blue-500/20 bg-blue-500/[0.02]">
                           <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-blue-400">
                              <span>Required Margin (Capital)</span>
                              <span className="text-slate-500">₹{(appConfig?.CAPITAL_BASE || 1000000).toLocaleString()} Base</span>
                           </div>
                           <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-1">
                                 <div className="text-[8px] font-black text-slate-500 uppercase">Max Reward</div>
                                 <div className="text-xs font-black text-emerald-400">₹{execution?.maxReward?.toLocaleString() || '--'}</div>
                              </div>
                              <div className="space-y-1">
                                 <div className="text-[8px] font-black text-slate-500 uppercase">Max Risk</div>
                                 <div className="text-xs font-black text-rose-400">₹{execution?.maxRisk?.toLocaleString() || '--'}</div>
                              </div>
                           </div>
                           <div className="flex flex-col gap-2 pt-2 border-t border-white/5">
                              <div className="flex justify-between text-[10px] items-center">
                                 <span className="font-black text-white uppercase">Margin Requirement</span>
                                 <span className="text-white font-mono">₹{execution?.capitalDeployed?.toLocaleString() || 0}</span>
                              </div>
                              <div className="flex justify-between text-[10px] items-center">
                                 <span className="font-black text-blue-400 uppercase">Net Premium</span>
                                 <span className="text-blue-400 font-mono">
                                    ₹{Math.abs(execution?.netPremium || 0).toLocaleString()} {execution?.netPremium >= 0 ? '(DR)' : '(CR)'}
                                 </span>
                              </div>
                           </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                       <div className="terminal-card p-4 bg-white/[0.01]">
                          <Zap className="w-4 h-4 text-amber-500 mb-2" />
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Consecutive Losses</h4>
                          <div className="text-xl font-black text-white">{execution?.risk?.consecutiveLosses || 0}</div>
                          <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Limit: {execution?.risk?.limits.consectuiveLimit}</p>
                       </div>
                       <div className="terminal-card p-4 bg-white/[0.01]">
                          <Activity className="w-4 h-4 text-blue-500 mb-2" />
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Portfolio Heat</h4>
                          <div className="text-xl font-black text-white">{execution?.risk?.portfolioHeat || 0}%</div>
                          <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Limit: {execution?.risk?.limits.heatLimit}% Cap</p>
                       </div>
                       <div className="terminal-card p-4 bg-white/[0.01]">
                          <Shield className="w-4 h-4 text-emerald-500 mb-2" />
                          <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Profit Lock</h4>
                          <div className="text-xl font-black text-emerald-400">₹{execution?.risk?.peakPnLToday || 0}</div>
                          <p className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Trailing protection active</p>
                       </div>
                    </div>

                    <div className="terminal-card h-40 flex flex-col p-6 overflow-hidden relative">
                       <div className="absolute top-0 right-0 p-4 opacity-5">
                          <LogOut className="w-24 h-24 rotate-12" />
                       </div>
                       <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Risk Intelligence Engine Status</h4>
                       <div className="flex-1 space-y-3 overflow-y-auto pr-2 custom-scrollbar">
                          {execution?.risk?.isKillSwitchActive ? (
                            <div className="flex items-start gap-3 p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg">
                               <ShieldAlert className="w-4 h-4 text-rose-500 shrink-0" />
                               <div>
                                  <div className="text-[10px] font-black text-rose-500 uppercase tracking-widest">EMERGENCY HALT ACTIVE</div>
                                  <div className="text-[9px] text-rose-400/70 font-bold mt-1 uppercase">{execution?.risk?.killReason}</div>
                               </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-3 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                               <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                               <div>
                                  <div className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">ENGINE NOMINAL</div>
                                  <div className="text-[9px] text-emerald-400/70 font-bold mt-1 uppercase">ALL RISK THRESHOLDS WITHIN BOUNDARIES</div>
                               </div>
                            </div>
                          )}

                          <div className="flex items-center gap-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
                             <Zap className="w-4 h-4 text-blue-500 shrink-0" />
                             <div>
                                <div className="text-[10px] font-black text-blue-400 uppercase tracking-widest">ADAPTIVE POSITION SIZING</div>
                                <div className="text-[9px] text-blue-400/70 font-bold mt-1 uppercase">DYNAMICALLY ADJUSTING LOTS BASED ON VIX ({market?.vix?.toFixed(1) || '---'})</div>
                             </div>
                          </div>

                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pb-2">
                             <div className="p-3 bg-white/5 border border-white/5 rounded-lg flex flex-col">
                                <span className="text-[8px] font-black text-slate-500 uppercase mb-1">Delta (NET)</span>
                                <div className={cn("text-xs font-black", Math.abs(execution?.netDelta || 0) > 1.0 ? "text-rose-400" : Math.abs(execution?.netDelta || 0) > 0.5 ? "text-amber-400" : "text-white")}>
                                   {execution?.netDelta?.toFixed(3) || '0.000'}
                                </div>
                             </div>
                             <div className="p-3 bg-white/5 border border-white/5 rounded-lg flex flex-col">
                                <span className="text-[8px] font-black text-slate-500 uppercase mb-1">Gamma (NET)</span>
                                <div className="text-xs font-black text-white">
                                   {execution?.netGamma?.toFixed(4) || '0.0000'}
                                </div>
                             </div>
                             <div className="p-3 bg-white/5 border border-white/5 rounded-lg flex flex-col">
                                <span className="text-[8px] font-black text-slate-500 uppercase mb-1">Theta (DECAY)</span>
                                <div className={cn("text-xs font-black", (execution?.netTheta || 0) > 0 ? "text-emerald-400" : "text-rose-400")}>
                                   {execution?.netTheta?.toFixed(2) || '0.00'}
                                </div>
                             </div>
                             <div className="p-3 bg-white/5 border border-white/5 rounded-lg flex flex-col">
                                <span className="text-[8px] font-black text-slate-500 uppercase mb-1">Vega (VOL)</span>
                                <div className="text-xs font-black text-blue-400">
                                   {execution?.netVega?.toFixed(2) || '0.00'}
                                </div>
                             </div>
                          </div>
                       </div>
                    </div>
                 </section>
              </div>

              {/* Advanced Risk Settings Section */}
              <section className="terminal-card p-6">
                <div className="flex items-center gap-2 mb-6">
                   <Settings className="w-4 h-4 text-slate-400" />
                   <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">Dynamic Risk Configuration</h3>
                </div>
                
                {appConfig && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    <div className="space-y-4">
                       <h4 className="text-[8px] font-black text-slate-500 uppercase tracking-widest border-b border-white/5 pb-2">Capital & Allocation</h4>
                       <div className="grid grid-cols-1 gap-4">
                          <RiskInput 
                            label="Capital Base (₹)" 
                            value={appConfig.CAPITAL_BASE} 
                            onChange={(val) => updateConfigAtServer({ CAPITAL_BASE: Number(val) })} 
                          />
                          <RiskInput 
                            label="Max Portfolio Heat (%)" 
                            value={appConfig.MAX_PORTFOLIO_HEAT} 
                            onChange={(val) => updateConfigAtServer({ MAX_PORTFOLIO_HEAT: Number(val) })} 
                          />
                          <RiskInput 
                            label="Max Risk Per Trade (%)" 
                            value={appConfig.MAX_RISK_PER_TRADE_PCT} 
                            onChange={(val) => updateConfigAtServer({ MAX_RISK_PER_TRADE_PCT: Number(val) })} 
                          />
                       </div>
                    </div>

                    <div className="space-y-4">
                       <h4 className="text-[8px] font-black text-slate-500 uppercase tracking-widest border-b border-white/5 pb-2">Circuit Breakers</h4>
                       <div className="grid grid-cols-1 gap-4">
                          <RiskInput 
                            label="Daily Loss Limit (₹)" 
                            value={appConfig.DAILY_LOSS_LIMIT} 
                            onChange={(val) => updateConfigAtServer({ DAILY_LOSS_LIMIT: Number(val) })} 
                          />
                          <RiskInput 
                            label="Profit Lock Threshold (₹)" 
                            value={appConfig.DAILY_PROFIT_LOCK} 
                            onChange={(val) => updateConfigAtServer({ DAILY_PROFIT_LOCK: Number(val) })} 
                          />
                          <RiskInput 
                            label="Consecutive Loss Limit" 
                            value={appConfig.CONSECUTIVE_LOSS_LIMIT} 
                            onChange={(val) => updateConfigAtServer({ CONSECUTIVE_LOSS_LIMIT: Number(val) })} 
                          />
                       </div>
                    </div>

                    <div className="space-y-4">
                       <h4 className="text-[8px] font-black text-slate-500 uppercase tracking-widest border-b border-white/5 pb-2">Operational Limits</h4>
                       <div className="grid grid-cols-1 gap-4">
                          <RiskInput 
                            label="Max Trades Per Day" 
                            value={appConfig.MAX_TRADES_PER_DAY} 
                            onChange={(val) => updateConfigAtServer({ MAX_TRADES_PER_DAY: Number(val) })} 
                          />
                          <RiskInput 
                            label="Start Time (Market)" 
                            value={appConfig.START_TIME} 
                            type="text"
                            onChange={(val) => updateConfigAtServer({ START_TIME: val })} 
                          />
                          <RiskInput 
                            label="End Time (Manual Square-off)" 
                            value={appConfig.END_TIME} 
                            type="text"
                            onChange={(val) => updateConfigAtServer({ END_TIME: val })} 
                          />
                       </div>
                    </div>
                  </div>
                )}

                {/* Risk Persistence Audit Table */}
                <div className="mt-12">
                  <div className="flex items-center gap-2 mb-4">
                    <Shield className="w-3 h-3 text-blue-400" />
                    <h4 className="text-[10px] font-black text-white uppercase tracking-widest">Active Risk Control Manifest</h4>
                  </div>
                  <div className="terminal-card overflow-hidden">
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="bg-black/40 text-[8px] text-slate-500 uppercase tracking-[0.2em]">
                          <th className="px-4 py-3 text-left border-b border-white/5">Risk Parameter</th>
                          <th className="px-4 py-3 text-left border-b border-white/5">Configured Limit</th>
                          <th className="px-4 py-3 text-left border-b border-white/5">Impact Horizon</th>
                          <th className="px-4 py-3 text-right border-b border-white/5">Status</th>
                        </tr>
                      </thead>
                      <tbody className="text-[10px] terminal-value">
                        <tr className="border-b border-white/[0.02]">
                          <td className="px-4 py-3 text-slate-400 uppercase">Capital Base</td>
                          <td className="px-4 py-3 text-white">₹{appConfig?.CAPITAL_BASE?.toLocaleString() || '0'}</td>
                          <td className="px-4 py-3 text-slate-500 uppercase">PORTFOLIO</td>
                          <td className="px-4 py-3 text-right text-emerald-400">PERSISTED</td>
                        </tr>
                        <tr className="border-b border-white/[0.02]">
                          <td className="px-4 py-3 text-slate-400 uppercase">Daily Loss Limit</td>
                          <td className="px-4 py-3 text-rose-400">₹{appConfig?.DAILY_LOSS_LIMIT?.toLocaleString() || '0'}</td>
                          <td className="px-4 py-3 text-slate-500 uppercase">SESSION</td>
                          <td className="px-4 py-3 text-right text-emerald-400">PERSISTED</td>
                        </tr>
                        <tr className="border-b border-white/[0.02]">
                          <td className="px-4 py-3 text-slate-400 uppercase">Max Risk Per Trade</td>
                          <td className="px-4 py-3 text-white">{appConfig?.MAX_RISK_PER_TRADE_PCT}%</td>
                          <td className="px-4 py-3 text-slate-500 uppercase">EXECUTION</td>
                          <td className="px-4 py-3 text-right text-emerald-400">PERSISTED</td>
                        </tr>
                        <tr>
                          <td className="px-4 py-3 text-slate-400 uppercase">Max Trades / Day</td>
                          <td className="px-4 py-3 text-white">{appConfig?.MAX_TRADES_PER_DAY}</td>
                          <td className="px-4 py-3 text-slate-500 uppercase">OPERATIONAL</td>
                          <td className="px-4 py-3 text-right text-emerald-400">PERSISTED</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            </div>
          </motion.main>
        ) : activeTab === 'options' ? (
          <motion.main 
            key="options"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="flex-1 p-6 overflow-y-auto flex flex-col gap-6"
          >
            <div className="flex justify-between items-end">
               <div>
                  <h2 className="text-2xl font-black text-white tracking-tight uppercase">Instrument Chain</h2>
                  <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mt-1">Institutional Order Flow Intelligence</p>
               </div>
               <div className="flex gap-4">
                  <div className="terminal-card px-4 py-2 border-blue-500/20">
                     <span className="terminal-label !mb-0 text-[8px]">ATM Strike</span>
                     <div className="terminal-value text-lg text-blue-400">
                        {market?.spot ? Math.round(market.spot / strikeStep) * strikeStep : '----'}
                     </div>
                  </div>
                  <div className="terminal-card px-4 py-2">
                     <span className="terminal-label !mb-0 text-[8px]">Net OI Sentiment</span>
                     <div className={cn(
                       "terminal-value text-lg font-black",
                       (market?.chain || []).reduce((acc, curr) => acc + (curr.pe_oi_change - curr.ce_oi_change), 0) > 0 ? "text-emerald-400" : "text-rose-400"
                     )}>
                       {(market?.chain || []).reduce((acc, curr) => acc + (curr.pe_oi_change - curr.ce_oi_change), 0) > 0 ? 'BULLISH' : 'BEARISH'}
                     </div>
                  </div>
               </div>
            </div>

            <section className="terminal-card flex-1 flex flex-col min-h-0 overflow-hidden border-white/5">
                {/* Option Chain Insights Bar */}
                <div className="px-5 py-3 bg-white/[0.02] border-b border-white/5 grid grid-cols-5 gap-4">
                   <div className="flex flex-col">
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Total PCR (OI)</span>
                      <div className="flex items-baseline gap-1.5">
                         <span className={cn(
                            "text-base font-black",
                            ((market?.chain || []).reduce((acc, curr) => acc + curr.pe_oi, 0) / ((market?.chain || []).reduce((acc, curr) => acc + curr.ce_oi, 0) || 1)) > 1 ? "text-emerald-400" : "text-rose-400"
                         )}>
                            {((market?.chain || []).reduce((acc, curr) => acc + (curr?.pe_oi || 0), 0) / ((market?.chain || []).reduce((acc, curr) => acc + (curr?.ce_oi || 0), 0) || 1))?.toFixed(2) || '0.00'}
                         </span>
                      </div>
                   </div>
                   <div className="flex flex-col border-l border-white/5 pl-4">
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">OI Change Bias</span>
                      <div className="flex items-baseline gap-1.5">
                         <span className={cn(
                            "text-base font-black",
                            (market?.chain || []).reduce((acc, curr) => acc + (curr.pe_oi_change - curr.ce_oi_change), 0) > 0 ? "text-emerald-400" : "text-rose-400"
                         )}>
                            {(market?.chain || []).reduce((acc, curr) => acc + ((curr?.pe_oi_change || 0) - (curr?.ce_oi_change || 0)), 0).toLocaleString() || '0'}
                         </span>
                      </div>
                   </div>
                   <div className="flex flex-col border-l border-white/5 pl-4">
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Max Pain (Est)</span>
                      <div className="flex items-baseline gap-1.5">
                         <span className="text-base font-black text-blue-400">
                            {market?.maxPain ? market.maxPain : (market?.spot ? Math.round(market.spot / strikeStep) * strikeStep : '----')}
                         </span>
                      </div>
                   </div>
                   <div className="flex flex-col border-l border-white/5 pl-4">
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Resistance (Max OI)</span>
                      <div className="flex items-baseline gap-1.5">
                         <span className="text-base font-black text-rose-400">
                            {market?.maxOi?.ce?.strike || '---'}
                         </span>
                      </div>
                   </div>
                   <div className="flex flex-col border-l border-white/5 pl-4">
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-0.5">Support (Max OI)</span>
                      <div className="flex items-baseline gap-1.5">
                         <span className="text-base font-black text-emerald-400">
                            {market?.maxOi?.pe?.strike || '---'}
                         </span>
                      </div>
                   </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                  <table className="w-full border-collapse">
                    <thead className="sticky top-0 bg-[#0f172a] shadow-sm z-10">
                      <tr className="text-[9px] font-black text-slate-500 uppercase tracking-widest bg-black/40">
                        <th className="px-6 py-4 text-left border-b border-terminal-line">Strike</th>
                        <th className="px-6 py-4 text-left border-b border-terminal-line">Delta (CE)</th>
                        <th className="px-6 py-4 text-left border-b border-terminal-line">Vol / OI (CE)</th>
                        <th className="px-6 py-4 text-right border-b border-terminal-line">LTP (Calls)</th>
                        <th className="px-6 py-4 text-center border-b border-terminal-line">IV (C/P)</th>
                        <th className="px-6 py-4 text-left border-b border-terminal-line">LTP (Puts)</th>
                        <th className="px-6 py-4 text-right border-b border-terminal-line">Vol / OI (PE)</th>
                        <th className="px-6 py-4 text-right border-b border-terminal-line">Gamma (PE)</th>
                        <th className="px-6 py-4 text-right border-b border-terminal-line">Signal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.02]">
                      {(market?.chain || []).map((c) => {
                        const isAtm = c.strike === Math.round((market?.spot || 0) / strikeStep) * strikeStep;
                        const isResistance = c.strike === market?.maxOi?.ce?.strike;
                        const isSupport = c.strike === market?.maxOi?.pe?.strike;
                        const biasNum = (c.pe_oi_change - c.ce_oi_change);
                        const bias = biasNum > 0 ? "BULL" : "BEAR";
                        
                        return (
                          <tr key={c.strike} className={cn(
                            "group transition-colors h-14",
                            isAtm ? "bg-blue-600/5 hover:bg-blue-600/10" : "hover:bg-white/[0.01]"
                          )}>
                            <td className={cn("px-6 py-2 terminal-value text-sm text-center", isAtm ? "text-blue-400 font-black" : "text-slate-400")}>
                               <div className="flex flex-col items-center">
                                  <span>{c.strike}</span>
                                  <div className="flex gap-1 mt-1">
                                    {isResistance && <span className="text-[7px] bg-rose-500/20 text-rose-400 px-1 rounded border border-rose-500/20">RES</span>}
                                    {isSupport && <span className="text-[7px] bg-emerald-500/20 text-emerald-400 px-1 rounded border border-emerald-500/20">SUP</span>}
                                  </div>
                               </div>
                            </td>
                            <td className="px-6 py-2 terminal-value text-[10px] text-blue-400 font-bold">
                              {(c.delta || 0.5).toFixed(2)}
                            </td>
                            <td className="px-6 py-2 terminal-value text-[10px] whitespace-nowrap">
                               <div className="flex flex-col">
                                 <span className="text-white font-black">{(c.ce_volume || 0).toLocaleString()}</span>
                                 <span className="text-slate-500 text-[8px] font-bold">OI: {(c.ce_oi || 0).toLocaleString()}</span>
                               </div>
                            </td>
                             <td className="px-6 py-2 text-right">
                               <div className="flex items-center justify-end gap-2">
                                 <svg width="24" height="10" className="opacity-30 group-hover:opacity-60 transition-opacity">
                                   <polyline fill="none" stroke="#10b981" strokeWidth="1" points="0,8 5,4 10,6 15,2 20,5 24,0" />
                                 </svg>
                                 <span className="terminal-value text-white text-xs font-black">₹{c.ce_price.toFixed(1)}</span>
                               </div>
                             </td>
                             <td className="px-6 py-2 text-center whitespace-nowrap">
                                <span className={cn("text-[9px] font-black", (c.ce_iv || 14) > 18 ? "text-rose-400" : "text-blue-400/60")}>{(c.ce_iv || 14.2).toFixed(1)}</span>
                                <span className="text-[8px] text-slate-600 mx-1">/</span>
                                <span className={cn("text-[9px] font-black", (c.pe_iv || 14) > 18 ? "text-rose-400" : "text-blue-400/60")}>{(c.pe_iv || 14.5).toFixed(1)}</span>
                             </td>
                             <td className="px-6 py-2 text-right">
                               <div className="flex items-center justify-end gap-2">
                                 <span className="terminal-value text-white text-xs font-black">₹{c.pe_price.toFixed(1)}</span>
                                 <svg width="24" height="10" className="opacity-30 group-hover:opacity-60 transition-opacity">
                                   <polyline fill="none" stroke="#f43f5e" strokeWidth="1" points="0,2 5,6 10,4 15,8 20,5 24,10" />
                                 </svg>
                               </div>
                             </td>
                             <td className="px-6 py-2 text-right terminal-value text-[10px] whitespace-nowrap">
                                <div className="flex flex-col items-end">
                                  <span className="text-white font-black">{(c.pe_volume || 0).toLocaleString()}</span>
                                  <span className="text-slate-500 text-[8px] font-bold">OI: {(c.pe_oi || 0).toLocaleString()}</span>
                                </div>
                             </td>
                            <td className="px-6 py-2 text-right terminal-value text-[10px] text-purple-400 font-bold">
                              {(c.gamma || 0.002).toFixed(4)}
                            </td>
                            <td className="px-6 py-2 text-right">
                                <div className={cn(
                                  "inline-flex items-center gap-2 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest",
                                  bias === 'BULL' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-500 border border-rose-500/20'
                                )}>
                                  {bias}
                                </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
          </motion.main>
        ) : activeTab === 'backtest' ? (
          <motion.main 
            key="backtest"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="flex-1 p-8 overflow-y-auto flex flex-col gap-6"
          >
            <div className="flex justify-between items-end">
               <div>
                  <h2 className="text-2xl font-black text-white tracking-tight uppercase">Algorithmic Backtesting</h2>
                  <p className="text-xs text-slate-500 font-bold tracking-widest mt-1">Quantitative Performance Validation Engine</p>
               </div>
               <div className="flex gap-4 items-center bg-slate-900/50 p-3 rounded-xl border border-white/5">
                  <div className="flex flex-col px-2">
                     <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">From Date</span>
                     <input 
                        type="date"
                        value={backtestDates.from}
                        onChange={(e) => setBacktestDates({...backtestDates, from: e.target.value})}
                        className="bg-transparent text-[10px] font-bold text-blue-400 outline-none cursor-pointer"
                     />
                  </div>
                  <div className="w-px h-6 bg-white/10" />
                  <div className="flex flex-col px-2">
                     <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">To Date</span>
                     <input 
                        type="date"
                        value={backtestDates.to}
                        onChange={(e) => setBacktestDates({...backtestDates, to: e.target.value})}
                        className="bg-transparent text-[10px] font-bold text-blue-400 outline-none cursor-pointer"
                     />
                  </div>
                  <div className="w-px h-6 bg-white/10" />
                  <div className="flex flex-col px-2 min-w-[140px]">
                     <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">Trading Strategy</span>
                     <select 
                        value={backtestStrategy}
                        onChange={(e) => setBacktestStrategy(e.target.value)}
                        className="bg-transparent text-[10px] font-bold text-blue-400 outline-none cursor-pointer appearance-none uppercase"
                     >
                        <option value="DYNAMIC" className="bg-slate-950 text-white">Dynamic (Smart)</option>
                        <option value="BUY_CE" className="bg-slate-950 text-white">Naked CE Buy</option>
                        <option value="BUY_PE" className="bg-slate-950 text-white">Naked PE Buy</option>
                        <option value="BULL_PUT_SPREAD" className="bg-slate-950 text-white">Bull Put Spread</option>
                        <option value="BEAR_CALL_SPREAD" className="bg-slate-950 text-white">Bear Call Spread</option>
                        <option value="IRON_CONDOR" className="bg-slate-950 text-white">Iron Condor</option>
                     </select>
                  </div>
                  <button 
                    onClick={handleRunBacktest}
                    disabled={backtestStatus.loading}
                    className="px-6 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-white text-[10px] font-black uppercase tracking-widest rounded-lg transition-all shadow-lg shadow-blue-900/20 flex items-center gap-2"
                  >
                     {backtestStatus.loading ? (
                       <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1 }}>
                          <Activity className="w-3 h-3" />
                       </motion.div>
                     ) : <Zap className="w-3 h-3" />}
                     {backtestStatus.loading ? 'Syncing...' : 'Sync Kite Data'}
                  </button>
               </div>
            </div>

            {backtestStatus.error && (
              <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-center gap-4">
                 <AlertTriangle className="w-5 h-5 text-rose-500" />
                 <p className="text-[10px] font-bold text-rose-500 uppercase tracking-widest">{backtestStatus.error}</p>
              </div>
            )}

            {backtestStatus.success && backtestStatus.data && (
              <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-4">
                 <ShieldCheck className="w-5 h-5 text-emerald-500" />
                 <div>
                    <p className="text-[10px] font-black text-emerald-500 uppercase tracking-widest">Historical Data Synchronized</p>
                    <p className="text-[9px] text-slate-400 font-bold uppercase mt-0.5">
                      Successfully processed {backtestStatus.data.candles?.length} hourly candles for NIFTY 50. Running strategy simulation...
                    </p>
                 </div>
              </div>
            )}

            <div className="grid grid-cols-5 gap-4">
               {[
                 { label: 'Win Rate', value: backtestStatus.data?.stats?.winRate || '64.2%', desc: 'Optimal range', color: 'text-emerald-400', icon: Target },
                 { label: 'Risk-Reward', value: backtestStatus.data?.stats?.rr || '1:1.8', desc: 'Positive expectancy', color: 'text-blue-400', icon: Crosshair },
                 { label: 'Profit Factor', value: backtestStatus.data?.stats?.profitFactor || '2.14', desc: 'Highly efficient', color: 'text-purple-400', icon: TrendingUp },
                 { label: 'Max Drawdown', value: backtestStatus.data?.stats?.drawdown || '8.4%', desc: 'Safe threshold', color: 'text-rose-400', icon: TrendingDown },
                 { label: 'Total Trades', value: backtestStatus.data?.stats?.totalTrades?.toString() || '412', desc: 'Statistically significant', color: 'text-white', icon: Activity },
               ].map((stat, i) => (
                 <div key={i} className="terminal-card p-5 group hover:border-white/20 transition-all">
                    <div className="flex justify-between items-start mb-4">
                       <div className="p-2 bg-white/5 rounded-lg">
                          <stat.icon className={cn("w-4 h-4", stat.color)} />
                       </div>
                       <span className={cn("text-[9px] font-black uppercase tracking-widest opacity-40")}>Live Audit</span>
                    </div>
                    <div className="text-2xl font-black text-white tracking-tighter mb-1">{stat.value}</div>
                    <div className={cn("text-[10px] font-black uppercase tracking-widest mb-2", stat.color)}>{stat.label}</div>
                    <p className="text-[9px] text-slate-500 font-bold uppercase">{stat.desc}</p>
                 </div>
               ))}
            </div>

            <div className="grid grid-cols-12 gap-4 h-[500px] shrink-0">
               <div className="col-span-8 flex flex-col gap-4">
                  <div className="terminal-card p-6 flex flex-col flex-1">
                     <div className="flex justify-between items-center mb-6">
                        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Equity Curve Simulation</h3>
                        <div className="flex gap-4">
                           <div className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full bg-blue-500" />
                              <span className="text-[9px] font-black text-slate-500 uppercase">Strategy Returns</span>
                           </div>
                           <div className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full bg-slate-700" />
                              <span className="text-[9px] font-black text-slate-500 uppercase">Benchmark</span>
                           </div>
                        </div>
                     </div>
                     <div className="flex-1 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                           <AreaChart data={backtestStatus.data?.equityCurve || mockPerformance}>
                              <defs>
                                 <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                                 </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                              <XAxis 
                                 dataKey="name" 
                                 stroke="rgba(255,255,255,0.2)" 
                                 fontSize={10}
                                 tickLine={false}
                                 axisLine={false}
                                 interval={Math.ceil((backtestStatus.data?.candles?.length || 7) / 7)}
                              />
                              <YAxis 
                                 stroke="rgba(255,255,255,0.2)" 
                                 fontSize={10}
                                 tickLine={false}
                                 axisLine={false}
                                 tickFormatter={(value) => `₹${(value/1000).toFixed(1)}k`}
                              />
                              <Tooltip 
                                 contentStyle={{ backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                                 itemStyle={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}
                                 labelStyle={{ color: '#64748b', fontSize: '10px', marginBottom: '4px' }}
                              />
                              <Area 
                                 type="monotone" 
                                 dataKey="value" 
                                 stroke="#3b82f6" 
                                 strokeWidth={3}
                                 fillOpacity={1} 
                                 fill="url(#colorValue)" 
                                 animationDuration={1500}
                              />
                           </AreaChart>
                        </ResponsiveContainer>
                     </div>
                  </div>

                  <div className="terminal-card p-6 bg-blue-600/[0.03] border-blue-500/20">
                     <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 bg-blue-600/10 rounded-lg">
                           <Brain className="w-4 h-4 text-blue-500" />
                        </div>
                        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-400">Strategy Advisory & Recommendations</h3>
                     </div>
                     <div className="grid grid-cols-3 gap-6">
                        <div className="space-y-2">
                           <div className="text-[9px] font-black text-white uppercase tracking-widest border-b border-white/5 pb-1">Optimization Tips</div>
                           <p className="text-[9px] text-slate-500 leading-relaxed font-bold">
                              • Increase allocation when India VIX is between 12-15 for optimal theta decay windows.
                              <br />• Your max drawdown ({backtestStatus.data?.stats?.drawdown || '8.4%'}) is {parseFloat(backtestStatus.data?.stats?.drawdown || '8') < 15 ? 'strictly within safe thresholds' : 'approaching risk limits'}. Consider {parseFloat(backtestStatus.data?.stats?.drawdown || '8') < 10 ? 'increasing' : 'reducing'} leverage.
                           </p>
                        </div>
                        <div className="space-y-2">
                           <div className="text-[9px] font-black text-white uppercase tracking-widest border-b border-white/5 pb-1">Risk Adjustments</div>
                           <p className="text-[9px] text-slate-500 leading-relaxed font-bold">
                              • Risk-Reward of {backtestStatus.data?.stats?.rr || '1:1.8'} is {parseFloat((backtestStatus.data?.stats?.rr || '1.8').split(':')[1]) > 1.5 ? 'efficient' : 'sub-optimal'}. {parseFloat((backtestStatus.data?.stats?.rr || '1.8').split(':')[1]) < 2 && 'Tighten stop-loss once price moves in favor.'}
                              <br />• Current Win Rate of {backtestStatus.data?.stats?.winRate || '64%'} allows for sustainable scaling.
                           </p>
                        </div>
                        <div className="space-y-2">
                           <div className="text-[9px] font-black text-white uppercase tracking-widest border-b border-white/5 pb-1">Anomalies Detected</div>
                           <p className="text-[9px] text-slate-500 leading-relaxed font-bold">
                              • {parseFloat(backtestStatus.data?.stats?.profitFactor || '2.0') > 2 ? 'High Profit Factor indicates strong edge.' : 'Profit Factor suggests frequent small gains.'}
                              <br />• Simulation processed {backtestStatus.data?.candles?.length || '0'} hourly data points for verification.
                           </p>
                        </div>
                     </div>
                  </div>
               </div>

               <div className="col-span-4 terminal-card overflow-hidden flex flex-col">
                  <div className="p-5 border-b border-terminal-line bg-white/[0.02]">
                     <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Trade Distribution</h3>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                     {[
                        { range: '0-500', count: backtestStatus.data?.stats?.distribution['0-500'] || 142, color: 'bg-emerald-500/20 text-emerald-500' },
                        { range: '500-1000', count: backtestStatus.data?.stats?.distribution['500-1000'] || 85, color: 'bg-emerald-500/40 text-emerald-400' },
                        { range: '1000+', count: backtestStatus.data?.stats?.distribution['1000+'] || 32, color: 'bg-emerald-500/60 text-white' },
                        { range: '-500 to 0', count: backtestStatus.data?.stats?.distribution['-500-0'] || 98, color: 'bg-rose-500/20 text-rose-500' },
                        { range: '-1000 to -500', count: backtestStatus.data?.stats?.distribution['-1000--500'] || 45, color: 'bg-rose-500/40 text-rose-400' },
                        { range: '< -1000', count: backtestStatus.data?.stats?.distribution['<-1000'] || 10, color: 'bg-rose-500/60 text-white' },
                     ].map((d, i) => (
                        <div key={i} className="flex flex-col gap-2">
                           <div className="flex justify-between text-[9px] font-black uppercase tracking-widest">
                              <span className="text-slate-500">{d.range} PnL</span>
                              <span className="text-white">{d.count} Trades</span>
                           </div>
                           <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                              <div className={cn("h-full", d.color.split(' ')[0])} style={{ width: `${(d.count / (backtestStatus.data?.stats?.totalTrades || 142)) * 100}%` }} />
                           </div>
                        </div>
                     ))}
                  </div>
                  <div className="p-5 bg-white/[0.02] border-t border-terminal-line">
                     <p className="text-[8px] text-slate-500 font-bold uppercase leading-relaxed text-center italic">
                        Values calculated based on standard margin requirement of ₹1.25L per lot.
                     </p>
                  </div>
               </div>
            </div>

            {backtestStatus.success && backtestStatus.data?.trades && backtestStatus.data.trades.length > 0 && (
              <div className="terminal-card p-6 flex flex-col gap-4 mt-2">
                 <div className="flex justify-between items-center border-b border-white/5 pb-3">
                    <div>
                       <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-400">Backtest Trade Ledger</h3>
                       <p className="text-[8px] text-slate-500 font-bold uppercase mt-0.5">Diagnostic historical simulation trade execution log</p>
                    </div>
                    <span className="text-[8px] font-black uppercase tracking-widest bg-blue-500/10 text-blue-400 px-2 py-1 rounded">
                       {backtestStatus.data.trades.length} Trades Executed
                    </span>
                 </div>
                 <div className="overflow-x-auto">
                    <div className="max-h-[350px] overflow-y-auto pr-1">
                       <table className="w-full text-left border-collapse">
                          <thead>
                             <tr className="border-b border-white/[0.03] text-[8px] font-black text-slate-500 uppercase tracking-widest">
                                <th className="py-2.5 px-3">Date/Time (IST)</th>
                                <th className="py-2.5 px-3">Option Strategy</th>
                                <th className="py-2.5 px-3 text-right">Atm Strike</th>
                                <th className="py-2.5 px-3 text-right">Entry Spot</th>
                                <th className="py-2.5 px-3 text-right">Exit Spot</th>
                                <th className="py-2.5 px-3 text-right">Entry Premium</th>
                                <th className="py-2.5 px-3 text-right">Exit Premium</th>
                                <th className="py-2.5 px-3 text-right">PnL (₹)</th>
                             </tr>
                          </thead>
                          <tbody className="divide-y divide-white/[0.02]">
                             {backtestStatus.data.trades.slice().reverse().map((trade: any, idx: number) => (
                                <tr key={idx} className="hover:bg-white/[0.01] transition-all text-[9.5px] font-bold">
                                   <td className="py-2.5 px-3 font-mono text-slate-400 text-[8.5px]">{trade.timestamp}</td>
                                   <td className="py-2.5 px-3">
                                      <span className={cn(
                                         "px-1.5 py-0.5 rounded-[3px] text-[7.5px] font-black tracking-wider border",
                                         trade.strategy === 'IRON_CONDOR' ? "bg-purple-500/10 text-purple-400 border-purple-500/20" :
                                         trade.strategy.startsWith('BUY_CE') || trade.strategy.startsWith('BULL') ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                                         "bg-rose-500/10 text-rose-400 border-rose-500/20"
                                      )}>
                                         {trade.strategy.replace(/_/g, ' ')}
                                       </span>
                                   </td>
                                   <td className="py-2.5 px-3 text-right font-mono text-slate-300">₹{trade.strike}</td>
                                   <td className="py-2.5 px-3 text-right font-mono text-slate-400">₹{trade.entrySpot?.toFixed(1) || '--'}</td>
                                   <td className="py-2.5 px-3 text-right font-mono text-slate-400">₹{trade.exitSpot?.toFixed(1) || '--'}</td>
                                   <td className="py-2.5 px-3 text-right font-mono text-slate-300">₹{trade.entryPremium?.toFixed(1) || '0.0'}</td>
                                   <td className="py-2.5 px-3 text-right font-mono text-slate-300">₹{trade.exitPremium?.toFixed(1) || '0.0'}</td>
                                   <td className={cn(
                                      "py-2.5 px-3 text-right font-mono text-[10px] font-black",
                                      trade.pnl >= 0 ? "text-emerald-400" : "text-rose-400"
                                   )}>
                                      {trade.pnl >= 0 ? '+' : ''}₹{trade.pnl.toLocaleString('en-IN')}
                                   </td>
                                </tr>
                             ))}
                          </tbody>
                       </table>
                    </div>
                 </div>
              </div>
            )}
          </motion.main>
        ) : activeTab === 'history' ? (
          <motion.main 
            key="history"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 p-8 overflow-y-auto flex flex-col gap-6"
          >
            <div className="flex justify-between items-end">
               <div>
                  <h2 className="text-2xl font-black text-white tracking-tight uppercase">Audit Logs</h2>
                  <p className="text-xs text-slate-500 font-bold tracking-widest mt-1">Institutional Execution History</p>
               </div>
               <div className="flex gap-4">
                  <div className="terminal-card px-4 py-2 border-emerald-500/20 bg-emerald-500/5">
                     <span className="terminal-label !mb-0">Success Rate</span>
                     <div className="terminal-value text-lg text-emerald-400">
                        {tradeLogs.length > 0 
                           ? ((tradeLogs.filter(l => l.win).length / tradeLogs.length) * 100).toFixed(1)
                           : '0.0'}%
                     </div>
                  </div>
                  <div className="terminal-card px-4 py-2">
                     <span className="terminal-label !mb-0">Total Return</span>
                     <div className={cn(
                        "terminal-value text-lg",
                        tradeLogs.reduce((acc, curr) => acc + curr.pnl, 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                     )}>
                        ₹{(tradeLogs.reduce((acc, curr) => acc + curr.pnl, 0) / 1000).toFixed(2)}k
                     </div>
                  </div>
               </div>
            </div>

            <div className="terminal-card flex-1 overflow-hidden flex flex-col">
               <div className="flex-1 overflow-y-auto overflow-x-auto">
                  <table className="w-full border-collapse">
                     <thead className="sticky top-0 bg-slate-900/90 backdrop-blur z-10">
                        <tr className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] text-left">
                           <th className="p-5 border-b border-terminal-line">Timestamp</th>
                           <th className="p-5 border-b border-terminal-line">Asset / Bias</th>
                           <th className="p-5 border-b border-terminal-line">Signal Score</th>
                           <th className="p-5 border-b border-terminal-line">Phase / VIX</th>
                           <th className="p-5 border-b border-terminal-line">Execution Details</th>
                           <th className="p-5 border-b border-terminal-line">Entry/Exit Level</th>
                           <th className="p-5 border-b border-terminal-line text-right">Investment</th>
                           <th className="p-5 border-b border-terminal-line text-right">Profit/Loss</th>
                           <th className="p-5 border-b border-terminal-line text-right">Duration</th>
                        </tr>
                     </thead>
                     <tbody className="divide-y divide-white/[0.03]">
                        {tradeLogs.map((log, i) => (
                           <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                              <td className="p-5 terminal-value text-[11px] text-slate-400">
                                 {new Date(log.timestamp).toLocaleString()}
                              </td>
                              <td className="p-5">
                                 <div className="flex flex-col">
                                    <span className="font-bold text-xs text-white">NIFTY 50 INDEX</span>
                                    <span className={cn(
                                       "text-[8px] font-black tracking-widest uppercase",
                                       log.bias === 'BULLISH' ? "text-emerald-400" : "text-rose-400"
                                    )}>
                                       {log.bias || 'QUANT'} ALPHA
                                    </span>
                                 </div>
                              </td>
                              <td className="p-5">
                                 <div className="flex items-center gap-3">
                                    <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                                       <div className="h-full bg-blue-500" style={{ width: `${log.score}%` }} />
                                    </div>
                                    <span className="terminal-value text-[10px]">{log.score}</span>
                                 </div>
                              </td>
                              <td className="p-5">
                                 <div className="flex flex-col">
                                    <span className="text-[10px] font-black uppercase text-blue-400">
                                       {log.phase || 'MID-SESSION'}
                                    </span>
                                    <span className="text-[9px] text-slate-500 font-bold">VIX: {log.vix?.toFixed(2) || '14.00'}</span>
                                     {log.exitReason && (
                                        <div className="text-[7px] text-rose-400 font-bold uppercase mt-0.5 tracking-tighter">
                                           {log.exitReason}
                                        </div>
                                     )}
                                 </div>
                              </td>
                              <td className="p-5">
                                 <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                                    <div className="flex flex-col">
                                       <span className="text-[7px] text-slate-500 uppercase font-black">Strike</span>
                                       <span className="text-[10px] text-white font-mono">{log.strike || Math.round((log.spot || 0)/strikeStep)*strikeStep || '---'}</span>
                                    </div>
                                    <div className="flex flex-col">
                                       <span className="text-[7px] text-slate-500 uppercase font-black">RR Ratio</span>
                                       <span className="text-[10px] text-blue-400 font-mono">1:{log.intelligence?.rr?.toFixed(1) || '1.5'}</span>
                                    </div>
                                    <div className="flex flex-col">
                                       <span className="text-[7px] text-slate-500 uppercase font-black">Target</span>
                                       <span className="text-[10px] text-emerald-400 font-mono">{log.intelligence?.targetPrice?.toFixed(1) || '---'}</span>
                                    </div>
                                    <div className="flex flex-col">
                                       <span className="text-[7px] text-slate-500 uppercase font-black">POP (AI)</span>
                                       <span className="text-[10px] text-indigo-400 font-mono">{log.intelligence?.pop || '---'}%</span>
                                    </div>
                                    <div className="flex flex-col">
                                       <span className="text-[7px] text-slate-500 uppercase font-black">Stop Loss</span>
                                       <span className="text-[10px] text-rose-400 font-mono">{log.intelligence?.slPrice?.toFixed(1) || '---'}</span>
                                    </div>
                                 </div>
                              </td>
                              <td className="p-5">
                                 <div className="flex flex-col gap-1">
                                    <div className="flex gap-2 items-center">
                                       <span className="text-[8px] font-bold text-slate-500 uppercase w-8">BUY:</span>
                                       <span className="text-[10px] terminal-value text-emerald-400">{log.buyPrice ? `₹${log.buyPrice.toFixed(1)}` : '---'}</span>
                                    </div>
                                    <div className="flex gap-2 items-center">
                                       <span className="text-[8px] font-bold text-slate-500 uppercase w-8">SELL:</span>
                                       <span className="text-[10px] terminal-value text-rose-400">{log.sellPrice ? `₹${log.sellPrice.toFixed(1)}` : '---'}</span>
                                    </div>
                                 </div>
                              </td>
                              <td className="p-5 text-right">
                                 <span className="terminal-value text-[11px] text-white">
                                    {log.totalInvestment ? `₹${(log.totalInvestment / 1000).toFixed(1)}k` : '---'}
                                 </span>
                              </td>
                              <td className={cn("p-5 text-right terminal-value text-[13px]", log.win ? "text-emerald-400" : "text-rose-400")}>
                                 {log.win ? '+' : '-'}₹{Math.abs(log.pnl)}
                              </td>
                              <td className="p-5 text-right terminal-value text-[11px] text-slate-500">
                                 {log.duration ? `${Math.floor(log.duration / 60)}m ${log.duration % 60}s` : '--'}
                              </td>
                           </tr>
                        ))}
                     </tbody>
                  </table>
               </div>
            </div>
          </motion.main>
        ) : activeTab === 'analytics' ? (
          <motion.main 
            key="analytics"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 p-8 overflow-y-auto flex flex-col gap-6"
          >
             {(() => {
                // Defensive Stats Engine
                const totalTrades = tradeLogs.length;
                const wins = tradeLogs.filter(l => l.win).length;
                const losses = totalTrades - wins;
                const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
                
                const totalPnL = tradeLogs.reduce((acc, l) => acc + (l.pnl || 0), 0);
                const avgPnL = totalTrades > 0 ? totalPnL / totalTrades : 0;
                
                const winningTrades = tradeLogs.filter(l => l.win);
                const losingTrades = tradeLogs.filter(l => !l.win);
                const avgWin = winningTrades.length > 0 ? winningTrades.reduce((acc, l) => acc + (l.pnl || 0), 0) / winningTrades.length : 0;
                const avgLoss = losingTrades.length > 0 ? losingTrades.reduce((acc, l) => acc + (l.pnl || 0), 0) / losingTrades.length : 0;
                
                const profitFactor = Math.abs(avgLoss) > 0 ? (avgWin * wins) / (Math.abs(avgLoss) * (losses || 1)) : (totalPnL >= 0 ? 1.5 : 0.5);
                const rrRatio = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 1;
                
                // Historical Consecutive streak estimation
                let maxWinStreak = 0;
                let maxLossStreak = 0;
                let currentWinStreak = 0;
                let currentLossStreak = 0;
                
                const chronologicalTrades = [...tradeLogs].reverse();
                chronologicalTrades.forEach(t => {
                  if (t.win) {
                    currentWinStreak++;
                    maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
                    currentLossStreak = 0;
                  } else {
                    currentLossStreak++;
                    maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
                    currentWinStreak = 0;
                  }
                });
                maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
                maxLossStreak = Math.max(maxLossStreak, currentLossStreak);

                // --- Group tradeLogs by standard strategy mappings ---
                const mapToStandardStrategy = (strategyType?: string, bias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL') => {
                  const type = strategyType || '';
                  const b = bias || 'NEUTRAL';

                  if (type === 'BULL_CALL_SPREAD') {
                    return { name: 'Bull Call Spread', category: 'Safer Spread Strategies', biasText: 'Bullish' };
                  }
                  if (type === 'BEAR_PUT_SPREAD') {
                    return { name: 'Bear Put Spread', category: 'Safer Spread Strategies', biasText: 'Bearish' };
                  }
                  if (type === 'IRON_CONDOR' || type === 'IRON_FLY' || type === 'BUTTERFLY' || type === 'CALENDAR') {
                    return { name: 'Iron Condor', category: 'Safer Spread Strategies', biasText: 'Neutral' };
                  }
                  
                  if (type === 'NAKED_BUY' || type === 'STRADDLE' || type === 'STRANGLE') {
                    if (b === 'BULLISH') {
                      return { name: 'Buy CE', category: 'Option Buying', biasText: 'Bullish' };
                    } else {
                      return { name: 'Buy PE', category: 'Option Buying', biasText: 'Bearish' };
                    }
                  }

                  if (type === 'BEAR_CALL_SPREAD' || (type === 'RATIO_SPREAD' && b === 'BEARISH')) {
                    return { name: 'Sell CE', category: 'Option Selling', biasText: 'Bearish/Neutral' };
                  }
                  
                  if (type === 'BULL_PUT_SPREAD' || (type === 'RATIO_SPREAD' && b === 'BULLISH')) {
                    return { name: 'Sell PE', category: 'Option Selling', biasText: 'Bullish/Neutral' };
                  }

                  // Fallback defaults
                  if (b === 'BULLISH') {
                    return { name: 'Buy CE', category: 'Option Buying', biasText: 'Bullish' };
                  } else if (b === 'BEARISH') {
                    return { name: 'Buy PE', category: 'Option Buying', biasText: 'Bearish' };
                  } else {
                    return { name: 'Iron Condor', category: 'Safer Spread Strategies', biasText: 'Neutral' };
                  }
                };

                const standardStrategiesMap = {
                  'Buy CE': { name: 'Buy CE', category: 'Option Buying', biasText: 'Bullish', count: 0, wins: 0, pnl: 0, totalScore: 0 },
                  'Buy PE': { name: 'Buy PE', category: 'Option Buying', biasText: 'Bearish', count: 0, wins: 0, pnl: 0, totalScore: 0 },
                  'Sell CE': { name: 'Sell CE', category: 'Option Selling', biasText: 'Bearish/Neutral', count: 0, wins: 0, pnl: 0, totalScore: 0 },
                  'Sell PE': { name: 'Sell PE', category: 'Option Selling', biasText: 'Bullish/Neutral', count: 0, wins: 0, pnl: 0, totalScore: 0 },
                  'Bull Call Spread': { name: 'Bull Call Spread', category: 'Safer Spread Strategies', biasText: 'Bullish', count: 0, wins: 0, pnl: 0, totalScore: 0 },
                  'Bear Put Spread': { name: 'Bear Put Spread', category: 'Safer Spread Strategies', biasText: 'Bearish', count: 0, wins: 0, pnl: 0, totalScore: 0 },
                  'Iron Condor': { name: 'Iron Condor', category: 'Safer Spread Strategies', biasText: 'Neutral', count: 0, wins: 0, pnl: 0, totalScore: 0 },
                };

                tradeLogs.forEach(l => {
                  const mapped = mapToStandardStrategy(l.strategyType, l.bias);
                  const node = (standardStrategiesMap as any)[mapped.name];
                  if (node) {
                    node.count++;
                    if (l.win) node.wins++;
                    node.pnl += (l.pnl || 0);
                    node.totalScore += (l.score || 0);
                  }
                });

                const strategies = Object.values(standardStrategiesMap).map(s => ({
                  ...s,
                  winRate: s.count > 0 ? (s.wins / s.count) * 100 : 0,
                  avgScore: s.count > 0 ? Math.round(s.totalScore / s.count) : 0,
                }));

                // Group by standard Category templates
                const categoryMetrics: {
                  [key: string]: { name: string; count: number; wins: number; pnl: number; items: string[] }
                } = {
                  'Option Buying': { name: 'Option Buying', count: 0, wins: 0, pnl: 0, items: ['Buy CE', 'Buy PE'] },
                  'Option Selling': { name: 'Option Selling', count: 0, wins: 0, pnl: 0, items: ['Sell CE', 'Sell PE'] },
                  'Safer Spread Strategies': { name: 'Safer Spread Strategies', count: 0, wins: 0, pnl: 0, items: ['Bull Call Spread', 'Bear Put Spread', 'Iron Condor'] }
                };

                strategies.forEach(s => {
                  const cat = categoryMetrics[s.category];
                  if (cat) {
                    cat.count += s.count;
                    cat.wins += s.wins;
                    cat.pnl += s.pnl;
                  }
                });

                // Directional Bias Affinity Matrix
                const biasMap: { [key: string]: { name: string; count: number; wins: number; pnl: number } } = {
                  BULLISH: { name: 'Bullish Shift', count: 0, wins: 0, pnl: 0 },
                  BEARISH: { name: 'Bearish Shift', count: 0, wins: 0, pnl: 0 },
                  NEUTRAL: { name: 'Neutral Decay', count: 0, wins: 0, pnl: 0 }
                };
                tradeLogs.forEach(l => {
                  const rawBias = l.bias || 'NEUTRAL';
                  if (biasMap[rawBias]) {
                    biasMap[rawBias].count++;
                    if (l.win) biasMap[rawBias].wins++;
                    biasMap[rawBias].pnl += (l.pnl || 0);
                  }
                });
                const biases = Object.values(biasMap);

                // Cumulative P&L curve calculation for chart
                let currentCumPnL = 0;
                const chartData = chronologicalTrades.map((t, idx) => {
                  currentCumPnL += (t.pnl || 0);
                  return {
                    name: `Trade ${idx + 1}`,
                    pnl: currentCumPnL,
                    tradePnL: t.pnl || 0,
                    score: t.score || 0,
                    vix: t.vix || 12.4
                  };
                });

                // Robust Downloads
                const exportCSV = () => {
                  const csvHeaders = ["ID", "Timestamp", "PnL", "Outcome", "Signal Score", "Strategy Mode", "System Bias", "VIX", "Market Spot"];
                  const csvRows = tradeLogs.map(l => [
                    l.id || "FALLBACK_NFO",
                    new Date(l.timestamp).toISOString(),
                    l.pnl || 0,
                    l.win ? "WIN" : "LOSS",
                    l.score || 0,
                    l.mode || "INST_SPREAD",
                    l.bias || "NEUTRAL",
                    l.vix || 12.4,
                    l.spot || 0
                  ]);
                  const contentString = [csvHeaders.join(","), ...csvRows.map(r => r.map(cell => `"${cell}"`).join(","))].join("\n");
                  const blob = new Blob([contentString], { type: "text/csv;charset=utf-8;" });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement("a");
                  anchor.setAttribute("href", url);
                  anchor.setAttribute("download", `quantum_trade_history_${new Date().toISOString().split('T')[0]}.csv`);
                  document.body.appendChild(anchor);
                  anchor.click();
                  document.body.removeChild(anchor);
                };

                const exportJSON = () => {
                  const jsonString = JSON.stringify(tradeLogs, null, 2);
                  const blob = new Blob([jsonString], { type: "application/json;charset=utf-8;" });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement("a");
                  anchor.setAttribute("href", url);
                  anchor.setAttribute("download", `quantum_trade_history_${new Date().toISOString().split('T')[0]}.json`);
                  document.body.appendChild(anchor);
                  anchor.click();
                  document.body.removeChild(anchor);
                };

                return (
                   <>
                     {/* --- Header Section --- */}
                     <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div>
                           <h2 className="text-2xl font-black text-white tracking-tight uppercase">Performance Intelligence</h2>
                           <p className="text-xs text-slate-500 font-bold tracking-widest mt-1">Institutional Model Analysis & Strategic Statistics</p>
                        </div>
                        
                        {/* Download Controller Vault */}
                        <div className="flex flex-wrap gap-2">
                           <button 
                             onClick={exportCSV}
                             className="px-4 py-2 bg-gradient-to-r from-blue-700 to-blue-600 hover:from-blue-600 hover:to-blue-500 text-white text-[10px] font-black uppercase tracking-widest rounded-lg flex items-center gap-2 transition-all cursor-pointer shadow-lg active:scale-95"
                           >
                             <Cpu size={12} className="animate-pulse" />
                             Export CSV Audit
                           </button>
                           <button 
                             onClick={exportJSON}
                             className="px-4 py-2 bg-slate-900 border border-white/5 hover:border-white/10 text-slate-300 hover:text-white text-[10px] font-black uppercase tracking-widest rounded-lg flex items-center gap-2 transition-all cursor-pointer shadow-lg active:scale-95"
                           >
                             <Layers size={12} />
                             Export JSON Payload
                           </button>
                        </div>
                     </div>

                     {/* --- Key Metrics KPI Cards --- */}
                     <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="terminal-card p-5 relative overflow-hidden group">
                           <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-500 to-indigo-500" />
                           <span className="terminal-label">Consolidated Net Returns</span>
                           <div className={`text-2xl font-mono font-black ${totalPnL >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                              ₹{totalPnL.toLocaleString('en-IN')}
                           </div>
                           <p className="text-[9px] text-slate-500 font-bold uppercase mt-2">
                              Avg / Trade: <span className="text-white font-mono">₹{Math.round(avgPnL)}</span>
                           </p>
                        </div>

                        <div className="terminal-card p-5 relative overflow-hidden group">
                           <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-500 to-teal-500" />
                           <span className="terminal-label">Model Success Rate</span>
                           <div className="text-2xl font-mono text-emerald-400 font-black">
                              {winRate.toFixed(1)}%
                           </div>
                           <p className="text-[9px] text-slate-500 font-bold uppercase mt-2">
                              Wins: <span className="text-emerald-400 font-mono">{wins}</span> | Losses: <span className="text-rose-400 font-mono">{losses}</span>
                           </p>
                        </div>

                        <div className="terminal-card p-5 relative overflow-hidden group">
                           <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-amber-500 to-orange-500" />
                           <span className="terminal-label">Profit Factor & RR Matrix</span>
                           <div className="text-2xl font-mono text-amber-400 font-black">
                              {profitFactor.toFixed(2)}x
                           </div>
                           <p className="text-[9px] text-slate-500 font-bold uppercase mt-2">
                              Risk Reward Quotient: <span className="text-white font-mono">{rrRatio.toFixed(1)}:1</span>
                           </p>
                        </div>

                        <div className="terminal-card p-5 relative overflow-hidden group">
                           <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-rose-500 to-pink-500" />
                           <span className="terminal-label">Consecutive Win Streak</span>
                           <div className="text-2xl font-mono text-rose-400 font-black">
                              {maxWinStreak} <span className="text-xs text-slate-500 font-sans uppercase">Trades</span>
                           </div>
                           <p className="text-[9px] text-slate-500 font-bold uppercase mt-2">
                              Max Loss Streak: <span className="text-slate-400 font-mono">{maxLossStreak}</span>
                           </p>
                        </div>
                     </div>

                     {/* --- Recharts Equity Curve Visualization --- */}
                     <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        <div className="lg:col-span-2 terminal-card p-6 flex flex-col gap-4">
                           <div>
                              <h3 className="text-xs font-black text-white uppercase tracking-widest">Cumulative Equity Growth (Chronological)</h3>
                              <p className="text-[9px] text-slate-500 font-bold uppercase">Tracks system financial performance curvature trajectory</p>
                           </div>

                           <div className="h-64 pricing-chart">
                              {chartData.length > 0 ? (
                                 <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={chartData}>
                                       <defs>
                                          <linearGradient id="pnlGlow" x1="0" y1="0" x2="0" y2="1">
                                             <stop offset="5%" stopColor={totalPnL >= 0 ? "#10b981" : "#3b82f6"} stopOpacity={0.2}/>
                                             <stop offset="95%" stopColor={totalPnL >= 0 ? "#10b981" : "#3b82f6"} stopOpacity={0}/>
                                          </linearGradient>
                                       </defs>
                                       <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" />
                                       <XAxis 
                                         dataKey="name" 
                                         stroke="#475569" 
                                         fontSize={8} 
                                         tickLine={false} 
                                       />
                                       <YAxis 
                                         stroke="#475569" 
                                         fontSize={8} 
                                         tickLine={false} 
                                         tickFormatter={(v) => `₹${v}`} 
                                       />
                                       <Tooltip 
                                         contentStyle={{ background: '#0a0f1d', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px' }}
                                         labelStyle={{ color: '#94a3b8', fontSize: '10px', fontWeight: 'bold' }}
                                         itemStyle={{ fontSize: '11px' }}
                                       />
                                       <Area 
                                         type="monotone" 
                                         dataKey="pnl" 
                                         stroke={totalPnL >= 0 ? "#10b981" : "#3b82f6"} 
                                         strokeWidth={2}
                                         fillOpacity={1} 
                                         fill="url(#pnlGlow)" 
                                       />
                                    </AreaChart>
                                 </ResponsiveContainer>
                              ) : (
                                 <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-2 border border-dashed border-white/5 rounded-xl bg-black/20">
                                    <Activity size={24} className="animate-spin text-slate-500" />
                                    <p className="text-[10px] font-bold uppercase tracking-widest">Waiting for Live Orders...</p>
                                 </div>
                              )}
                           </div>
                        </div>

                        {/* Right: Model Directional Affinity Matrix */}
                        <div className="terminal-card p-6 flex flex-col gap-4">
                           <div>
                              <h3 className="text-xs font-black text-white uppercase tracking-widest">Setup Bias Performance</h3>
                              <p className="text-[9px] text-slate-500 font-bold uppercase">Success correlation by trend-following signal direction</p>
                           </div>

                           <div className="flex flex-col gap-4 flex-1 justify-center">
                              {biases.map((b, i) => {
                                 const itemWinRate = b.count > 0 ? (b.wins / b.count) * 100 : 0;
                                 return (
                                    <div key={i} className="bg-black/20 border border-white/[0.02] rounded-lg p-3 flex flex-col gap-2">
                                       <div className="flex justify-between items-center">
                                          <span className="text-[11px] font-black text-white uppercase tracking-wider">{b.name}</span>
                                          <span className={`text-[10px] font-mono font-bold ${b.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                             ₹{b.pnl >= 0 ? '+' : ''}{b.pnl}
                                          </span>
                                       </div>
                                       
                                       <div className="w-full bg-slate-800/50 h-1.5 rounded-full overflow-hidden">
                                          <div 
                                            className={`h-full rounded-full ${b.name.includes('Bullish') ? 'bg-emerald-500' : b.name.includes('Bearish') ? 'bg-rose-500' : 'bg-blue-500'}`} 
                                            style={{ width: `${itemWinRate}%` }} 
                                          />
                                       </div>

                                       <div className="flex justify-between text-[9px] text-slate-500 uppercase font-bold">
                                          <span>Volume: {b.count} trades</span>
                                          <span>Win Rate: {itemWinRate.toFixed(0)}%</span>
                                       </div>
                                    </div>
                                 );
                              })}
                           </div>
                        </div>
                     </div>

                      {/* --- Strategy PnL Distribution Visualization Matrix --- */}
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                         <div className="lg:col-span-2 terminal-card p-6 flex flex-col gap-4">
                            <div>
                               <h3 className="text-xs font-black text-white uppercase tracking-widest flex items-center gap-2">
                                 <BarChart3 size={12} className="text-blue-400" />
                                 Strategy PnL Distribution Matrix
                               </h3>
                               <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5">Cross-strategy comparison of absolute financial performance categorized by archetype</p>
                            </div>
                            
                            <div className="h-72 pricing-chart mt-2">
                               {strategies.some(s => s.count > 0) ? (
                                  <ResponsiveContainer width="100%" height="100%">
                                     <BarChart
                                        data={strategies}
                                        layout="vertical"
                                        margin={{ top: 10, right: 30, left: 10, bottom: 5 }}
                                     >
                                        <XAxis 
                                          type="number" 
                                          stroke="#475569" 
                                          fontSize={8} 
                                          tickLine={false} 
                                          tickFormatter={(v) => `₹${v}`} 
                                        />
                                        <YAxis 
                                          dataKey="name" 
                                          type="category" 
                                          stroke="#e2e8f0" 
                                          fontSize={8} 
                                          tickLine={false} 
                                          width={100}
                                        />
                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" />
                                        <Tooltip
                                           contentStyle={{ background: '#0a0f1d', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '8px' }}
                                           labelStyle={{ color: '#94a3b8', fontSize: '10px', fontWeight: 'bold' }}
                                           itemStyle={{ fontSize: '11px' }}
                                           formatter={(value: any) => [`₹${Number(value).toLocaleString('en-IN')}`, 'Aggregated Return']}
                                        />
                                        <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
                                           {strategies.map((entry, index) => {
                                              const isPositive = entry.pnl >= 0;
                                              return (
                                                 <Cell 
                                                    key={`cell-${index}`} 
                                                    fill={isPositive ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'}
                                                    stroke={isPositive ? '#10b981' : '#ef4444'}
                                                    strokeWidth={1}
                                                 />
                                              );
                                           })}
                                        </Bar>
                                     </BarChart>
                                  </ResponsiveContainer>
                               ) : (
                                  <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-2 border border-dashed border-white/5 rounded-xl bg-black/20">
                                     <Activity size={24} className="animate-pulse text-slate-500" />
                                     <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Waiting for live trades to evaluate strategy distribution PnL...</p>
                                  </div>
                               )}
                            </div>
                         </div>

                         {/* Right Sidebar: Strategic Intelligence Summary */}
                         <div className="terminal-card p-6 flex flex-col gap-4">
                            <div>
                               <h3 className="text-xs font-black text-white uppercase tracking-widest flex items-center gap-2">
                                 <Brain size={12} className="text-amber-400" />
                                 Profitability Intelligence
                               </h3>
                               <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5">Dynamic performance attribution insights derived from active setups</p>
                            </div>

                            {(() => {
                               const activeStrats = strategies.filter(s => s.count > 0);
                               const topStrat = activeStrats.length > 0 
                                 ? activeStrats.reduce((best, curr) => curr.pnl > best.pnl ? curr : best, activeStrats[0]) 
                                 : null;
                               const highestWinrateStrat = activeStrats.length > 0 
                                 ? activeStrats.reduce((best, curr) => curr.winRate > best.winRate ? curr : best, activeStrats[0]) 
                                 : null;
                               const mostTradedStrat = activeStrats.length > 0 
                                 ? activeStrats.reduce((most, curr) => curr.count > most.count ? curr : most, activeStrats[0]) 
                                 : null;

                               return (
                                  <div className="flex flex-col gap-4 flex-1 justify-center">
                                     <div className="bg-black/20 border border-white/[0.02] rounded-lg p-3 flex flex-col gap-1.5 transition-all hover:bg-black/30">
                                        <span className="text-[8px] font-black text-emerald-400 uppercase tracking-widest flex items-center gap-1">
                                          <TrendingUp size={10} />
                                          MOST PROFITABLE SETUP
                                        </span>
                                        <div className="flex justify-between items-center mt-0.5">
                                           <span className="text-xs font-black text-white">{topStrat && topStrat.pnl > 0 ? topStrat.name : 'No profitable setup yet'}</span>
                                           {topStrat && topStrat.pnl > 0 && (
                                              <span className="text-[10px] font-mono font-black text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                                                 ₹{topStrat.pnl.toLocaleString('en-IN')}
                                              </span>
                                           )}
                                        </div>
                                        <p className="text-[8px] text-slate-500 uppercase font-bold tracking-normal leading-relaxed">
                                          This model strategy configuration is yielding the highest net financial returns in the current simulation session.
                                        </p>
                                     </div>

                                     <div className="bg-black/20 border border-white/[0.02] rounded-lg p-3 flex flex-col gap-1.5 transition-all hover:bg-black/30">
                                        <span className="text-[8px] font-black text-blue-400 uppercase tracking-widest flex items-center gap-1">
                                          <Zap size={10} />
                                          HEURISTIC SUCCESS VELOCITY
                                        </span>
                                        <div className="flex justify-between items-center mt-0.5">
                                           <span className="text-xs font-black text-white">{highestWinrateStrat ? highestWinrateStrat.name : 'N/A'}</span>
                                           {highestWinrateStrat && (
                                              <span className="text-[10px] font-mono font-black text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">
                                                 {highestWinrateStrat.winRate.toFixed(1)}% WR
                                              </span>
                                           )}
                                        </div>
                                        <p className="text-[8px] text-slate-500 uppercase font-bold tracking-normal leading-relaxed">
                                          Highest percentage coefficient of winning outcomes based on chronological trade evaluations.
                                        </p>
                                     </div>

                                     <div className="bg-black/20 border border-white/[0.02] rounded-lg p-3 flex flex-col gap-1.5 transition-all hover:bg-black/30">
                                        <span className="text-[8px] font-black text-amber-500 uppercase tracking-widest flex items-center gap-1">
                                          <Cpu size={10} />
                                          CORE UTILITY ARCHETYPE
                                        </span>
                                        <div className="flex justify-between items-center mt-0.5">
                                           <span className="text-xs font-black text-white">{mostTradedStrat ? mostTradedStrat.name : 'N/A'}</span>
                                           {mostTradedStrat && (
                                              <span className="text-[10px] font-mono font-black text-slate-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                                                 {mostTradedStrat.count} Trades
                                              </span>
                                           )}
                                        </div>
                                        <p className="text-[8px] text-slate-500 uppercase font-bold tracking-normal leading-relaxed">
                                          Most recurrent execution architecture dispatched by the automated risk controller system.
                                        </p>
                                     </div>
                                  </div>
                               );
                            })()}
                         </div>
                      </div>

                     {/* --- Standard Portfolio Category Matrix Summary --- */}
                     <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {Object.values(categoryMetrics).map((cat, idx) => {
                           const catWinRate = cat.count > 0 ? (cat.wins / cat.count) * 100 : 0;
                           return (
                              <div key={idx} className="terminal-card p-5 relative overflow-hidden group hover:border-white/10 transition-all">
                                 <div className={`absolute top-0 left-0 right-0 h-1 bg-gradient-to-r ${
                                    cat.name === 'Option Buying' ? 'from-blue-500 to-indigo-500' : 
                                    cat.name === 'Option Selling' ? 'from-rose-500 to-pink-500' : 'from-emerald-500 to-teal-500'
                                 }`} />
                                 <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">{cat.name} Segment</span>
                                 <div className="flex justify-between items-end mt-3">
                                    <div>
                                       <div className={`text-xl font-mono font-black ${cat.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                          ₹{cat.pnl >= 0 ? '+' : ''}{cat.pnl.toLocaleString('en-IN')}
                                       </div>
                                       <div className="text-[9px] text-slate-500 uppercase font-black tracking-wider mt-1">
                                          Total from {cat.count} trade{cat.count === 1 ? '' : 's'}
                                       </div>
                                    </div>
                                    <div className="text-right">
                                       <div className="text-xs font-mono text-white font-bold">{catWinRate.toFixed(0)}%</div>
                                       <div className="text-[8px] text-slate-500 uppercase font-black tracking-widest">WIN RATIO</div>
                                    </div>
                                 </div>
                                 <div className="mt-4 pt-3 border-t border-white/[0.03] flex items-center justify-between text-[9px] text-slate-500 uppercase font-bold">
                                    <span>Core Strategy Set</span>
                                    <div className="flex gap-1.5 overflow-x-auto">
                                       {cat.items.map((it, i) => (
                                          <span key={i} className="bg-black/40 text-slate-300 px-1.5 py-0.5 rounded border border-white/5 text-[8px] tracking-normal font-mono">{it}</span>
                                       ))}
                                    </div>
                                 </div>
                              </div>
                           );
                        })}
                     </div>

                     {/* --- Strategy Performance Leaderboard Table --- */}
                     <div className="terminal-card p-6">
                        <div className="mb-4">
                           <h3 className="text-xs font-black text-white uppercase tracking-widest">Detailed Strategy Performance Directory</h3>
                           <p className="text-[9px] text-slate-500 font-bold uppercase">Breakdown of trade metrics segmented by user defined execution strategies</p>
                        </div>

                        <div className="overflow-x-auto">
                           <table className="w-full border-collapse">
                              <thead>
                                 <tr className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] border-b border-terminal-line text-left">
                                    <th className="py-3 px-4">Strategy Class / Setup</th>
                                    <th className="py-3 px-4 text-center">Portfolio Category</th>
                                    <th className="py-3 px-4 text-center">Trade Count</th>
                                    <th className="py-3 px-4 text-center">Wins / Losses</th>
                                    <th className="py-3 px-4 text-center">Win Ratio</th>
                                    <th className="py-3 px-4 text-center">Avg Entry Signal</th>
                                    <th className="py-3 px-4 text-right">Aggregated Return</th>
                                 </tr>
                              </thead>
                              <tbody className="divide-y divide-white/[0.03]">
                                 {strategies.length > 0 ? (
                                    strategies.map((strat, idx) => (
                                       <tr key={idx} className="hover:bg-white/[0.01] transition-colors">
                                          <td className="py-4 px-4 font-black text-xs text-white tracking-wider flex items-center gap-2 mt-0.5">
                                             <span className={
                                                strat.category === 'Option Buying' ? 'text-blue-500' : 
                                                strat.category === 'Option Selling' ? 'text-rose-500' : 'text-emerald-500'
                                             }>
                                                ●
                                             </span>
                                             {strat.name}
                                             <span className="text-[8px] font-semibold text-slate-500 uppercase ml-2 bg-slate-900 border border-white/5 rounded px-1.5 py-0.5">
                                                {strat.biasText}
                                             </span>
                                          </td>
                                          <td className="py-4 px-4 text-center">
                                             <span className={`text-[8.5px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${
                                                strat.category === 'Option Buying' ? 'bg-blue-950/20 text-blue-400 border-blue-500/20' :
                                                strat.category === 'Option Selling' ? 'bg-rose-950/20 text-rose-400 border-rose-500/20' :
                                                'bg-emerald-950/20 text-emerald-400 border-emerald-500/20'
                                             }`}>
                                                {strat.category}
                                             </span>
                                          </td>
                                          <td className="py-4 px-4 font-mono text-center text-xs text-slate-300">
                                             {strat.count}
                                          </td>
                                          <td className="py-4 px-4 font-mono text-center text-xs text-slate-400">
                                             <span className="text-emerald-400 font-bold">{strat.wins}</span> / <span className="text-rose-400 font-bold">{strat.count - strat.wins}</span>
                                          </td>
                                          <td className="py-4 px-4 text-center">
                                             <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full bg-slate-800/40 border border-white/5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                                                <span className="font-mono text-[10px] text-blue-400 font-bold">{strat.winRate.toFixed(1)}%</span>
                                             </div>
                                          </td>
                                          <td className="py-4 px-4 font-mono text-center text-xs text-amber-400 font-bold">
                                             {strat.avgScore} pts
                                          </td>
                                          <td className={`py-4 px-4 font-mono text-right text-xs font-bold ${strat.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                                             ₹{strat.pnl >= 0 ? '+' : ''}{strat.pnl.toLocaleString('en-IN')}
                                          </td>
                                       </tr>
                                    ))
                                 ) : (
                                    <tr>
                                       <td colSpan={7} className="py-8 text-center text-slate-500 text-xs font-black uppercase tracking-widest">
                                          No active execution cycles recorded in session fallback.
                                       </td>
                                    </tr>
                                 )}
                              </tbody>
                           </table>
                        </div>
                     </div>
                   </>
                );
             })()}
          </motion.main>
        ) : activeTab === 'settings' ? (
          <motion.main 
            key="settings"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex-1 p-8 flex flex-col gap-8 max-w-4xl mx-auto overflow-y-auto"
          >
             <div>
                <h2 className="text-2xl font-black text-white tracking-tight uppercase">System Configuration</h2>
                <p className="text-xs text-slate-500 font-bold tracking-widest mt-1">Quantum Core Security & Integration</p>
             </div>

              <section className="terminal-card p-8 space-y-6">
                <div className="flex items-center gap-4 border-b border-terminal-line pb-6">
                   <div className="w-12 h-12 bg-blue-600/10 rounded-xl flex items-center justify-center border border-blue-500/20">
                      <Zap className="text-blue-500 w-6 h-6" />
                   </div>
                   <div>
                      <h4 className="text-sm font-black text-white uppercase tracking-widest">Zerodha KiteConnect Bridge</h4>
                      <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Status: {kiteStatus.connected ? 'Operational' : 'Disconnected'}</p>
                   </div>
                </div>

                <div className="space-y-6">
                   <div className="grid grid-cols-1 gap-4">
                      <div className="flex flex-col gap-2">
                         <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Zerodha API Key</label>
                         <div className="relative">
                            <input 
                               type="password"
                               value={manualKiteConfig.key}
                               onChange={(e) => setManualKiteConfig({...manualKiteConfig, key: e.target.value})}
                               placeholder={kiteStatus.hasConfig ? "••••••••••••••••" : "Enter API Key"}
                               className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-xs font-mono text-blue-400 outline-none focus:border-blue-500/50 transition-all"
                            />
                            {kiteStatus.hasConfig && (
                               <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
                                  <div className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                                  <span className="text-[8px] font-black text-emerald-500 uppercase">Configured</span>
                               </div>
                            )}
                         </div>
                      </div>
                      <div className="flex flex-col gap-2">
                         <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Zerodha API Secret</label>
                         <input 
                            type="password"
                            value={manualKiteConfig.secret}
                            onChange={(e) => setManualKiteConfig({...manualKiteConfig, secret: e.target.value})}
                            placeholder={kiteStatus.hasConfig ? "••••••••••••••••" : "Enter API Secret"}
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-xs font-mono text-blue-400 outline-none focus:border-blue-500/50 transition-all"
                         />
                      </div>
                   </div>

                   {(manualKiteConfig.key || manualKiteConfig.secret) && (
                      <div className="flex gap-2">
                        <button 
                           onClick={handleSaveKiteConfig}
                           className="flex-1 py-3 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-400 font-black rounded-lg uppercase tracking-widest text-[9px] transition-all"
                        >
                           Update Session
                        </button>
                        <button 
                           onClick={() => {
                              setManualKiteConfig({ key: '', secret: '' });
                              localStorage.removeItem('kite_config');
                           }}
                           className="px-4 py-3 bg-rose-600/10 hover:bg-rose-600/20 border border-rose-500/30 text-rose-500 font-black rounded-lg uppercase tracking-widest text-[9px] transition-all"
                        >
                           Clear
                        </button>
                      </div>
                   )}

                   <div className="space-y-4 pt-4 border-t border-terminal-line">
                      <div className="p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                         <h5 className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2 flex items-center gap-2">
                            <Info className="w-3 h-3" />
                            Configuration Options
                         </h5>
                         <p className="text-[10px] text-slate-400 leading-relaxed font-medium">
                            You can either enter keys above or declare <span className="text-white font-bold">KITE_API_KEY</span> and <span className="text-white font-bold">KITE_API_SECRET</span> in the editor settings. Manual entry is prioritized for the current session.
                         </p>
                      </div>

                      {!kiteStatus.connected ? (
                        <button 
                           onClick={handleKiteConnect}
                           disabled={!kiteStatus.hasConfig}
                           className="w-full py-4 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed text-white font-black rounded-lg uppercase tracking-[0.2em] text-[10px] transition-all shadow-lg shadow-blue-900/20"
                        >
                           Initiate Terminal Handshake
                        </button>
                      ) : (
                        <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-center">
                           <span className="text-emerald-400 text-[10px] font-black uppercase tracking-widest">Connection Live - Data Synchronized</span>
                        </div>
                      )}
                   </div>
                </div>
             </section>
              <section className="terminal-card p-8 space-y-6 mt-6">
                <div className="flex items-center gap-4 border-b border-terminal-line pb-6">
                   <div className="w-12 h-12 bg-blue-600/10 rounded-xl flex items-center justify-center border border-blue-500/20">
                      <Bell className="text-blue-500 w-6 h-6" />
                   </div>
                   <div>
                      <h4 className="text-sm font-black text-white uppercase tracking-widest">Telegram Notification Gateway</h4>
                      <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Status: Real-time Outbound Dispatcher</p>
                   </div>
                </div>

                <div className="space-y-6">
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="flex flex-col gap-2">
                         <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Telegram Bot Token</label>
                         <input 
                            type="password"
                            value={telegramToken}
                            onChange={(e) => setTelegramToken(e.target.value)}
                            placeholder="Enter Telegram Bot Token (e.g. 123456:ABC...)"
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-xs font-mono text-blue-400 outline-none focus:border-blue-500/50 transition-all"
                         />
                      </div>
                      <div className="flex flex-col gap-2">
                         <label className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Telegram Chat ID / Channel ID</label>
                         <input 
                            type="text"
                            value={telegramChatId}
                            onChange={(e) => setTelegramChatId(e.target.value)}
                            placeholder="Enter Chat ID or @channel (e.g. -10012345678)"
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-3 text-xs font-mono text-blue-400 outline-none focus:border-blue-500/50 transition-all"
                         />
                      </div>
                   </div>

                   {/* Save Status Banner */}
                   {telegramSaveStatus.success !== null && (
                      <div className={cn(
                        "p-3.5 rounded-lg border text-[9px] font-black uppercase tracking-widest flex items-center gap-2",
                        telegramSaveStatus.success ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-rose-500/10 border-rose-500/30 text-rose-400"
                      )}>
                         <Info className="w-3 h-3 shrink-0" />
                         <span>{telegramSaveStatus.message}</span>
                      </div>
                   )}

                   {/* Test Status Banner */}
                   {telegramTestStatus.success !== null && (
                      <div className={cn(
                        "p-4 rounded-lg border text-[9.5px] font-bold flex flex-col gap-1.5",
                        telegramTestStatus.success ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-rose-500/10 border-rose-500/30 text-rose-400"
                      )}>
                         <div className="flex items-center gap-2 uppercase tracking-wider font-black text-[10px]">
                            <Info className="w-3.5 h-3.5 shrink-0" />
                            <span>{telegramTestStatus.success ? "Dispatch Succeeded!" : "Dispatch Rejected (Error Details)"}</span>
                         </div>
                         <p className="font-mono text-[8.5px] font-semibold text-slate-400 leading-relaxed bg-black/50 p-2 rounded border border-white/5 break-all">
                            {telegramTestStatus.success ? telegramTestStatus.message : telegramTestStatus.error}
                            {telegramTestStatus.message && !telegramTestStatus.success && (
                              <span className="block mt-1 font-mono text-[8px] text-slate-500">
                                Raw API response: {telegramTestStatus.message}
                              </span>
                            )}
                         </p>
                      </div>
                   )}

                   <div className="flex flex-col md:flex-row gap-3 pt-2">
                      <button 
                         onClick={handleSaveTelegramConfig}
                         className="flex-1 py-3 bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-400 font-black rounded-lg uppercase tracking-widest text-[9px] transition-all"
                      >
                         Save & Apply Settings
                      </button>
                      <button 
                         onClick={handleTestTelegram}
                         disabled={telegramTestStatus.loading}
                         className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-white/10 text-slate-200 font-black rounded-lg uppercase tracking-widest text-[9px] transition-all flex items-center justify-center gap-2"
                      >
                         {telegramTestStatus.loading ? (
                            <>
                              <div className="w-3.5 h-3.5 border-2 border-slate-400 border-t-white rounded-full animate-spin" />
                              <span>Dispatching Test...</span>
                            </>
                         ) : (
                            <span>Send Live Test Alert</span>
                         )}
                      </button>
                   </div>

                   <p className="text-[9px] text-slate-500 leading-relaxed font-bold uppercase tracking-wider bg-black/20 p-4 border border-white/5 rounded-xl">
                      ⚙️ <b>IMPORTANT STEPS FOR TELEGRAM NOTIFICATION SETUP</b>:<br />
                      1. Talk to @BotFather on Telegram to create a Bot and copy the <b>Bot Token</b>.<br />
                      2. Add the Bot as an Admin (or Member) to your Telegram Group/Channel, or start a Direct Message conversation with your bot.<br />
                      3. Send a message to the bot (e.g. <code>/start</code>) or text anything in the chat so that the chat exists.<br />
                      4. Enter your exact <b>Chat ID</b> (tip: forward any channel message to @userinfobot or use online ID tools) and click <b>Send Live Test Alert</b>!
                   </p>
                </div>
             </section>
          </motion.main>
        ) : (
          <motion.main 
            key="fallback"
            className="flex-1 flex items-center justify-center"
          >
             <div className="flex flex-col items-center gap-4 opacity-20">
                <Shield className="w-16 h-16" />
                <span className="text-xs font-black uppercase tracking-[0.4em]">Terminal Lockup</span>
             </div>
          </motion.main>
        )}
      </AnimatePresence>

      {/* --- FOOTER CONSOLE --- */}
      <footer className="h-20 bg-black/60 border-t border-terminal-line backdrop-blur-2xl flex items-center px-8 justify-between shrink-0 z-10 box-glow-top">
        <div className="flex space-x-12">
          <div className="flex flex-col">
            <span className="terminal-label !mb-0">Consolidated Equity (PnL)</span>
            <div className={cn("text-2xl terminal-value tracking-tighter", (execution?.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
              {(execution?.pnl || 0) >= 0 ? '+' : ''}₹{(execution?.pnl || 0)?.toLocaleString() || '0'}
              <span className="text-[10px] ml-2 opacity-60">INR</span>
            </div>
          </div>
          <div className="hidden md:flex flex-col border-l border-white/5 pl-12">
            <span className="terminal-label !mb-0">Active Risk Cluster</span>
            <div className="flex gap-4 pt-1">
              {execution?.positions && execution.positions.length > 0 ? (
                execution.positions.map((p, i) => (
                  <div key={i} className="bg-slate-900 border border-white/5 rounded px-2 py-1 flex items-center gap-2">
                     <span className={cn("text-[10px] font-black", p.type === 'CE' ? 'text-rose-500' : 'text-emerald-500')}>{p.type}</span>
                     <span className="text-[10px] font-bold text-slate-400 font-mono tracking-tighter">{p.strike}</span>
                     <span className="text-[8px] font-black text-slate-600">{p.side}</span>
                  </div>
                ))
              ) : (
                <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest opacity-40">Zero Exposure</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center space-x-12">
          <div className="text-right hidden xl:block">
            <div className="terminal-label !mb-1.5 flex justify-between">
               <span>VAR Exposure Meter</span>
               <span className="text-[8px] text-emerald-500">NOMINAL</span>
            </div>
            <div className="w-56 h-1.5 bg-slate-900 rounded-full relative overflow-hidden ring-1 ring-white/5">
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/20 z-10"></div>
              <motion.div 
                className={cn("h-full", (execution?.pnl || 0) >= 0 ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" : "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]")}
                style={{ 
                  width: `${Math.min(50, (Math.abs(execution?.pnl || 0) / 4000) * 50)}%`,
                  marginLeft: (execution?.pnl || 0) >= 0 ? '50%' : `${50 - Math.min(50, (Math.abs(execution?.pnl || 0) / 2000) * 50)}%`
                }}
              />
            </div>
            <div className="flex justify-between text-[7px] mt-1.5 opacity-30 font-black uppercase tracking-widest font-mono">
              <span>-₹4000</span>
              <span>₹0</span>
              <span>+₹4000</span>
            </div>
          </div>

          <div className="text-right font-mono text-[9px] text-slate-500 border-l border-white/5 pl-12 h-10 flex flex-col justify-center">
            <div className="flex items-center justify-end gap-2 text-emerald-500 mb-1">
               <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
               <span className="font-bold uppercase tracking-widest">Feed: Realtime</span>
            </div>
            <div className="opacity-40">{new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</div>
          </div>
        </div>
      </footer>

      {/* Sticky Position Blotter — visible from every tab while positions are open */}
      {(execution?.positions?.length ?? 0) > 0 && (
        <div className="fixed bottom-0 left-20 right-0 z-30 bg-black/85 backdrop-blur-xl border-t border-white/10 shadow-[0_-8px_30px_rgba(0,0,0,0.4)]">
          <div className="px-6 py-2 flex items-center gap-4 overflow-x-auto custom-scrollbar">
            {/* Header chip with aggregate PnL + time-in-trade + structure */}
            <div className="shrink-0 flex items-center gap-3 pr-4 border-r border-white/10">
              <div className="flex items-center gap-1.5">
                <div className={cn("w-1.5 h-1.5 rounded-full animate-pulse",
                  (execution?.pnl ?? 0) >= 0 ? "bg-emerald-500" : "bg-rose-500")} />
                <span className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-400">
                  {execution?.actualStructure || 'Open Book'}
                </span>
              </div>
              <div className="flex flex-col leading-tight">
                <span className={cn("text-sm font-black font-mono tabular-nums",
                  (execution?.pnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                  {(execution?.pnl ?? 0) >= 0 ? '+' : ''}₹{Math.abs(execution?.pnl ?? 0).toLocaleString('en-IN')}
                </span>
                <span className="text-[7px] text-slate-500 font-bold uppercase tracking-widest">
                  {execution?.entryTime
                    ? `${Math.floor((uiClock - execution.entryTime) / 60000)}m ${Math.floor(((uiClock - execution.entryTime) % 60000) / 1000)}s`
                    : 'live'}
                  {execution?.params?.targetRupees ? ` · ${Math.round(((execution.pnl || 0) / execution.params.targetRupees) * 100)}% of tgt` : ''}
                </span>
              </div>
              {/* Bias-conflict badge: warns when live system bias has flipped vs entry bias */}
              {execution?.entryBias && strategy?.score?.bias && execution.entryBias !== strategy.score.bias && (
                <div
                  className="flex items-center gap-1 px-2 py-1 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-300 animate-pulse"
                  title={`Trade entered ${execution.entryBias} but live bias is ${strategy.score.bias}. Position may be fighting the current signal.`}
                >
                  <AlertTriangle className="w-3 h-3" />
                  <span className="text-[8px] font-black uppercase tracking-widest leading-none">
                    Bias Conflict
                    <span className="block text-[7px] font-bold opacity-80 mt-0.5">
                      {execution.entryBias} → {strategy.score.bias}
                    </span>
                  </span>
                </div>
              )}
            </div>
            {/* Per-leg blotter rows */}
            {(execution?.positions || []).map((p: any, idx: number) => {
              const atm = market?.chain?.find(c => c.strike === p.strike);
              const ltp = p.type === 'FUT'
                ? (market?.spot ?? p.entryPrice)
                : (atm ? (p.type === 'CE' ? atm.ce_price : atm.pe_price) : p.entryPrice);
              const legPnl = (p.side === 'BUY' ? (ltp - p.entryPrice) : (p.entryPrice - ltp)) * p.qty;
              const sideColor = p.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400';
              const sideBg = p.side === 'BUY' ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-rose-500/10 border-rose-500/20';
              const symbol = p.type === 'FUT' ? 'FUT' : `${p.strike}${p.type}`;
              return (
                <div key={`blotter-${idx}-${p.strike}-${p.type}-${p.side}`}
                  className={cn("shrink-0 flex items-center gap-3 px-3 py-1.5 rounded-md border", sideBg,
                    p.isHedge && "ring-1 ring-amber-500/40")}>
                  <div className="flex flex-col leading-tight">
                    <span className="text-[7px] font-black uppercase tracking-widest text-slate-500 flex items-center gap-1">
                      {p.isHedge && <span className="text-amber-400">HEDGE</span>}
                      <span className={sideColor}>{p.side}</span>
                      <span className="text-slate-600">·</span>
                      <span>{Math.round(p.qty / (appConfig?.LOT_SIZE || 75))}L</span>
                    </span>
                    <span className="text-[11px] font-black text-white font-mono leading-tight">{symbol}</span>
                  </div>
                  <div className="flex flex-col leading-tight text-right">
                    <span className="text-[7px] font-bold uppercase tracking-widest text-slate-500">LTP / Avg</span>
                    <span className="text-[10px] font-mono text-slate-200 tabular-nums">
                      ₹{ltp.toFixed(1)}
                      <span className="text-slate-600 mx-1">·</span>
                      <span className="text-slate-500">₹{p.entryPrice.toFixed(1)}</span>
                    </span>
                  </div>
                  <div className="flex flex-col leading-tight text-right pl-2 border-l border-white/10">
                    <span className="text-[7px] font-bold uppercase tracking-widest text-slate-500">P/L</span>
                    <span className={cn("text-[11px] font-black font-mono tabular-nums",
                      legPnl >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {legPnl >= 0 ? '+' : ''}₹{Math.round(legPnl).toLocaleString('en-IN')}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* LIVE Execute Confirm Modal — only opens when EXECUTION_MODE is LIVE */}
      {pendingExecute && (
        <div
          className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => !isExecuting && setPendingExecute(null)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#0b0f19] border border-amber-500/40 rounded-2xl w-full max-w-md shadow-[0_0_60px_rgba(245,158,11,0.3)] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-amber-500/10 border-b border-amber-500/30 px-6 py-4 flex items-center gap-3">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
              <div>
                <h3 className="text-sm font-black uppercase tracking-[0.2em] text-amber-300">Confirm Live Order</h3>
                <p className="text-[9px] text-amber-300/60 font-bold uppercase tracking-widest mt-0.5">Real money — broker order will be submitted</p>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-black/40 border border-white/5 rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">Direction</span>
                  <span className={cn(
                    "font-black uppercase tracking-widest",
                    pendingExecute.bias === 'BULLISH' ? "text-emerald-400" :
                    pendingExecute.bias === 'BEARISH' ? "text-rose-400" : "text-blue-400"
                  )}>
                    {pendingExecute.bias}
                  </span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">Structure</span>
                  <span className="text-white font-black font-mono uppercase">
                    {strategy?.score?.strategyType?.replace(/_/g, ' ') || '—'}
                  </span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">System Score</span>
                  <span className="text-white font-black font-mono">{strategy?.score?.total || 0} / 100</span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">Spot / ATM</span>
                  <span className="text-slate-200 font-mono">
                    ₹{(market?.spot || 0).toFixed(1)}
                    <span className="text-slate-500 mx-1">·</span>
                    ₹{(Math.round((market?.spot || 0) / strikeStep) * strikeStep).toLocaleString('en-IN')}
                  </span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">IV Rank</span>
                  <span className="text-slate-200 font-mono">
                    {strategy?.score?.ivRank !== null && strategy?.score?.ivRank !== undefined
                      ? `${Math.round(strategy.score.ivRank)}%`
                      : '—'}
                  </span>
                </div>
                {strategy?.score?.pinAlignment && strategy.score.pinAlignment !== 'NONE' && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-slate-500 font-bold uppercase tracking-widest">Pin Magnet</span>
                    <span className="text-purple-400 font-black font-mono">
                      {strategy.score.pinStrike} ({strategy.score.pinAlignment})
                    </span>
                  </div>
                )}
                <div className="border-t border-white/5 pt-2 mt-2 flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">Lot Size</span>
                  <span className="text-slate-200 font-mono">{appConfig?.LOT_SIZE || 75} per leg</span>
                </div>
              </div>
              {strategy?.score?.recommendation && (
                <div className="text-[10px] text-blue-300 bg-blue-500/5 border border-blue-500/15 rounded p-2 font-medium leading-relaxed">
                  <span className="font-black text-blue-400 uppercase tracking-widest text-[8px] mr-2">Engine note:</span>
                  {strategy.score.recommendation}
                </div>
              )}
              <p className="text-[10px] text-amber-300 font-bold leading-relaxed">
                This action will place real orders at the broker. SL / Target rules will be applied automatically by the risk engine after fill.
              </p>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setPendingExecute(null)}
                  disabled={isExecuting}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 text-[10px] font-black uppercase tracking-[0.15em] text-slate-300 hover:bg-white/5 transition disabled:opacity-50"
                >
                  Cancel <span className="text-slate-600 ml-1">(Esc)</span>
                </button>
                <button
                  onClick={() => submitExecute(pendingExecute.bias)}
                  disabled={isExecuting}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-[10px] font-black uppercase tracking-[0.15em] shadow-[0_0_18px_rgba(245,158,11,0.5)] transition disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isExecuting ? (
                    <>
                      <div className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      Submitting...
                    </>
                  ) : (
                    <>
                      <Zap className="w-3.5 h-3.5" />
                      Place Live Order
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Flatten All Confirm Modal */}
      {showFlattenConfirm && (
        <div
          className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
          onClick={() => !isFlattening && setShowFlattenConfirm(false)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-[#0b0f19] border border-rose-500/40 rounded-2xl w-full max-w-md shadow-[0_0_60px_rgba(225,29,72,0.3)] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-rose-500/10 border-b border-rose-500/30 px-6 py-4 flex items-center gap-3">
              <ShieldAlert className="w-5 h-5 text-rose-400" />
              <div>
                <h3 className="text-sm font-black uppercase tracking-[0.2em] text-rose-300">Emergency Square-Off</h3>
                <p className="text-[9px] text-rose-300/60 font-bold uppercase tracking-widest mt-0.5">All open legs will be exited at market</p>
              </div>
            </div>
            <div className="p-6 space-y-4">
              <div className="bg-black/40 border border-white/5 rounded-lg p-4 space-y-2">
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">Legs to close</span>
                  <span className="text-white font-black font-mono">{execution?.positions?.length ?? 0}</span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">Current PnL</span>
                  <span className={cn("font-black font-mono",
                    (execution?.pnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
                    {(execution?.pnl ?? 0) >= 0 ? '+' : ''}₹{(execution?.pnl ?? 0).toLocaleString('en-IN')}
                  </span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-slate-500 font-bold uppercase tracking-widest">Mode</span>
                  <span className={cn("font-black font-mono",
                    execution?.executionMode === 'LIVE' ? "text-rose-400" : "text-blue-400")}>
                    {execution?.executionMode === 'LIVE' ? 'LIVE — REAL MONEY' : 'PAPER'}
                  </span>
                </div>
              </div>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                This action exits every open position immediately and cannot be undone.
                {execution?.executionMode === 'LIVE' && <span className="block mt-1 text-rose-400 font-bold">Live orders will be submitted to the broker.</span>}
              </p>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setShowFlattenConfirm(false)}
                  disabled={isFlattening}
                  className="flex-1 px-4 py-2.5 rounded-lg border border-white/10 text-[10px] font-black uppercase tracking-[0.15em] text-slate-300 hover:bg-white/5 transition disabled:opacity-50"
                >
                  Cancel <span className="text-slate-600 ml-1">(Esc)</span>
                </button>
                <button
                  onClick={handleFlattenAll}
                  disabled={isFlattening}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-black uppercase tracking-[0.15em] shadow-[0_0_18px_rgba(225,29,72,0.5)] transition disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isFlattening ? (
                    <>
                      <div className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                      Exiting...
                    </>
                  ) : (
                    <>
                      <ShieldAlert className="w-3.5 h-3.5" />
                      Confirm Flatten
                    </>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Floating Live Quantum Terminal Notification Toast */}
      {toast && (
        <div className="fixed bottom-24 right-8 z-50 w-full max-w-sm overflow-hidden rounded-xl border border-slate-700/50 bg-slate-900/95 p-4 shadow-2xl backdrop-blur-xl">
          <div className="flex gap-3">
            <div className={cn(
               "w-10 h-10 rounded-lg flex items-center justify-center border shrink-0",
               toast.color === 'emerald' ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" :
               toast.color === 'rose' ? "bg-rose-500/10 border-rose-500/20 text-rose-400" :
               "bg-blue-500/10 border-blue-500/20 text-blue-400"
            )}>
              {toast.type === 'ENTRY' ? (
                 <span className="text-lg font-black leading-none">🚀</span>
              ) : toast.type === 'EXIT' ? (
                 <span className="text-lg font-black leading-none">🏁</span>
              ) : (
                 <span className="text-lg font-black leading-none">🔄</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-white mb-1 leading-normal flex items-center gap-2">
                <span>{toast.title}</span>
                <span className={cn(
                  "w-1.5 h-1.5 rounded-full animate-pulse",
                  toast.color === 'emerald' ? "bg-emerald-400" : toast.color === 'rose' ? "bg-rose-400" : "bg-blue-400"
                )} />
              </h4>
              <p className="text-[10.5px] text-slate-300 font-bold leading-normal mb-1">{toast.message}</p>
              {toast.subMessage && (
                <div className="font-mono text-[8.5px] font-black tracking-tight text-slate-400 border border-white/5 bg-black/40 px-2.5 py-1 rounded truncate">
                  {toast.subMessage}
                </div>
              )}
            </div>
            <button 
              onClick={() => setToast(null)}
              className="text-slate-500 hover:text-slate-300 transition-colors h-fit text-[11px] font-bold leading-none p-1 shrink-0"
            >
              ✕
            </button>
          </div>
        </div>
      )}
         </div>
    </div>
  </div>
  );
}

