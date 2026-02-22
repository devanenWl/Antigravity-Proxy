/**
 * Unleash 心跳服务
 * 模拟官方 Antigravity 客户端的 Unleash 功能开关心跳，
 * 向 antigravity-unleash.goog 定期发送 register / features / frontend 请求。
 *
 * 参考：antigravity2api-nodejs/src/utils/unleash.js
 */
import crypto from 'crypto';
import { fingerprintFetch } from '../runtime/fingerprint-requester.js';
import { ANTIGRAVITY_CONFIG, UNLEASH_TOKENS } from '../config.js';

const UNLEASH_BASE = 'https://antigravity-unleash.goog';
const UNLEASH_INTERVAL_MS = 60_000; // 60 秒
const UNLEASH_JITTER_MS = 5_000;    // ±5 秒抖动

const AG_VERSION = ANTIGRAVITY_CONFIG.user_agent.match(/antigravity\/([\d.]+)/)?.[1] || '1.18.3';
// Frontend 端点使用 Electron GUI 版本号，与 Go CLI 版本不同
const ELECTRON_VERSION = '1.107.0';
const FULL_CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${ELECTRON_VERSION} Chrome/142.0.7444.175 Electron/39.2.3 Safari/537.36`;

// 构造精确到纳秒的 ISO 时间戳（模拟 Go time.Now()）
function generateCreatedAt() {
    const now = new Date();
    const nanos = String(now.getMilliseconds()).padStart(3, '0') + '000000';
    return now.toISOString().replace(/\.\d{3}Z$/, `.${nanos}Z`);
}

function buildClientRegisterBody(account) {
    return {
        appName: 'codeium-language-server',
        instanceId: account.instance_id,
        connectionId: crypto.randomUUID(),
        sdkVersion: 'unleash-client-go:4.5.0',
        // 顺序与 antigravity2api 完全一致：remoteAddress 在 userWithId 前面
        strategies: ['default', 'applicationHostname', 'gradualRolloutRandom', 'gradualRolloutSessionId', 'gradualRolloutUserId', 'remoteAddress', 'userWithId', 'flexibleRollout'],
        started: generateCreatedAt(),
        interval: 60,
        platformVersion: 'go1.26-20260115-RC01 cl/856841426 +532e320349 X:boringcrypto,simd',
        platformName: 'go',
        yggdrasilVersion: null,
        specVersion: '4.3.1'
    };
}

function buildFrontEndBody(account) {
    // 字段顺序与 antigravity2api 完全一致
    return {
        context: {
            sessionId: '',
            appName: 'codeium-extension',
            environment: 'default',
            userId: account.access_token,
            properties: {
                ide: 'antigravity',
                ideVersion: AG_VERSION,
                extensionVersion: '',
                disableTelemetry: 'false',
                invocationId: crypto.randomUUID(),
                devMode: 'false'
            }
        }
    };
}

// ==================== 三套独立请求头 ====================

function getRegisterHeaders(account) {
    const body = JSON.stringify(buildClientRegisterBody(account));
    return {
        'Host': 'antigravity-unleash.goog',
        'User-Agent': 'codeium-language-server',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'Authorization': `*:${UNLEASH_TOKENS.client}`,
        'Content-Type': 'application/json',
        'Unleash-Appname': 'codeium-language-server',
        'Unleash-Connection-Id': crypto.randomUUID(),
        'Unleash-Instanceid': account.instance_id || '',
        'Unleash-Interval': '60000',
        'Unleash-Sdk': 'unleash-client-go:4.5.0',
        'Accept-Encoding': 'gzip',
        _body: body // 内部传递，避免重复序列化
    };
}

function getFeaturesHeaders(account) {
    return {
        'Host': 'antigravity-unleash.goog',
        'User-Agent': 'codeium-language-server',
        'Authorization': `*:${UNLEASH_TOKENS.client}`,
        'Unleash-Appname': 'codeium-language-server',
        'Unleash-Client-Spec': '4.3.1',
        'Unleash-Connection-Id': crypto.randomUUID(),
        'Unleash-Instanceid': account.instance_id || '',
        'Unleash-Interval': '60000',
        'Unleash-Sdk': 'unleash-client-go:4.5.0',
        'Accept-Encoding': 'gzip'
    };
}

function getFrontEndHeaders(account) {
    const body = JSON.stringify(buildFrontEndBody(account));
    return {
        'Host': 'antigravity-unleash.goog',
        'User-Agent': FULL_CHROME_UA,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US',
        'Authorization': `*:${UNLEASH_TOKENS.frontend}`,
        'Cache-Control': 'max-age=0',
        'Content-Type': 'application/json',
        'Origin': 'vscode-file://vscode-app',
        'Priority': 'u=1, i',
        'Sec-Ch-Ua': '"Not_A Brand";v="99", "Chromium";v="142"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': 'Windows',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'Unleash-Appname': 'codeium-extension',
        'Unleash-Connection-Id': crypto.randomUUID(),
        'Unleash-Sdk': 'unleash-client-js:3.7.8',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        _body: body // 内部传递
    };
}

async function sendRegister(account) {
    try {
        const headers = getRegisterHeaders(account);
        const body = headers._body;
        delete headers._body;
        await fingerprintFetch(`${UNLEASH_BASE}/api/client/register`, {
            method: 'POST',
            headers,
            body
        });
    } catch { /* 静默失败，不影响主业务 */ }
}

async function sendFeatures(account) {
    try {
        await fingerprintFetch(`${UNLEASH_BASE}/api/client/features`, {
            method: 'GET',
            headers: getFeaturesHeaders(account)
        });
    } catch { /* 静默 */ }
}

async function sendFrontEnd(account) {
    try {
        const headers = getFrontEndHeaders(account);
        const body = headers._body;
        delete headers._body;
        await fingerprintFetch(`${UNLEASH_BASE}/api/frontend`, {
            method: 'POST',
            headers,
            body
        });
    } catch { /* 静默 */ }
}

/**
 * 对单个账号执行一轮 Unleash 心跳
 */
export async function unleashHeartbeat(account) {
    if (!account.access_token || !account.instance_id) return;
    await sendRegister(account);
    await sendFeatures(account);
    await sendFrontEnd(account);
}

// 定时器管理
let _intervalId = null;

/**
 * 启动 Unleash 心跳调度器
 * @param {Function} getActiveAccounts - 返回所有活跃账号的函数
 */
export function startUnleashScheduler(getActiveAccounts) {
    if (_intervalId) return;

    const run = async () => {
        try {
            const accounts = getActiveAccounts();
            for (const account of accounts) {
                if (account.status !== 'active' || !account.access_token) continue;
                await unleashHeartbeat(account);
                // 每个账号之间加随机延迟，避免并发聚簇
                await new Promise(r => setTimeout(r, 200 + Math.random() * 500));
            }
        } catch { /* ignore */ }
    };

    // 首次执行延迟 10~30 秒（模拟启动延迟）
    setTimeout(() => {
        run();
        _intervalId = setInterval(() => {
            const jitter = Math.floor(Math.random() * UNLEASH_JITTER_MS);
            setTimeout(run, jitter);
        }, UNLEASH_INTERVAL_MS);
    }, 10_000 + Math.random() * 20_000);

    console.log('[Unleash] heartbeat scheduler started');
}

export function stopUnleashScheduler() {
    if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
    }
}
