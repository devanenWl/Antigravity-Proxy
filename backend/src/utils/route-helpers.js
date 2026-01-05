export function parseResetAfterMs(message) {
    if (!message) return null;
    const m = String(message).match(/reset after (\d+)s/i);
    if (!m) return null;
    const seconds = Number.parseInt(m[1], 10);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return (seconds + 1) * 1000;
}

export function sleep(ms) {
    if (!ms || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isCapacityError(err) {
    const msg = err?.message || '';
    return (
        msg.includes('exhausted your capacity on this model') ||
        msg.includes('Resource has been exhausted') ||
        msg.includes('No capacity available') ||
        err?.upstreamStatus === 429
    );
}

/**
 * 判断是否为不可重试的错误（这类错误换号也不会成功，应直接返回给客户端）
 * - 安全拦截 / 内容审核
 * - 请求太长 / token 超限
 * - 请求格式错误
 * - 模型不存在
 */
export function isNonRetryableError(err) {
    const msg = err?.message || '';
    const msgLower = msg.toLowerCase();
    const status = err?.upstreamStatus;

    // 400 系列错误（除 429 外）通常是请求本身的问题，重试无意义
    if (status && status >= 400 && status < 500 && status !== 429) {
        return true;
    }

    // 安全拦截 / 内容审核
    if (
        msgLower.includes('blocked') ||
        msgLower.includes('safety') ||
        msgLower.includes('harmful') ||
        msgLower.includes('policy') ||
        msgLower.includes('content filter') ||
        msgLower.includes('moderation')
    ) {
        return true;
    }

    // Prompt / Token 超限
    if (
        msgLower.includes('too long') ||
        msgLower.includes('too many tokens') ||
        msgLower.includes('token limit') ||
        msgLower.includes('context length') ||
        msgLower.includes('maximum context') ||
        msgLower.includes('exceeds the limit') ||
        msgLower.includes('prompt is too large')
    ) {
        return true;
    }

    // 请求格式错误
    if (
        msgLower.includes('invalid request') ||
        msgLower.includes('invalid argument') ||
        msgLower.includes('malformed') ||
        msgLower.includes('bad request')
    ) {
        return true;
    }

    // 模型不存在
    if (
        msgLower.includes('model not found') ||
        msgLower.includes('not found') ||
        msgLower.includes('does not exist') ||
        msgLower.includes('unknown model')
    ) {
        return true;
    }

    return false;
}

export const SSE_HEADERS = Object.freeze({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
});

export const SSE_HEADERS_ANTHROPIC = Object.freeze({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
});

