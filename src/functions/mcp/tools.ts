import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { invokeApiKeyHandler } from './invokeApiKeyHandler';
import { main as generatePdfApiKey } from '../pdf/generateApiKey/handler';
import { main as listTemplatesApiKey } from '../templates/listTemplatesApiKey/handler';
import { main as getTemplateApiKey } from '../templates/getTemplateApiKey/handler';
import { main as uploadTemplateApiKey } from '../templates/uploadTemplateApiKey/handler';
import { main as updateTemplateApiKey } from '../templates/updateTemplateApiKey/handler';
import { main as deleteTemplateApiKey } from '../templates/deleteTemplateApiKey/handler';

export function registerTools(server: McpServer, apiKey: string): void {
  server.registerTool(
    'generate_pdf',
    {
      description:
        'Generate a PDF from a template and data. Returns a download URL valid for 5 days.',
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
      description: 'Create a new template from Handlebars source.',
      inputSchema: {
        name: z.string(),
        content: z.string().describe('Handlebars template source, as plain text'),
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
      description: "Replace an existing template's Handlebars source in place.",
      inputSchema: { templateId: z.string(), content: z.string() },
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
