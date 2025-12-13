import { getActiveAccounts, updateAccountLastUsed, updateAccountStatus, updateAccountQuota } from '../db/index.js';
import { ensureValidToken, fetchQuotaInfo } from './tokenManager.js';

// 每个账号允许的最大并发请求数（防止单号被打爆）
const MAX_CONCURRENT_PER_ACCOUNT = Number(process.env.MAX_CONCURRENT_PER_ACCOUNT || 1);
// 容量耗尽后的默认冷却时间（毫秒），如果上游返回了具体秒数，会在此基础上调整
const CAPACITY_COOLDOWN_DEFAULT_MS = Number(process.env.CAPACITY_COOLDOWN_DEFAULT_MS || 3000);

/**
 * 账号池管理类
 * 实现加权轮询策略，优先使用配额多的账号
 */
class AccountPool {
    constructor() {
        this.lastAccountIndex = -1;
        this.accountLocks = new Map(); // 账号锁，防止并发问题（值为当前并发计数）
        this.capacityCooldowns = new Map(); // 账号在某个模型上的冷却期 key: `${accountId}:${model}` -> timestamp
    }

    /**
     * 获取最优账号
     * 策略：
     * 1. 筛选状态为 active 且配额 > 0 的账号
     * 2. 优先选择配额剩余最多的账号
     * 3. 如果配额相同，选择最近最少使用的账号
     */
    async getBestAccount(model = null) {
        const accounts = getActiveAccounts();

        if (accounts.length === 0) {
            throw new Error('No active accounts available');
        }

        // 按配额降序、最后使用时间升序排序
        accounts.sort((a, b) => {
            // 首先按配额排序
            if (b.quota_remaining !== a.quota_remaining) {
                return b.quota_remaining - a.quota_remaining;
            }
            // 配额相同时，优先使用最久未使用的账号
            return (a.last_used_at || 0) - (b.last_used_at || 0);
        });

        // 尝试找到一个可用的账号
        for (const account of accounts) {
            // 检查账号并发是否已满
            const lockCount = this.accountLocks.get(account.id) || 0;
            if (lockCount >= MAX_CONCURRENT_PER_ACCOUNT) {
                continue;
            }

            // 检查是否处于容量冷却期
            if (model && this.isAccountInCooldown(account.id, model)) {
                continue;
            }

            try {
                // 确保 token 有效
                const validAccount = await ensureValidToken(account);

                // 锁定账号并发
                this.lockAccount(account.id);

                // 更新最后使用时间
                updateAccountLastUsed(account.id);

                return validAccount;
            } catch (error) {
                // 继续尝试下一个账号
            }
        }

        throw new Error('No available accounts with valid tokens');
    }

    /**
     * 轮询获取账号（简单轮询，不考虑配额）
     */
    async getNextAccount() {
        const accounts = getActiveAccounts();

        if (accounts.length === 0) {
            throw new Error('No active accounts available');
        }

        // 简单轮询
        this.lastAccountIndex = (this.lastAccountIndex + 1) % accounts.length;
        const account = accounts[this.lastAccountIndex];

        try {
            const validAccount = await ensureValidToken(account);
            updateAccountLastUsed(account.id);
            return validAccount;
        } catch (error) {
            // 如果当前账号失败，尝试获取最优账号
            return this.getBestAccount();
        }
    }

    /**
     * 标记账号出错
     */
    markAccountError(accountId, error) {
        updateAccountStatus(accountId, 'error', error.message || String(error));
    }

    /**
     * 降低账号配额（请求成功后调用）
     */
    decreaseQuota(accountId, amount = 0.001) {
        // 简单的配额估算，实际配额以 API 返回为准
        const accounts = getActiveAccounts();
        const account = accounts.find(a => a.id === accountId);

        if (account) {
            const newQuota = Math.max(0, account.quota_remaining - amount);
            updateAccountQuota(accountId, newQuota, account.quota_reset_time);
        }
    }

    /**
     * 锁定账号（防止并发使用同一账号）
     */
    lockAccount(accountId) {
        const current = this.accountLocks.get(accountId) || 0;
        this.accountLocks.set(accountId, current + 1);
    }

    /**
     * 解锁账号
     */
    unlockAccount(accountId) {
        const current = this.accountLocks.get(accountId) || 0;
        if (current <= 1) {
            this.accountLocks.delete(accountId);
        } else {
            this.accountLocks.set(accountId, current - 1);
        }
    }

    /**
     * 标记账号在某个模型上容量耗尽，进入短暂冷却期
     */
    markCapacityLimited(accountId, model, message) {
        if (!accountId || !model) return;

        let cooldownMs = CAPACITY_COOLDOWN_DEFAULT_MS;

        // 尝试从错误信息中解析 reset 秒数
        if (typeof message === 'string') {
            const match = message.match(/reset after (\d+)s/i);
            if (match) {
                const seconds = parseInt(match[1], 10);
                if (!Number.isNaN(seconds) && seconds >= 0) {
                    // 稍微多加 1 秒缓冲
                    cooldownMs = (seconds + 1) * 1000;
                }
            }
        }

        const key = `${accountId}:${model}`;
        const until = Date.now() + cooldownMs;
        this.capacityCooldowns.set(key, until);
    }

    /**
     * 检查账号在某个模型上是否处于冷却期
     */
    isAccountInCooldown(accountId, model) {
        if (!accountId || !model) return false;
        const key = `${accountId}:${model}`;
        const until = this.capacityCooldowns.get(key);
        if (!until) return false;

        if (Date.now() < until) {
            return true;
        }

        // 冷却已过期，清理
        this.capacityCooldowns.delete(key);
        return false;
    }

    /**
     * 获取池状态统计
     */
    getPoolStats() {
        const accounts = getActiveAccounts();

        return {
            total: accounts.length,
            active: accounts.filter(a => a.status === 'active').length,
            avgQuota: accounts.length > 0
                ? accounts.reduce((sum, a) => sum + a.quota_remaining, 0) / accounts.length
                : 0
        };
    }

    /**
     * 刷新所有账号的配额信息
     */
    async refreshAllQuotas() {
        const accounts = getActiveAccounts();

        for (const account of accounts) {
            try {
                if (account.access_token) {
                    await fetchQuotaInfo(account);
                }
            } catch (error) {
                // ignore
            }
        }
    }
}

// 单例
export const accountPool = new AccountPool();
