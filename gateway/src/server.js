import express from 'express';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const GATEWAY_CONFIG_PATH =
  process.env.GATEWAY_CONFIG_PATH || path.join(repoRoot, '.mini-agent', 'gateway-config.json');

const PORT = Number(process.env.PORT || 3000);
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const SANDBOX_MODULE = process.env.SANDBOX_MODULE || 'mini_agent_sandbox.cli';
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 5000);
const MAX_TIMEOUT_MS = Number(process.env.MAX_TIMEOUT_MS || 10000);
const DEFAULT_FILE_NAME = process.env.DEFAULT_FILE_NAME || 'generated.py';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000);
const DEFAULT_LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const DEFAULT_LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const DEFAULT_LLM_API_KEY = process.env.LLM_API_KEY || '';
const DEFAULT_CONTEXT_HISTORY_LIMIT = Number(process.env.CONTEXT_HISTORY_LIMIT || 10);
const MAX_CONTEXT_PREVIEW_LENGTH = Number(process.env.MAX_CONTEXT_PREVIEW_LENGTH || 4000);
const sessionCleanupTimers = new Map();

async function readGatewayConfigFile() {
  try {
    const raw = await readFile(GATEWAY_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Gateway config must be a JSON object');
    }

    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    throw new Error(`Failed to read gateway config: ${error.message}`);
  }
}

function normalizeOptionalString(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  return value.trim();
}

function normalizeGatewayConfigInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config body must be a JSON object');
  }

  return {
    llmApiKey: normalizeOptionalString(input.llmApiKey, 'llmApiKey'),
    llmApiUrl: normalizeOptionalString(input.llmApiUrl, 'llmApiUrl'),
    llmModel: normalizeOptionalString(input.llmModel, 'llmModel'),
  };
}

function sanitizeGatewayConfig(config) {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

function clampHistoryLimit(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_CONTEXT_HISTORY_LIMIT;
  }

  return Math.min(Math.max(1, Math.floor(value)), 100);
}

function truncateForContext(value, maxLength = MAX_CONTEXT_PREVIEW_LENGTH) {
  if (typeof value !== 'string') {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function normalizeContextEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  if (typeof entry.type !== 'string' || typeof entry.content !== 'string') {
    return null;
  }

  return {
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : new Date().toISOString(),
    sessionId: typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : null,
    type: entry.type,
    content: entry.content,
    metadata: entry.metadata && typeof entry.metadata === 'object' && !Array.isArray(entry.metadata) ? entry.metadata : {},
  };
}

function getContextHistoryFromConfig(config) {
  if (!Array.isArray(config.contextHistory)) {
    return [];
  }

  return config.contextHistory.map(normalizeContextEntry).filter(Boolean);
}

function buildContextEntry({ sessionId = null, type, content, metadata = {} }) {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    type,
    content: truncateForContext(content),
    metadata,
  };
}

