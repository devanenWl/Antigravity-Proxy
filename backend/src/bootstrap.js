import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici';

function parseIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

const connectTimeoutMs = parseIntEnv('FETCH_CONNECT_TIMEOUT_MS', 30000);
const proxyUrl = process.env.OUTBOUND_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

try {
  if (proxyUrl) {
    // 让 Node 的全局 fetch 走代理（常用于国内网络 / Clash）
    setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl, connectTimeout: connectTimeoutMs }));
    console.log(`[Net] OUTBOUND_PROXY enabled (connectTimeout=${connectTimeoutMs}ms)`);
  } else {
    // 提高默认 connect timeout（undici 默认 10s，弱网下易超时）
    setGlobalDispatcher(new Agent({ connectTimeout: connectTimeoutMs }));
    console.log(`[Net] connectTimeout=${connectTimeoutMs}ms`);
  }
} catch (e) {
  console.warn('[Net] Failed to configure dispatcher:', e?.message || e);
}

// Start server
import './index.js';

