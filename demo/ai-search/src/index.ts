// Lambda (function URL) behind the demo site's AI search. Demo-only — not part of the library.
//
// POST {question, locale, fields} → {query}, through the library's own server helper.
// Environment: AI_SEARCH_PROVIDER (anthropic | openai), AI_SEARCH_MODEL (required for OpenAI), and
// the API key — read once per cold start from the SSM SecureString named by AI_SEARCH_KEY_PARAM,
// or else from the provider's own variable (ANTHROPIC_API_KEY / OPENAI_API_KEY).
import {GetParameterCommand, SSMClient} from '@aws-sdk/client-ssm';
import {type AiSearchProvider, createAiSearch} from '../../../packages/everygrid/src/ai-server';

async function init() {
  const param = process.env.AI_SEARCH_KEY_PARAM;
  const apiKey = param
    ? (await new SSMClient({}).send(new GetParameterCommand({Name: param, WithDecryption: true}))).Parameter?.Value
    : undefined;
  return createAiSearch({
    provider: (process.env.AI_SEARCH_PROVIDER || undefined) as AiSearchProvider | undefined,
    model: process.env.AI_SEARCH_MODEL || undefined,
    apiKey,
  });
}
// Once per container; a failed key fetch is forgotten so the next request tries again.
let ready: ReturnType<typeof init> | null = null;
const search = () => (ready ??= init().catch((e: unknown) => { ready = null; throw e; }));

interface UrlEvent {
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: {http?: {method?: string}};
}

const reply = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: {'content-type': 'application/json'},
  body: JSON.stringify(body),
});

export const handler = async (event: UrlEvent) => {
  if (event.requestContext?.http?.method !== 'POST') { return reply(405, {error: 'POST only'}); }
  let body: unknown;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? ''));
  } catch {
    return reply(400, {error: 'Body must be JSON'});
  }
  const result = await (await search())(body);
  return reply(result.status, result.body);
};
