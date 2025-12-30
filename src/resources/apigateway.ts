/**
 * API Gateway Resources
 *
 * Configures CORS headers on API Gateway default responses (4XX/5XX errors).
 * Without this, browser blocks error responses due to missing CORS headers.
 *
 * Allowed origins: *.mkpdfs.com (all environments)
 */

export const apiGatewayResponses = {
  // Handle all 4XX errors (400, 401, 403, 404, etc.)
  GatewayResponseDefault4XX: {
    Type: 'AWS::ApiGateway::GatewayResponse',
    Properties: {
      ResponseParameters: {
        'gatewayresponse.header.Access-Control-Allow-Origin': "'*'",
        'gatewayresponse.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
        'gatewayresponse.header.Access-Control-Allow-Methods': "'OPTIONS,GET,POST,PUT,DELETE,PATCH'"
      },
      ResponseType: 'DEFAULT_4XX',
      RestApiId: { Ref: 'ApiGatewayRestApi' }
    }
  },

  // Handle all 5XX errors (500, 502, 503, etc.)
  GatewayResponseDefault5XX: {
    Type: 'AWS::ApiGateway::GatewayResponse',
    Properties: {
      ResponseParameters: {
        'gatewayresponse.header.Access-Control-Allow-Origin': "'*'",
        'gatewayresponse.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
        'gatewayresponse.header.Access-Control-Allow-Methods': "'OPTIONS,GET,POST,PUT,DELETE,PATCH'"
      },
      ResponseType: 'DEFAULT_5XX',
      RestApiId: { Ref: 'ApiGatewayRestApi' }
    }
  },

  // Explicit handling for Access Denied (403 from IAM authorizer)
  GatewayResponseAccessDenied: {
    Type: 'AWS::ApiGateway::GatewayResponse',
    Properties: {
      ResponseParameters: {
        'gatewayresponse.header.Access-Control-Allow-Origin': "'*'",
        'gatewayresponse.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
        'gatewayresponse.header.Access-Control-Allow-Methods': "'OPTIONS,GET,POST,PUT,DELETE,PATCH'"
      },
      ResponseType: 'ACCESS_DENIED',
      RestApiId: { Ref: 'ApiGatewayRestApi' }
    }
  },

  // Explicit handling for Unauthorized (401)
  GatewayResponseUnauthorized: {
    Type: 'AWS::ApiGateway::GatewayResponse',
    Properties: {
      ResponseParameters: {
        'gatewayresponse.header.Access-Control-Allow-Origin': "'*'",
        'gatewayresponse.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
        'gatewayresponse.header.Access-Control-Allow-Methods': "'OPTIONS,GET,POST,PUT,DELETE,PATCH'"
      },
      ResponseType: 'UNAUTHORIZED',
      RestApiId: { Ref: 'ApiGatewayRestApi' }
    }
  },

  // Explicit handling for Expired Token
  GatewayResponseExpiredToken: {
    Type: 'AWS::ApiGateway::GatewayResponse',
    Properties: {
      ResponseParameters: {
        'gatewayresponse.header.Access-Control-Allow-Origin': "'*'",
        'gatewayresponse.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
        'gatewayresponse.header.Access-Control-Allow-Methods': "'OPTIONS,GET,POST,PUT,DELETE,PATCH'"
      },
      ResponseType: 'EXPIRED_TOKEN',
      RestApiId: { Ref: 'ApiGatewayRestApi' }
    }
  }
};
