import { ValidatedEventAPIGatewayProxyEvent, formatJSONResponse, formatErrorResponse } from '@libs/apiGateway';
import { middyfy } from '@libs/lambda';
import { iamOnlyMiddleware } from '@libs/middleware/dualAuth';
import { listLedgerEntries } from '@libs/services/creditService';

const handler: ValidatedEventAPIGatewayProxyEvent<null> = async (event: any) => {
  try {
    const userId = event.userId!;
    const entries = await listLedgerEntries(userId, 50);
    return formatJSONResponse({
      success: true,
      entries: entries.map((e) => ({
        entryId: e.entryId,
        type: e.type,
        amount: e.amount,
        balanceAfter: e.balanceAfter,
        description: e.description,
        createdAt: e.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing ledger:', error);
    return formatErrorResponse(error);
  }
};

export const main = middyfy(handler)
  .use(iamOnlyMiddleware());
