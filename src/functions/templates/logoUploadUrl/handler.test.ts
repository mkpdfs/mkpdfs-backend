import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/put'),
}));
vi.mock('@libs/middleware/dualAuth', () => ({ iamOnlyMiddleware: () => ({}) }));
vi.mock('@libs/middleware/subscription', () => ({ subscriptionMiddleware: () => ({}) }));
vi.mock('@libs/lambda', () => ({ middyfy: (h: any) => Object.assign(h, { use: () => h }) }));

import { logoUploadUrl } from './handler';

beforeEach(() => { process.env.ASSETS_BUCKET = 'bucket'; });

it('returns a presigned URL + an s3Key under the user logos prefix', async () => {
  const res: any = await logoUploadUrl(
    { userId: 'u1', body: { contentType: 'image/png' } } as any, {} as any);
  const body = JSON.parse(res.body);
  expect(body.uploadUrl).toBe('https://signed.example/put');
  expect(body.s3Key).toMatch(/^users\/u1\/logos\/[0-9a-f-]+\.png$/);
});

it('rejects a disallowed content type', async () => {
  const res: any = await logoUploadUrl(
    { userId: 'u1', body: { contentType: 'image/gif' } } as any, {} as any);
  expect(res.statusCode).toBe(400);
});
