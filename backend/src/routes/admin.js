import { verifyAdmin } from '../middleware/auth.js';
import {
    getAllAccounts, getAccountById, createAccount, updateAccountStatus, deleteAccount,
    getAllAccountsForRefresh,
    getAllApiKeys, createApiKey, updateApiKeyStatus, deleteApiKey,
    getRequestLogs, getRequestStats, getModelUsageStats,
    getSetting, setSetting
} from '../db/index.js';
import { initializeAccount, refreshAccessToken, fetchProjectId, fetchQuotaInfo, fetchDetailedQuotaInfo } from '../services/tokenManager.js';
import { accountPool } from '../services/accountPool.js';

// 仪表盘「今日」统计的时区偏移（分钟）
// 例如中国时间（UTC+8）可设置为 480，默认使用服务器本地时间（0 表示不偏移）
const DASHBOARD_TZ_OFFSET_MINUTES = Number(process.env.DASHBOARD_TZ_OFFSET_MINUTES || 0);

function getDayStart(timestamp, offsetMinutes) {
    // 将时间平移到目标时区，取该时区的 00:00，再平移回 UTC 毫秒时间戳
    const shifted = timestamp + offsetMinutes * 60 * 1000;
    const d = new Date(shifted);
    d.setHours(0, 0, 0, 0);
    return d.getTime() - offsetMinutes * 60 * 1000;
}

