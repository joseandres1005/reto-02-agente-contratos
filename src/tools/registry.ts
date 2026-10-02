// src/tools/registry.ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { LLMToolDef } from "../llm/adapter.ts";
import type { ToolContext } from "./contratos.ts";

export interface Tool {
  description: string;
  args: Record<string, z.ZodTypeAny>;
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext
  ) => Promise<string>;
}

export function buildToolDefinitions(
  tools: Record<string, Tool>
): LLMToolDef[] {
  return Object.entries(tools).map(([name, tool]) => {
    // Asegurar un schema OpenAPI válido: type=object, properties siempre presente
    const schema = z.object(tool.args);
    let jsonSchema: Record<string, unknown>;

    if (Object.keys(tool.args).length === 0) {
      // Herramienta sin argumentos: schema explícito y compatible con harmony
      jsonSchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
      };
    } else {
      const generated = zodToJsonSchema(schema, {
        target: "openApi3",
        $refStrategy: "none",
      }) as Record<string, unknown>;

      // Limpiar metadatos que Groq/harmony rechaza
      delete generated.$schema;
      delete generated.additionalProperties;

      jsonSchema = {
        type: "object",
        properties: (generated.properties as Record<string, unknown>) ?? {},
        required: (generated.required as string[]) ?? [],
        additionalProperties: false,
      };
    }

    return {
      type: "function" as const,
      function: {
        name,
        description: tool.description,
        parameters: jsonSchema,
      },
    };
  });
}