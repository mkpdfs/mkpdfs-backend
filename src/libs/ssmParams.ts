import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssmClient = new SSMClient({});

// Warm-container cache: each parameter is fetched at most once per container.
const cache = new Map<string, string>();

/**
 * Runtime SSM parameter lookup with in-memory caching.
 *
 * Pattern (CDK migration): lambdas receive the parameter NAME via env var
 * (e.g. STRIPE_SECRET_KEY_PARAM) and resolve the value here at runtime, so
 * secrets never live in plaintext in the Lambda environment. IAM is scoped
 * to /mkpdfs/{stage}/* per function.
 */
export async function getSsmParameter(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const response = await ssmClient.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  const value = response.Parameter?.Value ?? '';
  cache.set(name, value);
  return value;
}
