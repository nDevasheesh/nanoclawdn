/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Non-Anthropic model support:
 *   When ANTHROPIC_MODEL is set to a non-Claude model (e.g. google/gemini-*,
 *   meta-llama/*), the proxy converts Anthropic-format requests to OpenAI
 *   format and calls /v1/chat/completions, then converts the response back
 *   to Anthropic format so Claude Code sees a native response.
 */
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// ---------------------------------------------------------------------------
// Request condensing helpers
// ---------------------------------------------------------------------------

function condenseRequest(
  parsed: Record<string, unknown>,
  model: string | undefined,
): void {
  // Override model
  if (model && parsed.model !== undefined) parsed.model = model;

  // Strip Claude Code-specific fields unsupported by other models
  delete parsed.thinking;
  delete parsed.output_config;
  delete parsed.metadata;
  delete parsed.stream; // we handle non-streaming for OpenAI compat

  // Cap max_tokens — 4096 gives Delo room to write a full Task call with coding prompt
  if (typeof parsed.max_tokens === 'number' && parsed.max_tokens > 4096) {
    parsed.max_tokens = 4096;
  }

  // Keep only mcp__nanoclaw__* tools and agent-spawning tools.
  // Drop heavy Claude Code code-editing tools (Bash, Read, Write, etc.) that
  // exceed non-Anthropic model context limits, but keep Task/TeamCreate so
  // Delo (Flash) can spawn Claude coding sub-agents for coding work.
  // Explicitly block schedule_task so Delo uses Task() directly for immediate work.
  const AGENT_TOOLS = new Set([
    'Task',
    'TaskOutput',
    'TaskStop',
    'TeamCreate',
    'TeamDelete',
    'SendMessage',
  ]);
  const BLOCKED_MCP_TOOLS = new Set([
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__cancel_task',
  ]);
  if (Array.isArray(parsed.tools)) {
    parsed.tools = (parsed.tools as Array<{ name: string }>).filter(
      (t) =>
        !BLOCKED_MCP_TOOLS.has(t.name) &&
        (t.name.startsWith('mcp__nanoclaw__') || AGENT_TOOLS.has(t.name)),
    );
    if ((parsed.tools as unknown[]).length === 0) delete parsed.tools;
  }

  // Flatten system array → plain string, strip billing noise
  if (Array.isArray(parsed.system)) {
    const text = (parsed.system as Array<{ type: string; text?: string }>)
      .filter((b) => {
        if (b.type !== 'text' || typeof b.text !== 'string') return false;
        if (b.text.startsWith('x-anthropic-billing-header:')) return false;
        if (b.text.startsWith('You are a Claude agent')) return false;
        return true;
      })
      .map((b) => b.text as string)
      .join('\n\n')
      .trim();
    parsed.system = text || 'You are a helpful assistant.';
  }

  // Clean messages
  if (Array.isArray(parsed.messages)) {
    let seenContext = false;
    parsed.messages = (
      parsed.messages as Array<{ role: string; content: unknown }>
    )
      .filter((msg) => {
        if (msg.role !== 'assistant') return true;
        const c = msg.content;
        if (!c) return false;
        if (typeof c === 'string')
          return c.trim() !== '' && c.trim() !== '(no content)';
        if (Array.isArray(c)) return (c as unknown[]).length > 0;
        return true;
      })
      .map((msg) => {
        const blocks: Array<{ type: string; text?: string }> = Array.isArray(
          msg.content,
        )
          ? (msg.content as Array<{ type: string; text?: string }>)
          : [{ type: 'text', text: String(msg.content) }];

        const cleaned = blocks
          .map((block) => {
            if (block.type !== 'text' || typeof block.text !== 'string')
              return block;
            let text = block.text
              .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n?/g, '')
              .trim();
            text = text.replace(/<context [^/]*\/>\n?/g, (match) => {
              if (seenContext) return '';
              seenContext = true;
              return match;
            });
            return text ? { type: 'text', text } : null;
          })
          .filter(Boolean);

        const merged = cleaned
          .filter((b) => (b as { type: string }).type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
          .trim();

        return { role: msg.role, content: merged || '…' };
      });
  }
}

// ---------------------------------------------------------------------------
// Anthropic ↔ OpenAI format conversion
// ---------------------------------------------------------------------------

function isNonAnthropicModel(model: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  return !m.startsWith('claude') && !m.startsWith('anthropic/claude');
}

function anthropicToOpenAI(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];

  // System prompt
  if (
    parsed.system &&
    typeof parsed.system === 'string' &&
    parsed.system.trim()
  ) {
    messages.push({ role: 'system', content: parsed.system });
  }

  // Conversation messages
  for (const msg of (parsed.messages as Array<{
    role: string;
    content: unknown;
  }>) || []) {
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? (msg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
          : String(msg.content);
    messages.push({ role: msg.role, content });
  }

  const out: Record<string, unknown> = {
    model: parsed.model,
    messages,
    max_tokens: parsed.max_tokens ?? 2048,
  };

  // Convert Anthropic tool defs → OpenAI function defs
  if (Array.isArray(parsed.tools) && (parsed.tools as unknown[]).length > 0) {
    out.tools = (
      parsed.tools as Array<{
        name: string;
        description: string;
        input_schema: unknown;
      }>
    ).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  return out;
}

function openAIToAnthropic(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const choices = body.choices as Array<{
    finish_reason: string;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
  const choice = choices?.[0];
  const msg = choice?.message;
  const usage = body.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;

  const content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }> = [];

  if (msg?.content) content.push({ type: 'text', text: msg.content });

  if (msg?.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        /* keep empty */
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: `msg_${String(body.id ?? 'openrouter').replace(/[^a-z0-9]/gi, '')}`,
    type: 'message',
    role: 'assistant',
    content,
    model: body.model,
    stop_reason:
      choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Proxy with OpenAI-compat bridge for non-Anthropic models
// ---------------------------------------------------------------------------

function handleOpenAIBridge(
  parsed: Record<string, unknown>,
  upstreamUrl: URL,
  apiKey: string,
  res: ServerResponse,
): void {
  const openaiBody = anthropicToOpenAI(parsed);
  const bodyBuf = Buffer.from(JSON.stringify(openaiBody), 'utf-8');
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': bodyBuf.length,
    host: upstreamUrl.host,
    authorization: `Bearer ${apiKey}`,
  };

  const BRIDGE_TIMEOUT_MS = 30_000;

  // Wall-clock timeout — fires even if OpenRouter sends headers but hangs on body
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    logger.warn(
      { timeout: BRIDGE_TIMEOUT_MS },
      'OpenAI bridge request timed out',
    );
    upstream.destroy();
    if (!res.headersSent) {
      res.writeHead(504);
      res.end('Gateway Timeout: model did not respond in time');
    }
  }, BRIDGE_TIMEOUT_MS);

  const upstream = makeRequest(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: upstreamUrl.pathname.replace(/\/$/, '') + '/chat/completions',
      method: 'POST',
      headers,
    } as RequestOptions,
    (upRes) => {
      const chunks: Buffer[] = [];
      upRes.on('data', (c: Buffer) => chunks.push(c));
      upRes.on('end', () => {
        done = true;
        clearTimeout(timer);
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const openaiResp = JSON.parse(raw) as Record<string, unknown>;
          if (openaiResp.error) {
            res.writeHead(upRes.statusCode ?? 400, {
              'content-type': 'application/json',
            });
            res.end(JSON.stringify(openaiResp));
            return;
          }
          const anthropicResp = openAIToAnthropic(openaiResp);
          const out = Buffer.from(JSON.stringify(anthropicResp), 'utf-8');
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': out.length,
          });
          res.end(out);
        } catch (e) {
          res.writeHead(502);
          res.end('Bad Gateway: format conversion failed');
        }
      });
    },
  );

  upstream.on('error', (err) => {
    done = true;
    clearTimeout(timer);
    logger.error({ err }, 'OpenAI bridge upstream error');
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  upstream.write(bodyBuf);
  upstream.end();
}

// ---------------------------------------------------------------------------
// Main proxy
// ---------------------------------------------------------------------------

/**
 * Start the credential proxy.
 * @param passthrough - When true, skip request condensing and model override.
 *   Used by the Claude proxy port so coding sub-agents reach Claude Sonnet
 *   rather than the default non-Anthropic model set in ANTHROPIC_MODEL.
 */
export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  passthrough = false,
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body = Buffer.concat(chunks);

        if (req.headers['content-type']?.includes('application/json')) {
          try {
            const parsed = JSON.parse(body.toString('utf-8')) as Record<
              string,
              unknown
            >;

            if (!passthrough) {
              condenseRequest(parsed, secrets.ANTHROPIC_MODEL);

              // Non-Anthropic model: convert to OpenAI format and bridge
              if (
                req.url?.includes('/messages') &&
                isNonAnthropicModel(parsed.model as string)
              ) {
                const apiKey = secrets.ANTHROPIC_API_KEY || oauthToken || '';
                handleOpenAIBridge(parsed, upstreamUrl, apiKey, res);
                return;
              }
            }

            body = Buffer.from(JSON.stringify(parsed), 'utf-8');
          } catch {
            // Not valid JSON — forward as-is
          }
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) headers['authorization'] = `Bearer ${oauthToken}`;
          }
        }

        const PROXY_TIMEOUT_MS = 30_000;

        // Wall-clock timeout — fires even if upstream sends headers but hangs on body
        let proxyDone = false;
        const proxyTimer = setTimeout(() => {
          if (proxyDone) return;
          proxyDone = true;
          logger.warn(
            { timeout: PROXY_TIMEOUT_MS, url: req.url },
            'Credential proxy request timed out',
          );
          upstream.destroy();
          if (!res.headersSent) {
            res.writeHead(504);
            res.end('Gateway Timeout: model did not respond in time');
          }
        }, PROXY_TIMEOUT_MS);

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
            upRes.on('end', () => {
              proxyDone = true;
              clearTimeout(proxyTimer);
            });
          },
        );

        upstream.on('error', (err) => {
          proxyDone = true;
          clearTimeout(proxyTimer);
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
