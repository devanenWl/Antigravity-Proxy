import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { SERVER_CONFIG } from '../config.js';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db = null;

export function initDatabase() {
    db = new Database(SERVER_CONFIG.db_path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // 执行 schema
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);

    // 初始化默认 API Key（如果没有）
    const keyCount = db.prepare('SELECT COUNT(*) as count FROM api_keys').get();
    if (keyCount.count === 0) {
        const defaultKey = `sk-${uuidv4().replace(/-/g, '')}`;
        db.prepare('INSERT INTO api_keys (key, name) VALUES (?, ?)').run(defaultKey, 'Default Key');
    }

    return db;
}

export function getDatabase() {
    if (!db) {
        throw new Error('Database not initialized');
    }
    return db;
}

// ==================== Account 操作 ====================

export function getAllAccounts() {
    return getDatabase().prepare(`
        SELECT id, email, status, tier, quota_remaining, quota_reset_time,
               last_used_at, error_count, last_error, created_at,
               CASE WHEN token_expires_at > ? THEN 1 ELSE 0 END as token_valid
        FROM accounts ORDER BY created_at DESC
    `).all(Date.now());
}

// 管理用途：包含 refresh_token/access_token 等字段（排除 disabled）
export function getAllAccountsForRefresh() {
    return getDatabase().prepare(`
        SELECT * FROM accounts
        WHERE status != 'disabled'
        ORDER BY created_at DESC
    `).all();
}

export function getActiveAccounts() {
    return getDatabase().prepare(`
        SELECT * FROM accounts
        WHERE status = 'active' AND quota_remaining > 0
        ORDER BY quota_remaining DESC, last_used_at ASC
    `).all();
}

