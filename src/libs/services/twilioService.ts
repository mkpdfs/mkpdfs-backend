import Twilio from 'twilio';

export class TwilioService {
  private client: Twilio.Twilio;
  private fromNumber: string;

  constructor(
    accountSid: string,
    apiKeySid: string,
    apiKeySecret: string,
    fromNumber: string
  ) {
    // Use API Key authentication
    this.client = Twilio(apiKeySid, apiKeySecret, { accountSid });
    this.fromNumber = fromNumber;
  }

  async sendSMS(to: string, message: string): Promise<void> {
    await this.client.messages.create({
      body: message,
      from: this.fromNumber,
      to
    });
  }
}
