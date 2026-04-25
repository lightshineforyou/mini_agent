import express from 'express';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

const PORT = Number(process.env.PORT || 3000);
const PYTHON_BIN = process.env.PYTHON_BIN || 'python';
const SANDBOX_MODULE = process.env.SANDBOX_MODULE || 'mini_agent_sandbox.cli';
const DEFAULT_TIMEOUT_MS = Number(process.env.DEFAULT_TIMEOUT_MS || 5000);
const MAX_TIMEOUT_MS = Number(process.env.MAX_TIMEOUT_MS || 10000);
const DEFAULT_FILE_NAME = process.env.DEFAULT_FILE_NAME || 'generated.py';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 10 * 60 * 1000);
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const sessionCleanupTimers = new Map();

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

async function generatePythonCode(prompt) {
  if (!LLM_API_KEY) {
    throw new Error('LLM_API_KEY is not set');
  }

  const response = await fetch(LLM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You generate runnable Python scripts only. Return code only, no markdown fences, no explanations. The script must write useful stdout for the user request.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
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
  res.json({ ok: true, sessionTtlMs: SESSION_TTL_MS });
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
    res.json(result);
  } catch (error) {
    res.status(getStatusCode(error)).json({ error: error.message });
  }
});

async function runCodeInSandbox({ sessionId, fileName, code, timeoutMs, scriptArgs = [] }) {
  const ownedSession = !sessionId;
  const session = ownedSession ? await createSandboxSession() : { session_id: sessionId };
  let cleanupAt = null;

  if (!ownedSession) {
    cleanupAt = scheduleSessionCleanup(session.session_id);
  }

  try {
    const writeResult = await writeSandboxFile(session.session_id, fileName, code);
    const execution = await runSandboxScript(session.session_id, fileName, timeoutMs, scriptArgs);
    return {
      sessionId: session.session_id,
      fileName,
      filePath: writeResult.path,
      timeoutMs,
      execution,
      sessionCleanup: ownedSession
        ? { mode: 'immediate', cleanup_at: null }
        : { mode: 'ttl', cleanup_at: cleanupAt },
    };
  } finally {
    if (ownedSession) {
      clearSessionCleanup(session.session_id);
      try {
        await cleanupSandboxSession(session.session_id);
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

  try {
    const result = await runCodeInSandbox({
      sessionId,
      fileName,
      code,
      timeoutMs: effectiveTimeout,
      scriptArgs,
    });
    res.json({
      ...result,
      code,
    });
  } catch (error) {
    res.status(getStatusCode(error)).json({ error: error.message });
  }
});

app.post('/generate-and-run', async (req, res) => {
  const { prompt, sessionId, fileName = DEFAULT_FILE_NAME, timeoutMs, scriptArgs = [] } = req.body ?? {};

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

  try {
    const generatedCode = await generatePythonCode(prompt);
    const result = await runCodeInSandbox({
      sessionId,
      fileName,
      code: generatedCode,
      timeoutMs: effectiveTimeout,
      scriptArgs,
    });

    res.json({
      ...result,
      generatedCode,
    });
  } catch (error) {
    res.status(getStatusCode(error)).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`mini-agent gateway listening on :${PORT}`);
});
