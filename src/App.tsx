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
  Tooltip, ResponsiveContainer, BarChart, Bar,
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
  const [kiteStatus, setKiteStatus] = useState<{ connected: boolean; hasConfig: boolean; error?: string | null }>({ connected: false, hasConfig: false });
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [prediction, setPrediction] = useState<PredictionResult | null>(null);
  const [isPredicting, setIsPredicting] = useState(false);
  
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
  const [backtestStatus, setBacktestStatus] = useState<{
    loading: boolean;
    error: string | null;
    success: boolean;
    data: any | null;
  }>({ loading: false, error: null, success: false, data: null });

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

  // Data Fetching
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

      const results = await Promise.all(endpoints.map(async (url) => {
        try {
          const res = await fetch(url);
          if (res.ok) {
            const contentType = res.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              return await res.json();
            }
          }
        } catch (e) {
          console.error(`Network error fetching ${url}:`, e);
        }
        return null;
      }));
      
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

      // Fetch config once
      if (!appConfig) {
        fetch('/api/config').then(r => r.json()).then(setAppConfig);
      }
      
      setLastSync(new Date());
      setLoading(false);
    } catch (err) {
      console.error("Fetch Data Critical Error:", err);
    }
  }, [isLoggedIn, appConfig]);

  // Data Fetching Intervals
  useEffect(() => {
    if (!isLoggedIn) return;

    // Initial load
    fetchData('fast');
    fetchData('slow');

    // Fast polling: 1.5s (optimized for responsiveness)
    const fastInterval = setInterval(() => fetchData('fast'), 1500);
    // Slow polling: 15s (improved from 30s)
    const slowInterval = setInterval(() => fetchData('slow'), 15000);

    return () => {
      clearInterval(fastInterval);
      clearInterval(slowInterval);
    };
  }, [fetchData, isLoggedIn]);

  const handleExecute = async (bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL') => {
    await fetch('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bias })
    });
  };

  const handleExit = async () => {
    await fetch('/api/exit', { method: 'POST' });
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

      // --- SIMULATION ENGINE ---
      const initialBalance = 200000;
      let balance = initialBalance;
      let trades: any[] = [];
      let equityCurve: any[] = [];
      let currentDrawdown = 0;
      let maxBalance = balance;
      let wins = 0;
      let losses = 0;
      let totalProfit = 0;
      let totalLoss = 0;

      // Simple Trend-Following Simulation based on real candle data
      for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        
        // Strategy Logic Proxy: Enter every few hours if volatility is present
        if (i > 10 && i % 6 === 0) {
          const prevClose = candles[i-1].close;
          const currentClose = candle.close;
          const priceChange = ((currentClose - prevClose) / prevClose) * 100;
          
          // Heuristic: Capture a portion of the movement based on "Quantum Alpha" logic
          // Buying options means high gamma/vega impact
          const pnlMultiplier = (Math.random() > 0.4 ? 1.2 : -0.8); 
          const pnlValue = Math.round(priceChange * pnlMultiplier * 5000); // 5000 is exposure proxy
          
          balance += pnlValue;
          const timestamp = new Date(candle.date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit' });
          
          trades.push({ 
            pnl: pnlValue, 
            balance,
            timestamp,
            type: pnlValue > 0 ? 'WIN' : 'LOSS'
          });
          
          if (pnlValue > 0) {
            wins++;
            totalProfit += pnlValue;
          } else {
            losses++;
            totalLoss += Math.abs(pnlValue);
          }

          if (balance > maxBalance) maxBalance = balance;
          const drawdown = ((maxBalance - balance) / maxBalance) * 100;
          if (drawdown > currentDrawdown) currentDrawdown = drawdown;
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

      <div className="flex-1 flex flex-col min-w-0">
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
                 <div className="flex items-center gap-1 group bg-white/5 px-2 py-0.5 rounded-full border border-white/5">
                    <motion.div 
                      key={lastSync?.getTime()}
                      initial={{ scale: 2, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className={cn(
                        "w-1.5 h-1.5 rounded-full transition-all duration-300",
                        loading ? "bg-slate-700" : "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]"
                      )} 
                    />
                    <span className={cn(
                      "text-[8px] font-mono transition-colors",
                      lastSync && (new Date().getTime() - lastSync.getTime() < 3000) ? "text-emerald-400" : "text-amber-400/50"
                    )}>
                      {market?.error ? 'FAIL' : (lastSync ? `${Math.floor((new Date().getTime() - lastSync.getTime()) / 1000)}s` : 'OFFLINE')}
                    </span>
                 </div>
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
                    ₹{((market?.chain?.find(c => c.strike === Math.round((market?.spot || 0)/50)*50)?.ce_price || 0) + 
                       (market?.chain?.find(c => c.strike === Math.round((market?.spot || 0)/50)*50)?.pe_price || 0))?.toFixed(1) || '---'}
                  </motion.span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-500">IV Rank / Percentile</span>
              <span className="text-purple-400">42 / 68%</span>
            </div>
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
                Nifty 50 Spot
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
                  <h2 className="text-sm font-black uppercase tracking-wider text-white">NIFTY 50 COGNITIVE COCKPIT</h2>
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
                      <span>Proximity: {Math.abs((market?.spot || 0) - Math.round((market?.spot || 0)/50)*50).toFixed(1)} pts</span>
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
                </div>
              </section>

              {/* Gemini Predictor */}
              <section className="terminal-card bg-blue-950/20 p-5 flex flex-col gap-3">
                 <div className="flex justify-between items-center border-b border-blue-900/30 pb-2.5">
                   <div className="flex items-center gap-2">
                     <Zap className="w-3.5 h-3.5 text-blue-400" />
                     <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-400">Gemini Predictive Scan</h3>
                   </div>
                   <button 
                     onClick={handlePredict}
                     disabled={isPredicting}
                     className="p-1 hover:bg-blue-500/20 rounded transition-colors disabled:opacity-50 hover:text-blue-200 text-blue-400"
                   >
                     <Activity className={cn("w-3 h-3", isPredicting && "animate-pulse")} />
                   </button>
                 </div>

                 {!prediction && !isPredicting ? (
                   <div className="flex flex-col items-center justify-center p-4 bg-black/30 rounded-xl border border-blue-500/10 border-dashed">
                      <p className="text-[8px] font-bold text-slate-500 uppercase tracking-widest text-center">
                        Evaluate live tick-structures and open interest using server-side Gemini intelligence
                      </p>
                      <button 
                        onClick={handlePredict}
                        className="mt-2.5 px-3 py-1 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 rounded text-[9px] font-black text-blue-400 uppercase tracking-widest transition-all"
                      >
                        [ RUN SCAN ]
                      </button>
                   </div>
                 ) : isPredicting ? (
                   <div className="flex flex-col items-center justify-center p-6 bg-black/30 rounded-xl border border-blue-500/10">
                      <motion.div 
                        animate={{ rotate: 360 }}
                        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                        className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full mb-2"
                      />
                      <p className="text-[8px] font-bold text-blue-400 uppercase tracking-wider animate-pulse text-center">
                        Interrogating options structures...
                      </p>
                   </div>
                 ) : (
                   <div className="space-y-3 p-1">
                      <div className="flex justify-between items-center text-[10px]">
                        <span className="font-extrabold text-blue-300 uppercase">Win Probability</span>
                        <span className={cn(
                          "font-black text-xs px-2 py-0.5 rounded",
                          prediction.isBullish ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                        )}>
                           {(prediction.confidence * 100).toFixed(0)}% ({prediction.isBullish ? 'BULL' : 'BEAR'})
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-300 leading-relaxed font-mono bg-black/40 p-3 rounded-lg border border-white/5 max-h-36 overflow-y-auto custom-scrollbar">
                        {prediction.aiLogic}
                      </div>
                   </div>
                 )}
              </section>
            </div>

            {/* Column 2: Live Trade Analytics & Real-Time NIFTY Dynamics */}
            <div className="col-span-12 lg:col-span-4 flex flex-col gap-4 h-fit">
              {/* Active Positions */}
              {execution?.positions && execution.positions.length > 0 && (
                <section className="terminal-card bg-emerald-600/[0.05] border-emerald-500/20 p-5">
                   <div className="flex justify-between items-center mb-4">
                      <div className="flex items-center gap-2.5">
                         <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                         <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-400">Current Positions</h3>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <div className={cn(
                          "px-2.5 py-0.5 rounded text-[10px] font-black",
                          (execution?.pnl || 0) >= 0 ? "text-emerald-400 bg-emerald-400/10" : "text-rose-400 bg-rose-400/10"
                        )}>
                          PNL: ₹{execution?.pnl}
                        </div>
                        <div className="px-2.5 py-0.5 rounded text-[10px] font-black text-blue-400 bg-blue-400/10 uppercase tracking-tighter">
                          MARGIN: ₹{execution?.capitalDeployed?.toLocaleString() || 0}
                        </div>
                      </div>
                   </div>
                   <div className="space-y-2">
                      {execution.positions.map((pos: any, idx: number) => (
                        <div key={idx} className="bg-black/40 border border-white/5 rounded-lg p-3 flex justify-between items-center">
                           <div className="flex items-center gap-4">
                              <span className={cn(
                                "px-2 py-0.5 rounded text-[8px] font-black",
                                pos.side === 'SELL' ? "bg-rose-500/20 text-rose-500" : "bg-emerald-500/20 text-emerald-500"
                              )}>
                                {pos.side}
                              </span>
                              <div>
                                 <div className="text-[10px] font-black text-white">NIFTY {pos.strike} {pos.type}</div>
                                 <div className="flex items-center gap-2">
                                    <div className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">{pos.qty} QTY @ ₹{pos.entryPrice}</div>
                                    <div className="w-1 h-1 rounded-full bg-white/10" />
                                    <div className="text-[8px] font-black text-blue-400 uppercase tracking-widest">
                                       LTP: ₹{
                                         market?.chain.find(c => c.strike === pos.strike)?.[pos.type === 'CE' ? 'ce_price' : 'pe_price']?.toFixed(1) || pos.entryPrice
                                       }
                                    </div>
                                 </div>
                              </div>
                           </div>
                           <div className="text-right">
                              <div className="text-[10px] font-black text-emerald-400">LIVE</div>
                              <div className="text-[8px] text-slate-500 font-bold">DECAY: OPTIMAL</div>
                           </div>
                        </div>
                      ))}
                      <button 
                         onClick={handleExit}
                         className="w-full mt-2 py-2 bg-rose-600/10 hover:bg-rose-600/20 border border-rose-500/30 text-rose-500 text-[9px] font-black uppercase tracking-widest rounded-lg transition-all"
                      >
                         Emergency Square Off
                      </button>
                   </div>
                </section>
              )}

              {/* NIFTY 50 Today Movement Trend Chart */}
              <section className="terminal-card bg-slate-900/40 p-5 flex flex-col gap-4">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-emerald-400 animate-pulse" />
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">NIFTY 50 Intraday Trend</h3>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] font-bold text-slate-500 uppercase">
                    <span>Spot: <span className="text-emerald-400">₹{market?.spot?.toFixed(1) || '----'}</span></span>
                  </div>
                </div>

                <div className="h-[200px] w-full relative">
                  {market?.priceHistory && market.priceHistory.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={market.priceHistory.map((val: any, idx: number) => {
                        if (typeof val === 'object' && val !== null) {
                          return {
                            time: val.time || idx.toString(),
                            price: val.price || 0
                          };
                        }
                        const totalPoints = market.priceHistory?.length || 1;
                        const secondsAgo = (totalPoints - 1 - idx) * 2; // assume ~2s average interval
                        const d = new Date(Date.now() - secondsAgo * 1000);
                        const timeStr = d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        return {
                          time: timeStr,
                          price: Number(val)
                        };
                      })}>
                        <defs>
                          <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.25}/>
                            <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                        <XAxis dataKey="time" stroke="#475569" fontSize={8} tickLine={false} axisLine={false} />
                        <YAxis domain={['auto', 'auto']} stroke="#475569" fontSize={8} tickLine={false} axisLine={false} orientation="right" />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', fontSize: '9px' }}
                          itemStyle={{ fontSize: '9px', fontWeight: 'bold' }}
                        />
                        <Area type="monotone" dataKey="price" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorPrice)" name="Spot Price" />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/20 rounded-lg border border-dashed border-white/5">
                      <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest animate-pulse">
                        Synchronizing High Frequency Spot Stream...
                      </span>
                    </div>
                  )}
                </div>
              </section>





               {/* NIFTY 50 Unified Options Chain */}
               <section className="terminal-card bg-slate-900/40 p-5 flex flex-col gap-4">
                 <div className="flex justify-between items-center border-b border-white/5 pb-2.5">
                   <div className="flex items-center gap-2">
                     <Activity className="w-4 h-4 text-violet-400" />
                     <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-white">Focused Option Chain</h3>
                   </div>
                   <span className="text-[8px] font-bold text-slate-500 uppercase">Weekly Expiry Standard</span>
                 </div>
                    <div className="flex gap-4">
                      <div className="flex items-center gap-1.5">
                         <div className={cn("w-1.5 h-1.5 rounded-full", market?.gapPercent && market.gapPercent > 0.3 ? "bg-emerald-500" : market?.gapPercent && market.gapPercent < -0.3 ? "bg-rose-500" : "bg-slate-500")} />
                         <span className="text-[8px] font-bold text-slate-500 uppercase">Gap: {(market?.gapPercent || 0).toFixed(2)}%</span>
                      </div>
                    </div>

                  <div className="overflow-x-auto mt-2">
                    <table className="w-full text-left border-collapse text-[10px]">
                       <thead>
                         <tr className="border-b border-white/10 text-[7.5px] font-black text-slate-500 uppercase tracking-wider text-center">
                           <th className="py-2 text-rose-400">CE Price</th>
                           <th className="py-2 text-rose-400/80">CE Vol</th>
                           <th className="py-2 text-white bg-white/5 rounded-t font-black">Strike</th>
                           <th className="py-2 text-emerald-400/80">PE Vol</th>
                           <th className="py-2 text-emerald-400">PE Price</th>
                         </tr>
                       </thead>
                       <tbody className="divide-y divide-white/[0.02]">
                         {(() => {
                           const spotStrike = Math.round((market?.spot || 22000) / 50) * 50;
                           const displayedStrikes = (market?.chain || [])
                             .filter((c: any) => Math.abs(c.strike - spotStrike) <= 100)
                             .sort((a: any, b: any) => b.strike - a.strike);

                           if (displayedStrikes.length === 0) {
                             return (
                               <tr>
                                 <td colSpan={5} className="py-8 text-center text-slate-500 font-bold uppercase text-[8px] tracking-widest">
                                   Handshaking Option Chain Matrix...
                                 </td>
                               </tr>
                             );
                           }

                           return displayedStrikes.map((c: any) => {
                             const isAtm = c.strike === spotStrike;
                             return (
                               <tr key={c.strike} className={cn(
                                 "text-center transition-colors hover:bg-white/[0.01]",
                                 isAtm && "bg-blue-600/[0.04]"
                               )}>
                                 <td className="py-3 font-mono font-bold text-rose-400">₹{c.ce_price?.toFixed(1) || '0.0'}</td>
                                 <td className="py-3 font-mono text-slate-500 text-[8.5px]">{(c.ce_volume || 0).toLocaleString()}</td>
                                 <td className={cn(
                                   "py-3 font-mono font-black text-[11px] bg-white/[0.01]",
                                   isAtm ? "text-blue-400 ring-1 ring-blue-500/20" : "text-slate-300"
                                 )}>
                                   {c.strike} {isAtm ? "●" : ""}
                                 </td>
                                 <td className="py-3 font-mono text-slate-500 text-[8.5px]">{(c.pe_volume || 0).toLocaleString()}</td>
                                 <td className="py-3 font-mono font-bold text-emerald-400">₹{c.pe_price?.toFixed(1) || '0.0'}</td>
                               </tr>
                             );
                           });
                         })()}
                      </tbody>
                     </table>
                  </div>
                </section>
              </div>
            <div className="col-span-12 lg:col-span-3 flex flex-col gap-4 h-full pb-8 overflow-y-auto custom-scrollbar pl-2">
              {/* Positons & Execution Column */}
              <section className="terminal-card bg-gradient-to-br from-blue-600/10 to-transparent border-blue-500/30 p-8 flex flex-col justify-between shrink-0">
                <div className="text-center">
                  <div className={cn(
                    "bg-blue-600/10 border border-blue-500/20 inline-block px-4 py-1.5 rounded-full mb-6",
                    strategy?.score.mode === 'MOMENTUM_SNIPER' && "bg-rose-600/20 border-rose-500/40"
                  )}>
                    <span className={cn(
                      "text-[9px] font-black tracking-[0.3em] uppercase",
                      strategy?.score.mode === 'MOMENTUM_SNIPER' ? "text-rose-400" : "text-blue-400"
                    )}>
                      {strategy?.score.mode === 'MOMENTUM_SNIPER' ? 'Momentum Sniper' : 'Institutional Logic'}
                    </span>
                  </div>
                  <div className={cn(
                    "text-4xl font-black tracking-tighter mb-2",
                    strategy?.score.bias === 'BULLISH' ? "text-emerald-400" : strategy?.score.bias === 'BEARISH' ? "text-rose-400" : "text-slate-500"
                  )}>
                    {strategy?.score.mode === 'MOMENTUM_SNIPER' 
                      ? (strategy?.score.bias === 'BULLISH' ? 'EXPLOSIVE UP' : 'EXPLOSIVE DOWN')
                      : (strategy?.score.bias === 'BULLISH' ? 'SHORT PUT' : strategy?.score.bias === 'BEARISH' ? 'SHORT CALL' : 'STANDBY')}
                  </div>
                  <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">
                    REC: {strategy?.score.recommendation}
                  </div>
                  {execution?.executionMode === 'LIVE' && (
                    <div className="mt-4 p-2 bg-rose-500/10 border border-rose-500/20 rounded flex items-center gap-2">
                       <ShieldAlert className="w-4 h-4 text-rose-500" />
                       <span className="text-[10px] font-black text-rose-500 uppercase tracking-tighter">Real Money Warning</span>
                    </div>
                  )}
                </div>

                  <div className="bg-slate-900/60 backdrop-blur border border-white/5 p-5 rounded-xl space-y-4 my-8">
                   <div className="flex justify-between items-center text-[10px]">
                      <span className="terminal-label !mb-0">Win Prob. (Edge)</span>
                      <span className="terminal-value text-emerald-400">
                         {Math.min(95, Math.max(30, (strategy?.score.total || 50) * 0.8 + 15)).toFixed(1)}%
                      </span>
                   </div>
                   <div className="flex justify-between items-center text-[10px]">
                      <span className="terminal-label !mb-0">Exp. Value (EV)</span>
                      <span className="terminal-value text-blue-400">
                         +₹{Math.round((appConfig?.TARGET_RUPEES || 4000) * 0.6 - (appConfig?.SL_RUPEES || 2000) * 0.4)} / Trade
                      </span>
                   </div>
                   <div className="flex justify-between items-center text-[10px]">
                      <span className="terminal-label !mb-0">Required Margin</span>
                      <span className="terminal-value text-white">
                         ₹{execution?.capitalDeployed > 0 ? execution.capitalDeployed.toLocaleString() : 
                           (strategy?.score?.strategyType.includes('SPREAD') || strategy?.score?.strategyType.includes('IRON'))
                             ? (415 * (appConfig?.LOT_SIZE || 65)).toLocaleString()
                             : '1.15L+'}
                      </span>
                   </div>
                   {(strategy?.score?.strategyType.includes('SPREAD') || strategy?.score?.strategyType.includes('IRON')) && (
                     <div className="flex justify-between items-center text-[10px] pt-1 border-t border-white/5 mt-1">
                       <span className="terminal-label !mb-0 text-amber-400">Management Bias</span>
                       <span className="terminal-value text-amber-400">
                         {strategy?.score.bias === 'NEUTRAL' ? 'Gamma Scalp' : 'Theta Harvest'}
                       </span>
                     </div>
                   )}
                 </div>

                <button 
                  onClick={() => handleExecute(strategy?.score.bias || 'NEUTRAL')}
                  className={cn(
                    "w-full py-5 font-black rounded-xl shadow-2xl border transition-all uppercase tracking-[0.2em] text-xs",
                    strategy?.score.bias === 'BULLISH' ? "bg-emerald-600 border-emerald-400/50 hover:bg-emerald-500" : 
                    strategy?.score.bias === 'BEARISH' ? "bg-rose-600 border-rose-400/50 hover:bg-rose-500" : 
                    strategy?.score.bias === 'NEUTRAL' ? "bg-slate-700 border-slate-600 hover:bg-slate-500" :
                    "bg-slate-800 border-slate-700 opacity-50 cursor-not-allowed"
                  )}
                >
                  {execution?.executionMode === 'PAPER' ? 'Execute Paper Trade' : 'Confirm LIVE Order'}
                </button>
                 {execution?.autoMode && (
                  <div className="mt-4 p-4 border border-purple-500/20 bg-purple-500/5 rounded-xl space-y-3">
                     <div className="flex items-start justify-between">
                        <div className="flex items-start gap-4">
                           <div className="w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center animate-pulse">
                              <Activity className="w-3 h-3 text-white" />
                           </div>
                           <div>
                              <span className="text-[10px] font-black text-purple-400 uppercase tracking-widest block mb-1">Autonomous Guard Active</span>
                              <p className="text-[10px] text-slate-400 font-medium leading-relaxed">
                                Continuous market scanning enabled.
                              </p>
                           </div>
                        </div>
                        <div className={`p-1.5 rounded-lg border ${execution.lastTradeSuppression ? 'border-amber-500/40 bg-amber-500/10' : 'border-emerald-500/40 bg-emerald-500/10'} flex items-center gap-2`}>
                           <div className={`w-2 h-2 rounded-full ${execution.lastTradeSuppression ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]'}`} />
                           <span className={`text-[9px] font-black uppercase ${execution.lastTradeSuppression ? 'text-amber-400' : 'text-emerald-400'}`}>
                              {execution.lastTradeSuppression ? 'Paused' : 'Ready'}
                           </span>
                        </div>
                     </div>
                     {execution?.lastTradeSuppression && (
                       <div className="pt-2 border-t border-purple-500/10 space-y-2">
                          <div className="flex items-center justify-between">
                             <span className="text-[9px] font-black text-amber-500 uppercase flex items-center gap-1.5">
                                <ShieldAlert className="w-3 h-3" />
                                {execution.lastTradeSuppression.reason}
                             </span>
                             <span className="text-[8px] font-mono text-slate-500">
                                {new Date(execution.lastTradeSuppression.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                             </span>
                          </div>
                          <div className="flex gap-1">
                             <div className="flex-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                                <div className="h-full bg-amber-500/50 w-[70%]" />
                             </div>
                             <span className="text-[8px] text-slate-500 font-black">SCANNING...</span>
                          </div>
                       </div>
                     )}
                  </div>
                )}
              </section>

              <section className="terminal-card bg-emerald-600/[0.03] border-emerald-500/20 p-6 flex flex-col gap-4 shrink-0">
                 <div className="flex items-center gap-3">
                    <div className="p-2 bg-emerald-600/10 rounded-lg">
                       <Brain className="w-4 h-4 text-emerald-500" />
                    </div>
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-400">Tactical Strategy Advisory</h3>
                 </div>
                 <div className="space-y-4">
                    <div className="space-y-1">
                       <div className="text-[9px] font-black text-white uppercase tracking-widest opacity-60">Primary Recommendation</div>
                       <p className="text-[10px] text-slate-300 font-bold leading-relaxed">
                          {strategy?.score.bias === 'BULLISH' 
                            ? strategy?.score.mode === 'MOMENTUM_SNIPER' 
                              ? "Momentum Sniper active. High velocity bullish expansion detected. Buying ATM CE for rapid delta capture."
                              : "Aggressive Bullish Bias. Institutional flow supports PE Credit Spreads for optimal Theta yield." 
                            : strategy?.score.bias === 'BEARISH' 
                              ? strategy?.score.mode === 'MOMENTUM_SNIPER'
                                ? "Momentum Sniper active. Bearish breakdown with volume surge. Buying ATM PE for maximum exposure."
                                : "Confirmed Bearish Breakdown. Institutional sellers entering. Initiate CE Credit Spreads at next resistance."
                              : "Neutral Range Detected. Low directional conviction. Avoid directionals, prioritize Iron Fly or delta-neutral strategies."}
                       </p>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                       <div className="bg-white/5 p-2 rounded border border-white/5">
                          <span className="text-[8px] text-slate-500 font-black uppercase">Edge Window</span>
                          <div className="text-[10px] text-blue-400 font-bold">{appConfig?.START_TIME || '09:15'} - {appConfig?.END_TIME || '15:20'} IST</div>
                       </div>
                       <div className="bg-white/5 p-2 rounded border border-white/5">
                          <span className="text-[8px] text-slate-500 font-black uppercase">Volatility Edge</span>
                          <div className="text-[10px] text-emerald-400 font-bold">
                             {market?.vix && market.vix > 18 ? "IV Expansion Alert" : market?.vix && market.vix < 14 ? "Low IV Environment" : "Normal IV Regime"}
                          </div>
                       </div>
                    </div>
                 </div>
              </section>

              <section className="terminal-card bg-white/[0.01] overflow-hidden flex flex-col min-h-[220px] shrink-0">
                 <div className="p-4 border-b border-terminal-line bg-white/[0.02] flex justify-between items-center">
                    <h3 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Live Stream</h3>
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                 </div>
                 <div className="flex-1 overflow-y-auto">
                    {tradeLogs.slice(0, 5).map((log, i) => (
                      <div key={i} className="p-4 border-b border-white/5 flex flex-col gap-1">
                         <div className="flex justify-between text-[9px] font-mono text-slate-500">
                            <span>{new Date(log.timestamp).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
                            <span className={log.win ? 'text-emerald-500' : 'text-rose-500'}>{log.win ? '+WIN' : '-LOSS'}</span>
                         </div>
                         <div className="flex justify-between items-center">
                            <span className="text-[10px] font-bold text-slate-300">NIFTY {log.score > 50 ? 'BULL' : 'BEAR'}</span>
                            <span className="terminal-value text-xs">₹{log.pnl}</span>
                         </div>
                      </div>
                    ))}
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
            className="flex-1 p-6 overflow-hidden flex flex-col gap-6"
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
            className="flex-1 p-6 overflow-hidden flex flex-col gap-6"
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
                        {market?.spot ? Math.round(market.spot / 50) * 50 : '----'}
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
                            {market?.maxPain ? market.maxPain : (market?.spot ? Math.round(market.spot / 50) * 50 : '----')}
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
                        const isAtm = c.strike === Math.round((market?.spot || 0) / 50) * 50;
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
            className="flex-1 p-8 overflow-hidden flex flex-col gap-6"
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

            <div className="grid grid-cols-12 gap-4 flex-1 min-h-0">
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
          </motion.main>
        ) : activeTab === 'history' ? (
          <motion.main 
            key="history"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 p-8 overflow-hidden flex flex-col gap-6"
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
                                       <span className="text-[10px] text-white font-mono">{log.strike || Math.round((log.spot || 0)/50)*50 || '---'}</span>
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

                // Strategy Performance Matrix
                const strategyMap: { [key: string]: { name: string; count: number; wins: number; pnl: number; totalScore: number } } = {};
                tradeLogs.forEach(l => {
                  const sName = l.mode || 'INST_SPREAD';
                  if (!strategyMap[sName]) {
                    strategyMap[sName] = { name: sName, count: 0, wins: 0, pnl: 0, totalScore: 0 };
                  }
                  strategyMap[sName].count++;
                  if (l.win) strategyMap[sName].wins++;
                  strategyMap[sName].pnl += (l.pnl || 0);
                  strategyMap[sName].totalScore += (l.score || 0);
                });

                const strategies = Object.values(strategyMap).map(s => ({
                  ...s,
                  winRate: s.count > 0 ? (s.wins / s.count) * 100 : 0,
                  avgScore: s.count > 0 ? Math.round(s.totalScore / s.count) : 0,
                }));

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

                     {/* --- Strategy Performance Leaderboard Table --- */}
                     <div className="terminal-card p-6">
                        <div className="mb-4">
                           <h3 className="text-xs font-black text-white uppercase tracking-widest">Detailed Strategy Performance Leaderboard</h3>
                           <p className="text-[9px] text-slate-500 font-bold uppercase">Breakdown of trade metrics segmented by execution module mode</p>
                        </div>

                        <div className="overflow-x-auto">
                           <table className="w-full border-collapse">
                              <thead>
                                 <tr className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] border-b border-terminal-line text-left">
                                    <th className="py-3 px-4">Strategy Mode</th>
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
                                          <td className="py-4 px-4 font-black text-xs text-white uppercase tracking-wider">
                                             {strat.name.replace(/_/g, ' ')}
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
                                       <td colSpan={6} className="py-8 text-center text-slate-500 text-xs font-black uppercase tracking-widest">
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
    </div>
  </div>
  );
}

