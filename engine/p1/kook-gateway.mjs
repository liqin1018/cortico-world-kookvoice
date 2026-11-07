// KOOK WebSocket 网关：负责收文字消息
//
// 用 Node 22 内置的全局 WebSocket，不需要装 @kookapp/js-sdk。
// 处理了：心跳(s=2)、断线重连(带 sn + session_id 续传)、服务端要求重连(s=5)。
import { api, loadToken } from '../p0/kook.mjs';

const SIGNAL = { EVENT: 0, HELLO: 1, PING: 2, PONG: 3, RESUME: 4, RECONNECT: 5, RESUME_ACK: 6 };

export class KookGateway {
  /**
   * @param {object} o
   * @param {(evt:object)=>void} o.onEvent  收到业务事件（d.type 存在的那种）
   * @param {(s:string)=>void} [o.log]
   */
  constructor({ onEvent, log }) {
    this.token = loadToken();
    this.onEvent = onEvent;
    this.log = log || ((s) => console.log(s));

    this.ws = null;
    this.sn = 0;
    this.sessionId = null;
    this.pingInterval = 30000;
    this.heartbeat = null;
    this.closedByUs = false;
    this.retry = 0;
    this.reconnectTimer = null;
  }

  async start() {
    const gw = await api('GET', '/gateway/index', { token: this.token, query: { compress: 0 } });
    this.gatewayUrl = gw.url;
    this._connect(false);
  }

  _connect(resume) {
    const url = new URL(this.gatewayUrl);
    url.searchParams.set('compress', '0');
    if (resume && this.sessionId) {
      url.searchParams.set('resume', '1');
      url.searchParams.set('sn', String(this.sn));
      url.searchParams.set('session_id', this.sessionId);
    }

    this.ws = new WebSocket(url.toString());

    this.ws.addEventListener('open', () => {
      this.log(`✓ 网关已连接${resume ? '（续传）' : ''}`);
    });

    this.ws.addEventListener('message', (ev) => {
      let pkt;
      try {
        pkt = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      this._onPacket(pkt);
    });

    this.ws.addEventListener('error', () => {
      this.log('! 网关连接出错');
    });

    this.ws.addEventListener('close', (ev) => {
      this._clearHeartbeat();
      if (this.closedByUs) return;
      this.log(`! 网关断开 code=${ev.code}${ev.reason ? ' ' + ev.reason : ''}`);
      this._scheduleReconnect();
    });
  }

  _onPacket(pkt) {
    const { s, d } = pkt;
    if (typeof pkt.sn === 'number' && pkt.sn > 0) this.sn = pkt.sn;

    if (s === SIGNAL.HELLO) {
      if (d && d.code === 0) {
        this.sessionId = d.session_id || this.sessionId;
        this.pingInterval = d.ping_interval || 30000;
        this.retry = 0;
        this._startHeartbeat();
        // 连上后先发一个心跳，服务端回 pong(s=3) 才算 ready。
        // 注意：官方文档写的是 sn=1，但实测这个网关会回 s=5 code=40108 "Invalid SN"，
        // 必须是 sn=0（或不带 sn）。别按文档写 1。
        this._send({ s: SIGNAL.PING, sn: this.sn });
        this.log(`✓ 会话就绪 session=${String(this.sessionId).slice(0, 8)}… 心跳 ${this.pingInterval}ms`);
      } else {
        // 续传失败：丢弃会话，重新连一次
        this.sessionId = null;
        this.sn = 0;
        this.log('! 续传被拒，改为重新建会话');
        this._hardReconnect();
      }
      return;
    }

    if (s === SIGNAL.EVENT) {
      if (d && d.type !== undefined && this.onEvent) this.onEvent(d);
      return;
    }

    if (s === SIGNAL.RECONNECT) {
      this.log('! 服务端要求重连');
      this._hardReconnect();
      return;
    }

    // s=3 pong / s=6 resume ack：不需要处理
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this.heartbeat = setInterval(() => {
      this._send({ s: SIGNAL.PING, sn: this.sn });
    }, this.pingInterval);
  }

  _clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  _send(obj) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    } catch {}
  }

  _hardReconnect() {
    try { this.ws && this.ws.close(); } catch {}
    this.sessionId = null;
    this.sn = 0;
    this._scheduleReconnect(0);
  }

  _scheduleReconnect(delay) {
    if (this.retry > 8) {
      this.log('✗ 重连次数过多，放弃。检查网络或 Token。');
      return;
    }
    const wait = delay !== undefined ? delay : Math.min(1000 * 2 ** this.retry, 30000);
    this.retry++;
    this.log(`· ${Math.round(wait / 1000)} 秒后重连（第 ${this.retry} 次）`);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      // 有会话就续传，没有就重新建
      this._connect(!!this.sessionId);
    }, wait);
  }

  async stop() {
    this.closedByUs = true;
    this._clearHeartbeat();
    clearTimeout(this.reconnectTimer);
    try { this.ws && this.ws.close(); } catch {}
  }
}
