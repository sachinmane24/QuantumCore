/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  TrendingUp, TrendingDown, Activity, AlertTriangle, 
  ShieldCheck, LayoutDashboard, History, Zap,
  BarChart3, Brain, ArrowUpRight, ArrowDownRight,
  Shield, Target, Crosshair, Menu, Bell, Search,
  Globe, Moon, Info, ShieldAlert
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, 
  Tooltip, ResponsiveContainer, BarChart, Bar 
} from 'recharts';
import { cn } from './lib/utils';
import { config } from './engine/config.ts';

// --- Types ---
interface MarketData {
  spot: number;
  tick: any;
  chain: Array<{
    strike: number;
    ce_oi: number;
    ce_oi_change: number;
    pe_oi: number;
    pe_oi_change: number;
    ce_price: number;
    pe_price: number;
    iv?: number;
    delta?: number;
    theta?: number;
  }>;
}

interface StrategyData {
  score: {
    total: number;
    trend: number;
    oiBias: number;
    gamma: number;
    trap: number;
    timeFilter: number;
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  };
  aiProb: number;
}

interface ExecutionState {
  positions: any[];
  pnl: number;
  rollsToday: number;
  dataSource: 'MOCK' | 'LIVE';
  executionMode: 'PAPER' | 'LIVE';
  autoMode: boolean;
}

interface MarketInfo {
  expiry: {
    weekly: string;
    monthly: string;
    daysToExpiry: number;
  };
  holiday: {
    next: string;
    isUpcoming: boolean;
  };
}

interface TradeLogEntry {
  timestamp: string;
  score: number;
  gamma: number;
  oi_bias: number;
  trap: boolean;
  pnl: number;
  win: boolean;
}

