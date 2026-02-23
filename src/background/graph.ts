import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { tool } from "@langchain/core/tools";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

type ToolCall = {
  name: string;
  args: Record<string, unknown>;
} | null;

type ChatLog = {
  role: "user" | "assistant" | "tool";
  content: string;
};

export type LlmSettings = {
  provider: "openai";
  model: string;
  apiKey: string;
};

const GraphState = Annotation.Root({
  input: Annotation<string>({
    default: () => "",
  }),
  model: Annotation<string>({
    default: () => "",
  }),
  apiKey: Annotation<string>({
    default: () => "",
  }),
  response: Annotation<string>({
    default: () => "",
  }),
  turn: Annotation<number>({
    default: () => 0,
  }),
  messages: Annotation<ChatLog[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  pendingToolCall: Annotation<ToolCall>({
    default: () => null,
  }),
  lastToolResult: Annotation<string | null>({
    default: () => null,
  }),
});

const mockCdpTool = tool(
  async ({ action, target }) => {
    return `Mock CDP executed action='${action}' target='${target ?? ""}'`;
  },
  {
    name: "mock_cdp_action",
    description: "Mock Chrome DevTools Protocol action executor.",
    schema: z.object({
      action: z.string().describe("CDP action name, e.g. click, navigate"),
      target: z.string().optional().describe("Optional selector or URL target"),
    }),
  }
);

function parseCdpCommand(input: string): ToolCall {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/cdp")) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const action = parts[1] ?? "noop";
  const target = parts.slice(2).join(" ") || undefined;

  return {
    name: mockCdpTool.name,
    args: { action, target },
  };
}

async function plannerNode(state: typeof GraphState.State) {
  const toolCall = parseCdpCommand(state.input);

  return {
    pendingToolCall: toolCall,
    messages: [{ role: "user", content: state.input }],
  };
}

async function toolNode(state: typeof GraphState.State) {
  if (!state.pendingToolCall) {
    return {
      response: "No tool call requested.",
    };
  }

  const toolResult = await mockCdpTool.invoke(state.pendingToolCall.args);

  return {
    pendingToolCall: null,
    lastToolResult: String(toolResult),
    response: String(toolResult),
    turn: state.turn + 1,
    messages: [
      { role: "tool", content: `${mockCdpTool.name}: ${toolResult}` },
      { role: "assistant", content: String(toolResult) },
    ],
  };
}

function getTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("\n");
  }
  return JSON.stringify(content);
}

function toModelMessages(messages: ChatLog[]) {
  return messages.map((msg) => {
    if (msg.role === "user") {
      return new HumanMessage(msg.content);
    }
    if (msg.role === "assistant") {
      return new AIMessage(msg.content);
    }
    return new AIMessage(`Tool result: ${msg.content}`);
  });
}

async function responseNode(state: typeof GraphState.State) {
  if (!state.apiKey || !state.model) {
    const missingSettings = "Missing OpenAI settings. Open extension Options and save model + API key.";
    return {
      response: missingSettings,
      turn: state.turn + 1,
      messages: [{ role: "assistant", content: missingSettings }],
    };
  }

  const model = new ChatOpenAI({
    apiKey: state.apiKey,
    model: state.model,
    temperature: 0.2,
  });
  const modelResponse = await model.invoke([
    new SystemMessage("You are a helpful assistant inside a Chrome extension."),
    ...toModelMessages(state.messages),
  ]);
  const answer = getTextContent(modelResponse.content);
  return {
    response: answer,
    turn: state.turn + 1,
    messages: [{ role: "assistant", content: answer }],
  };
}

const checkpointer = new MemorySaver();

const graph = new StateGraph(GraphState)
  .addNode("planner", plannerNode)
  .addNode("tool", toolNode)
  .addNode("respond", responseNode)
  .addEdge(START, "planner")
  .addConditionalEdges("planner", (state) => (state.pendingToolCall ? "tool" : "respond"), ["tool", "respond"])
  .addEdge("tool", END)
  .addEdge("respond", END)
  .compile({ checkpointer });

export type PersistedThreadState = {
  turn: number;
  messages: ChatLog[];
  lastToolResult: string | null;
};

export async function runGraphTurn(threadId: string, input: string, settings: LlmSettings, seed?: PersistedThreadState) {
  const config = {
    configurable: {
      thread_id: threadId,
    },
  };

  let hasCheckpoint = false;
  try {
    const checkpointState = await graph.getState(config);
    hasCheckpoint = Boolean(checkpointState?.values);
  } catch {
    hasCheckpoint = false;
  }

  const invokeInput = hasCheckpoint
    ? {
        input,
        model: settings.model,
        apiKey: settings.apiKey,
      }
    : {
        input,
        model: settings.model,
        apiKey: settings.apiKey,
        turn: seed?.turn ?? 0,
        messages: seed?.messages ?? [],
        lastToolResult: seed?.lastToolResult ?? null,
      };

  const state = await graph.invoke(invokeInput, config);

  const persisted: PersistedThreadState = {
    turn: state.turn,
    messages: state.messages,
    lastToolResult: state.lastToolResult,
  };

  return {
    response: state.response,
    state: persisted,
  };
}
