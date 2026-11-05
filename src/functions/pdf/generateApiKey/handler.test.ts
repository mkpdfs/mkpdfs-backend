import { readFileSync } from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  warmup: vi.fn(),
  generatePdf: vi.fn(),
  auth: vi.fn(),
  subscription: vi.fn(),
  creditGate: vi.fn(),
  usage: vi.fn(),
  debit: vi.fn(),
}));

vi.mock('@libs/services/pdfService', () => ({
  PdfService: class {
    warmup() {
      return m.warmup();
    }
  },
}));
vi.mock('../generate/handler', () => ({ generatePdf: m.generatePdf }));
vi.mock('@libs/middleware/dualAuth', () => ({ apiKeyOnlyMiddleware: () => ({ before: m.auth }) }));
vi.mock('@libs/middleware/subscription', () => ({
  subscriptionMiddleware: () => ({ before: m.subscription }),
}));
vi.mock('@libs/middleware/usageTracking', () => ({
  usageTrackingMiddleware: () => ({ after: m.usage }),
}));
vi.mock('@libs/middleware/credits', () => ({
  checkCreditsMiddleware: () => ({ before: m.creditGate }),
  debitCreditsMiddleware: () => ({ after: m.debit }),
}));

import { main } from './handler';
import { WARMUP_EVENT } from '@libs/warmup';

const httpEvent = (body: unknown, extra: Record<string, unknown> = {}) => ({
  httpMethod: 'POST',
  path: '/v1/pdf/generate',
  resource: '/v1/pdf/generate',
  headers: { 'content-type': 'application/json', 'x-api-key': 'tlfy_test' },
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  pathParameters: null,
  stageVariables: null,
  requestContext: {},
  isBase64Encoded: false,
  body: JSON.stringify(body),
  ...extra,
});

const billingChainCalls = () =>
  m.auth.mock.calls.length +
  m.subscription.mock.calls.length +
  m.creditGate.mock.calls.length +
  m.usage.mock.calls.length +
  m.debit.mock.calls.length +
  m.generatePdf.mock.calls.length;

describe('generateApiKey handler — scheduled warmer (obra#3909)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.warmup.mockResolvedValue({ browserReused: false, browserMs: 1700, renderMs: 40 });
    m.generatePdf.mockResolvedValue({ statusCode: 200, body: '{"pdfUrl":"https://x.invalid/a.pdf"}' });
  });

  it('answers the warmer event without auth, credits, usage or PDF generation', async () => {
    const res: any = await main({ ...WARMUP_EVENT }, {});
    expect(res.warmed).toBe(true);
    expect(res.browserMs).toBe(1700);
    expect(m.warmup).toHaveBeenCalledTimes(1);
    expect(billingChainCalls()).toBe(0);
  });

  it('a failed warm never throws (async invoke must not retry or alarm)', async () => {
    m.warmup.mockRejectedValueOnce(new Error('chromium exploded'));
    const res: any = await main({ ...WARMUP_EVENT }, {});
    expect(res).toMatchObject({ warmed: false, error: 'chromium exploded' });
    expect(billingChainCalls()).toBe(0);
  });

  it('an HTTP caller cannot reach the warm path through the JSON body', async () => {
    await main(httpEvent({ ...WARMUP_EVENT }), {});
    expect(m.warmup).not.toHaveBeenCalled();
    expect(m.auth).toHaveBeenCalledTimes(1);
  });

  it('an HTTP-shaped event with top-level warmup keys still goes through the full chain', async () => {
    await main(httpEvent({ templateId: 't' }, { ...WARMUP_EVENT }), {});
    expect(m.warmup).not.toHaveBeenCalled();
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.creditGate).toHaveBeenCalledTimes(1);
  });

  it('a normal request runs the unchanged chain in order', async () => {
    const res: any = await main(httpEvent({ templateId: 't', data: {} }), {});
    expect(res.statusCode).toBe(200);
    expect(m.auth).toHaveBeenCalledTimes(1);
    expect(m.subscription).toHaveBeenCalledTimes(1);
    expect(m.creditGate).toHaveBeenCalledTimes(1);
    expect(m.generatePdf).toHaveBeenCalledTimes(1);
    expect(m.debit).toHaveBeenCalledTimes(1);
    expect(m.warmup).not.toHaveBeenCalled();
  });

  it('the CDK rule sends exactly WARMUP_EVENT', () => {
    const stack = readFileSync(
      path.resolve(__dirname, '../../../../cdk/lib/stacks/api-stack.ts'),
      'utf8',
    );
    const match = stack.match(/RuleTargetInput\.fromObject\((\{[^}]*\})\)/);
    expect(match).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const sent = new Function(`return (${match![1]});`)();
    expect(sent).toEqual({ ...WARMUP_EVENT });
  });
});
