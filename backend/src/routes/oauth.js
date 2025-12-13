import { OAUTH_CONFIG } from '../config.js';
import { createAccount, getAccountByEmail, updateAccountToken } from '../db/index.js';
import { initializeAccount } from '../services/tokenManager.js';

export default async function oauthRoutes(fastify) {
    // POST /oauth/exchange - 用授权码交换 token（前端传入 code 和 port）
    fastify.post('/oauth/exchange', async (request, reply) => {
        const { code, port } = request.body;

        if (!code || !port) {
            return reply.code(400).send({
                success: false,
                message: 'code和port必填'
            });
        }

        try {
            const redirectUri = `http://localhost:${port}/oauth-callback`;

            // 用 code 换取 tokens
            const tokenResponse = await fetch(OAUTH_CONFIG.token_endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    client_id: OAUTH_CONFIG.client_id,
                    client_secret: OAUTH_CONFIG.client_secret,
                    code,
                    grant_type: 'authorization_code',
                    redirect_uri: redirectUri
                })
            });

            const tokenData = await tokenResponse.json();

            if (!tokenData.access_token) {
                return reply.code(400).send({
                    success: false,
                    message: 'Token交换失败: ' + (tokenData.error_description || tokenData.error || '未知错误')
                });
            }

            const { access_token, refresh_token, expires_in } = tokenData;

            if (!refresh_token) {
                return reply.code(400).send({
                    success: false,
                    message: '未获取到refresh_token，请确保已授权离线访问'
                });
            }

            // 获取用户信息
            let email = null;
            try {
                const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: {
                        'Authorization': `Bearer ${access_token}`
                    }
                });
                const userInfo = await userInfoResponse.json();
                email = userInfo.email || null;
            } catch (emailError) {
                // ignore
            }

            // 检查账号是否已存在
            let account = email ? getAccountByEmail(email) : null;

            if (account) {
                // 更新现有账号的 token
                updateAccountToken(account.id, access_token, expires_in);
            } else {
                // 创建新账号
                const accountId = createAccount(email || `oauth_${Date.now()}`, refresh_token);
                account = { id: accountId, email, refresh_token, access_token };
            }

            // 初始化账号
            try {
                account.access_token = access_token;
                account.refresh_token = refresh_token;
                await initializeAccount(account);
            } catch (initError) {
                // ignore
            }

            return {
                success: true,
                data: {
                    email,
                    access_token,
                    refresh_token,
                    expires_in
                }
            };
        } catch (error) {
            return reply.code(500).send({
                success: false,
                message: error.message
            });
        }
    });

    // GET /oauth/config - 获取前端需要的 OAuth 配置
    fastify.get('/oauth/config', async () => {
        return {
            client_id: OAUTH_CONFIG.client_id,
            scope: OAUTH_CONFIG.scope,
            auth_endpoint: OAUTH_CONFIG.auth_endpoint
        };
    });
}
