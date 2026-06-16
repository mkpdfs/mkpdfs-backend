import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { Theme, ThemeInput } from './themeTypes';
import { validateThemeFields, ThemeValidationError } from './validateTheme';
import { fetchLogoFromUrl } from './logoIngest';

const s3Client = new S3Client({});

/**
 * Validate a ThemeInput and resolve its logo to a private S3 key owned by the
 * user. URL logos are fetched (SSRF-guarded) and stored; upload keys are
 * ownership-checked. Returns a storable Theme.
 */
export async function resolveThemeInput(userId: string, input: ThemeInput): Promise<Theme> {
  const fields = validateThemeFields(input);
  const theme: Theme = { ...fields };

  const logo = input.logo;
  if (!logo) return theme;

  const prefix = `users/${userId}/logos/`;
  if (logo.source === 'upload') {
    if (typeof logo.s3Key !== 'string' || !logo.s3Key.startsWith(prefix)) {
      throw new ThemeValidationError('logo.s3Key must be an uploaded key under your own prefix');
    }
    theme.logoKey = logo.s3Key;
  } else if (logo.source === 'url') {
    const { buffer, contentType, ext } = await fetchLogoFromUrl(logo.url);
    const key = `${prefix}${uuidv4()}.${ext}`;
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.ASSETS_BUCKET!,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      Metadata: { 'user-id': userId, 'upload-purpose': 'template-logo' },
    }));
    theme.logoKey = key;
  }
  return theme;
}