async function appendContextHistory(entries, limit = DEFAULT_CONTEXT_HISTORY_LIMIT) {
  const currentConfig = await readGatewayConfigFile();
  const normalizedEntries = (Array.isArray(entries) ? entries : [entries]).map(normalizeContextEntry).filter(Boolean);
  const historyLimit = clampHistoryLimit(limit);
  const existingHistory = getContextHistoryFromConfig(currentConfig);
  const mergedHistory = [...existingHistory, ...normalizedEntries];
  const scopedSessionIds = [...new Set(normalizedEntries.map((entry) => entry.sessionId).filter(Boolean))];

  let nextHistory = mergedHistory;
  for (const sessionId of scopedSessionIds) {
    const sessionEntries = nextHistory.filter((entry) => entry.sessionId === sessionId).slice(-historyLimit);
    const otherEntries = nextHistory.filter((entry) => entry.sessionId !== sessionId);
    nextHistory = [...otherEntries, ...sessionEntries].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  const mergedConfig = {
    ...currentConfig,
    contextHistory: nextHistory,
  };

  await writeGatewayConfigFile(mergedConfig);
  return mergedConfig.contextHistory;
}

async function getRecentContextHistory({ sessionId = null, limit = DEFAULT_CONTEXT_HISTORY_LIMIT } = {}) {
  const config = await readGatewayConfigFile();
  const history = getContextHistoryFromConfig(config);
  const filteredHistory = sessionId ? history.filter((entry) => entry.sessionId === sessionId) : history;
  return filteredHistory.slice(-clampHistoryLimit(limit));
}

async function clearContextHistory({ sessionId = null } = {}) {
  const currentConfig = await readGatewayConfigFile();
  const nextHistory = sessionId
    ? getContextHistoryFromConfig(currentConfig).filter((entry) => entry.sessionId !== sessionId)
    : [];

  await writeGatewayConfigFile({
    ...currentConfig,
    contextHistory: nextHistory,
  });

  return nextHistory;
}

function formatContextHistoryForPrompt(entries) {
  if (!entries.length) {
    return null;
  }

  const lines = entries.map((entry, index) => {
    const sessionLine = entry.sessionId ? ` session=${entry.sessionId}` : '';
    return [
      `#${index + 1} [${entry.timestamp}] type=${entry.type}${sessionLine}`,
      entry.content,
    ].join('\n');
  });

  return [
    'Recent cached interaction context follows.',
    'Use it only as supporting context. Prioritize the current user request if there is any conflict.',
    ...lines,
  ].join('\n\n');
}

async function writeGatewayConfigFile(config) {
  await mkdir(path.dirname(GATEWAY_CONFIG_PATH), { recursive: true });
  await writeFile(GATEWAY_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function updateGatewayConfig(nextConfig) {
  const currentConfig = await readGatewayConfigFile();
  const normalizedInput = normalizeGatewayConfigInput(nextConfig);
  const mergedConfig = sanitizeGatewayConfig({
    ...currentConfig,
    ...normalizedInput,
  });

  await writeGatewayConfigFile(mergedConfig);
  return mergedConfig;
}

async function getLlmConfig() {
  const fileConfig = await readGatewayConfigFile();
  const llmApiKey = fileConfig.llmApiKey || DEFAULT_LLM_API_KEY;
  const llmApiUrl = fileConfig.llmApiUrl || DEFAULT_LLM_API_URL;
  const llmModel = fileConfig.llmModel || DEFAULT_LLM_MODEL;

  return {
    llmApiKey,
    llmApiUrl,
    llmModel,
    source: {
      llmApiKey: fileConfig.llmApiKey ? 'config' : 'env',
      llmApiUrl: fileConfig.llmApiUrl ? 'config' : 'env',
      llmModel: fileConfig.llmModel ? 'config' : 'env',
    },
  };
}

async function buildGatewayConfigResponse() {
  const fileConfig = await readGatewayConfigFile();
  const effectiveConfig = await getLlmConfig();
  const contextHistory = getContextHistoryFromConfig(fileConfig);

  return {
    configPath: GATEWAY_CONFIG_PATH,
    persisted: {
      hasConfigFile:
        fileConfig.llmApiKey !== undefined || fileConfig.llmApiUrl !== undefined || fileConfig.llmModel !== undefined,
      llmApiKeyConfigured: Boolean(fileConfig.llmApiKey),
      llmApiUrl: fileConfig.llmApiUrl || null,
      llmModel: fileConfig.llmModel || null,
    },
    effective: {
      llmApiKeyConfigured: Boolean(effectiveConfig.llmApiKey),
      llmApiUrl: effectiveConfig.llmApiUrl,
      llmModel: effectiveConfig.llmModel,
      source: effectiveConfig.source,
    },
    contextCache: {
      limit: DEFAULT_CONTEXT_HISTORY_LIMIT,
      size: contextHistory.length,
      latestSessionId: contextHistory.at(-1)?.sessionId || null,
      sessionScoped: true,
    },
  };
}

function clampTimeout(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(1, value), MAX_TIMEOUT_MS);
}

function stripCodeFences(content) {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:python)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function parseJsonOutput(stdout, fallbackMessage) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${fallbackMessage}: ${stdout || error.message}`);
  }
}

function getStatusCode(error) {
  if (error.message.includes('Sandbox session not found')) {
    return 404;
  }
  return 500;
}

function buildSessionResponse(session, cleanupAt = null) {
  return {
    ...session,
    cleanup_at: cleanupAt,
  };
}

function getCleanupAt() {
  return new Date(Date.now() + SESSION_TTL_MS).toISOString();
}

function clearSessionCleanup(sessionId) {
  const existing = sessionCleanupTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    sessionCleanupTimers.delete(sessionId);
  }
}

function scheduleSessionCleanup(sessionId) {
  clearSessionCleanup(sessionId);
  const cleanupAt = getCleanupAt();
  const timer = setTimeout(async () => {
    try {
      await cleanupSandboxSession(sessionId);
    } catch (_error) {
      // Ignore cleanup failures during background expiry.
    } finally {
      sessionCleanupTimers.delete(sessionId);
    }
  }, SESSION_TTL_MS);
  timer.unref?.();
  sessionCleanupTimers.set(sessionId, timer);
  return cleanupAt;
}

function runPythonCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, ['-m', SANDBOX_MODULE, ...args], {
      cwd: repoRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `sandbox cli exited with code ${code}`));
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function createSandboxSession() {
  const result = await runPythonCli(['create-session']);
  return parseJsonOutput(result.stdout, 'Failed to parse create-session output');
}

async function writeSandboxFile(sessionId, relativePath, content) {
  const result = await runPythonCli(['write-file', sessionId, relativePath, '--stdin'], { stdin: content });
  return parseJsonOutput(result.stdout, 'Failed to parse write-file output');
}

async function runSandboxScript(sessionId, script, timeoutMs, scriptArgs = []) {
  const result = await runPythonCli([
    'run',
    sessionId,
    script,
    ...scriptArgs,
    '--timeout-ms',
    String(timeoutMs),
  ]);
  return parseJsonOutput(result.stdout, 'Failed to parse run output');
}

async function cleanupSandboxSession(sessionId) {
  const result = await runPythonCli(['cleanup-session', sessionId]);
  return parseJsonOutput(result.stdout, 'Failed to parse cleanup output');
}

async function generatePythonCode(prompt, options = {}) {
  const { contextLimit = DEFAULT_CONTEXT_HISTORY_LIMIT, sessionId = null } = options;
  const { llmApiKey, llmApiUrl, llmModel } = await getLlmConfig();
  const recentContext = await getRecentContextHistory({ sessionId, limit: contextLimit });
  const contextMessage = formatContextHistoryForPrompt(recentContext);

  if (!llmApiKey) {
    throw new Error('LLM_API_KEY is not set');
  }

  const messages = [
    {
      role: 'system',
      content:
        'You generate runnable Python scripts only. Return code only, no markdown fences, no explanations. The script must write useful stdout for the user request.',
    },
  ];

  if (contextMessage) {
    messages.push({
      role: 'system',
      content: contextMessage,
    });
  }

  messages.push({
    role: 'user',
    content: prompt,
  });

  const response = await fetch(llmApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${llmApiKey}`,
    },
    body: JSON.stringify({
      model: llmModel,
      temperature: 0.2,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM request failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  const rawCode = payload?.choices?.[0]?.message?.content;
  if (typeof rawCode !== 'string' || !rawCode.trim()) {
    throw new Error('LLM response did not contain code');
  }

  return stripCodeFences(rawCode);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    sessionTtlMs: SESSION_TTL_MS,
    configPath: GATEWAY_CONFIG_PATH,
    contextHistoryLimit: DEFAULT_CONTEXT_HISTORY_LIMIT,
  });
});

