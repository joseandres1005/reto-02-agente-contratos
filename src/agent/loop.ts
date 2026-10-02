// src/agent/loop.ts
import { z } from "zod";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  LLMToolDef,
} from "../llm/adapter.ts";
import { buildToolDefinitions, type Tool } from "../tools/registry.ts";
import type { ToolContext } from "../tools/contratos.ts";

const MAX_ITER = 25;

export interface ToolCallLog {
  name: string;
  arguments: string;
  result: string;
  ok: boolean;
  resumen: string;
}

export interface AgentTurnResult {
  messages: LLMMessage[];
  toolCalls: ToolCallLog[];
  reply: string;
  needsConfirmation: boolean;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function truncarHistorial(messages: LLMMessage[]): LLMMessage[] {
  const MAX = 20;
  if (messages.length <= MAX) return messages;

  const system = messages[0];
  // Encontrar el primer user (el prompt original del usuario)
  const primerUser = messages.find((m) => m.role === "user");
  // Conservar los últimos 15 mensajes
  const ultimos = messages.slice(-15);

  // Si el primer user NO está en los últimos, lo incluimos al inicio
  if (primerUser && !ultimos.includes(primerUser)) {
    return [system, primerUser, ...ultimos];
  }
  return [system, ...ultimos];
}


async function sendWithRetry(
  llm: LLMAdapter,
  messages: LLMMessage[],
  tools: LLMToolDef[],
  maxRetries = 5
): Promise<LLMResponse> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await llm.send(messages, tools);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const esReintentable =
        msg.includes("429") ||
        msg.includes("Rate limit") ||
        msg.includes("503") ||
        msg.includes("502") ||
        msg.includes("504") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("high demand");

      if (!esReintentable || attempt === maxRetries - 1) throw e;

      const match = msg.match(/try again in ([\d.]+)s/i);
      const espera = match
        ? Math.ceil(parseFloat(match[1])) * 1000 + 500
        : Math.min(2 ** attempt * 1000 + 1000, 30_000);

      console.log(
        `⏳ Reintentando en ${(espera / 1000).toFixed(1)}s (intento ${attempt + 1}/${maxRetries})…`
      );
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw new Error("Máximo de reintentos alcanzado");
}

export async function runAgentTurn(
  history: LLMMessage[],
  userMessage: string,
  tools: Record<string, Tool>,
  llm: LLMAdapter,
  ctx: ToolContext,
  systemPrompt: string
): Promise<AgentTurnResult> {
  const toolDefs = buildToolDefinitions(tools);

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  const toolCallLog: ToolCallLog[] = [];
  const usageTotal = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const mensajesOptimizados = truncarHistorial(messages);
    const response = await sendWithRetry(llm, mensajesOptimizados, toolDefs);

    if (response.usage) {
      usageTotal.prompt_tokens += response.usage.prompt_tokens;
      usageTotal.completion_tokens += response.usage.completion_tokens;
      usageTotal.total_tokens += response.usage.total_tokens;
    }

    const assistantMsg: LLMMessage = {
      role: "assistant",
      content: response.content,
    };
    if (response.tool_calls.length > 0) {
      assistantMsg.tool_calls = response.tool_calls;
    }
    messages.push(assistantMsg);

    if (response.tool_calls.length === 0) {
      const reply = response.content ?? "";
      const needsConfirmation =
        /confirmas|confirma|¿confirm|sí para proceder/i.test(reply);
      return {
        messages,
        toolCalls: toolCallLog,
        reply,
        needsConfirmation,
        usage: usageTotal,
      };
    }

    for (const tc of response.tool_calls) {
      const name = tc.function.name;
      const tool = tools[name];

      let resultStr: string;
      let ok = true;
      let resumen = "";

      if (!tool) {
        resultStr = JSON.stringify({
          ok: false,
          error: `Herramienta desconocida: ${name}`,
        });
        ok = false;
        resumen = "herramienta desconocida";
      } else {
        try {
          const rawArgs = JSON.parse(tc.function.arguments || "{}");
          const schema = z.object(tool.args);
          const parsed = schema.safeParse(rawArgs);

          if (!parsed.success) {
            const errores = parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ");
            resultStr = JSON.stringify({
              ok: false,
              error: `Argumentos inválidos: ${errores}`,
            });
            ok = false;
            resumen = "argumentos inválidos";
          } else {
            resultStr = await tool.execute(
              parsed.data as Record<string, unknown>,
              ctx
            );
            const parsedResult = JSON.parse(resultStr);
            ok = parsedResult.ok !== false;
            resumen = ok ? "ok" : (parsedResult.error?.slice(0, 120) ?? "error");
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "unknown";
          resultStr = JSON.stringify({
            ok: false,
            error: `Error ejecutando ${name}: ${msg}`,
          });
          ok = false;
          resumen = `excepción: ${msg.slice(0, 80)}`;
        }
      }

      await logToolCall(ctx, name, tc.function.arguments, ok, resumen);

      toolCallLog.push({
        name,
        arguments: tc.function.arguments,
        result: resultStr,
        ok,
        resumen,
      });

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: resultStr,
      });
    }
  }

  return {
    messages,
    toolCalls: toolCallLog,
    reply: `Alcancé el tope de ${MAX_ITER} iteraciones sin completar la tarea.`,
    needsConfirmation: false,
    usage: usageTotal,
  };
}

async function logToolCall(
  ctx: ToolContext,
  herramienta: string,
  args: string,
  ok: boolean,
  resumen: string
): Promise<void> {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    herramienta,
    ok,
    resumen,
    args: args.slice(0, 200),
  });
  await appendFile(join(ctx.outDir, "log.jsonl"), line + "\n").catch(() => {});
}