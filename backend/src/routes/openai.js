import { verifyApiKey, recordApiKeyUsage } from '../middleware/auth.js';
import { accountPool } from '../services/accountPool.js';
import { acquireModelSlot, releaseModelSlot } from '../services/rateLimiter.js';
import { streamChat, chat } from '../services/antigravity.js';
import {
    convertOpenAIToAntigravity,
    convertSSEChunk,
    convertResponse,
    extractUsageFromSSE,
    getModelsList
} from '../services/converter.js';
import { createRequestLog } from '../db/index.js';
import { isThinkingModel } from '../config.js';
import { logModelCall } from '../services/modelLogger.js';

function parseResetAfterMs(message) {
    if (!message) return null;
    const m = String(message).match(/reset after (\\d+)s/i);
    if (!m) return null;
    const seconds = Number.parseInt(m[1], 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return (seconds + 1) * 1000;
}

function sleep(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default async function openaiRoutes(fastify) {
    // POST /v1/chat/completions
    fastify.post('/v1/chat/completions', {
        preHandler: verifyApiKey
    }, async (request, reply) => {
        const startTime = Date.now();
        const openaiRequest = request.body;
        const { stream = false, model } = openaiRequest;

        let account = null;
        let usage = null;
        let status = 'success';
        let errorMessage = null;
        let modelSlotAcquired = false;
        let invokedUpstream = false;
        let responseForLog = null;
        let streamChunksForLog = null;
        let errorResponseForLog = null;

        const maxRetries = Math.max(0, Number(process.env.UPSTREAM_CAPACITY_RETRIES || 2));
        const baseRetryDelayMs = Math.max(0, Number(process.env.UPSTREAM_CAPACITY_RETRY_DELAY_MS || 1000));
        const isCapacityError = (err) => {
            const msg = err?.message || '';
            return (
                msg.includes('exhausted your capacity on this model') ||
                msg.includes('Resource has been exhausted') ||
                msg.includes('No capacity available') ||
                err?.upstreamStatus === 429
            );
        };

        try {
            // 1. 获取模型并发槽位（避免本地直接打爆上游）
            modelSlotAcquired = acquireModelSlot(model);
            if (!modelSlotAcquired) {
                status = 'error';
                errorMessage = 'Model concurrency limit reached';
                errorResponseForLog = {
                    error: {
                        message: 'Model concurrency limit reached, please retry later',
                        type: 'rate_limit_error',
                        code: 'model_concurrency_limit'
                    }
                };
                return reply.code(429).send(errorResponseForLog);
            }

            // 2/3. 先转换请求格式（requestId 固定），project 在选择账号后再注入，便于容量错误时重试切号
            const antigravityRequestBase = convertOpenAIToAntigravity(openaiRequest, '');
            const requestId = antigravityRequestBase.requestId.replace('agent-', '');

            // 4. 流式或非流式处理
            if (stream) {
                streamChunksForLog = [];
                // 设置 SSE 响应头
                reply.raw.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });

                // 处理客户端断开
                const abortController = new AbortController();
                request.raw.on('close', () => {
                    abortController.abort();
                });

                let lastUsage = null;

                try {
                    let attempt = 0;
                    while (true) {
                        attempt++;
                        account = await accountPool.getBestAccount(model);
                        const antigravityRequest = structuredClone(antigravityRequestBase);
                        antigravityRequest.project = account.project_id || '';

                        invokedUpstream = true;
                        try {
                            await streamChat(
                                account,
                                antigravityRequest,
                                (data) => {
                                    // 提取 usage 信息
                                    const extractedUsage = extractUsageFromSSE(data);
                                    if (extractedUsage) {
                                        lastUsage = extractedUsage;
                                    }

                                    // 转换并发送响应（thinking 模型返回思维链）
                                    const chunks = convertSSEChunk(data, requestId, model, isThinkingModel(model));
                                    if (chunks) {
                                        for (const chunk of chunks) {
                                            // 若 converter 生成了 error chunk，标记本次请求为 error（但仍以 SSE 方式返回）
                                            if (chunk?.error?.message) {
                                                status = 'error';
                                                errorMessage = chunk.error.message;
                                                errorResponseForLog = chunk;
                                            }
                                            streamChunksForLog.push(chunk);
                                            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
                                        }
                                    }
                                },
                                null,
                                abortController.signal
                            );

                            accountPool.markCapacityRecovered(account.id, model);
                            break;
                        } catch (err) {
                            if (abortController.signal.aborted) return;
                            if (account && isCapacityError(err)) {
                                accountPool.markCapacityLimited(account.id, model, err.message || '');
                                accountPool.unlockAccount(account.id);
                                account = null;
                                if (attempt <= maxRetries + 1 && streamChunksForLog.length === 0) {
                                    const resetMs = parseResetAfterMs(err?.message);
                                    const delay = resetMs ?? (baseRetryDelayMs * attempt);
                                    await sleep(delay);
                                    continue;
                                }
                            }
                            throw err;
                        }
                    }
                } catch (err) {
                    status = 'error';
                    errorMessage = err.message;
                    const errorChunk = {
                        error: {
                            message: err.message,
                            type: 'api_error'
                        }
                    };
                    streamChunksForLog.push(errorChunk);
                    reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                }

                // 上游有时会返回“HTTP 200 + SSE 结束”，但没有任何有效内容（例如安全拦截/空回复）
                // 这种情况下给客户端一个明确的 error chunk，避免出现“空回复且不报错”
                const hasUsefulDelta = streamChunksForLog.some((chunk) => {
                    const delta = chunk?.choices?.[0]?.delta;
                    return !!(delta && (delta.content || delta.reasoning_content || delta.tool_calls));
                });

                if (status === 'success' && !hasUsefulDelta) {
                    status = 'error';
                    errorMessage = 'Upstream returned empty response (no candidates)';
                    const errorChunk = {
                        error: {
                            message: errorMessage,
                            type: 'api_error',
                            code: 'empty_upstream_response'
                        }
                    };
                    errorResponseForLog = errorChunk;
                    streamChunksForLog.push(errorChunk);
                    reply.raw.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                }

                // 发送结束标志
                reply.raw.write('data: [DONE]\n\n');
                reply.raw.end();

                usage = lastUsage;
                responseForLog = { stream: true, chunks: streamChunksForLog, done: true };
            } else {
                // 非流式请求（thinking 模型返回思维链）
                let antigravityResponse = null;
                let attempt = 0;
                while (true) {
                    attempt++;
                    account = await accountPool.getBestAccount(model);
                    const antigravityRequest = structuredClone(antigravityRequestBase);
                    antigravityRequest.project = account.project_id || '';

                    try {
                        invokedUpstream = true;
                        antigravityResponse = await chat(account, antigravityRequest);
                        accountPool.markCapacityRecovered(account.id, model);
                        break;
                    } catch (err) {
                        if (account && isCapacityError(err)) {
                            accountPool.markCapacityLimited(account.id, model, err.message || '');
                            accountPool.unlockAccount(account.id);
                            account = null;
                            if (attempt <= maxRetries + 1) {
                                const resetMs = parseResetAfterMs(err?.message);
                                const delay = resetMs ?? (baseRetryDelayMs * attempt);
                                await sleep(delay);
                                continue;
                            }
                        }
                        throw err;
                    }
                }
                const openaiResponse = convertResponse(antigravityResponse, requestId, model, isThinkingModel(model));

                usage = {
                    promptTokens: openaiResponse.usage.prompt_tokens,
                    completionTokens: openaiResponse.usage.completion_tokens,
                    totalTokens: openaiResponse.usage.total_tokens,
                    thinkingTokens: antigravityResponse?.response?.usageMetadata?.thoughtsTokenCount || 0
                };

                responseForLog = openaiResponse;
                return responseForLog;
            }
        } catch (error) {
            status = 'error';
            errorMessage = error.message;

            const msg = error.message || '';
            const capacity = isCapacityError(error);

            // 容量耗尽：不把账号标成 error，只做短暂冷却，并返回 429
            if (account && capacity) {
                accountPool.markCapacityLimited(account.id, model, msg);
            } else if (account) {
                // 其他错误依然标记账号错误，避免持续使用异常账号
                accountPool.markAccountError(account.id, error);
            }

            const httpStatus = capacity ? 429 : 500;
            const errorCode = capacity ? 'rate_limit_exceeded' : 'internal_error';

            // 返回 OpenAI 格式的错误
            errorResponseForLog = {
                error: {
                    message: error.message,
                    type: 'api_error',
                    code: errorCode
                }
            };
            return reply.code(httpStatus).send(errorResponseForLog);
        } finally {
            // 释放模型并发槽位
            if (modelSlotAcquired) {
                releaseModelSlot(model);
            }
            // 解锁账号并发
            if (account) {
                accountPool.unlockAccount(account.id);
            }

            // 记录请求日志
            const latencyMs = Date.now() - startTime;
            createRequestLog({
                accountId: account?.id,
                apiKeyId: request.apiKey?.id,
                model,
                promptTokens: usage?.promptTokens || 0,
                completionTokens: usage?.completionTokens || 0,
                totalTokens: usage?.totalTokens || 0,
                thinkingTokens: usage?.thinkingTokens || 0,
                status,
                latencyMs,
                errorMessage
            });

            // 记录 API Key 使用量
            if (request.apiKey && usage?.totalTokens) {
                recordApiKeyUsage(request.apiKey.id, usage.totalTokens);
            }

            // 只在「调用模型」时输出日志（OpenAI 格式：完整请求与响应）
            try {
                if (invokedUpstream) {
                    logModelCall({
                        kind: 'model_call',
                        provider: 'openai',
                        endpoint: '/v1/chat/completions',
                        model,
                        stream: !!stream,
                        status,
                        latencyMs,
                        account: account ? { id: account.id, email: account.email, tier: account.tier } : null,
                        request: openaiRequest,
                        response: responseForLog,
                        errorResponse: errorResponseForLog
                    });
                }
            } catch {
                // ignore logging failure
            }
        }
    });

    // GET /v1/models
    fastify.get('/v1/models', {
        preHandler: verifyApiKey
    }, async () => {
        return getModelsList();
    });

    // GET /v1/models/:model
    fastify.get('/v1/models/:model', {
        preHandler: verifyApiKey
    }, async (request) => {
        const { model } = request.params;
        const models = getModelsList();
        const found = models.data.find(m => m.id === model);

        if (!found) {
            return {
                error: {
                    message: `Model '${model}' not found`,
                    type: 'invalid_request_error',
                    code: 'model_not_found'
                }
            };
        }

        return found;
    });

    // 健康检查（不需要认证）
    fastify.get('/health', async () => {
        const stats = accountPool.getPoolStats();
        return {
            status: 'ok',
            accounts: stats
        };
    });

    // 根路径信息
    // 单容器模式下，根路径由前端静态资源（index.html）接管
}