app.get('/config/llm', async (_req, res) => {
  try {
    res.json(await buildGatewayConfigResponse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/config/llm', async (req, res) => {
  try {
    await updateGatewayConfig(req.body ?? {});
    res.json(await buildGatewayConfigResponse());
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/context/history', async (req, res) => {
  try {
    const limit = clampHistoryLimit(Number(req.query.limit ?? DEFAULT_CONTEXT_HISTORY_LIMIT));
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : null;
    const history = await getRecentContextHistory({ sessionId, limit });
    res.json({
      sessionId,
      limit,
      size: history.length,
      items: history,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/context/history', async (_req, res) => {
  try {
    const sessionId = typeof _req.query.sessionId === 'string' && _req.query.sessionId ? _req.query.sessionId : null;
    await clearContextHistory({ sessionId });
    res.json({ ok: true, cleared: true, sessionId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/sandbox/sessions', async (_req, res) => {
  try {
    const session = await createSandboxSession();
    const cleanupAt = scheduleSessionCleanup(session.session_id);
    res.status(201).json(buildSessionResponse(session, cleanupAt));
  } catch (error) {
    res.status(getStatusCode(error)).json({ error: error.message });
  }
});

app.delete('/sandbox/sessions/:sessionId', async (req, res) => {
  try {
    clearSessionCleanup(req.params.sessionId);
    const result = await cleanupSandboxSession(req.params.sessionId);
    await clearContextHistory({ sessionId: req.params.sessionId });
    res.json(result);
  } catch (error) {
    res.status(getStatusCode(error)).json({ error: error.message });
  }
});

async function runCodeInSandbox({ sessionId, fileName, code, timeoutMs, scriptArgs = [], ownedSession }) {
  const shouldCleanupOwnedSession = ownedSession ?? !sessionId;
  const session = sessionId ? { session_id: sessionId } : await createSandboxSession();
  let cleanupAt = null;

  if (!shouldCleanupOwnedSession) {
    cleanupAt = scheduleSessionCleanup(session.session_id);
  }

  try {
    const writeResult = await writeSandboxFile(session.session_id, fileName, code);
    const commandPreview = [`python -m ${SANDBOX_MODULE} run ${session.session_id} ${fileName}`, ...scriptArgs, '--timeout-ms', String(timeoutMs)].join(' ');
    await appendContextHistory(
      buildContextEntry({
        sessionId: session.session_id,
        type: 'command',
        content: commandPreview,
        metadata: {
          fileName,
          scriptArgs,
          timeoutMs,
        },
      }),
    );
    const execution = await runSandboxScript(session.session_id, fileName, timeoutMs, scriptArgs);
    await appendContextHistory(
      buildContextEntry({
        sessionId: session.session_id,
        type: 'command_result',
        content: JSON.stringify(
          {
            success: execution.success,
            exit_code: execution.exit_code,
            stdout: execution.stdout,
            stderr: execution.stderr,
            timeout: execution.timeout,
            duration_ms: execution.duration_ms,
            truncated: execution.truncated,
          },
          null,
          2,
        ),
      }),
    );
    return {
      sessionId: session.session_id,
      fileName,
      filePath: writeResult.path,
      timeoutMs,
      execution,
      sessionCleanup: shouldCleanupOwnedSession
        ? { mode: 'immediate', cleanup_at: null }
        : { mode: 'ttl', cleanup_at: cleanupAt },
    };
  } finally {
    if (shouldCleanupOwnedSession) {
      clearSessionCleanup(session.session_id);
      try {
        await cleanupSandboxSession(session.session_id);
        await clearContextHistory({ sessionId: session.session_id });
      } catch (_error) {
        // Ignore cleanup failures for ephemeral sessions.
      }
    }
  }
}

app.post('/execute-code', async (req, res) => {
  const { code, sessionId, fileName = DEFAULT_FILE_NAME, timeoutMs, scriptArgs = [] } = req.body ?? {};

  if (typeof code !== 'string' || !code.trim()) {
    res.status(400).json({ error: 'code is required' });
    return;
  }

  if (typeof fileName !== 'string' || !fileName.endsWith('.py')) {
    res.status(400).json({ error: 'fileName must be a .py file' });
    return;
  }

  if (!Array.isArray(scriptArgs) || scriptArgs.some((item) => typeof item !== 'string')) {
    res.status(400).json({ error: 'scriptArgs must be an array of strings' });
    return;
  }

  const effectiveTimeout = clampTimeout(Number(timeoutMs ?? DEFAULT_TIMEOUT_MS));
  let effectiveSessionId = sessionId || null;
  const ownedSession = !sessionId;

  try {
    if (!effectiveSessionId) {
      effectiveSessionId = (await createSandboxSession()).session_id;
    }

    await appendContextHistory(
      buildContextEntry({
        sessionId: effectiveSessionId,
        type: 'user_instruction',
        content: code,
        metadata: {
          mode: 'execute-code',
          fileName,
          scriptArgs,
        },
      }),
    );
    const result = await runCodeInSandbox({
      sessionId: effectiveSessionId,
      fileName,
      code,
      timeoutMs: effectiveTimeout,
      scriptArgs,
      ownedSession,
    });
    res.json({
      ...result,
      code,
    });
  } catch (error) {
    if (ownedSession && effectiveSessionId) {
      clearSessionCleanup(effectiveSessionId);
      try {
        await cleanupSandboxSession(effectiveSessionId);
        await clearContextHistory({ sessionId: effectiveSessionId });
      } catch (_cleanupError) {
        // Ignore cleanup failures while handling the primary error.
      }
    }
    res.status(getStatusCode(error)).json({ error: error.message });
  }
});

app.post('/generate-and-run', async (req, res) => {
  const { prompt, sessionId, fileName = DEFAULT_FILE_NAME, timeoutMs, scriptArgs = [], contextLimit } = req.body ?? {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  if (typeof fileName !== 'string' || !fileName.endsWith('.py')) {
    res.status(400).json({ error: 'fileName must be a .py file' });
    return;
  }

  if (!Array.isArray(scriptArgs) || scriptArgs.some((item) => typeof item !== 'string')) {
    res.status(400).json({ error: 'scriptArgs must be an array of strings' });
    return;
  }

  const effectiveTimeout = clampTimeout(Number(timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const effectiveContextLimit = clampHistoryLimit(Number(contextLimit ?? DEFAULT_CONTEXT_HISTORY_LIMIT));
  let effectiveSessionId = sessionId || null;
  const ownedSession = !sessionId;

  try {
    if (!effectiveSessionId) {
      effectiveSessionId = (await createSandboxSession()).session_id;
    }

    const generatedCode = await generatePythonCode(prompt, {
      contextLimit: effectiveContextLimit,
      sessionId: effectiveSessionId,
    });
    await appendContextHistory(
      buildContextEntry({
        sessionId: effectiveSessionId,
        type: 'user_instruction',
        content: prompt,
        metadata: {
          mode: 'generate-and-run',
          fileName,
          scriptArgs,
        },
      }),
    );
    const result = await runCodeInSandbox({
      sessionId: effectiveSessionId,
      fileName,
      code: generatedCode,
      timeoutMs: effectiveTimeout,
      scriptArgs,
      ownedSession,
    });

    res.json({
      ...result,
      generatedCode,
    });
  } catch (error) {
    if (ownedSession && effectiveSessionId) {
      clearSessionCleanup(effectiveSessionId);
      try {
        await cleanupSandboxSession(effectiveSessionId);
        await clearContextHistory({ sessionId: effectiveSessionId });
      } catch (_cleanupError) {
        // Ignore cleanup failures while handling the primary error.
      }
    }
    res.status(getStatusCode(error)).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`mini-agent gateway listening on :${PORT}`);
});
