import { beforeEach, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = mockClient(DynamoDBDocumentClient);

vi.mock('@libs/middleware/dualAuth', () => ({ iamOnlyMiddleware: () => ({}) }));
vi.mock('@libs/middleware/subscription', () => ({ subscriptionMiddleware: () => ({}) }));
vi.mock('@libs/lambda', () => ({ middyfy: (h: any) => Object.assign(h, { use: () => h }) }));
vi.mock('@libs/theme/resolveLogoInput', () => ({
  resolveThemeInput: vi.fn().mockResolvedValue(
    { brand: '#000000', accent: '#ffffff', fontKey: 'inter-inter' }),
}));
import { resolveThemeInput } from '@libs/theme/resolveLogoInput';
import { updateTheme } from './handler';

beforeEach(() => { ddb.reset(); vi.clearAllMocks(); process.env.TEMPLATES_TABLE = 't'; });

it('404s when the template does not belong to the user', async () => {
  ddb.on(GetCommand).resolves({ Item: undefined });
  const res: any = await updateTheme({ userId: 'u1', pathParameters: { templateId: 'x' },
    body: { brand: '#000', accent: '#fff', fontKey: 'inter-inter' } } as any, {} as any);
  expect(res.statusCode).toBe(404);
});

it('writes the resolved theme via UpdateCommand (no content clobber)', async () => {
  ddb.on(GetCommand).resolves({ Item: { userId: 'u1', templateId: 'x', name: 'N' } });
  ddb.on(UpdateCommand).resolves({});
  const res: any = await updateTheme({ userId: 'u1', pathParameters: { templateId: 'x' },
    body: { brand: '#000', accent: '#fff', fontKey: 'inter-inter' } } as any, {} as any);
  expect(res.statusCode).toBe(200);
  expect(resolveThemeInput).toHaveBeenCalledWith('u1', expect.objectContaining({ fontKey: 'inter-inter' }));
  const call = ddb.commandCalls(UpdateCommand)[0].args[0].input;
  expect(call.UpdateExpression).toContain('#theme');
  expect(call.ExpressionAttributeValues![':theme']).toEqual(
    { brand: '#000000', accent: '#ffffff', fontKey: 'inter-inter' });
});

it('400s on invalid theme fields', async () => {
  ddb.on(GetCommand).resolves({ Item: { userId: 'u1', templateId: 'x' } });
  (resolveThemeInput as any).mockRejectedValueOnce(
    Object.assign(new Error('bad'), { name: 'ThemeValidationError' }));
  const res: any = await updateTheme({ userId: 'u1', pathParameters: { templateId: 'x' },
    body: { brand: 'red', accent: '#fff', fontKey: 'inter-inter' } } as any, {} as any);
  expect(res.statusCode).toBe(400);
});
