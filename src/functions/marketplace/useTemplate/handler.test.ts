import { beforeEach, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, CopyObjectCommand } from '@aws-sdk/client-s3';

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);

vi.mock('@libs/middleware/dualAuth', () => ({ iamOnlyMiddleware: () => ({}) }));
vi.mock('@libs/middleware/subscription', () => ({ subscriptionMiddleware: () => ({}) }));
vi.mock('@libs/lambda', () => ({ middyfy: (h: any) => Object.assign(h, { use: () => h }) }));
vi.mock('@libs/theme/resolveLogoInput', () => ({
  resolveThemeInput: vi.fn().mockResolvedValue(
    { brand: '#000000', accent: '#ffffff', fontKey: 'inter-inter' }),
}));
import { main as useTemplate } from './handler';

beforeEach(() => {
  ddb.reset(); s3.reset(); vi.clearAllMocks();
  process.env.MARKETPLACE_TABLE = 'mp'; process.env.TEMPLATES_TABLE = 't'; process.env.ASSETS_BUCKET = 'b';
  ddb.on(GetCommand).resolves({ Item: { templateId: 'mp-x', name: 'X', s3Key: 'marketplace/x.hbs' } });
  ddb.on(QueryCommand).resolves({ Count: 0 });
  ddb.on(PutCommand).resolves({});
  ddb.on(UpdateCommand).resolves({});
  s3.on(CopyObjectCommand).resolves({ VersionId: 'ver-123' });
});

it('persists the resolved theme and the S3 content version on the new row', async () => {
  const res: any = await useTemplate({ userId: 'u1', pathParameters: { templateId: 'mp-x' },
    subscriptionLimits: { templatesAllowed: -1 },
    body: { theme: { brand: '#000', accent: '#fff', fontKey: 'inter-inter' } } } as any, {} as any);
  expect(res.statusCode).toBe(201);
  const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item as any;
  expect(item.theme).toEqual({ brand: '#000000', accent: '#ffffff', fontKey: 'inter-inter' });
  expect(item.contentVersion).toBe('ver-123');
});

it('works with no theme (theme omitted from the row)', async () => {
  const res: any = await useTemplate({ userId: 'u1', pathParameters: { templateId: 'mp-x' },
    subscriptionLimits: { templatesAllowed: -1 }, body: {} } as any, {} as any);
  expect(res.statusCode).toBe(201);
  const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item as any;
  expect(item.theme).toBeUndefined();
});
