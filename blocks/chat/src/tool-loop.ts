/**
 * Bounded tool-calling loop.
 *
 * The "agent" half of the block: a model step may ask to call tools, whose results are fed back for
 * another step, until the model returns a final answer. The only invariant enforced here is the
 * iteration ceiling, because that is what stops a public endpoint from looping forever and burning
 * Capacity-Hours. The pure pieces (budget check, argument parsing) live here so they can be tested
 * without a live model; wiring them to the streamed model call is a marked TODO seam in index.ts.
 */

export interface ToolCall {
  /** Provider-assigned id, echoed back with the tool result. */
  id: string;
  name: string;
  /** Raw JSON arguments string as the model emitted it. */
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments, passed to the model. */
  parameters: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
}

export class ToolIterationLimit extends Error {
  override readonly name = "ToolIterationLimit";
  constructor(readonly limit: number) {
    super(
      `Tool loop exceeded its ${limit}-iteration ceiling without a final answer. Raise ` +
        `CHAT_MAX_TOOL_ITERATIONS if this is legitimate, but a runaway loop usually means a tool ` +
        `keeps failing or the model is stuck.`,
    );
  }
}

export class ToolArgumentsError extends Error {
  override readonly name = "ToolArgumentsError";
}

/** True while another model to tool iteration is allowed. */
export function withinIterationBudget(iteration: number, max: number): boolean {
  return iteration < max;
}

/** Throw once the iteration ceiling is reached. Called at the top of each loop turn. */
export function assertIterationBudget(iteration: number, max: number): void {
  if (!withinIterationBudget(iteration, max)) throw new ToolIterationLimit(max);
}

/**
 * Parse a tool call's arguments.
 *
 * Models occasionally emit malformed or empty argument strings; treating an empty string as `{}`
 * and surfacing anything else as a typed error keeps a bad tool call from crashing the whole turn.
 */
export function parseToolArguments(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new ToolArgumentsError(`Tool arguments were not valid JSON: ${trimmed.slice(0, 200)}`);
  }
}

/** Look up a tool by the name the model asked for, or throw a clear error. */
export function resolveTool(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new ToolArgumentsError(
      `Model requested unknown tool "${name}". Available: ${tools.map((t) => t.name).join(", ") || "none"}`,
    );
  }
  return tool;
}
