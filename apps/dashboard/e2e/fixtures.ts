/**
 * Admin API responses for dashboard tests, in the shapes the gateway returns. `empty` is what an
 * empty database answers; `sample` is a small, busy project. Tests only: the dashboard itself
 * shows nothing but what the API returns.
 */
import type {
  ApiKey,
  CostComparisonResponse,
  CostResponse,
  InfraResponse,
  Me,
  Member,
  Metrics,
  ModelCatalog,
  ModelsResponse,
  OverviewResponse,
  Project,
  QuotaUsageResponse,
  ReliabilityResponse,
  RequestDetail,
  RequestPage,
  Role,
  SecurityResponse,
  Window,
} from '../src/api.js';

export const PROJECT_ID = '0192f5a0-0000-7000-8000-000000000001';
const USER_ID = '0192f5a0-0000-7000-8000-0000000000aa';
const KEY_ID = '0192f5a0-0000-7000-8000-0000000000bb';
const REQUEST_ID = '0192f5a0-0000-7000-8000-0000000000cc';

const window: Window = {
  range: '24h',
  from: '2026-10-20T00:00:00.000Z',
  to: '2026-10-21T00:00:00.000Z',
  granularity: 'minute',
  stepSeconds: 900,
};

const starts = Array.from({ length: 96 }, (_, i) =>
  new Date(Date.parse(window.from) + i * 900_000).toISOString(),
);

const noLatency = { avg: null, p50: null, p95: null, p99: null };

export const zeroMetrics: Metrics = {
  requests: 0,
  succeeded: 0,
  failed: 0,
  rejected: 0,
  canceled: 0,
  cacheHits: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costMicroUsd: 0,
  billedCostMicroUsd: 0,
  savedMicroUsd: 0,
  unpricedRequests: 0,
  attempts: 0,
  retries: 0,
  fallbacks: 0,
  errorRate: null,
  fallbackRate: null,
  latencyMs: noLatency,
  ttftMs: noLatency,
  outputTokensPerSecond: null,
};

const busyMetrics: Metrics = {
  requests: 120,
  succeeded: 100,
  failed: 8,
  rejected: 10,
  canceled: 2,
  cacheHits: 5,
  promptTokens: 40_000,
  completionTokens: 12_000,
  totalTokens: 52_000,
  costMicroUsd: 184_000,
  billedCostMicroUsd: 46_000,
  savedMicroUsd: 138_000,
  unpricedRequests: 4,
  attempts: 125,
  retries: 3,
  fallbacks: 2,
  errorRate: 8 / 110,
  fallbackRate: 2 / 110,
  latencyMs: { avg: 640, p50: 420, p95: 2_100, p99: 4_800 },
  ttftMs: { avg: 180, p50: 150, p95: 600, p99: 900 },
  outputTokensPerSecond: 42.5,
};

