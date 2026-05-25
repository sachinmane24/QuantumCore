import { config } from './config';

export class NotificationService {
  private static isMarketClosed(): boolean {
    const holidays = [
      "2026-01-26", "2026-03-08", "2026-03-25", "2026-03-29", "2026-04-11",
      "2026-04-17", "2026-05-01", "2026-06-17", "2026-07-17", "2026-08-15",
      "2026-10-02", "2026-11-01", "2026-11-15", "2026-12-25"
    ];
    
    try {
      const now = new Date();
      
      // Direct, 100% fail-safe extraction of Asia/Kolkata time parts via Intl
      const istString = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
      const istDate = new Date(istString);
      
      const day = istDate.getDay(); // 0 (Sun) to 6 (Sat)
      const hours = istDate.getHours(); // 0 to 23
      const minutes = istDate.getMinutes(); // 0 to 59
      const currentTimeMinutes = hours * 60 + minutes;
      
      const year = istDate.getFullYear();
      const month = String(istDate.getMonth() + 1).padStart(2, '0');
      const dateVal = String(istDate.getDate()).padStart(2, '0');
      const today = `${year}-${month}-${dateVal}`;
      
      const isWeekend = day === 0 || day === 6;
      const isHoliday = holidays.includes(today);
      const isOffMarketHours = currentTimeMinutes < 555 || currentTimeMinutes > 930; // 9:15 AM to 3:30 PM
      
      return isWeekend || isHoliday || isOffMarketHours;
    } catch (err) {
      console.error('[NOTIFY] Error calculating market hours:', err);
      return false;
    }
  }

  private static async sendTelegram(message: string) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
      console.log('[NOTIFY] Telegram not configured. Message:', message);
      return;
    }

    if (this.isMarketClosed()) {
      console.log('[NOTIFY] Telegram message blocked because market is closed (weekend, holiday, or off-market hours):', message.replace(/<[^>]*>/g, '').substring(0, 100) + '...');
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML'
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorDetails = '';
        try {
          const resJson = await response.json();
          errorDetails = resJson.description ? `: ${resJson.description}` : '';
        } catch (_) {}
        
        const status = response.status;
        if (status === 403) {
          console.warn(`[NOTIFY] Telegram Permission Error (403)${errorDetails}.\n` +
            `👉 Troubleshooting:\n` +
            `1. Make sure you have searched for the bot on Telegram and clicked 'Start' (sent /start) to initiate the chat.\n` +
            `2. Verify that your TELEGRAM_CHAT_ID matches your secret Chat ID.\n` +
            `3. If sending to a group or channel, ensure the bot is added as a member and has Send/Admin privileges.`);
        }
        throw new Error(`Telegram API returned ${status}${errorDetails}`);
      }
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        console.error('[NOTIFY] Telegram notification request TIMEOUT (aborted after 5s)');
      } else {
        console.error('[NOTIFY] Failed to send Telegram notification:', error);
      }
    }
  }

  static async notifyTradeEntry(trade: any) {
    const slPriceStr = trade.params?.stopLossPrice 
      ? `₹${trade.params.stopLossPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
      : "Dynamic / None";
    const targetPriceStr = trade.params?.targetPrice 
      ? `₹${trade.params.targetPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
      : "Dynamic / None";
    const slRupeesStr = trade.params?.stopLossRupees 
      ? `₹${trade.params.stopLossRupees.toLocaleString()}` 
      : "Dynamic";
    const targetRupeesStr = trade.params?.targetRupees 
      ? `₹${trade.params.targetRupees.toLocaleString()}` 
      : "Dynamic";
    const rrStr = trade.params?.riskRewardRatio 
      ? `1:${(1 / trade.params.riskRewardRatio).toFixed(1)}` 
      : "Dynamic";
    const popStr = trade.params?.pop 
      ? `${(trade.params.pop * 100).toFixed(1)}%` 
      : "Dynamic";

    const message = `🚀 <b>TRADE INITIATED</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🔹 <b>Symbol:</b> <code>${trade.symbol}</code>\n` +
      `📊 <b>Strategy Type:</b> <code>${trade.strategyType || "N/A"}</code>\n` +
      `⚙️ <b>Strategy Mode:</b> <code>${trade.strategyMode || "N/A"}</code>\n` +
      `🎯 <b>Trade Bias:</b> <code>${trade.bias}</code>\n` +
      `💰 <b>Entry Spot:</b> ₹<code>${trade.entrySpot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</code>\n\n` +
      `🛠️ <b>EXERTED LIMITS & PARAMETERS</b>\n` +
      `🛡️ <b>SL Price:</b> <code>${slPriceStr}</code>\n` +
      `🎯 <b>Target Price:</b> <code>${targetPriceStr}</code>\n` +
      `🛑 <b>Max SL (Rupees):</b> <code>${slRupeesStr}</code>\n` +
      `📈 <b>Max Target (Rupees):</b> <code>${targetRupeesStr}</code>\n` +
      `📊 <b>Risk-Reward Ratio:</b> <code>${rrStr}</code>\n` +
      `🎲 <b>Win Prob (PoP):</b> <code>${popStr}</code>`;
    
    await this.sendTelegram(message);
  }

  static async notifyTradeExit(trade: any, reason: string) {
    const statusSymbol = trade.pnl >= 0 ? '✅' : '🔴';
    const profitEmoji = trade.pnl >= 0 ? "🏆 WIN" : "🛑 LOSS";
    const pnlPrefix = trade.pnl >= 0 ? '₹+' : '₹';
    
    // Duration in minutes
    const durationMins = trade.entryTimestamp 
      ? `${Math.round((Date.now() - trade.entryTimestamp) / 60000)} mins` 
      : "N/A";

    const entrySpotStr = trade.entrySpot 
      ? `₹${trade.entrySpot.toLocaleString(undefined, { minimumFractionDigits: 2 })}` 
      : "N/A";
    const slPriceStr = trade.params?.stopLossPrice 
      ? `₹${trade.params.stopLossPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}` 
      : "N/A";
    const targetPriceStr = trade.params?.targetPrice 
      ? `₹${trade.params.targetPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}` 
      : "N/A";

    const message = `🏁 <b>TRADE LIQUIDATED</b> ${trade.pnl >= 0 ? "💰" : "📉"}\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `🔹 <b>Symbol:</b> <code>${trade.symbol}</code>\n` +
      `💰 <b>Net PnL:</b> <b>${pnlPrefix}${trade.pnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>\n` +
      `📊 <b>Result:</b> <b>${profitEmoji}</b>\n` +
      `💡 <b>Reason:</b> <code>${reason}</code>\n` +
      `⏱️ <b>Holding Time:</b> <code>${durationMins}</code>\n\n` +
      `🛠️ <b>HISTORICAL ENTRY STATS</b>\n` +
      `📥 <b>Entry Spot:</b> <code>${entrySpotStr}</code>\n` +
      `📊 <b>Strategy Type:</b> <code>${trade.strategyType || "N/A"}</code>\n` +
      `🛡️ <b>Initial SL Price:</b> <code>${slPriceStr}</code>\n` +
      `🎯 <b>Initial Target Price:</b> <code>${targetPriceStr}</code>`;
    
    await this.sendTelegram(message);
  }

  static async notifyError(error: string) {
    await this.sendTelegram(`⚠️ <b>SYSTEM ALERT</b>\n\n${error}`);
  }

  static async notifyMessage(message: string) {
    await this.sendTelegram(`ℹ️ <b>QUANT ENGINE</b>\n\n${message}`);
  }
}