export function getAccountById(id) {
    return getDatabase().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export function getAccountByEmail(email) {
    return getDatabase().prepare('SELECT * FROM accounts WHERE email = ?').get(email);
}

export function createAccount(email, refreshToken, projectId = null) {
    const stmt = getDatabase().prepare(`
        INSERT INTO accounts (email, refresh_token, project_id, created_at)
        VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(email, refreshToken, projectId, Date.now());
    return result.lastInsertRowid;
}

export function updateAccountToken(id, accessToken, expiresIn) {
    const expiresAt = Date.now() + (expiresIn * 1000);
    getDatabase().prepare(`
        UPDATE accounts SET access_token = ?, token_expires_at = ? WHERE id = ?
    `).run(accessToken, expiresAt, id);
}

export function updateAccountQuota(id, quotaRemaining, quotaResetTime) {
    getDatabase().prepare(`
        UPDATE accounts SET quota_remaining = ?, quota_reset_time = ? WHERE id = ?
    `).run(quotaRemaining, quotaResetTime, id);
}

export function updateAccountStatus(id, status, error = null) {
    if (error) {
        getDatabase().prepare(`
            UPDATE accounts SET status = ?, last_error = ?, error_count = error_count + 1 WHERE id = ?
        `).run(status, error, id);
    } else {
        getDatabase().prepare(`
            UPDATE accounts SET status = ?, error_count = 0, last_error = NULL WHERE id = ?
        `).run(status, id);
    }
}

export function updateAccountLastUsed(id) {
    getDatabase().prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
}

export function updateAccountProjectId(id, projectId) {
    getDatabase().prepare('UPDATE accounts SET project_id = ? WHERE id = ?').run(projectId, id);
}

export function updateAccountTier(id, tier) {
    getDatabase().prepare('UPDATE accounts SET tier = ? WHERE id = ?').run(tier, id);
}

export function deleteAccount(id) {
    const db = getDatabase();
    // 先将关联的日志记录的 account_id 设为 NULL
    db.prepare('UPDATE request_logs SET account_id = NULL WHERE account_id = ?').run(id);
    // 然后删除账号
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

// ==================== API Key 操作 ====================

export function getAllApiKeys() {
    return getDatabase().prepare(`
        SELECT id, key, name, status, request_count, token_count, created_at, last_used_at
        FROM api_keys ORDER BY created_at DESC
    `).all();
}

export function getApiKeyByKey(key) {
    return getDatabase().prepare('SELECT * FROM api_keys WHERE key = ? AND status = ?').get(key, 'active');
}

export function createApiKey(name) {
    const key = `sk-${uuidv4().replace(/-/g, '')}`;
    const stmt = getDatabase().prepare('INSERT INTO api_keys (key, name, created_at) VALUES (?, ?, ?)');
    stmt.run(key, name, Date.now());
    return key;
}

export function updateApiKeyUsage(id, tokens) {
    getDatabase().prepare(`
        UPDATE api_keys SET request_count = request_count + 1, token_count = token_count + ?, last_used_at = ?
        WHERE id = ?
    `).run(tokens, Date.now(), id);
}

export function updateApiKeyStatus(id, status) {
    getDatabase().prepare('UPDATE api_keys SET status = ? WHERE id = ?').run(status, id);
}

export function deleteApiKey(id) {
    const db = getDatabase();
    // 先将关联的日志记录的 api_key_id 设为 NULL
    db.prepare('UPDATE request_logs SET api_key_id = NULL WHERE api_key_id = ?').run(id);
    // 然后删除 API Key
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

// ==================== Request Log 操作 ====================

export function createRequestLog(data) {
    const stmt = getDatabase().prepare(`
        INSERT INTO request_logs (account_id, api_key_id, model, prompt_tokens, completion_tokens,
                                  total_tokens, thinking_tokens, status, latency_ms, error_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
        data.accountId,
        data.apiKeyId,
        data.model,
        data.promptTokens || 0,
        data.completionTokens || 0,
        data.totalTokens || 0,
        data.thinkingTokens || 0,
        data.status,
        data.latencyMs || 0,
        data.errorMessage || null,
        Date.now()
    );
}

export function getRequestLogs(limit = 100, offset = 0, filters = {}) {
    let sql = `
        SELECT l.*, a.email as account_email, k.name as api_key_name
        FROM request_logs l
        LEFT JOIN accounts a ON l.account_id = a.id
        LEFT JOIN api_keys k ON l.api_key_id = k.id
        WHERE 1=1
    `;
    const params = [];

    if (filters.model) {
        sql += ' AND l.model = ?';
        params.push(filters.model);
    }
    if (filters.accountId) {
        sql += ' AND l.account_id = ?';
        params.push(filters.accountId);
    }
    if (filters.status) {
        sql += ' AND l.status = ?';
        params.push(filters.status);
    }
    if (filters.startTime) {
        sql += ' AND l.created_at >= ?';
        params.push(filters.startTime);
    }
    if (filters.endTime) {
        sql += ' AND l.created_at <= ?';
        params.push(filters.endTime);
    }

    sql += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    return getDatabase().prepare(sql).all(...params);
}

export function getRequestStats(startTime, endTime) {
    return getDatabase().prepare(`
        SELECT
            COUNT(*) as total_requests,
            SUM(prompt_tokens) as total_prompt_tokens,
            SUM(completion_tokens) as total_completion_tokens,
            SUM(total_tokens) as total_tokens,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
            AVG(latency_ms) as avg_latency
        FROM request_logs
        WHERE created_at >= ? AND created_at <= ?
    `).get(startTime, endTime);
}

export function getModelUsageStats(startTime, endTime) {
    return getDatabase().prepare(`
        SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens
        FROM request_logs
        WHERE created_at >= ? AND created_at <= ?
        GROUP BY model
        ORDER BY count DESC
    `).all(startTime, endTime);
}

// ==================== Settings 操作 ====================

export function getSetting(key, defaultValue = null) {
    const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultValue;
}

export function setSetting(key, value) {
    getDatabase().prepare(`
        INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    `).run(key, JSON.stringify(value), Date.now());
}
