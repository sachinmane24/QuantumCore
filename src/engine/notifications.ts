import { config } from './config';

export class NotificationService {
  private static async sendTelegram(message: string) {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
      console.log('[NOTIFY] Telegram not configured. Message:', message);
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML'
        })
      });

      if (!response.ok) {
        throw new Error(`Telegram API returned ${response.status}`);
      }
    } catch (error) {
      console.error('[NOTIFY] Failed to send Telegram notification:', error);
    }
  }

  static async notifyTradeEntry(trade: any) {
    const message = `🚀 <b>TRADE OPENED</b>\n\n` +
      `<b>Symbol:</b> ${trade.symbol}\n` +
      `<b>Strategy:</b> ${trade.strategyMode}\n` +
      `<b>Bias:</b> ${trade.bias}\n` +
      `<b>Entry Spot:</b> ₹${trade.entrySpot.toFixed(2)}\n` +
      `<b>Status:</b> ${trade.status}`;
    
    await this.sendTelegram(message);
  }

  static async notifyTradeExit(trade: any, reason: string) {
    const symbol = trade.pnl >= 0 ? '✅' : '🔴';
    const message = `${symbol} <b>TRADE CLOSED</b>\n\n` +
      `<b>Symbol:</b> ${trade.symbol}\n` +
      `<b>PnL:</b> ₹${trade.pnl.toFixed(2)}\n` +
      `<b>Reason:</b> ${reason}\n` +
      `<b>Duration:</b> ${Math.round((Date.now() - trade.entryTimestamp) / 60000)}m`;
    
    await this.sendTelegram(message);
  }

  static async notifyError(error: string) {
    await this.sendTelegram(`⚠️ <b>SYSTEM ALERT</b>\n\n${error}`);
  }

  static async notifyMessage(message: string) {
    await this.sendTelegram(`ℹ️ <b>QUANT ENGINE</b>\n\n${message}`);
  }
}