export default async function adminRoutes(fastify) {
    // 所有管理路由需要认证
    fastify.addHook('preHandler', verifyAdmin);

    // ==================== 仪表盘 ====================

    // GET /admin/dashboard
    fastify.get('/admin/dashboard', async () => {
        const now = Date.now();
        const todayStart = getDayStart(now, DASHBOARD_TZ_OFFSET_MINUTES);

        const accounts = getAllAccounts();
        const todayStats = getRequestStats(todayStart, now);
        const modelUsage = getModelUsageStats(todayStart, now);
        const poolStats = accountPool.getPoolStats();

        return {
            accounts: {
                total: accounts.length,
                active: accounts.filter(a => a.status === 'active').length,
                error: accounts.filter(a => a.status === 'error').length
            },
            today: {
                requests: todayStats.total_requests || 0,
                tokens: todayStats.total_tokens || 0,
                successRate: todayStats.total_requests > 0
                    ? ((todayStats.success_count / todayStats.total_requests) * 100).toFixed(1)
                    : 100,
                avgLatency: Math.round(todayStats.avg_latency || 0)
            },
            modelUsage,
            pool: poolStats
        };
    });

    // ==================== 账号管理 ====================

    // GET /admin/accounts
    fastify.get('/admin/accounts', async () => {
        const accounts = getAllAccounts();
        return { accounts };
    });

    // GET /admin/accounts/:id
    fastify.get('/admin/accounts/:id', async (request) => {
        const { id } = request.params;
        const account = getAccountById(id);

        if (!account) {
            return { error: { message: 'Account not found' } };
        }

        // 隐藏敏感信息
        delete account.refresh_token;
        delete account.access_token;

        return { account };
    });

    // POST /admin/accounts
    fastify.post('/admin/accounts', async (request, reply) => {
        const { email, refresh_token } = request.body;

        if (!email || !refresh_token) {
            return reply.code(400).send({
                error: { message: 'email and refresh_token are required' }
            });
        }

        try {
            const accountId = createAccount(email, refresh_token);
            const account = getAccountById(accountId);

            // 初始化账号（刷新 token + 获取 projectId）
            try {
                await initializeAccount(account);
            } catch (initError) {
                // 不删除账号，只是标记为 error 状态
            }

            return {
                success: true,
                accountId,
                message: 'Account created successfully'
            };
        } catch (error) {
            if (error.message.includes('UNIQUE constraint')) {
                return reply.code(400).send({
                    error: { message: 'Account with this email already exists' }
                });
            }
            throw error;
        }
    });

    // POST /admin/accounts/batch
    fastify.post('/admin/accounts/batch', async (request) => {
        const { accounts } = request.body;

        if (!Array.isArray(accounts)) {
            return { error: { message: 'accounts must be an array' } };
        }

        const results = [];

        for (const acc of accounts) {
            try {
                const accountId = createAccount(acc.email, acc.refresh_token);
                results.push({ email: acc.email, success: true, accountId });
            } catch (error) {
                results.push({ email: acc.email, success: false, error: error.message });
            }
        }

        return { results };
    });

    // PUT /admin/accounts/:id/status
    fastify.put('/admin/accounts/:id/status', async (request) => {
        const { id } = request.params;
        const { status } = request.body;

        if (!['active', 'disabled', 'error'].includes(status)) {
            return { error: { message: 'Invalid status' } };
        }

        updateAccountStatus(id, status);
        return { success: true };
    });

    // POST /admin/accounts/:id/refresh
    fastify.post('/admin/accounts/:id/refresh', async (request) => {
        const { id } = request.params;
        const account = getAccountById(id);

        if (!account) {
            return { error: { message: 'Account not found' } };
        }

        try {
            const refreshed = await refreshAccessToken(account);
            // 确保后续请求使用新 token
            account.access_token = refreshed.access_token;
            // 同步 projectId/tier（tier 历史上可能一直停留在 free-tier）
            if (!account.project_id || !account.tier || account.tier === 'free-tier') {
                await fetchProjectId(account);
            }
            await fetchQuotaInfo(account);
            return { success: true, message: 'Token refreshed' };
        } catch (error) {
            return { error: { message: error.message } };
        }
    });

    // GET /admin/accounts/:id/quota - 获取账号详细配额
    fastify.get('/admin/accounts/:id/quota', async (request) => {
        const { id } = request.params;
        const account = getAccountById(id);

        if (!account) {
            return { error: { message: 'Account not found' } };
        }

        try {
            const quotaInfo = await fetchDetailedQuotaInfo(account);
            return { success: true, data: quotaInfo };
        } catch (error) {
            return { error: { message: error.message } };
        }
    });

    // DELETE /admin/accounts/:id
    fastify.delete('/admin/accounts/:id', async (request) => {
        const { id } = request.params;
        deleteAccount(id);
        return { success: true };
    });

    // POST /admin/accounts/refresh-all
    fastify.post('/admin/accounts/refresh-all', async () => {
        const accounts = getAllAccountsForRefresh();
        const results = [];

        for (const account of accounts) {
            try {
                const refreshed = await refreshAccessToken(account);
                account.access_token = refreshed.access_token;

                // 同步 projectId/tier（强制一次，避免长期显示 free-tier）
                await fetchProjectId(account);

                // 同步配额
                await fetchQuotaInfo(account);

                results.push({ id: account.id, email: account.email, success: true });
            } catch (error) {
                results.push({ id: account.id, email: account.email, success: false, error: error.message });
            }
        }

        const successCount = results.filter(r => r.success).length;
        return {
            success: true,
            message: `Refreshed ${successCount}/${results.length} accounts (token + quota)`,
            results
        };
    });

    // ==================== API Key 管理 ====================

    // GET /admin/api-keys
    fastify.get('/admin/api-keys', async () => {
        const keys = getAllApiKeys();
        return { keys };
    });

    // POST /admin/api-keys
    fastify.post('/admin/api-keys', async (request) => {
        const { name } = request.body;
        const key = createApiKey(name || 'New Key');
        return { success: true, key };
    });

    // PUT /admin/api-keys/:id/status
    fastify.put('/admin/api-keys/:id/status', async (request) => {
        const { id } = request.params;
        const { status } = request.body;

        if (!['active', 'disabled'].includes(status)) {
            return { error: { message: 'Invalid status' } };
        }

        updateApiKeyStatus(id, status);
        return { success: true };
    });

    // DELETE /admin/api-keys/:id
    fastify.delete('/admin/api-keys/:id', async (request) => {
        const { id } = request.params;
        deleteApiKey(id);
        return { success: true };
    });

    // ==================== 请求日志 ====================

    // GET /admin/logs
    fastify.get('/admin/logs', async (request) => {
        const { limit = 100, offset = 0, model, account_id, status, start_time, end_time } = request.query;

        const logs = getRequestLogs(parseInt(limit), parseInt(offset), {
            model,
            accountId: account_id ? parseInt(account_id) : null,
            status,
            startTime: start_time ? parseInt(start_time) : null,
            endTime: end_time ? parseInt(end_time) : null
        });

        return { logs };
    });

    // GET /admin/stats
    fastify.get('/admin/stats', async (request) => {
        const { start_time, end_time } = request.query;
        const now = Date.now();
        const startTime = start_time ? parseInt(start_time) : now - 24 * 60 * 60 * 1000;
        const endTime = end_time ? parseInt(end_time) : now;

        const stats = getRequestStats(startTime, endTime);
        const modelUsage = getModelUsageStats(startTime, endTime);

        return { stats, modelUsage };
    });

    // ==================== 系统设置 ====================

    // GET /admin/settings
    fastify.get('/admin/settings', async () => {
        return {
            defaultModel: getSetting('defaultModel', 'gemini-2.5-flash'),
            pollingStrategy: getSetting('pollingStrategy', 'weighted')
        };
    });

    // PUT /admin/settings
    fastify.put('/admin/settings', async (request) => {
        const { key, value } = request.body;

        if (!key) {
            return { error: { message: 'key is required' } };
        }

        setSetting(key, value);
        return { success: true };
    });
}
