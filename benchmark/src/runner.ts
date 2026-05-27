/**
 * runner.ts — single-task agentic loop using Anthropic SDK.
 * Records exact token counts, tool calls, files read, memory delta.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ANTHROPIC_API_KEY, MODEL, MAX_TOOL_TURNS, SYSTEM_PROMPT } from './config.js';
import { BASELINE_TOOLS, GP_TOOLS, executeTool } from './tools.js';
import { score } from './score.js';
import type { Task, TaskResult, ToolCall } from './types.js';

type MessageParam = Anthropic.MessageParam;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;
type ContentBlock = Anthropic.ContentBlock;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

export async function runTask(task: Task, mode: 'baseline' | 'gp'): Promise<TaskResult> {
  const startMem = process.memoryUsage().heapUsed;
  const startTime = Date.now();

  const tools = mode === 'baseline' ? BASELINE_TOOLS : GP_TOOLS;
  const messages: MessageParam[] = [{ role: 'user', content: task.question }];

  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls: ToolCall[] = [];
  const filesRead: string[] = [];
  let answer = '';

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      answer = response.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      break;
    }

    // Handle tool calls
    const toolResults: ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const args = block.input as Record<string, unknown>;
      const { text, bytesRead, isFileRead } = executeTool(block.name, args);

      toolCalls.push({ name: block.name, args, resultBytes: bytesRead || text.length });

      if (isFileRead && args.path) {
        filesRead.push(String(args.path));
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: text,
      });
    }

    if (toolResults.length) {
      messages.push({ role: 'user', content: toolResults });
    } else {
      // No tool calls but stop_reason wasn't end_turn — extract any text
      answer = response.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      break;
    }
  }

  const peakHeapMb = (process.memoryUsage().heapUsed - startMem) / 1024 / 1024;
  const durationMs = Date.now() - startTime;
  const { correct, score: scoreVal } = score(answer, task.expectedKeywords);

  return {
    taskId: task.id,
    mode,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    toolCalls,
    filesRead,
    answer,
    correct,
    score: scoreVal,
    durationMs,
    peakHeapMb,
  };
}
