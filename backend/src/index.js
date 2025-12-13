import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { SERVER_CONFIG } from './config.js';
import { initDatabase } from './db/index.js';
import { startTokenRefreshScheduler, startQuotaSyncScheduler } from './services/tokenManager.js';

import openaiRoutes from './routes/openai.js';
import anthropicRoutes from './routes/anthropic.js';
import adminRoutes from './routes/admin.js';
import oauthRoutes from './routes/oauth.js';
import authRoutes from './routes/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 确保数据目录存在
const dataDir = dirname(SERVER_CONFIG.db_path);
if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
}

// 初始化数据库
initDatabase();

// 创建 Fastify 实例
const fastify = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 50 * 1024 * 1024 // 50MB，支持大文件（如图片）
});

// 注册 CORS
await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
});

// 注册静态文件服务（前端）
const frontendPath = join(__dirname, '../../frontend/dist');
const hasFrontendDist = existsSync(frontendPath);
if (hasFrontendDist) {
    await fastify.register(fastifyStatic, {
        root: frontendPath,
        prefix: '/'
    });

    // SPA history fallback：浏览器直接刷新 /accounts 等路由时返回 index.html
    fastify.setNotFoundHandler((request, reply) => {
        const accept = String(request.headers.accept || '');
        const wantsHtml = accept.includes('text/html');

        if (request.method === 'GET' && wantsHtml) {
            return reply.sendFile('index.html');
        }

        return reply.code(404).send({
            error: {
                message: 'Not Found',
                type: 'invalid_request_error',
                code: 'not_found'
            }
        });
    });
}

// 注册路由
await fastify.register(openaiRoutes);
await fastify.register(anthropicRoutes);
await fastify.register(adminRoutes);
await fastify.register(oauthRoutes);
await fastify.register(authRoutes);

// 错误处理
fastify.setErrorHandler((error, request, reply) => {
    // OpenAI 格式的错误响应
    reply.code(error.statusCode || 500).send({
        error: {
            message: error.message || 'Internal server error',
            type: 'api_error',
            code: error.code || 'internal_error'
        }
    });
});

// 启动定时任务
startTokenRefreshScheduler();
startQuotaSyncScheduler();

// 启动服务器
const start = async () => {
    try {
        await fastify.listen({
            port: SERVER_CONFIG.port,
            host: SERVER_CONFIG.host
        });
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
};

start();

// 优雅关闭
process.on('SIGINT', async () => {
    await fastify.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await fastify.close();
    process.exit(0);
});
