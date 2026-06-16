import { beforeEach, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = mockClient(S3Client);

vi.mock('./logoIngest', async (orig) => {
  const actual = await orig<typeof import('./logoIngest')>();
  return { ...actual, fetchLogoFromUrl: vi.fn() };
});
import { fetchLogoFromUrl } from './logoIngest';
import { resolveThemeInput } from './resolveLogoInput';

beforeEach(() => { s3.reset(); vi.clearAllMocks(); process.env.ASSETS_BUCKET = 'b'; });

it('keeps a validated upload s3Key owned by the user', async () => {
  const t = await resolveThemeInput('u1',
    { brand: '#000', accent: '#fff', fontKey: 'inter-inter',
      logo: { source: 'upload', s3Key: 'users/u1/logos/abc.png' } });
  expect(t).toEqual({ brand: '#000000', accent: '#ffffff', fontKey: 'inter-inter',
    logoKey: 'users/u1/logos/abc.png' });
});

it('rejects an upload s3Key that belongs to another user', async () => {
  await expect(resolveThemeInput('u1',
    { brand: '#000', accent: '#fff', fontKey: 'inter-inter',
      logo: { source: 'upload', s3Key: 'users/u2/logos/abc.png' } })).rejects.toThrow();
});

it('ingests a url logo to private S3 and returns its key', async () => {
  (fetchLogoFromUrl as any).mockResolvedValue({
    buffer: Buffer.from('x'), contentType: 'image/png', ext: 'png' });
  s3.on(PutObjectCommand).resolves({});
  const t = await resolveThemeInput('u1',
    { brand: '#000', accent: '#fff', fontKey: 'inter-inter',
      logo: { source: 'url', url: 'https://cdn.example.com/l.png' } });
  expect(t.logoKey).toMatch(/^users\/u1\/logos\/[0-9a-f-]+\.png$/);
  expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
});

it('omits logoKey when no logo is provided', async () => {
  const t = await resolveThemeInput('u1',
    { brand: '#000', accent: '#fff', fontKey: 'inter-inter' });
  expect(t.logoKey).toBeUndefined();
});
