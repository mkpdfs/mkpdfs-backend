import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export function buildWebRequest(event: APIGatewayProxyEvent): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value != null) headers.set(key, value);
  }

  const host = event.headers?.['Host'] || event.headers?.['host'] || 'mkpdfs.internal';
  const url = `https://${host}${event.path}`;

  const rawBody = event.body
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body)
    : undefined;

  return new Request(url, {
    method: event.httpMethod,
    headers,
    body: rawBody,
  });
}

export async function toApiGatewayResult(res: Response): Promise<APIGatewayProxyResult> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
  };
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: res.status,
    headers,
    body: await res.text(),
  };
}
