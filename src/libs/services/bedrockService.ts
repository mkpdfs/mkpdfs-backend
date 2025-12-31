import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import Handlebars from 'handlebars';

const bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });

export interface GenerateTemplateOptions {
  prompt: string;
  templateType?: string;
  image?: {
    data: string;      // Base64 without data URL prefix
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  };
  previousTemplate?: string;
  feedback?: string;
}

export interface GeneratedTemplate {
  template: {
    content: string;
    name: string;
    description: string;
  };
  sampleData: Record<string, unknown>;
}

const SYSTEM_PROMPT = `You are an expert PDF template designer specializing in Handlebars templates with print-optimized CSS. Your templates are professional, well-structured, and follow best practices.

WHEN GIVEN A REFERENCE IMAGE:
1. Analyze the layout structure (headers, footers, columns, sections, grids)
2. Identify typography choices (font sizes, weights, spacing, hierarchy)
3. Recognize color schemes and apply them consistently using CSS
4. Replicate the visual hierarchy, alignment, and spacing as closely as possible
5. Convert any placeholder text or data fields to appropriate Handlebars variables
6. Ensure the generated template captures the design intent while being fully data-driven
7. If the image shows a table or list, use {{#each}} helpers appropriately
8. Match the aspect ratio and page layout (portrait/landscape) shown in the image

WHEN GIVEN FEEDBACK ON A PREVIOUS TEMPLATE:
1. Carefully analyze the feedback and identify specific changes requested
2. Preserve parts of the template that were not mentioned in the feedback
3. Apply the requested changes while maintaining overall consistency
4. Ensure the updated template still compiles and works with similar data structure

AVAILABLE HANDLEBARS HELPERS:
- {{#ifEq a b}}...{{else}}...{{/ifEq}} - Conditional equality check
- {{#gt a b}}...{{/gt}} - Greater than comparison (returns boolean)
- {{formatDate date}} - Formats date to locale string
- {{formatCurrency amount}} - Formats number as USD currency
- {{#each items}}...{{/each}} - Iterate over arrays

TEMPLATE REQUIREMENTS:
1. Use semantic HTML5 with proper print CSS
2. Include @media print styles for page breaks, margins
3. Use CSS Grid or Flexbox for layouts
4. Include @page rules for PDF sizing (A4 default)
5. Ensure all dynamic content uses Handlebars {{variable}} syntax
6. Support array iteration with {{#each items}}
7. Include conditional rendering for optional fields

CSS REQUIREMENTS:
- Use print-friendly fonts (system fonts stack)
- Include proper page-break-before, page-break-after, page-break-inside rules
- Set appropriate margins for printing
- Use border-collapse: collapse for tables
- Keep styling clean and professional

OUTPUT FORMAT:
You MUST return ONLY a valid JSON object with exactly this structure (no markdown, no explanation):
{
  "template": "<!-- Full Handlebars HTML template here -->",
  "sampleData": { /* Matching JSON data with realistic values */ },
  "suggestedName": "template-name-in-kebab-case",
  "description": "Brief description of the template"
}

IMPORTANT:
- The template must be valid Handlebars syntax
- The sampleData must contain all variables used in the template
- Generate realistic sample data (real-looking names, dates, amounts)
- Do not include any text outside the JSON object`;

export class BedrockService {
  private modelId = 'anthropic.claude-3-sonnet-20240229-v1:0';

  async generateTemplate(options: GenerateTemplateOptions): Promise<GeneratedTemplate> {
    const { prompt, templateType, image, previousTemplate, feedback } = options;

    // Build multimodal content array
    const content: Array<{ type: string; [key: string]: unknown }> = [];

    // Add image if provided (must come before text for Claude)
    if (image) {
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: image.data
        }
      });
    }

    // Build text prompt
    let userPrompt = '';

    if (image) {
      userPrompt += `I've provided a reference image. Please analyze this design and create a PDF template that matches its layout, styling, and structure as closely as possible.\n\n`;
    }

    userPrompt += `Create a professional PDF template based on this description:\n\n"${prompt}"\n\n`;

    if (templateType) {
      userPrompt += `Template type: ${templateType}\n`;
    }

    // Add iteration context if refining a previous template
    if (previousTemplate && feedback) {
      userPrompt += `\n--- ITERATION MODE ---\nHere is the previous version of the template:\n\`\`\`html\n${previousTemplate}\n\`\`\`\n\nUser feedback: "${feedback}"\n\nPlease improve the template based on this feedback while preserving parts that weren't mentioned.\n--- END ITERATION ---\n`;
    }

    userPrompt += `\nGenerate the template following all requirements in your instructions. The sample data should be realistic and demonstrate all template features including any array iterations and conditional sections.`;

    content.push({ type: 'text', text: userPrompt });

    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content }
        ]
      })
    }));

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const responseContent = responseBody.content[0]?.text;

    if (!responseContent) {
      throw new Error('No content in AI response');
    }

    return this.parseAndValidateResponse(responseContent);
  }

  private parseAndValidateResponse(content: string): GeneratedTemplate {
    // Try to extract JSON from the response
    let jsonContent = content.trim();

    // Handle markdown code blocks if present
    const jsonMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonContent = jsonMatch[1].trim();
    }

    // Try to find JSON object directly
    const objectMatch = jsonContent.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      jsonContent = objectMatch[0];
    }

    let parsed: {
      template: string;
      sampleData: Record<string, unknown>;
      suggestedName: string;
      description: string;
    };

    try {
      parsed = JSON.parse(jsonContent);
    } catch (error) {
      throw new Error(`Failed to parse AI response as JSON: ${(error as Error).message}`);
    }

    // Validate required fields
    if (!parsed.template || typeof parsed.template !== 'string') {
      throw new Error('AI response missing valid template field');
    }

    if (!parsed.sampleData || typeof parsed.sampleData !== 'object') {
      throw new Error('AI response missing valid sampleData field');
    }

    if (!parsed.suggestedName || typeof parsed.suggestedName !== 'string') {
      throw new Error('AI response missing valid suggestedName field');
    }

    // Validate Handlebars syntax
    try {
      Handlebars.compile(parsed.template);
    } catch (error) {
      throw new Error(`Generated template has invalid Handlebars syntax: ${(error as Error).message}`);
    }

    // Validate sample data works with template
    try {
      const compiledTemplate = Handlebars.compile(parsed.template);
      compiledTemplate(parsed.sampleData);
    } catch (error) {
      throw new Error(`Sample data does not match template: ${(error as Error).message}`);
    }

    return {
      template: {
        content: parsed.template,
        name: parsed.suggestedName,
        description: parsed.description || ''
      },
      sampleData: parsed.sampleData
    };
  }
}
