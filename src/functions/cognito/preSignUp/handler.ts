import type { PreSignUpTriggerEvent, PreSignUpTriggerHandler } from 'aws-lambda';

/**
 * Cognito Pre-SignUp Trigger
 *
 * Auto-confirms users signing up via external providers (Google OAuth)
 * since Google already verified their email.
 */
const preSignUp: PreSignUpTriggerHandler = async (event: PreSignUpTriggerEvent) => {
  console.log('PreSignUp trigger', {
    triggerSource: event.triggerSource,
    userName: event.userName,
    userPoolId: event.userPoolId
  });

  // Auto-confirm users signing up via external providers (Google OAuth)
  if (event.triggerSource === 'PreSignUp_ExternalProvider') {
    console.log('External provider signup - auto-confirming', {
      userName: event.userName,
      provider: event.userName.split('_')[0]
    });

    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }

  return event;
};

export const main = preSignUp;
