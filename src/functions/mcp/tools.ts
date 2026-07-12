import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AUTHORING_GUIDE } from './authoringGuide';
import { invokeApiKeyHandler } from './invokeApiKeyHandler';
import { main as generatePdfApiKey } from '../pdf/generateApiKey/handler';
import { main as listTemplatesApiKey } from '../templates/listTemplatesApiKey/handler';
import { main as getTemplateApiKey } from '../templates/getTemplateApiKey/handler';
import { main as uploadTemplateApiKey } from '../templates/uploadTemplateApiKey/handler';
import { main as updateTemplateApiKey } from '../templates/updateTemplateApiKey/handler';
import { main as deleteTemplateApiKey } from '../templates/deleteTemplateApiKey/handler';

export function registerTools(server: McpServer, apiKey: string): void {
  server.registerTool(
    'get_authoring_guide',
    {
      description:
        'How to write mkpdfs templates: format (plain HTML + inline CSS + Handlebars ' +
        'placeholders, rendered by headless Chromium), page size via @page CSS, the exact ' +
        'helper signatures (ifEq, gt, formatDate, formatCurrency, mkpdfsQR), {{#each}} for ' +
        'tables/loops, and a complete worked example with matching data. Call this BEFORE ' +
        'writing or editing your first template.',
    },
    async () => ({ content: [{ type: 'text' as const, text: AUTHORING_GUIDE }] }),
  );

  server.registerTool(
    'generate_pdf',
    {
      description:
        'Generate a PDF from a template and data. Returns a download URL valid for 5 days. ' +
        'The data keys must match the {{placeholders}} in the template source ' +
        '(see get_template / get_authoring_guide). Costs 1 credit per rendered page; ' +
        'a 402 error means the account is out of credits.',
      inputSchema: {
        templateId: z.string().describe('The template ID to render'),
        data: z
          .unknown()
          .describe(
            'Template data: a single object (1 page) or an array of objects (1 page each, max 50)',
          ),
      },
    },
    async (args) =>
      invokeApiKeyHandler(generatePdfApiKey, {
        apiKey,
        body: { templateId: args.templateId, data: args.data },
      }),
  );

  server.registerTool(
    'list_templates',
    { description: 'List all templates owned by this account.' },
    async () => invokeApiKeyHandler(listTemplatesApiKey, { apiKey }),
  );

  server.registerTool(
    'get_template',
    {
      description: 'Get a single template by id, including its Handlebars source.',
      inputSchema: { templateId: z.string() },
    },
    async (args) =>
      invokeApiKeyHandler(getTemplateApiKey, {
        apiKey,
        pathParameters: { templateId: args.templateId },
      }),
  );

  server.registerTool(
    'upload_template',
    {
      description:
        'Create a new template from Handlebars source — plain HTML with inline CSS plus ' +
        '{{placeholders}}; set page size with @page CSS (e.g. `@page { size: A4; margin: 2cm; }`). ' +
        'Read get_authoring_guide first for helper signatures and a worked example.',
      inputSchema: {
        name: z.string(),
        content: z
          .string()
          .describe('Handlebars template source (HTML + inline CSS), as plain text; max 6.5 MiB'),
        description: z.string().optional(),
      },
    },
    async (args) =>
      invokeApiKeyHandler(uploadTemplateApiKey, {
        apiKey,
        body: { name: args.name, content: args.content, description: args.description },
      }),
  );

  server.registerTool(
    'update_template',
    {
      description:
        "Replace an existing template's Handlebars source in place (same templateId — " +
        'use this to iterate instead of uploading a new template each time).',
      inputSchema: {
        templateId: z.string(),
        content: z
          .string()
          .describe('Full replacement Handlebars source (HTML + inline CSS), as plain text'),
      },
    },
    async (args) =>
      invokeApiKeyHandler(updateTemplateApiKey, {
        apiKey,
        pathParameters: { templateId: args.templateId },
        body: { content: args.content },
      }),
  );

  server.registerTool(
    'delete_template',
    {
      description: 'Delete a template permanently.',
      inputSchema: { templateId: z.string() },
    },
    async (args) =>
      invokeApiKeyHandler(deleteTemplateApiKey, {
        apiKey,
        pathParameters: { templateId: args.templateId },
      }),
  );
}
