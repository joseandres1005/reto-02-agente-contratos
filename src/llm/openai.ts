// src/llm/openai.ts
// Implementación OpenAI-compatible del adaptador LLM.
// Funciona con OpenAI, Azure OpenAI, Groq, DeepSeek, Mistral, Together, etc.

import type {
  LLMAdapter,
  LLMMessage,
  LLMResponse,
  LLMToolDef,
  ToolCall,
} from "./adapter.ts";

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  message: {
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAICompatibleAdapter implements LLMAdapter {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
    private maxTokens = 4096,
    private temperature = 0.1
  ) {}

  async send(  
    messages: LLMMessage[],
    tools: LLMToolDef[]
  ): Promise<LLMResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;

    // Detectar si es OpenAI oficial: usa max_completion_tokens en lugar de max_tokens
    const esOpenAIOficial = /api\.openai\.com/i.test(this.baseUrl);
    const tokenParam = esOpenAIOficial ? "max_completion_tokens" : "max_tokens";

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      [tokenParam]: this.maxTokens,
      temperature: this.temperature,
    };

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      clearTimeout(timeout);
      const msg = e instanceof Error ? e.message : "unknown";
      throw new Error(`Error de red al llamar al LLM: ${msg}`);
    }
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    if (!choice) throw new Error("Respuesta del LLM sin choices");

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map(
      (tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })
    );

    return {
      content: choice.message.content,
      tool_calls: toolCalls,
      finish_reason: choice.finish_reason,
      usage: data.usage,
    };
  }
}