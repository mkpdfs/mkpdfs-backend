import { describe, expect, it, vi } from 'vitest';

vi.mock('./services/pdfService', () => ({
  PdfService: class {
    async warmup() {
      return { browserReused: false, browserMs: 1, renderMs: 1 };
    }
  },
}));

import { isWarmupEvent, runWarmup, WARMUP_EVENT } from './warmup';
import { PerfTrace } from './perf';

describe('isWarmupEvent', () => {
  it('accepts exactly the scheduled warmer payload', () => {
    expect(isWarmupEvent({ warmup: true, source: 'mkpdfs.warmer' })).toBe(true);
    expect(isWarmupEvent({ ...WARMUP_EVENT })).toBe(true);
  });

  it.each([
    ['null', null],
    ['string', 'warmup'],
    ['array', [WARMUP_EVENT]],
    ['missing source', { warmup: true }],
    ['wrong source', { warmup: true, source: 'someone.else' }],
    ['truthy, not true', { warmup: 'true', source: 'mkpdfs.warmer' }],
    ['API Gateway shape', { ...WARMUP_EVENT, httpMethod: 'POST' }],
    ['requestContext', { ...WARMUP_EVENT, requestContext: {} }],
    ['body', { ...WARMUP_EVENT, body: null }],
    ['headers', { ...WARMUP_EVENT, headers: {} }],
  ])('rejects %s', (_label, event) => {
    expect(isWarmupEvent(event)).toBe(false);
  });
});

describe('runWarmup', () => {
  it('consumes the container cold flag so the next real request reports coldStart:false', async () => {
    const first = await runWarmup();
    expect(first).toMatchObject({ warmed: true, coldStart: true });
    const second = await runWarmup();
    expect(second.coldStart).toBe(false);

    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    new PerfTrace().emit('pdf_generate');
    const line = info.mock.calls.find((c) => c[0] === '[perf]');
    expect(JSON.parse(line![1] as string).coldStart).toBe(false);
    info.mockRestore();
  });
});
