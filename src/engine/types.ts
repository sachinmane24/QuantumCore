/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TradeLogEntry {
  id?: string;
  timestamp: string;
  score: number;
  gamma: number;
  oi_bias: number;
  trap: boolean;
  pnl: number;
  win: boolean;
  bias?: 'BULLISH' | 'BEARISH';
  mode?: string;
  vix?: number;
  spot?: number;
  phase?: string;
  isExpiryDay?: boolean;
  isMonthlyExpiry?: boolean;
  entryNetDelta?: number;
  entryNetGamma?: number;
  indicators?: {
    rsi: number | null;
    macd: number | null;
    macdSignal: number | null;
    macdHist: number | null;
    bbUpper: number | null;
    bbLower: number | null;
    bbMiddle: number | null;
  };
  duration?: number; // Holding time in seconds
  entryTime?: string;
  buyPrice?: number;
  sellPrice?: number;
  totalInvestment?: number;
  strike?: number;
  exitReason?: string;
  intelligence?: {
    atr: number;
    vixFactor: number;
    rr: number;
    slPrice: number;
    targetPrice: number;
    slRupees?: number;
    targetRupees?: number;
    pop?: number;
  };
  serverTimestamp?: any;
}

export interface OptionChainData {
  strike: number;
  ce_oi: number;
  ce_oi_change: number;
  pe_oi: number;
  pe_oi_change: number;
  ce_price: number;
  pe_price: number;
  ce_volume?: number;
  pe_volume?: number;
  ce_iv?: number;
  pe_iv?: number;
  iv?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

export interface MarketData {
  spot: number;
  tick: any;
  vix: number;
  vixDelta?: number;
  pcr: number;
  gapPercent: number;
  orb: { high: number; low: number };
  vwap: number;
  todayOpen: number;
  yesterdayClose: number;
  maxPain: number;
  maxOi?: { ce: { strike: number; oi: number }; pe: { strike: number; oi: number } };
  chain: Array<{
    strike: number;
    ce_oi: number;
    ce_oi_change: number;
    pe_oi: number;
    pe_oi_change: number;
    ce_price: number;
    pe_price: number;
    ce_volume?: number;
    pe_volume?: number;
    ce_iv?: number;
    pe_iv?: number;
    iv?: number;
    delta?: number;
    gamma?: number;
    theta?: number;
  }>;
  indicators?: {
    rsi: number | null;
    macd: {
      macd: number | null;
      signal: number | null;
      histogram: number | null;
    };
    bollinger: {
      upper: number | null;
      lower: number | null;
      middle: number | null;
    };
  };
}

export interface StrategyData {
  score: {
    total: number;
    trend: number;
    oiBias: number;
    gamma: number;
    trap: number;
    timeFilter: number;
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    mode: string;
    strategyType: string;
    recommendation: string;
  };
  aiProb: number;
}

export interface ExecutionState {
  positions: any[];
  pnl: number;
  rollsToday: number;
  netDelta: number;
  netGamma: number;
  hedgeLogs: string[];
  risk: {
    tradesToday: number;
    dailyPnL: number;
    consecutiveLosses: number;
    maxDrawdownToday: number;
    peakPnLToday: number;
    portfolioHeat: number;
    riskScore: number;
    isKillSwitchActive: boolean;
    killReason: string | null;
    limits: {
      dailyLoss: number;
      maxTrades: number;
      consectuiveLimit: number;
      heatLimit: number;
    };
  };
  dataSource: 'MOCK' | 'LIVE';
  executionMode: 'PAPER' | 'LIVE';
  autoMode: boolean;
  params?: any;
  activeSL?: number;
  peakPnL?: number;
}

export interface MarketInfo {
  expiry: {
    weekly: string;
    monthly: string;
    daysToExpiry: number;
  };
  holiday: {
    next: string;
    isUpcoming: boolean;
  };
  isMarketClosed?: boolean;
}

export interface HistoryPoint {
  time: string;
  pnl: number;
  score: number;
  vix: number;
  spot: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbMiddle: number | null;
}

export interface StockIntel {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  indicators: {
    rsi: number;
    macd: { macd: number; signal: number; histogram: number };
    bollinger: { upper: number; middle: number; lower: number };
  };
  optionChain: OptionChainData[];
  verdict: {
    bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    score: number;
    reasoning: string;
    sl: number;
    target: number;
  };
  institutionalActivity: {
    oiTrend: string;
    volatilityRegime: string;
    deliveryPercentage?: number;
  };
}

export const FO_STOCKS = [
  "RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "BHARTIARTL", "SBIN", "LICI", "ITC", "HINDUNILVR",
  "LT", "BAJFINANCE", "ADANIENT", "MARUTI", "SUNPHARMA", "TITAN", "AXISBANK", "ULTRACEMCO", "KOTAKBANK", "ADANIPORTS",
  "ONGC", "ASIANPAINT", "NTPC", "JSWSTEEL", "M&M", "POWERGRID", "TATASTEEL", "BAJAJ-AUTO", "ADANIPOWER", "COALINDIA",
  "TATAMOTORS", "HCLTECH", "SBILIFE", "GRASIM", "NESTLEIND", "INDUSINDBK", "TECHM", "WIPRO", "HINDALCO", "BRITANNIA",
  "DIVISLAB", "CIPLA", "APOLLOHOSP", "EICHERMOT", "BPCL", "HEROMOTOCO", "DRREDDY", "BAJAJFINSV", "ONGC", "TATARELI"
];
