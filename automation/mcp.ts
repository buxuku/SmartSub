import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { operations, toolName } from './catalog';
import { AutomationClient } from './client';
import { safeMessage } from './redact';

export async function serveMcp(client: AutomationClient) {
  const server = new Server(
    { name: 'smartsub', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'SmartSub processes local media. Use absolute paths. Discover models/providers before processing. Long operations immediately return a persisted job ID: poll tasks_get or tasks_wait, then inspect result and artifacts. A submitted job continues after disconnect. New pipelines default to automatic review gates. Secrets are write-only. Explicit provider tests may incur provider charges. For advanced configuration inspect CLI help or the SmartSub automation documentation.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: operations.map((op) => ({
      name: toolName(op.name),
      description: op.description,
      inputSchema: (zodToJsonSchema as Function)(op.schema, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as any,
      outputSchema: {
        type: 'object',
        properties: { result: {} },
        required: ['result'],
      },
      annotations: {
        readOnlyHint: op.readOnly,
        destructiveHint:
          /\.(delete|remove|write|save|update|edit|cancel|retrain)$/.test(
            op.name,
          ),
        idempotentHint: op.readOnly,
        openWorldHint: true,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const op = operations.find((o) => toolName(o.name) === request.params.name);
    try {
      if (!op) throw new Error('UNKNOWN_TOOL');
      const args = op.schema.parse(request.params.arguments || {});
      const result = await client.call(op.name, args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { result },
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: {
                code: (error as any).code || 'OPERATION_FAILED',
                message: safeMessage(
                  error instanceof Error ? error.message : error,
                ),
              },
            }),
          },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