export function project(role: Role): Project {
  return {
    id: PROJECT_ID,
    name: 'Demo project',
    allowedModels: null,
    limits: { requestsPerMinute: 60, tokensPerMinute: null, concurrentRequests: 10 },
    budget: { monthlyLimitMicroUsd: 5_000_000, maxRequestCostMicroUsd: 50_000 },
    role,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

export function me(role: Role): Me {
  return {
    user: { id: USER_ID, email: 'admin@example.com' },
    projects: [{ id: PROJECT_ID, name: 'Demo project', role }],
  };
}

const key: ApiKey = {
  id: KEY_ID,
  name: 'backend',
  maskedKey: 'gw_0123456789abcdef_…',
  status: 'active',
  limits: { requestsPerMinute: null, tokensPerMinute: null, concurrentRequests: null },
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: null,
  revokedAt: null,
  rotatedTo: null,
};

/** The Playground's short-lived key, as POST .../api-keys answers; the key is a placeholder. */
const playgroundKey = {
  apiKey: {
    ...key,
    id: '0192f5a0-0000-7000-8000-0000000000dd',
    name: 'playground',
    status: 'expiring',
    expiresAt: '2099-01-01T00:00:00.000Z',
  } satisfies ApiKey,
  key: `gw_${'0'.repeat(16)}_${'0'.repeat(64)}`,
};

const members: Member[] = [
  { userId: USER_ID, email: 'admin@example.com', role: 'owner', createdAt: '2026-10-01T00:00:00Z' },
  {
    userId: '0192f5a0-0000-7000-8000-0000000000dd',
    email: 'viewer@example.com',
    role: 'viewer',
    createdAt: '2026-10-02T00:00:00Z',
  },
];

const catalog: ModelCatalog = {
  deployments: [
    {
      id: 'mock',
      provider: 'mock',
      providerModel: 'mock',
      enabled: true,
      timeoutMs: 30_000,
      streamIdleTimeoutMs: 30_000,
      maxOutputTokens: 4_096,
    },
    {
      id: 'mock-error',
      provider: 'mock',
      providerModel: 'mock',
      enabled: true,
      timeoutMs: 30_000,
      streamIdleTimeoutMs: 30_000,
      maxOutputTokens: 4_096,
    },
    {
      id: 'hosted-small',
      provider: 'openai-compatible',
      providerModel: 'small-model',
      enabled: false,
      timeoutMs: 60_000,
      streamIdleTimeoutMs: 30_000,
      maxOutputTokens: 4_096,
    },
  ],
  models: [
    {
      name: 'mock-1',
      policy: 'priority',
      targets: [{ deployment: 'mock', weight: 1 }],
      available: true,
    },
  ],
};

const requestRow = {
  id: REQUEST_ID,
  projectId: PROJECT_ID,
  apiKeyId: KEY_ID,
  model: 'mock-failover',
  deployment: 'mock',
  provider: 'mock',
  stream: true,
  status: 'success' as const,
  httpStatus: 200,
  errorCode: null,
  attemptCount: 3,
  cacheHit: false,
  endpoint: 'chat' as const,
  startedAt: '2026-10-20T12:00:00.000Z',
  latencyMs: 812,
  ttftMs: 238,
  totalTokens: 420,
  costMicroUsd: 1_250,
};

const requestDetail: RequestDetail = {
  ...requestRow,
  completedAt: '2026-10-20T12:00:00.812Z',
  usage: {
    source: 'reported',
    promptTokens: 400,
    completionTokens: 20,
    totalTokens: 420,
    costMicroUsd: 1_250,
  },
  attempts: [
    {
      id: '0192f5a0-0000-7000-8000-0000000000e1',
      attemptNumber: 1,
      deployment: 'mock-error',
      provider: 'mock',
      outcome: 'server_error',
      upstreamStatus: 500,
      routingPolicy: 'priority',
      routingReason: 'priority 1 of 2',
      latencyMs: 12,
      ttftMs: null,
    },
    {
      id: '0192f5a0-0000-7000-8000-0000000000e2',
      attemptNumber: 2,
      deployment: 'mock',
      provider: 'mock',
      outcome: 'success',
      upstreamStatus: null,
      routingPolicy: 'priority',
      routingReason: 'priority 2 of 2; fallback after mock-error failed (server_error)',
      latencyMs: 790,
      ttftMs: 226,
    },
  ],
};

type Responses = Record<string, unknown>;

/**
 * Responses by path (without the query string) for an empty database; `POST <path>` keys answer
 * that method only.
 */
export function emptyResponses(role: Role): Responses {
  return {
    '/admin/me': me(role),
    [`/admin/projects/${PROJECT_ID}`]: project(role),
    [`/admin/projects/${PROJECT_ID}/api-keys`]: { data: [] },
    [`POST /admin/projects/${PROJECT_ID}/api-keys`]: playgroundKey,
    '/v1/models': { object: 'list', data: [] },
    [`/admin/projects/${PROJECT_ID}/members`]: { data: [] },
    [`/admin/projects/${PROJECT_ID}/alerts`]: { enabled: true, destinations: [], deliveries: [] },
    [`/admin/projects/${PROJECT_ID}/routes`]: { enabled: true, models: [] },
    '/admin/models': { deployments: [], models: [] },
    '/admin/models/quotas': { deployments: [] } satisfies QuotaUsageResponse,
    '/admin/analytics/cost-comparison': {
      window,
      promptTokens: 0,
      completionTokens: 0,
      actualCostMicroUsd: 0,
      note: "Priced at list prices with this range's token counts; each model counts tokens with its own tokenizer.",
      models: [],
    } satisfies CostComparisonResponse,
    '/ready': { status: 'ready', checks: { postgres: { status: 'ok', latencyMs: 2 } } },
    '/admin/analytics/overview': {
      window,
      totals: zeroMetrics,
      series: starts.map((start) => ({
        start,
        requests: 0,
        succeeded: 0,
        failed: 0,
        rejected: 0,
        canceled: 0,
      })),
      month: { period: '2026-10', spentMicroUsd: 0 },
    } satisfies OverviewResponse,
    '/admin/analytics/requests': { window, data: [], nextCursor: null } satisfies RequestPage,
    '/admin/analytics/models': { window, data: [] } satisfies ModelsResponse,
    '/admin/analytics/cost': {
      window,
      totals: {
        requests: 0,
        totalTokens: 0,
        costMicroUsd: 0,
        billedCostMicroUsd: 0,
        savedMicroUsd: 0,
        unpricedRequests: 0,
        promptTokens: 0,
        completionTokens: 0,
      },
      byProvider: [],
      byModel: [],
      byProject: [],
      byApiKey: [],
      series: starts.map((start) => ({
        start,
        costMicroUsd: 0,
        billedCostMicroUsd: 0,
        totalTokens: 0,
      })),
      budgets: [],
      projection: {
        monthlyCostMicroUsd: null,
        reason: 'A projection needs 7 full days of data; there are 0.',
        daysOfData: 0,
      },
    } satisfies CostResponse,
    '/admin/analytics/reliability': {
      window,
      totals: zeroMetrics,
      errorsByCode: [],
      byDeployment: [],
      series: starts.map((start) => ({ start, requests: 0, failed: 0, retries: 0, fallbacks: 0 })),
      breakers: [],
      healthEvents: [],
    } satisfies ReliabilityResponse,
    '/admin/analytics/security': {
      window,
      rejected: 0,
      byCategory: [{ category: 'rate_limit', requests: 0 }],
      byCode: [],
      byApiKey: [],
      series: starts.map((start) => ({ start, rejected: 0 })),
      invalidApiKeys: { count: null, reason: 'Not attributed to a project.' },
    } satisfies SecurityResponse,
    '/admin/analytics/infra': {
      window,
      measuredAt: '2026-10-21T00:00:00.000Z',
      pipeline: {
        transport: 'redis-stream',
        streamLength: 0,
        unreadEvents: 0,
        pendingEvents: 0,
        oldestPendingAgeMs: null,
        consumers: 1,
        deadLetterLength: 0,
      },
      failedEvents: { total: 0, inWindow: 0 },
      dependencies: {},
      // A first reading: CPU and event-loop delay are not measured yet.
      instance: {
        uptimeSeconds: 5,
        residentMemoryBytes: 80_000_000,
        heapUsedBytes: 20_000_000,
        heapTotalBytes: 30_000_000,
        cpuShare: null,
        eventLoopDelayP99Ms: null,
        usageEvents: { buffered: 0, published: 0, dropped: 0 },
      },
    } satisfies InfraResponse,
  };
}

/** The two deployments of `chat-pair`, a route the sample project overrides (ADR 034). */
const pairA = { deployment: 'groq-fast', weight: 1, lastResort: false };
const pairB = { deployment: 'gemini-lite', weight: 1, lastResort: false };

/** Responses by path for a project with traffic. */
export function sampleResponses(role: Role): Responses {
  const wave = (i: number) => Math.round(4 + 3 * Math.sin(i / 6));
  return {
    ...emptyResponses(role),
    [`/admin/projects/${PROJECT_ID}/api-keys`]: { data: [key] },
    '/v1/models': {
      object: 'list',
      data: [{ id: 'mock-1', object: 'model', owned_by: 'gateway' }],
    },
    [`/admin/projects/${PROJECT_ID}/members`]: { data: members },
    [`/admin/projects/${PROJECT_ID}/alerts`]: {
      enabled: true,
      destinations: [
        {
          id: '0192f000-0000-7000-8000-0000000000d1',
          name: 'on-call',
          kind: 'discord',
          urlHint: 'https://discord.com/…abcd',
          events: ['budget', 'breaker'],
          createdAt: '2026-10-20T10:00:00.000Z',
        },
      ],
      deliveries: [
        {
          id: '0192f000-0000-7000-8000-0000000000e1',
          destinationId: '0192f000-0000-7000-8000-0000000000d1',
          destinationName: 'on-call',
          eventType: 'budget.threshold',
          status: 'delivered',
          attempts: 2,
          lastStatus: 204,
          lastError: null,
          createdAt: '2026-10-20T23:10:00.000Z',
          deliveredAt: '2026-10-20T23:10:06.000Z',
          nextAttemptAt: null,
        },
      ],
    },
    '/admin/models': catalog,
    // chat-pair overridden for this project: its second deployment moved first.
    [`/admin/projects/${PROJECT_ID}/routes`]: {
      enabled: true,
      models: [
        {
          name: 'chat-pair',
          file: { policy: 'priority', targets: [pairA, pairB] },
          override: {
            version: 2,
            route: { policy: 'weighted', targets: [{ ...pairB, weight: 3 }, pairA] },
            createdAt: '2026-10-20T22:00:00.000Z',
          },
        },
        {
          name: 'mock-1',
          file: {
            policy: 'priority',
            targets: [{ deployment: 'mock', weight: 1, lastResort: false }],
          },
          override: null,
        },
      ],
    },
    [`/admin/projects/${PROJECT_ID}/routes/chat-pair/history`]: {
      model: 'chat-pair',
      versions: [
        {
          version: 2,
          action: 'change',
          route: { policy: 'weighted', targets: [{ ...pairB, weight: 3 }, pairA] },
          rolledBackTo: null,
          createdAt: '2026-10-20T22:00:00.000Z',
          createdBy: 'owner@example.test',
        },
        {
          version: 1,
          action: 'change',
          route: { policy: 'priority', targets: [pairB, pairA] },
          rolledBackTo: null,
          createdAt: '2026-10-20T21:00:00.000Z',
          createdBy: 'owner@example.test',
        },
      ],
    },
    // The mock with a daily quota of 1,000 requests, three quarters used; mock-error cooling down.
    '/admin/models/quotas': {
      deployments: [
        {
          deployment: 'mock',
          limits: {
            requestsPerMinute: null,
            requestsPerDay: 1_000,
            tokensPerMinute: null,
            tokensPerDay: null,
          },
          minute: { requests: 2, tokens: 300 },
          today: { requests: 750, tokens: 90_000 },
          cooldownUntil: null,
        },
        {
          deployment: 'mock-error',
          limits: null,
          minute: { requests: 0, tokens: 0 },
          today: { requests: 12, tokens: 1_200 },
          cooldownUntil: '2026-10-21T12:00:30.000Z',
        },
      ],
    } satisfies QuotaUsageResponse,
    // The busy project's tokens at a free model's list price and at a reference price.
    '/admin/analytics/cost-comparison': {
      window,
      promptTokens: 40_000,
      completionTokens: 12_000,
      actualCostMicroUsd: 184_000,
      note: "Priced at list prices with this range's token counts; each model counts tokens with its own tokenizer.",
      models: [
        {
          provider: 'zai',
          model: 'glm-4.7-flash',
          reference: false,
          inputMicroUsdPerMTok: 60_500,
          outputMicroUsdPerMTok: 400_000,
          priceSince: '2026-11-03T00:00:00.000Z',
          costMicroUsd: 7_220,
        },
        {
          provider: 'gemini',
          model: 'gemini-3.1-pro-preview',
          reference: true,
          inputMicroUsdPerMTok: 2_000_000,
          outputMicroUsdPerMTok: 12_000_000,
          priceSince: '2026-11-03T00:00:00.000Z',
          costMicroUsd: 224_000,
        },
      ],
    } satisfies CostComparisonResponse,
    [`/admin/requests/${REQUEST_ID}`]: requestDetail,
    '/admin/analytics/overview': {
      window,
      totals: busyMetrics,
      series: starts.map((start, i) => ({
        start,
        requests: wave(i) + 1,
        succeeded: wave(i),
        failed: i % 12 === 0 ? 1 : 0,
        rejected: 0,
        canceled: 0,
      })),
      month: { period: '2026-10', spentMicroUsd: 1_840_000 },
    } satisfies OverviewResponse,
    '/admin/analytics/requests': {
      window,
      data: [requestRow],
      nextCursor: null,
    } satisfies RequestPage,
    '/admin/analytics/models': {
      window,
      data: [
        { model: 'mock-1', deployment: 'mock', provider: 'mock', metrics: busyMetrics },
        {
          model: 'mock-1',
          deployment: null,
          provider: null,
          metrics: { ...zeroMetrics, requests: 10, rejected: 10 },
        },
      ],
    } satisfies ModelsResponse,
    '/admin/analytics/cost': {
      window,
      totals: {
        requests: 120,
        totalTokens: 52_000,
        costMicroUsd: 184_000,
        billedCostMicroUsd: 46_000,
        savedMicroUsd: 138_000,
        unpricedRequests: 4,
        promptTokens: 40_000,
        completionTokens: 12_000,
      },
      // Groq on its free tier (list cost, nothing billed) and the mock at its demo price.
      byProvider: [
        {
          provider: 'groq',
          requests: 60,
          totalTokens: 30_000,
          costMicroUsd: 138_000,
          billedCostMicroUsd: 0,
          savedMicroUsd: 138_000,
          unpricedRequests: 0,
        },
        {
          provider: 'mock',
          requests: 46,
          totalTokens: 21_100,
          costMicroUsd: 46_000,
          billedCostMicroUsd: 46_000,
          savedMicroUsd: 0,
          unpricedRequests: 0,
        },
        {
          provider: 'openrouter',
          requests: 4,
          totalTokens: 900,
          costMicroUsd: 0,
          billedCostMicroUsd: 0,
          savedMicroUsd: 0,
          unpricedRequests: 4,
        },
      ],
      byModel: [
        { model: 'mock-1', requests: 116, totalTokens: 51_100, costMicroUsd: 184_000 },
        {
          model: 'gemma-4-31b',
          requests: 4,
          totalTokens: 900,
          costMicroUsd: 0,
          billedCostMicroUsd: 0,
          savedMicroUsd: 0,
          unpricedRequests: 4,
        },
      ],
      byProject: [
        {
          projectId: PROJECT_ID,
          projectName: 'Demo project',
          requests: 120,
          totalTokens: 52_000,
          costMicroUsd: 184_000,
        },
      ],
      byApiKey: [
        {
          apiKeyId: KEY_ID,
          name: 'backend',
          requests: 120,
          totalTokens: 52_000,
          costMicroUsd: 184_000,
        },
      ],
      series: starts.map((start, i) => ({
        start,
        costMicroUsd: wave(i) * 400,
        billedCostMicroUsd: wave(i) * 100,
        totalTokens: wave(i) * 110,
      })),
      budgets: [
        {
          projectId: PROJECT_ID,
          projectName: 'Demo project',
          period: '2026-10',
          spentMicroUsd: 4_200_000,
          budgetMicroUsd: 5_000_000,
          usedShare: 0.84,
          alert: 'warning',
        },
      ],
      projection: { monthlyCostMicroUsd: 6_100_000, reason: null, daysOfData: 12 },
    } satisfies CostResponse,
    '/admin/analytics/reliability': {
      window,
      totals: busyMetrics,
      errorsByCode: [{ status: 'error', errorCode: 'upstream_error', requests: 8 }],
      byDeployment: [
        {
          deployment: 'mock',
          provider: 'mock',
          requests: 110,
          failed: 8,
          attempts: 125,
          retries: 3,
          fallbacks: 2,
        },
      ],
      series: starts.map((start, i) => ({
        start,
        requests: wave(i),
        failed: i % 12 === 0 ? 1 : 0,
        retries: 0,
        fallbacks: 0,
      })),
      breakers: [
        {
          deployment: 'mock-error',
          instances: [
            {
              instanceId: 'gateway-1',
              state: 'open',
              reason: '5 consecutive failures',
              at: '2026-10-20T11:00:00Z',
            },
          ],
        },
      ],
      healthEvents: [
        {
          deployment: 'mock-error',
          instanceId: 'gateway-1',
          fromState: 'closed',
          toState: 'open',
          reason: '5 consecutive failures',
          occurredAt: '2026-10-20T11:00:00Z',
        },
      ],
    } satisfies ReliabilityResponse,
    '/admin/analytics/security': {
      window,
      rejected: 10,
      byCategory: [
        { category: 'rate_limit', requests: 7 },
        { category: 'budget', requests: 3 },
      ],
      byCode: [
        { errorCode: 'rpm_limit_exceeded', category: 'rate_limit', requests: 7 },
        { errorCode: 'budget_exceeded', category: 'budget', requests: 3 },
      ],
      byApiKey: [{ apiKeyId: KEY_ID, name: 'backend', requests: 10 }],
      series: starts.map((start, i) => ({ start, rejected: i % 10 === 0 ? 1 : 0 })),
      invalidApiKeys: { count: null, reason: 'Not attributed to a project.' },
    } satisfies SecurityResponse,
    '/admin/analytics/infra': {
      window,
      measuredAt: '2026-10-21T00:00:00.000Z',
      pipeline: {
        transport: 'redis-stream',
        streamLength: 42,
        unreadEvents: 3,
        pendingEvents: 1,
        oldestPendingAgeMs: 1_200,
        consumers: 1,
        deadLetterLength: 0,
      },
      failedEvents: { total: 1, inWindow: 0 },
      dependencies: {
        postgres: { status: 'ok', latencyMs: 3 },
        redis: { status: 'ok', latencyMs: 1 },
      },
      instance: {
        uptimeSeconds: 7_200,
        residentMemoryBytes: 90_596_966,
        heapUsedBytes: 25_000_000,
        heapTotalBytes: 40_000_000,
        cpuShare: 0.042,
        eventLoopDelayP99Ms: 12.5,
        usageEvents: { buffered: 0, published: 1_234, dropped: 0 },
      },
    } satisfies InfraResponse,
  };
}
