/**
 * 遥测日志上报
 * 向上游发送伪造的使用统计数据，模拟真实客户端的遥测行为。
 *
 * 参考：antigravity2api-nodejs/src/utils/recordCodeAssistMetrics.js
 */
import crypto from 'crypto';
import { ANTIGRAVITY_CONFIG } from '../config.js';
import { fingerprintFetch } from '../runtime/fingerprint-requester.js';

const BASE_URL = ANTIGRAVITY_CONFIG.base_url;
const USER_AGENT = ANTIGRAVITY_CONFIG.user_agent;
const AG_VERSION = USER_AGENT.match(/antigravity\/([\d.]+)/)?.[1] || '1.18.3';
const TELEMETRY_INTERVAL_MS = 5 * 60_000; // 5 分钟基准
const TELEMETRY_JITTER_MS = 5 * 60_000;   // 额外 0~5 分钟随机

let _intervalId = null;

// 构造精确到纳秒的 ISO 时间戳
function generateCreatedAt() {
    const now = new Date();
    const nanos = String(now.getMilliseconds()).padStart(3, '0') + '000000';
    return now.toISOString().replace(/\.\d{3}Z$/, `.${nanos}Z`);
}

/**
 * 构造 recordCodeAssistMetrics 请求体
 * 匹配 antigravity2api 的 buildRecordCodeAssistMetricsBody 结构
 */
function buildMetrics(account, trajectoryId) {
    const traceId = crypto.randomUUID().replace(/-/g, '');
    const firstLatency = (Math.random() * 5 + 1).toFixed(9);
    const totalLatency = (Math.random() * 10 + 5).toFixed(9);

    return {
        project: account.project_id || '',
        requestId: crypto.randomUUID(),
        metadata: {
            ideType: 'ANTIGRAVITY',
            ideVersion: AG_VERSION,
            platform: 'WINDOWS_AMD64'
        },
        metrics: [
            {
                timestamp: generateCreatedAt(),
                conversationOffered: {
                    status: 'ACTION_STATUS_NO_ERROR',
                    traceId,
                    streamingLatency: {
                        firstMessageLatency: `${firstLatency}s`,
                        totalLatency: `${totalLatency}s`
                    },
                    isAgentic: true,
                    initiationMethod: 'AGENT',
                    trajectoryId: trajectoryId || crypto.randomUUID()
                }
            }
        ]
    };
}

/**
 * 向上游发送遥测数据
 */
async function sendTelemetry(account) {
    if (!account.access_token) return;
    try {
        await fingerprintFetch(`${BASE_URL}/v1internal:recordCodeAssistMetrics`, {
            method: 'POST',
            headers: {
                'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
                'User-Agent': USER_AGENT,
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip'
            },
            body: JSON.stringify(buildMetrics(account))
        });
    } catch { /* 静默失败 */ }
}

/**
 * 启动遥测上报调度器
 * @param {Function} getActiveAccounts - 返回所有活跃账号的函数
 */
export function startTelemetryScheduler(getActiveAccounts) {
    if (_intervalId) return;

    const run = async () => {
        try {
            const accounts = getActiveAccounts();
            for (const account of accounts) {
                if (account.status !== 'active' || !account.access_token) continue;
                await sendTelemetry(account);
                // 账号间随机间隔
                await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
            }
        } catch { /* ignore */ }
    };

    // 首次执行延迟 30~60 秒
    setTimeout(() => {
        run();
        _intervalId = setInterval(() => {
            const jitter = Math.random() * TELEMETRY_JITTER_MS;
            setTimeout(run, jitter);
        }, TELEMETRY_INTERVAL_MS);
    }, 30_000 + Math.random() * 30_000);

    console.log('[Telemetry] scheduler started');
}

export function stopTelemetryScheduler() {
    if (_intervalId) {
        clearInterval(_intervalId);
        _intervalId = null;
    }
}
