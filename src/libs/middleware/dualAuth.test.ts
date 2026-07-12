import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { validateApiToken } from './dualAuth';

const ddbMock = mockClient(DynamoDBDocumentClient);

const baseItem = {
  token: 'hashed',
  userId: 'u1',
  active: true,
  lastUsed: null,
  expiresAt: null,
};

beforeEach(() => {
  ddbMock.reset();
  process.env.TOKENS_TABLE = 'tokens-test';
});

describe('validateApiToken — expiry', () => {
  it('accepts a token without expiration', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem } });
    ddbMock.on(UpdateCommand).resolves({});
    expect(await validateApiToken('tlfy_x')).toBe('u1');
  });

  it('accepts a token whose ISO expiresAt is in the future (regression: ISO vs epoch)', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, expiresAt: future } });
    ddbMock.on(UpdateCommand).resolves({});
    expect(await validateApiToken('tlfy_x')).toBe('u1');
  });

  it('rejects a token whose ISO expiresAt is in the past', async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, expiresAt: past } });
    expect(await validateApiToken('tlfy_x')).toBeNull();
  });

  it('rejects a token with an unparseable expiresAt (fail closed)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, expiresAt: 'garbage' } });
    expect(await validateApiToken('tlfy_x')).toBeNull();
  });

  it('still accepts legacy numeric epoch expiresAt in the future', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, expiresAt: Date.now() + 60_000 } });
    ddbMock.on(UpdateCommand).resolves({});
    expect(await validateApiToken('tlfy_x')).toBe('u1');
  });
});

describe('validateApiToken — lastUsed throttle', () => {
  it('refreshes lastUsed when older than an hour', async () => {
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, lastUsed: stale } });
    ddbMock.on(UpdateCommand).resolves({});
    expect(await validateApiToken('tlfy_x')).toBe('u1');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it('skips the lastUsed write when refreshed recently', async () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    ddbMock.on(GetCommand).resolves({ Item: { ...baseItem, lastUsed: recent } });
    expect(await validateApiToken('tlfy_x')).toBe('u1');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
