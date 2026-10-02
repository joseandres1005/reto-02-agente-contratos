// src/server.ts
// Backend HTTP + ciclo del agente conversacional.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";

import { runAgentTurn } from "./agent/loop.ts";
import { OpenAICompatibleAdapter } from "./llm/openai.ts";
import type { LLMMessage } from "./llm/adapter.ts";
import {
  leer_buzon,
  extraer,
  validar,
  registrar,
  alertas,
  type ToolContext,
} from "./tools/contratos.ts";
import type { Tool } from "./tools/registry.ts";

// ============================================================================
// CARGA DE .env (sin dependencias externas)
// ============================================================================
async function loadEnv(): Promise<void> {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = await readFile(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

await loadEnv();

// ============================================================================
// CONFIG
// ============================================================================
const ROOT = process.cwd();
const OUT = join(ROOT, "out");
const FIXTURES = join(ROOT, "fixtures/reto-02");
const PORT = Number(process.env.PORT ?? 3000);

const API_KEY = process.env.LLM_API_KEY;
const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
const MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";

if (!API_KEY) {
  console.error("❌ Falta LLM_API_KEY en el entorno o en .env");
  console.error("   Copia .env.example a .env y configura tu clave.");
  process.exit(1);
}

// ============================================================================
// TOOLS
// ============================================================================
const TOOLS: Record<string, Tool> = {
  contratos_leer_buzon: leer_buzon as unknown as Tool,
  contratos_extraer: extraer as unknown as Tool,
  contratos_validar: validar as unknown as Tool,
  contratos_registrar: registrar as unknown as Tool,
  contratos_alertas: alertas as unknown as Tool,
};

// ============================================================================
// SYSTEM PROMPT
// ============================================================================
const SYSTEM_PROMPT = await readFile(
  join(ROOT, "agent/prompt.md"),
  "utf-8"
);

// ============================================================================
// LLM
// ============================================================================
const LLM = new OpenAICompatibleAdapter(API_KEY, BASE_URL, MODEL, 1024, 0.1);

// ============================================================================
// SESIONES EN MEMORIA
// ============================================================================
interface Session {
  id: string;
  history: LLMMessage[];
  createdAt: number;
  lastToolCalls: unknown[];
  lastNeedsConfirmation: boolean;
}

const sessions = new Map<string, Session>();

function getOrCreateSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    s = {
      id: sessionId,
      history: [],
      createdAt: Date.now(),
      lastToolCalls: [],
      lastNeedsConfirmation: false,
    };
    sessions.set(sessionId, s);
  }
  return s;
}

// ============================================================================
// INICIALIZACIÓN DE OUT/
// ============================================================================
async function ensureOutDir(): Promise<void> {
  await mkdir(join(OUT, "sharepoint"), { recursive: true });
  const maestroOut = join(OUT, "sharepoint/maestro-contratos.csv");
  if (!existsSync(maestroOut)) {
    await cp(join(FIXTURES, "maestro-contratos.csv"), maestroOut);
    console.log("📦 Fixture copiado a out/sharepoint/maestro-contratos.csv");
  }
}

// ============================================================================
// HELPERS HTTP
// ============================================================================
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
}

async function serveStatic(
  res: ServerResponse,
  path: string
): Promise<boolean> {
  const cleanPath = path === "/" ? "index.html" : path.replace(/^\//, "");
  const filePath = join(ROOT, "web", cleanPath);
  if (!existsSync(filePath)) return false;
  const content = await readFile(filePath);
  const ext = extname(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
  });
  res.end(content);
  return true;
}

// ============================================================================
// SERVIDOR
// ============================================================================
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // GET /api/health
  if (req.method === "GET" && url.pathname === "/api/health") {
    json(res, 200, { ok: true, provider: BASE_URL, model: MODEL });
    return;
  }

  // GET /api/sessions/:id
  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.split("/").pop()!;
    const s = sessions.get(id);
    if (!s) {
      json(res, 404, { ok: false, error: "sesión no encontrada" });
      return;
    }
    json(res, 200, {
      ok: true,
      sessionId: s.id,
      history: s.history,
      toolCalls: s.lastToolCalls,
      needsConfirmation: s.lastNeedsConfirmation,
    });
    return;
  }

  // POST /api/chat
  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = JSON.parse(await readBody(req));
      const sessionId: string = body.sessionId ?? randomUUID();
      const message: string = body.message ?? "";

      if (!message.trim()) {
        json(res, 400, { ok: false, error: "mensaje vacío" });
        return;
      }

      const session = getOrCreateSession(sessionId);
      const ctx: ToolContext = {
        directory: ROOT,
        sessionId,
        outDir: OUT,
      };

      const result = await runAgentTurn(
        session.history,
        message,
        TOOLS,
        LLM,
        ctx,
        SYSTEM_PROMPT
      );

      session.history = result.messages;
      session.lastToolCalls = result.toolCalls;
      session.lastNeedsConfirmation = result.needsConfirmation;

      json(res, 200, {
        ok: true,
        sessionId,
        reply: result.reply,
        toolCalls: result.toolCalls,
        needsConfirmation: result.needsConfirmation,
        usage: result.usage,
      });
      return;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "unknown";
      console.error("Error en /api/chat:", msg);
      json(res, 500, { ok: false, error: msg });
      return;
    }
  }

  // Archivos estáticos
  if (req.method === "GET") {
    const served = await serveStatic(res, url.pathname);
    if (served) return;
  }

  json(res, 404, { ok: false, error: "not found" });
});

// ============================================================================
// MAIN
// ============================================================================
await ensureOutDir();
server.listen(PORT, () => {
  console.log(`\n🚀 Agente de contratos listo en http://localhost:${PORT}`);
  console.log(`   Modelo:  ${MODEL}`);
  console.log(`   Backend: ${BASE_URL}\n`);
});