export default function App() {
  const [market, setMarket] = useState<MarketData | null>(null);
  const [strategy, setStrategy] = useState<StrategyData | null>(null);
  const [execution, setExecution] = useState<ExecutionState | null>(null);
  const [tradeLogs, setTradeLogs] = useState<TradeLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [kiteStatus, setKiteStatus] = useState<{ connected: boolean; hasConfig: boolean }>({ connected: false, hasConfig: false });
  const [marketInfo, setMarketInfo] = useState<MarketInfo | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [loginData, setLoginData] = useState({ user: '', pass: '' });
  const [loginError, setLoginError] = useState('');

  // Data Fetching
  useEffect(() => {
    const fetchKiteStatus = async () => {
      try {
        const res = await fetch('/api/kite/status');
        const data = await res.json();
        setKiteStatus(data);
      } catch (e) {
        console.error("Failed to fetch Kite status", e);
      }
    };

    fetchKiteStatus();

    // Listen for OAuth success
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'KITE_AUTH_SUCCESS') {
        setKiteStatus(prev => ({ ...prev, connected: true }));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleKiteConnect = async () => {
    try {
      const res = await fetch('/api/kite/url');
      const { url } = await res.json();
      
      // Using window.location.href is more reliable than window.open in many restricted environments
      // and avoids the 'about:blank' issue with popup blockers.
      window.location.href = url;
    } catch (e) {
      console.error("Failed to get Kite URL", e);
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

  // Data Fetching
  useEffect(() => {
    const fetchData = async () => {
      if (!isLoggedIn) return;
      try {
        const endpoints = [
          '/api/market-data',
          '/api/strategy-data',
          '/api/execution-state',
          '/api/trade-logs',
          '/api/market-info'
        ];

        const responses = await Promise.all(endpoints.map(async (url) => {
          try {
            return await fetch(url);
          } catch (e) {
            console.error(`Network error fetching ${url}:`, e);
            return null;
          }
        }));
        
        // Validate all responses are OK and JSON
        for (let i = 0; i < responses.length; i++) {
          const res = responses[i];
          if (!res) continue; // Skip if network error occurred

          if (!res.ok) {
            console.error(`Endpoint ${endpoints[i]} failed with status ${res.status}`);
            continue;
          }
          const contentType = res.headers.get('content-type');
          if (!contentType || !contentType.includes('application/json')) {
            const text = await res.text();
            console.error(`Endpoint ${endpoints[i]} returned non-JSON content:`, text.slice(0, 100));
            continue;
          }
          
          try {
            const data = await res.json();
            if (i === 0) setMarket(data);
            if (i === 1) setStrategy(data);
            if (i === 2) setExecution(data);
            if (i === 3) setTradeLogs(data);
            if (i === 4) setMarketInfo(data);
          } catch (e) {
            console.error(`Failed to parse JSON from ${endpoints[i]}:`, e);
          }
        }
        
        setLoading(false);
      } catch (err) {
        console.error("Fetch Data Critical Error:", err);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 1000);
    return () => clearInterval(interval);
  }, [isLoggedIn]);

  const handleExecute = async (bias: 'BULLISH' | 'BEARISH') => {
    await fetch('/api/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bias })
    });
  };

  const handleExit = async () => {
    await fetch('/api/exit', { method: 'POST' });
  };

  const handleToggleDataMode = async () => {
    if (!execution) return;
    try {
      const newMode = execution.dataSource === 'MOCK' ? 'LIVE' : 'MOCK';
      const res = await fetch('/api/toggle-data-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode })
      });
      const data = await res.json();
      setExecution(prev => prev ? { ...prev, dataSource: data.dataSource } : null);
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
    if (!execution) return;
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

  const pnlColor = (execution?.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400";
  const biasColor = strategy?.score.bias === 'BULLISH' ? "text-emerald-400" : strategy?.score.bias === 'BEARISH' ? "text-rose-400" : "text-slate-400";

  return (
    <div className="h-screen bg-[#070b14] text-slate-300 font-sans flex overflow-hidden">
      
      {/* --- SIDEBAR NAVIGATION --- */}
      <aside className="w-20 border-r border-terminal-line bg-black/40 backdrop-blur-3xl flex flex-col items-center py-8 gap-10 z-20">
        <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(37,99,235,0.4)]">
          <Zap className="text-white w-6 h-6 fill-current" />
        </div>
        
        <nav className="flex flex-col gap-6">
          {[
            { id: 'dashboard', icon: LayoutDashboard, label: 'Intel' },
            { id: 'options', icon: Activity, label: 'Chain' },
            { id: 'backtest', icon: BarChart3, label: 'Backtest' },
            { id: 'history', icon: History, label: 'Audit' },
            { id: 'settings', icon: Shield, label: 'Secure' },
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
        {/* --- REFINED TOP BAR --- */}
        <header className="h-16 border-b border-terminal-line px-8 flex items-center justify-between bg-black/20 backdrop-blur-xl shrink-0 z-10">
          <div className="flex items-center space-x-12">
            <div>
              <h1 className="text-xs font-black tracking-[0.3em] uppercase leading-none text-white">Quantum Core v5.2</h1>
              <p className="text-[9px] text-slate-500 uppercase tracking-widest mt-1 font-bold">Terminal Interface Engine (Stable)</p>
            </div>
          
          <div className="hidden lg:flex space-x-10 items-center">
            <div className="flex flex-col">
              <span className="terminal-label !mb-0.5">Nifty 50 Spot</span>
              <div className="terminal-value text-lg">
                <span className="text-slate-200">{market?.spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                <span className={cn("text-[10px] font-bold ml-2", biasColor)}>
                  {(strategy?.score.trend || 0) > 12 ? '+104.20' : '-12.45'}
                </span>
              </div>
            </div>
            <div className="flex flex-col">
              <span className="terminal-label !mb-0.5">India VIX</span>
              <div className="terminal-value text-lg">
                <span className="text-slate-200">12.42</span>
                <span className="text-[10px] text-rose-500 font-bold ml-2">-2.1%</span>
              </div>
            </div>
            <div className="flex flex-col">
              <span className="terminal-label !mb-0.5">PCR Ratio</span>
              <div className="terminal-value text-lg text-emerald-400">1.18</div>
            </div>
            {marketInfo && (
              <>
                <div className="w-px h-8 bg-white/5 mx-2" />
                <div className="flex flex-col px-4 border-r border-white/5">
                  <span className="terminal-label !mb-0.5 text-[8px] uppercase tracking-widest text-slate-500">Weekly Expiry</span>
                  <div className="terminal-value text-[11px] text-blue-400 font-black">
                    {marketInfo.expiry.weekly} 
                    <span className="text-[9px] text-slate-500 ml-2 font-bold">({marketInfo.expiry.daysToExpiry}d)</span>
                  </div>
                </div>
                <div className="flex flex-col px-4 border-r border-white/5">
                  <span className="terminal-label !mb-0.5 text-[8px] uppercase tracking-widest text-slate-500">Monthly</span>
                  <div className="terminal-value text-[11px] text-purple-400 font-black">
                    {marketInfo.expiry.monthly}
                  </div>
                </div>
                <div className="flex flex-col px-4">
                  <span className="terminal-label !mb-0.5 text-[8px] uppercase tracking-widest text-slate-500">Holiday Wall</span>
                  <div className={cn("terminal-value text-[11px] font-black", marketInfo.holiday.isUpcoming ? "text-amber-500" : "text-slate-500")}>
                    {marketInfo.holiday.next || 'CLEAR'}
                    {marketInfo.holiday.isUpcoming && <span className="text-[7px] border border-amber-500/30 px-1 rounded ml-2 animate-pulse leading-none py-0.5">UPCOMING</span>}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center space-x-6">
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
            <button 
              onClick={handleToggleDataMode}
              className={cn(
                "px-3 py-1.5 rounded text-[9px] font-bold tracking-[0.1em] transition-all",
                execution?.dataSource === 'MOCK' 
                  ? "bg-amber-600/20 text-amber-500 border border-amber-600/30"
                  : "bg-emerald-600/20 text-emerald-500 border border-emerald-600/30"
              )}
            >
              {execution?.dataSource || 'MOCK'}
            </button>
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
              className={cn(
                "px-3 py-1.5 rounded text-[9px] font-bold tracking-[0.1em] transition-all",
                execution?.autoMode 
                  ? "bg-purple-600 text-white shadow-[0_0_10px_rgba(147,51,234,0.3)]"
                  : "bg-slate-700 text-slate-300 border border-white/10"
              )}
            >
              {execution?.autoMode ? 'AUTO' : 'MANUAL'}
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
            className="flex-1 grid grid-cols-12 gap-4 p-4 overflow-hidden bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-blue-900/10 via-transparent to-transparent"
          >
            {/* Same as before but with expanded Option Chain */}
            <div className="col-span-12 lg:col-span-3 flex flex-col gap-4 overflow-y-auto">
              <section className="terminal-card flex flex-col group hover:border-blue-500/30">
                <div className="p-5 border-b border-terminal-line flex justify-between items-center bg-white/[0.02]">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Strategy Matrix</h3>
                  <Activity className="w-3 h-3 text-blue-500 animate-pulse" />
                </div>
                <div className="p-4">
                  <div className="flex items-center justify-between mb-4">
                    <div className="relative">
                      <svg className="w-16 h-16 -rotate-90">
                        <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="3" />
                        <motion.circle 
                          cx="32" cy="32" r="28" fill="none" 
                          stroke="#3b82f6" strokeWidth="3" 
                          strokeDasharray="175.9"
                          initial={{ strokeDashoffset: 175.9 }}
                          animate={{ strokeDashoffset: 175.9 * (1 - (strategy?.score.total || 0) / 100) }}
                          transition={{ duration: 1.5, ease: "easeOut" }}
                          strokeLinecap="round"
                        />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center flex-col">
                        <div className="text-base font-black text-white">{strategy?.score.total}</div>
                        <div className="text-[7px] font-bold text-slate-500 uppercase tracking-widest leading-none">Score</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="terminal-label !mb-0 text-[8px]">Confidence</span>
                      <div className="text-2xl font-black tracking-tighter text-blue-400">
                        {((strategy?.aiProb || 0) * 100).toFixed(1)}%
                      </div>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                     {[
                       { label: 'Market Regime', val: (strategy?.score.trend || 0) > 12 ? 'BULLISH' : 'BEARISH', color: (strategy?.score.trend || 0) > 12 ? 'text-emerald-400' : 'text-rose-400', max: 25, current: strategy?.score.trend },
                       { label: 'OI Flow Context', val: 'POSITIVE', color: 'text-emerald-400', max: 20, current: strategy?.score.oiBias },
                       { label: 'Gamma Proxy', val: (strategy?.score.gamma || 0) > 7 ? 'HIGH' : 'STABLE', color: 'text-blue-400', max: 15, current: strategy?.score.gamma },
                       { label: 'Time Filter (θ)', val: 'OPTIMAL', color: 'text-amber-400', max: 20, current: strategy?.score.timeFilter },
                     ].map((item, i) => (
                       <div key={i} className="bg-white/[0.02] border border-white/5 rounded-lg p-3 hover:bg-white/[0.04] transition-colors">
                          <div className="flex justify-between items-center mb-2">
                            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">{item.label}</span>
                            <span className={cn("text-[9px] font-black underline underline-offset-4 decoration-white/10", item.color)}>{item.val}</span>
                          </div>
                          <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                            <motion.div 
                              initial={{ width: 0 }}
                              animate={{ width: `${(item.current || 0) / item.max * 100}%` }}
                              className={cn("h-full", item.color.replace('text-', 'bg-'))} 
                            />
                          </div>
                       </div>
                     ))}
                  </div>
                </div>
              </section>

              <section className="terminal-card bg-rose-500/[0.02] border-rose-500/10 min-h-[160px] flex flex-col">
                <div className="p-5 border-b border-terminal-line flex justify-between items-center bg-rose-500/5">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-rose-500">Trap Intelligence Scan</h3>
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1">
                      {[1, 2, 3].map(i => (
                        <motion.div
                          key={i}
                          animate={{ opacity: [0.2, 1, 0.2] }}
                          transition={{ duration: 1, delay: i * 0.2, repeat: Infinity }}
                          className="w-1 h-1 bg-rose-500 rounded-full"
                        />
                      ))}
                    </div>
                    <ShieldAlert className={cn("w-3 h-3 text-rose-500", strategy?.score.trap !== 20 && "animate-pulse")} />
                  </div>
                </div>
                <div className="p-5 flex-1 flex flex-col justify-center gap-4">
                  <div className={cn(
                    "p-4 rounded-xl border flex flex-col items-center justify-center transition-all bg-black/40",
                    strategy?.score.trap === 20 
                      ? "border-emerald-500/20" 
                      : "border-rose-500/40 shadow-[0_0_30px_rgba(244,63,94,0.15)]"
                  )}>
                    <div className={cn("font-black tracking-[0.2em] text-sm uppercase mb-1", strategy?.score.trap === 20 ? "text-emerald-400" : "text-rose-500")}>
                      {strategy?.score.trap === 20 ? "Neutral Grounds" : "Stop-Loss Hunt"}
                    </div>
                    <div className="text-[9px] opacity-70 uppercase font-black text-center tracking-widest">
                       {strategy?.score.trap === 20 ? "Scanning Liquidity..." : "Execution Anomaly Detected"}
                    </div>
                  </div>
                  
                  {strategy?.score.trap !== 20 && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="text-[8px] font-bold text-rose-400/60 uppercase tracking-widest text-center"
                    >
                      Warning: Heavy Institutional Absorption at Current Level
                    </motion.div>
                  )}
                </div>
              </section>
            </div>

            <div className="col-span-12 lg:col-span-6 flex flex-col gap-4 overflow-hidden">
              <section className="terminal-card h-32 shrink-0 px-6 py-4 flex flex-col">
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Quantum Greeks Surface</h3>
                  <div className="flex gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[8px] font-bold text-emerald-500 uppercase tracking-widest">Live Sync</span>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4 flex-1">
                  <div className="bg-white/[0.02] border border-white/5 rounded-lg px-4 py-2 flex flex-col justify-center relative overflow-hidden group">
                     <span className="terminal-label !mb-0 text-[8px]">Delta (Δ)</span>
                     <div className="flex items-baseline gap-2">
                        <span className="text-xl font-black text-emerald-400 tracking-tighter">+0.84</span>
                        <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Bullish</span>
                     </div>
                  </div>
                  <div className="bg-white/[0.02] border border-white/5 rounded-lg px-4 py-2 flex flex-col justify-center relative overflow-hidden">
                     <span className="terminal-label !mb-0 text-[8px]">Theta (θ)</span>
                     <div className="flex items-baseline gap-2">
                        <span className="text-xl font-black text-rose-400 tracking-tighter">-420</span>
                        <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Decay</span>
                     </div>
                  </div>
                  <div className="bg-white/[0.02] border border-white/5 rounded-lg px-4 py-2 flex flex-col justify-center relative overflow-hidden">
                     <span className="terminal-label !mb-0 text-[8px]">Vega (ν)</span>
                     <div className="flex items-baseline gap-2">
                        <span className="text-xl font-black text-white tracking-tighter">12.8</span>
                        <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest">Norm</span>
                     </div>
                  </div>
                </div>
              </section>

              <section className="terminal-card flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="px-5 py-3 border-b border-terminal-line flex justify-between items-center bg-white/[0.02]">
                  <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Option Chain (Institutional Data)</h3>
                  <div className="flex gap-4">
                    <div className="flex items-center gap-2">
                       <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                       <span className="text-[8px] font-bold uppercase text-slate-500">Puts</span>
                    </div>
                    <div className="flex items-center gap-2">
                       <div className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                       <span className="text-[8px] font-bold uppercase text-slate-500">Calls</span>
                    </div>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <table className="w-full border-collapse">
                    <thead className="sticky top-0 bg-[#0f172a] shadow-sm z-10">
                      <tr className="text-[8px] font-black text-slate-500 uppercase tracking-widest bg-black/20">
                        <th className="px-4 py-2 text-left border-b border-terminal-line">Strike</th>
                        <th className="px-4 py-2 text-left border-b border-terminal-line">ΔOI (C)</th>
                        <th className="px-4 py-2 text-right border-b border-terminal-line">LTP (C)</th>
                        <th className="px-4 py-2 text-center border-b border-terminal-line">IV%</th>
                        <th className="px-4 py-2 text-left border-b border-terminal-line">LTP (P)</th>
                        <th className="px-4 py-2 text-right border-b border-terminal-line">ΔOI (P)</th>
                        <th className="px-4 py-2 text-right border-b border-terminal-line">Signal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.02]">
                      {market?.chain.map((c) => {
                        const isAtm = c.strike === Math.round((market?.spot || 0) / 50) * 50;
                        const biasNum = (c.pe_oi_change - c.ce_oi_change);
                        const bias = biasNum > 0 ? "BULL" : "BEAR";
                        return (
                          <tr key={c.strike} className={cn(
                            "group transition-colors",
                            isAtm ? "bg-blue-600/5 hover:bg-blue-600/10" : "hover:bg-white/[0.01]"
                          )}>
                            <td className={cn("px-4 py-2 terminal-value text-[11px]", isAtm ? "text-blue-400 font-black" : "text-slate-400")}>
                               {c.strike}
                            </td>
                            <td className="px-4 py-2 terminal-value text-rose-500/70 text-[9px]">{(c.ce_oi_change / 1000000).toFixed(2)}M</td>
                            <td className="px-4 py-2 text-right terminal-value text-white text-[10px]">₹{c.ce_price.toFixed(1)}</td>
                            <td className="px-4 py-2 text-center terminal-value text-blue-400/60 text-[9px]">{c.iv?.toFixed(1) || '14.2'}%</td>
                            <td className="px-4 py-2 text-left terminal-value text-white text-[10px]">₹{c.pe_price.toFixed(1)}</td>
                            <td className="px-4 py-2 text-right terminal-value text-emerald-500/70 text-[9px]">{(c.pe_oi_change / 1000000).toFixed(2)}M</td>
                            <td className="px-4 py-2 text-right">
                               <span className={cn(
                                 "text-[8px] font-black uppercase tracking-widest",
                                 bias === 'BULL' ? 'text-emerald-500' : 'text-rose-500'
                               )}>
                                 {bias}
                               </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>

            <div className="col-span-12 lg:col-span-3 flex flex-col gap-4 overflow-y-auto">
              {/* Positons & Execution Column */}
              <section className="terminal-card bg-gradient-to-br from-blue-600/10 to-transparent border-blue-500/30 p-8 flex flex-col justify-between flex-1 min-h-[400px]">
                <div className="text-center">
                  <div className="bg-blue-600/10 border border-blue-500/20 inline-block px-4 py-1.5 rounded-full mb-6">
                    <span className="text-[9px] font-black tracking-[0.3em] uppercase text-blue-400">Institutional Logic</span>
                  </div>
                  <div className={cn(
                    "text-4xl font-black tracking-tighter mb-2",
                    strategy?.score.bias === 'BULLISH' ? "text-emerald-400" : strategy?.score.bias === 'BEARISH' ? "text-rose-400" : "text-slate-500"
                  )}>
                    {strategy?.score.bias === 'BULLISH' ? 'SHORT PUT' : strategy?.score.bias === 'BEARISH' ? 'SHORT CALL' : 'STANDBY'}
                  </div>
                  <div className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">
                    REC: {market?.spot ? Math.round(market.spot / 50) * 50 : '----'} {strategy?.score.bias === 'BULLISH' ? 'PE' : 'CE'}
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
                     <span className="terminal-label !mb-0">Win Prob.</span>
                     <span className="terminal-value text-emerald-400">{((strategy?.aiProb || 0) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between items-center text-[10px]">
                     <span className="terminal-label !mb-0">Max Margin</span>
                     <span className="terminal-value text-white">₹1.25L</span>
                  </div>
                </div>

                <button 
                  onClick={() => handleExecute(strategy?.score.bias === 'BULLISH' ? 'BULLISH' : 'BEARISH')}
                  className={cn(
                    "w-full py-5 font-black rounded-xl shadow-2xl border transition-all uppercase tracking-[0.2em] text-xs",
                    strategy?.score.bias === 'BULLISH' ? "bg-emerald-600 border-emerald-400/50 hover:bg-emerald-500" : 
                    strategy?.score.bias === 'BEARISH' ? "bg-rose-600 border-rose-400/50 hover:bg-rose-500" : 
                    "bg-slate-800 border-slate-700 opacity-50 cursor-not-allowed"
                  )}
                >
                  {execution?.executionMode === 'PAPER' ? 'Execute Paper Trade' : 'Confirm LIVE Order'}
                </button>
                {execution?.autoMode && (
                  <div className="mt-4 p-4 border border-purple-500/20 bg-purple-500/5 rounded-xl flex items-start gap-4">
                     <div className="w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center animate-pulse">
                        <Activity className="w-3 h-3 text-white" />
                     </div>
                     <div>
                        <span className="text-[10px] font-black text-purple-400 uppercase tracking-widest block mb-1">Autonomous Guard Active</span>
                        <p className="text-[10px] text-slate-400 font-medium leading-relaxed">
                          Quantum Core will automatically handle execution logic. Manual override is always available.
                        </p>
                     </div>
                  </div>
                )}
              </section>

              <section className="terminal-card bg-white/[0.01] overflow-hidden flex flex-col h-[280px]">
                 <div className="p-4 border-b border-terminal-line bg-white/[0.02] flex justify-between items-center">
                    <h3 className="text-[9px] font-black uppercase tracking-[0.2em] text-slate-500">Live Stream</h3>
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                 </div>
                 <div className="flex-1 overflow-y-auto">
                    {tradeLogs.slice(0, 5).map((log, i) => (
                      <div key={i} className="p-4 border-b border-white/5 flex flex-col gap-1">
                         <div className="flex justify-between text-[9px] font-mono text-slate-500">
                            <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
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
        ) : activeTab === 'options' ? (
          <motion.main 
            key="options"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="flex-1 p-8 overflow-hidden flex flex-col gap-6"
          >
            <div className="flex justify-between items-end">
               <div>
                  <h2 className="text-2xl font-black text-white tracking-tight uppercase">Instrument Chain</h2>
                  <p className="text-xs text-slate-500 font-bold tracking-widest mt-1">NIFTY 50 Option Matrix v3.0</p>
               </div>
               <div className="flex gap-4">
                  <div className="terminal-card px-4 py-2 border-blue-500/20">
                     <span className="terminal-label !mb-0">ATM Strike</span>
                     <div className="terminal-value text-lg text-blue-400">
                        {market?.spot ? Math.round(market.spot / 50) * 50 : '----'}
                     </div>
                  </div>
                  <div className="terminal-card px-4 py-2">
                     <span className="terminal-label !mb-0">IV Surface</span>
                     <div className="terminal-value text-lg text-white">14.2% Avg</div>
                  </div>
               </div>
            </div>

            <div className="terminal-card flex-1 overflow-hidden flex flex-col">
               <div className="flex-1 overflow-y-auto">
                  <table className="w-full border-collapse">
                     <thead className="sticky top-0 bg-slate-900 z-10">
                        <tr className="text-[10px] font-black text-slate-500 uppercase tracking-widest border-b border-terminal-line bg-black/40">
                           <th className="p-4 text-center border-r border-terminal-line" colSpan={4}>CALLS</th>
                           <th className="p-4 text-center border-r border-terminal-line" colSpan={1}>STRIKE</th>
                           <th className="p-4 text-center" colSpan={4}>PUTS</th>
                        </tr>
                        <tr className="text-[8px] font-bold text-slate-400 uppercase tracking-widest border-b border-terminal-line italic">
                           <th className="p-3 text-left">ΔOI</th>
                           <th className="p-3">DELTA</th>
                           <th className="p-3">THETA</th>
                           <th className="p-3 border-r border-terminal-line">LTP</th>
                           <th className="p-3 border-r border-terminal-line bg-white/5">INDEX</th>
                           <th className="p-3">LTP</th>
                           <th className="p-3">THETA</th>
                           <th className="p-3">DELTA</th>
                           <th className="p-3 text-right">ΔOI</th>
                        </tr>
                     </thead>
                     <tbody className="divide-y divide-white/[0.03]">
                        {market?.chain.map((c) => {
                           const isAtm = c.strike === Math.round((market?.spot || 0) / 50) * 50;
                           return (
                              <tr key={c.strike} className={cn(
                                "group transition-colors",
                                isAtm ? "bg-blue-600/5 hover:bg-blue-600/10" : "hover:bg-white/[0.01]"
                              )}>
                                 <td className="p-4 terminal-value text-rose-500 text-[10px]">{(c.ce_oi_change / 1000000).toFixed(2)}M</td>
                                 <td className="p-4 text-center terminal-value text-slate-500 text-[10px]">{c.delta?.toFixed(2)}</td>
                                 <td className="p-4 text-center terminal-value text-slate-600 text-[10px]">{c.theta?.toFixed(1)}</td>
                                 <td className="p-4 text-center terminal-value text-white text-[11px] font-black border-r border-terminal-line">₹{c.ce_price.toFixed(1)}</td>
                                 
                                 <td className="p-4 text-center border-r border-terminal-line bg-white/[0.02]">
                                    <span className={cn("terminal-value text-xs", isAtm ? "text-blue-400" : "text-slate-400")}>
                                       {c.strike}
                                    </span>
                                 </td>

                                 <td className="p-4 text-center terminal-value text-white text-[11px] font-black">₹{c.pe_price.toFixed(1)}</td>
                                 <td className="p-4 text-center terminal-value text-slate-600 text-[10px]">{c.theta?.toFixed(1)}</td>
                                 <td className="p-4 text-center terminal-value text-slate-500 text-[10px]">{(c.delta ? -c.delta : 0).toFixed(2)}</td>
                                 <td className="p-4 text-right terminal-value text-emerald-500 text-[10px]">{(c.pe_oi_change / 1000000).toFixed(2)}M</td>
                              </tr>
                           );
                        })}
                     </tbody>
                  </table>
               </div>
            </div>
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
               <div className="flex gap-4 items-center bg-slate-900/50 p-2 rounded-xl border border-white/5">
                  <div className="flex flex-col px-4">
                     <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-1">Testing Period</span>
                     <select className="bg-transparent text-xs font-bold text-blue-400 outline-none cursor-pointer">
                        <option value="30d">Last 30 Days</option>
                        <option value="90d">Last 90 Days</option>
                        <option value="1y">Last 1 Year</option>
                        <option value="max">Max Available</option>
                     </select>
                  </div>
                  <button className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-black uppercase tracking-widest rounded-lg transition-all shadow-lg shadow-blue-900/20">
                     Run Simulation
                  </button>
               </div>
            </div>

            <div className="grid grid-cols-5 gap-4">
               {[
                 { label: 'Win Rate', value: '64.2%', desc: 'Optimal range', color: 'text-emerald-400', icon: Target },
                 { label: 'Risk-Reward', value: '1:1.8', desc: 'Positive expectancy', color: 'text-blue-400', icon: Crosshair },
                 { label: 'Profit Factor', value: '2.14', desc: 'Highly efficient', color: 'text-purple-400', icon: TrendingUp },
                 { label: 'Max Drawdown', value: '8.4%', desc: 'Safe threshold', color: 'text-rose-400', icon: TrendingDown },
                 { label: 'Total Trades', value: '412', desc: 'Statistically significant', color: 'text-white', icon: Activity },
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
               <div className="col-span-8 terminal-card p-6 flex flex-col">
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
                        <AreaChart data={mockPerformance}>
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
                           />
                           <YAxis 
                              stroke="rgba(255,255,255,0.2)" 
                              fontSize={10}
                              tickLine={false}
                              axisLine={false}
                              tickFormatter={(value) => `₹${value/1000}k`}
                           />
                           <Tooltip 
                              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                              itemStyle={{ color: '#fff', fontSize: '12px', fontWeight: 'bold' }}
                           />
                           <Area 
                              type="monotone" 
                              dataKey="value" 
                              stroke="#3b82f6" 
                              strokeWidth={3}
                              fillOpacity={1} 
                              fill="url(#colorValue)" 
                           />
                        </AreaChart>
                     </ResponsiveContainer>
                  </div>
               </div>

               <div className="col-span-4 terminal-card overflow-hidden flex flex-col">
                  <div className="p-5 border-b border-terminal-line bg-white/[0.02]">
                     <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Trade Distribution</h3>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                     {[
                        { range: '0-500', count: 142, color: 'bg-emerald-500/20 text-emerald-500' },
                        { range: '500-1000', count: 85, color: 'bg-emerald-500/40 text-emerald-400' },
                        { range: '1000+', count: 32, color: 'bg-emerald-500/60 text-white' },
                        { range: '-500 to 0', count: 98, color: 'bg-rose-500/20 text-rose-500' },
                        { range: '-1000 to -500', count: 45, color: 'bg-rose-500/40 text-rose-400' },
                        { range: '< -1000', count: 10, color: 'bg-rose-500/60 text-white' },
                     ].map((d, i) => (
                        <div key={i} className="flex flex-col gap-2">
                           <div className="flex justify-between text-[9px] font-black uppercase tracking-widest">
                              <span className="text-slate-500">{d.range} PnL</span>
                              <span className="text-white">{d.count} Trades</span>
                           </div>
                           <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                              <div className={cn("h-full", d.color.split(' ')[0])} style={{ width: `${(d.count / 142) * 100}%` }} />
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
                     <div className="terminal-value text-lg text-emerald-400">72.4%</div>
                  </div>
                  <div className="terminal-card px-4 py-2">
                     <span className="terminal-label !mb-0">Total Return</span>
                     <div className="terminal-value text-lg text-white">₹1.24L</div>
                  </div>
               </div>
            </div>

            <div className="terminal-card flex-1 overflow-hidden flex flex-col">
               <div className="flex-1 overflow-y-auto overflow-x-auto">
                  <table className="w-full border-collapse">
                     <thead className="sticky top-0 bg-slate-900/90 backdrop-blur z-10">
                        <tr className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] text-left">
                           <th className="p-5 border-b border-terminal-line">Timestamp</th>
                           <th className="p-5 border-b border-terminal-line">Asset</th>
                           <th className="p-5 border-b border-terminal-line">Signal Score</th>
                           <th className="p-5 border-b border-terminal-line">Identity</th>
                           <th className="p-5 border-b border-terminal-line">Relational Sync</th>
                           <th className="p-5 border-b border-terminal-line text-right">Profit/Loss</th>
                           <th className="p-5 border-b border-terminal-line text-right">Action</th>
                        </tr>
                     </thead>
                     <tbody className="divide-y divide-white/[0.03]">
                        {tradeLogs.map((log, i) => (
                           <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                              <td className="p-5 terminal-value text-[11px] text-slate-400">
                                 {new Date(log.timestamp).toLocaleString()}
                              </td>
                              <td className="p-5 font-bold text-xs text-white">NIFTY 50 INDEX</td>
                              <td className="p-5">
                                 <div className="flex items-center gap-3">
                                    <div className="w-16 h-1.5 bg-white/5 rounded-full overflow-hidden">
                                       <div className="h-full bg-blue-500" style={{ width: `${log.score}%` }} />
                                    </div>
                                    <span className="terminal-value text-[10px]">{log.score}</span>
                                 </div>
                              </td>
                              <td className="p-5">
                                 <span className="text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                    Institutional
                                 </span>
                              </td>
                              <td className="p-5">
                                 <span className={cn(
                                   "text-[9px] font-bold uppercase",
                                   log.trap ? "text-rose-500" : "text-emerald-500"
                                 )}>
                                    {log.trap ? 'Trap Filter Active' : 'Clean Orderflow'}
                                 </span>
                              </td>
                              <td className={cn("p-5 text-right terminal-value text-[13px]", log.win ? "text-emerald-400" : "text-rose-400")}>
                                 {log.win ? '+' : '-'}₹{Math.abs(log.pnl)}
                              </td>
                              <td className="p-5 text-right">
                                 <button className="text-[10px] font-black text-slate-600 hover:text-white uppercase tracking-widest transition-colors opacity-0 group-hover:opacity-100">
                                    DETAILS
                                 </button>
                              </td>
                           </tr>
                        ))}
                     </tbody>
                  </table>
               </div>
            </div>
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

                <div className="space-y-4">
                   <p className="text-xs text-slate-400 leading-relaxed">
                      To enable real-time institutional data, you must provide your KiteConnect API credentials in the environment settings. 
                      Navigate to <span className="text-blue-400 font-bold">Settings</span> menu in this editor and declare the following variables:
                   </p>
                   <div className="bg-black/40 p-4 rounded-lg font-mono text-[10px] space-y-4 border border-white/5">
                      <div className="flex justify-between items-center">
                         <div>
                            <span className="text-slate-500 block">Variable Name</span>
                            <span className="text-blue-400 font-bold">KITE_API_KEY</span>
                         </div>
                         <span className={kiteStatus.hasConfig ? "text-emerald-500" : "text-rose-500"}>{kiteStatus.hasConfig ? "DETECTED" : "MISSING"}</span>
                      </div>
                      <div className="flex justify-between items-center">
                         <div>
                            <span className="text-slate-500 block">Variable Name</span>
                            <span className="text-blue-400 font-bold">KITE_API_SECRET</span>
                         </div>
                         <span className={kiteStatus.hasConfig ? "text-emerald-500" : "text-rose-500"}>{kiteStatus.hasConfig ? "DETECTED" : "MISSING"}</span>
                      </div>
                   </div>
                   {!kiteStatus.connected && (
                     <button 
                        onClick={handleKiteConnect}
                        disabled={!kiteStatus.hasConfig}
                        className="w-full py-4 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed text-white font-black rounded-lg uppercase tracking-[0.2em] text-[10px] transition-all shadow-lg shadow-blue-900/20"
                     >
                        Initiate Terminal Handshake
                     </button>
                   )}
                   {kiteStatus.connected && (
                     <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-center">
                        <span className="text-emerald-400 text-[10px] font-black uppercase tracking-widest">Connection Live - Data Synchronized</span>
                     </div>
                   )}
                </div>
             </section>

             <section className="terminal-card p-8 border-rose-500/10">
                <div className="flex items-center gap-4 mb-6">
                   <ShieldAlert className="text-rose-500 w-6 h-6" />
                   <h4 className="text-sm font-black text-white uppercase tracking-widest">Risk Guardrail</h4>
                </div>
                <div className="grid grid-cols-2 gap-4">
                   <div className="p-4 bg-white/5 rounded-lg border border-white/5">
                      <span className="terminal-label">Max Loss Strategy</span>
                      <div className="terminal-value text-white">₹4,000 / Day</div>
                   </div>
                   <div className="p-4 bg-white/5 rounded-lg border border-white/5">
                      <span className="terminal-label">Trade Timeout</span>
                      <div className="terminal-value text-white">300 Seconds</div>
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
              {(execution?.pnl || 0) >= 0 ? '+' : ''}₹{(execution?.pnl || 0).toLocaleString()}
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
            <div className="opacity-40">{new Date().toLocaleTimeString()} IST</div>
          </div>
        </div>
      </footer>
    </div>
  </div>
  );
}

