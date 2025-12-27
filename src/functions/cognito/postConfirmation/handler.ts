import type { PostConfirmationTriggerEvent, PostConfirmationTriggerHandler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * Cognito Post-Confirmation Trigger
 *
 * Creates user record in DynamoDB when a new user signs up.
 * This trigger fires ONCE when user is confirmed, not on every login.
 *
 * Trigger sources:
 * - PostConfirmation_ConfirmSignUp: User confirmed via email/phone or external provider
 * - PostConfirmation_ConfirmForgotPassword: User reset password (we skip this)
 */
const postConfirmation: PostConfirmationTriggerHandler = async (event: PostConfirmationTriggerEvent) => {
  console.log('PostConfirmation trigger', {
    triggerSource: event.triggerSource,
    userName: event.userName,
    userPoolId: event.userPoolId
  });

  // Only process initial signup confirmation, not password resets
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    console.log('Skipping - not a signup confirmation', { triggerSource: event.triggerSource });
    return event;
  }

  const { sub, email, name } = event.request.userAttributes;
  const isGoogleUser = event.userName.startsWith('Google_');

  console.log('Processing user confirmation', {
    userId: sub,
    email,
    isGoogleUser
  });

  try {
    // Check if user already exists (defensive check)
    const existing = await docClient.send(new GetCommand({
      TableName: process.env.USERS_TABLE!,
      Key: { userId: sub }
    }));

    if (existing.Item) {
      console.log('User already exists in DynamoDB, skipping creation', { userId: sub });
      return event;
    }

    // Create new user record
    const userRecord = {
      userId: sub,
      email: email || 'unknown',
      name: name || email?.split('@')[0] || 'User',
      authProvider: isGoogleUser ? 'google' : 'cognito',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: {
        emailNotifications: true,
        defaultTemplateSettings: {}
      }
    };

    await docClient.send(new PutCommand({
      TableName: process.env.USERS_TABLE!,
      Item: userRecord
    }));

    console.log('User created in DynamoDB', { userId: sub, email });
  } catch (error) {
    console.error('Failed to create user in DynamoDB', { error, userId: sub });
    // Don't throw - allow signup to complete even if DynamoDB write fails
    // User can be created on-demand via getProfile endpoint
  }

  return event;
};

export const main = postConfirmation;
