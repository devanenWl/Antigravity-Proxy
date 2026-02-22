/**
 * Trajectory Analytics 上报
 * 在每次成功 API 响应后向上游发送伪造的使用轨迹数据，
 * 模拟真实 Antigravity 客户端的行为。
 *
 * 参考：antigravity2api-nodejs/src/utils/trajectory.js
 */
import crypto from 'crypto';
import { ANTIGRAVITY_CONFIG } from '../config.js';
import { fingerprintFetch } from '../runtime/fingerprint-requester.js';
import { QA_PAIRS } from '../constants/qaPairs.js';

const BASE_URL = ANTIGRAVITY_CONFIG.base_url;
const USER_AGENT = ANTIGRAVITY_CONFIG.user_agent;
const AG_VERSION = USER_AGENT.match(/antigravity\/([\d.]+)/)?.[1] || '1.18.3';

// 模块级持久 deviceId（与 antigravity2api 一致，模块加载时生成一次）
let deviceId = crypto.randomUUID();

function generateCreatedAt() {
    const now = new Date();
    const nanos = String(now.getMilliseconds()).padStart(3, '0') + '000000';
    return now.toISOString().replace(/\.\d{3}Z$/, `.${nanos}Z`);
}

function randomQAPair() {
    return QA_PAIRS[Math.floor(Math.random() * QA_PAIRS.length)];
}

function generateMetadata(account) {
    return {
        deviceFingerprint: account.device_fingerprint || deviceId,
        extensionName: 'antigravity',
        extensionPath: 'd:\\Antigravity\\resources\\app\\extensions\\antigravity',
        hardware: 'amd64',
        ideName: 'antigravity',
        ideVersion: AG_VERSION,
        locale: 'en',
        os: 'windows',
        regionCode: 'US',
        userTierId: account.tier || 'g1-pro-tier'
    };
}

function buildGeneratorMetadata(qa) {
    const createdAt = generateCreatedAt();
    return [
        {
            chatModel: {
                chatStartMetadata: {
                    cacheBreakpoints: [
                        {
                            contentChecksum: crypto.randomBytes(4).toString('hex'),
                            index: 1,
                            options: {
                                type: 'CACHE_CONTROL_TYPE_EPHEMERAL'
                            }
                        }
                    ],
                    checkpointIndex: -1,
                    contextWindowMetadata: {
                        estimatedTokensUsed: 2500 + Math.floor(Math.random() * 2000)
                    },
                    createdAt,
                    latestStableMessageIndex: 1,
                    systemPromptCache: {
                        contentChecksum: crypto.randomBytes(4).toString('hex'),
                        options: {
                            type: 'CACHE_CONTROL_TYPE_EPHEMERAL'
                        }
                    },
                    timeSinceLastInvocation: '0s',
                    completionConfig: {
                        fimEotProbThreshold: 1,
                        firstTemperature: 0.4,
                        maxNewlines: '200',
                        maxTokens: '16384',
                        numCompletions: 1,
                        stopPatterns: [
                            '<|user|>',
                            '<|bot|>',
                            '<|context_request|>',
                            '<|endoftext|>',
                            '<|end_of_turn|>'
                        ],
                        temperature: 0.4,
                        topK: '50',
                        topP: 1
                    },
                    lastCacheIndex: 1,
                    messageMetadata: [
                        {},
                        { messageIndex: 1 },
                        { messageIndex: 2 },
                        { messageIndex: 3 },
                        { messageIndex: 4 },
                        { messageIndex: 5 },
                        { messageIndex: 6 },
                        { messageIndex: 6, segmentIndex: 1 }
                    ],
                    messagePrompts: [
                        {
                            prompt: `<user_information>\nThe USER's OS version is windows.\nThe user does not have any active workspace. If the user's request involves creating a new project, you should create a reasonable subdirectory inside the default project directory at C:\\Users\\user\\.gemini\\antigravity\\scratch.\n</user_information>`,
                            source: 'CHAT_MESSAGE_SOURCE_USER'
                        },
                        {
                            prompt: `<agentic_mode_overview>\nArtifact Directory Path: C:\\Users\\user\\.gemini\\antigravity\\brain\\${crypto.randomUUID()}\n</agentic_mode_overview>`,
                            promptCacheOptions: { type: 'CACHE_CONTROL_TYPE_EPHEMERAL' },
                            source: 'CHAT_MESSAGE_SOURCE_USER'
                        },
                        {
                            prompt: '<user_rules>\nThe user has not defined any custom rules.\n</user_rules>',
                            source: 'CHAT_MESSAGE_SOURCE_USER'
                        },
                        {
                            numTokens: 100 + Math.floor(Math.random() * 50),
                            prompt: `Step Id: 0\n\n<USER_REQUEST>\n${qa.question}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${new Date().toISOString().replace('Z', '+08:00')}.\n</ADDITIONAL_METADATA>`,
                            safeForCodeTelemetry: true,
                            source: 'CHAT_MESSAGE_SOURCE_USER'
                        },
                        {
                            prompt: qa.answer,
                            source: 'CHAT_MESSAGE_SOURCE_SYSTEM',
                            stepIdx: 3
                        }
                    ],
                    model: 'MODEL_PLACEHOLDER_M12',
                    promptSections: [
                        {
                            content: '<identity>\nYou are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.\nYou are pair programming with a USER to solve their coding task.\n</identity>',
                            metadata: {
                                sourceType: 'PROMPT_SECTION_SOURCE_TYPE_TEMPLATE',
                                templateKey: 'identity'
                            },
                            title: 'identity'
                        },
                        {
                            dynamicContent: `<user_information>\nThe USER's OS version is windows.\n</user_information>`,
                            title: 'user_information'
                        }
                    ]
                }
            }
        }
    ];
}

function buildTrajectoryPayload(account) {
    const qa = randomQAPair();
    const cascadeId = crypto.randomUUID();
    const trajectoryId = crypto.randomUUID();

    return {
        trajectory: {
            cascadeId,
            trajectoryId,
            trajectoryType: 'CHAT',
            executorMetadatas: [{
                lastStepIdx: 4,
                numGeneratorInvocations: 1,
                terminationReason: 'EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL'
            }],
            generatorMetadata: buildGeneratorMetadata(qa),
            metadata: {
                createdAt: generateCreatedAt(),
                initializationStateId: crypto.randomUUID()
            }
        },
        metadata: generateMetadata(account)
    };
}

/**
 * 向上游发送 Trajectory Analytics 数据（fire-and-forget）
 * @param {Object} account - 包含 access_token, device_fingerprint, tier 等的账号对象
 * @param {string} _model - 使用的模型名称（未使用，payload 中使用 MODEL_PLACEHOLDER_M12）
 */
export async function sendTrajectoryAnalytics(account, _model) {
    if (!account?.access_token) return;

    try {
        await fingerprintFetch(`${BASE_URL}/v1internal:recordTrajectoryAnalytics`, {
            method: 'POST',
            headers: {
                'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
                'User-Agent': USER_AGENT,
                'Authorization': `Bearer ${account.access_token}`,
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip'
            },
            body: JSON.stringify(buildTrajectoryPayload(account))
        });
    } catch { /* fire-and-forget，静默失败 */ }
}
