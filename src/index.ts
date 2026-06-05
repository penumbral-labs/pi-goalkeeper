import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./commands.js";
import { formatFooterStatus } from "./format.js";
import { budgetLimitPrompt, continuationGoalIdFromPrompt, continuationPrompt } from "./prompts.js";
import {
  applyUsage,
  clearEntry,
  clearToolErrorProgress,
  goalPolicy,
  goalProgress,
  goalWithLiveUsage,
  hasReachedContinuationLimit,
  limitGoal,
  recordContinuationQueued,
  recordToolCallObserved,
  recordToolErrorObserved,
  reconstructGoal,
  setEntry,
  updateGoalStatus,
} from "./state.js";
import { registerGoalTools } from "./tools.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

interface AccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
  budgetWarningSentFor: string | null;
}

interface StatusContext {
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

interface AssistantUsage {
  input: number;
  output: number;
}

interface QueuedGoalMessageDetails {
  kind?: unknown;
  goalId?: unknown;
}

function usageChannelTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function assistantTurnTokens(message: { role: string; usage?: AssistantUsage }): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }
  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}

function isAbortedAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

function isToolUseAssistantMessage(message: { role: string; stopReason?: string }): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

function isQueuedGoalWorkKind(kind: unknown): boolean {
  return kind === "continuation" || kind === "command_start" || kind === "command_resume";
}

function isQueuedGoalMessageDetails(details: unknown): details is QueuedGoalMessageDetails {
  return details !== null && typeof details === "object";
}

function staleGoalContinuationMessage(queuedGoalId: string, currentGoal: ThreadGoal | null): string {
  const currentState = currentGoal
    ? `Current goal id: ${currentGoal.goalId}; current status: ${currentGoal.status}.`
    : "There is no current goal.";
  return [
    "A queued hidden goal continuation is stale because the referenced goal is no longer active.",
    `Queued goal id: ${queuedGoalId}.`,
    currentState,
    "Do not perform task work. Do not call tools. Reply briefly that the queued goal continuation is no longer active.",
  ].join("\n");
}

function queuedGoalWorkMessageId(message: {
  role: string;
  customType?: string;
  details?: unknown;
  content?: unknown;
}): string | null {
  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE) {
    return null;
  }

  if (isQueuedGoalMessageDetails(message.details)) {
    const { kind, goalId } = message.details;
    if (isQueuedGoalWorkKind(kind) && typeof goalId === "string") {
      return goalId;
    }
  }

  if (typeof message.content === "string") {
    return continuationGoalIdFromPrompt(message.content);
  }

  return null;
}

function stableJson(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return "{" +
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableJson(record[key]))
      .join(",") +
    "}";
}

function toolSignature(toolName: string, input: unknown): string {
  return `${toolName}:${stableJson(input)}`;
}

function normalizeToolError(result: unknown): string {
  const normalized = typeof result === "string" ? result : stableJson(result);
  return normalized.replace(/\s+/g, " ").trim().slice(0, 500);
}

const CONTINUATION_RETRY_MS = 50;

export default function (pi: ExtensionAPI): void {
  let goal: ThreadGoal | null = null;
  let continuationQueuedFor: string | null = null;
  let continuationScheduledFor: string | null = null;
  let continuationTimer: ReturnType<typeof setTimeout> | null = null;
  let statusContext: StatusContext | null = null;
  let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  const accounting: AccountingState = {
    activeGoalId: null,
    lastAccountedAt: null,
    budgetWarningSentFor: null,
  };
  const toolCallInputs = new Map<string, unknown>();

  const goalForDisplay = (): ThreadGoal | null =>
    goalWithLiveUsage(goal, accounting.activeGoalId, accounting.lastAccountedAt);

  const stopStatusRefresh = (): void => {
    if (statusRefreshTimer) {
      clearInterval(statusRefreshTimer);
      statusRefreshTimer = null;
    }
  };

  const clearContinuationTimer = (): void => {
    if (continuationTimer) {
      clearTimeout(continuationTimer);
      continuationTimer = null;
    }
    continuationScheduledFor = null;
  };

  const clearContinuationState = (): void => {
    clearContinuationTimer();
    continuationQueuedFor = null;
  };

  const clearActiveAccounting = (): void => {
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
  };

  const clearStoppedRuntimeState = (): void => {
    clearContinuationState();
    clearActiveAccounting();
  };

  const syncStatusRefresh = (): void => {
    if (goal?.status === "active" && statusContext && !statusRefreshTimer) {
      statusRefreshTimer = setInterval(() => {
        if (!statusContext || goal?.status !== "active") {
          stopStatusRefresh();
          return;
        }
        statusContext.ui.setStatus("codex-goal", formatFooterStatus(goalForDisplay()));
      }, 1_000);
      statusRefreshTimer.unref?.();
      return;
    }

    if (goal?.status !== "active") {
      stopStatusRefresh();
    }
  };

  const refreshUi = (ctx: StatusContext): void => {
    statusContext = ctx;
    ctx.ui.setStatus("codex-goal", formatFooterStatus(goalForDisplay()));
    syncStatusRefresh();
  };

  const persistGoal = (nextGoal: ThreadGoal, source: GoalEntrySource): void => {
    const previousGoalId = goal?.goalId ?? null;
    goal = nextGoal;
    if (previousGoalId !== nextGoal.goalId) {
      accounting.budgetWarningSentFor = null;
      clearStoppedRuntimeState();
    }
    if (nextGoal.status === "paused" || nextGoal.status === "complete") {
      clearStoppedRuntimeState();
    } else if (nextGoal.status === "budgetLimited") {
      clearContinuationState();
    }
    if (nextGoal.status !== "budgetLimited") {
      accounting.budgetWarningSentFor = null;
    }
    pi.appendEntry(CUSTOM_ENTRY_TYPE, setEntry(nextGoal, source));
  };

  const persistClear = (source: GoalEntrySource): void => {
    const clearedGoalId = goal?.goalId ?? null;
    goal = null;
    clearStoppedRuntimeState();
    stopStatusRefresh();
    pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
  };

  const pauseForAbort = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "active") {
      return;
    }

    const result = updateGoalStatus(goal, "paused");
    if (!result.ok || !result.goal) {
      return;
    }

    clearStoppedRuntimeState();
    persistGoal(result.goal, "runtime");
    refreshUi(ctx);
  };

  const resumePausedGoal = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "paused") {
      return;
    }

    const result = updateGoalStatus(goal, "active");
    if (!result.ok || !result.goal) {
      return;
    }

    clearContinuationState();
    persistGoal(result.goal, "runtime");
    refreshUi(ctx);
  };

  const reloadFromSession = (ctx: ExtensionContext): void => {
    goal = reconstructGoal(ctx.sessionManager.getBranch()).goal;
    clearContinuationState();
    if (goal?.status !== "active") {
      clearActiveAccounting();
    }
    refreshUi(ctx);
  };

  const beginAccounting = (): void => {
    if (!goal || goal.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      return;
    }

    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = Date.now();
  };

  const accountProgress = (
    ctx: ExtensionContext,
    allowBudgetSteering: boolean,
    completedTurnTokens = 0,
    accountBudgetLimited = false,
  ): void => {
    const canAccount = goal?.status === "active" || (accountBudgetLimited && goal?.status === "budgetLimited");
    if (!goal || accounting.activeGoalId !== goal.goalId || !canAccount) {
      beginAccounting();
      return;
    }

    const now = Date.now();
    const elapsed = accounting.lastAccountedAt === null ? 0 : Math.floor((now - accounting.lastAccountedAt) / 1000);
    accounting.lastAccountedAt = now;

    const result = applyUsage(goal, completedTurnTokens, elapsed, {
      expectedGoalId: accounting.activeGoalId,
      accountBudgetLimited,
    });
    if (!result.changed || !result.goal) {
      return;
    }

    persistGoal(result.goal, "runtime");
    refreshUi(ctx);

    if (allowBudgetSteering && result.crossedBudget && accounting.budgetWarningSentFor !== result.goal.goalId) {
      accounting.budgetWarningSentFor = result.goal.goalId;
      pi.sendMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: budgetLimitPrompt(result.goal),
          display: false,
          details: { kind: "budget_limit", goalId: result.goal.goalId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  };

  const completeGoal = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    accountProgress(ctx, false, 0, true);
    const result = updateGoalStatus(goal, "complete");
    if (!result.ok || !result.goal) {
      return result;
    }
    persistGoal(result.goal, source);
    refreshUi(ctx);
    return result;
  };

  const sendContinuation = (goalToContinue: ThreadGoal, ctx: ExtensionContext): void => {
    if (hasReachedContinuationLimit(goalToContinue)) {
      const result = limitGoal(goalToContinue, "maxContinuationTurns");
      if (result.ok && result.goal) {
        persistGoal(result.goal, "runtime");
        refreshUi(ctx);
      }
      return;
    }

    const result = recordContinuationQueued(goalToContinue);
    if (!result.ok || !result.goal) {
      return;
    }

    persistGoal(result.goal, "runtime");
    refreshUi(ctx);
    continuationQueuedFor = result.goal.goalId;
    pi.sendMessage(
      {
        customType: CUSTOM_ENTRY_TYPE,
        content: continuationPrompt(result.goal),
        display: false,
        details: { kind: "continuation", goalId: result.goal.goalId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const recordToolCallOrLimit = (
    toolName: string,
    input: unknown,
    ctx: ExtensionContext,
  ): { block: boolean; reason?: string } => {
    if (!goal || goal.status !== "active") {
      return { block: false };
    }

    const recorded = recordToolCallObserved(goal, toolName, toolSignature(toolName, input));
    if (!recorded.ok || !recorded.goal) {
      return { block: false };
    }
    persistGoal(recorded.goal, "runtime");
    refreshUi(ctx);

    const policy = goalPolicy(recorded.goal);
    const repeated = goalProgress(recorded.goal).repeatedToolCall;
    if (policy.maxRepeatedToolCalls !== null && repeated && repeated.count >= policy.maxRepeatedToolCalls) {
      const limited = limitGoal(recorded.goal, "repeatedToolCall");
      if (limited.ok && limited.goal) {
        persistGoal(limited.goal, "runtime");
        refreshUi(ctx);
      }
      return {
        block: true,
        reason: `Blocked repeated ${toolName} call after ${repeated.count} identical attempts.`,
      };
    }

    return { block: false };
  };

  const recordToolErrorOrLimit = (toolName: string, args: unknown, result: unknown, ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "active") {
      return;
    }

    const normalizedError = normalizeToolError(result);
    const recorded = recordToolErrorObserved(goal, toolName, toolSignature(toolName, args), normalizedError);
    if (!recorded.ok || !recorded.goal) {
      return;
    }
    persistGoal(recorded.goal, "runtime");
    refreshUi(ctx);

    const policy = goalPolicy(recorded.goal);
    const repeated = goalProgress(recorded.goal).repeatedToolError;
    if (policy.maxRepeatedToolErrors !== null && repeated && repeated.count >= policy.maxRepeatedToolErrors) {
      const limited = limitGoal(recorded.goal, "repeatedToolError");
      if (limited.ok && limited.goal) {
        persistGoal(limited.goal, "runtime");
        refreshUi(ctx);
      }
    }
  };

  const clearToolErrorIfNeeded = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "active" || !goalProgress(goal).repeatedToolError) {
      return;
    }
    const result = clearToolErrorProgress(goal);
    if (result.ok && result.goal && result.goal !== goal) {
      persistGoal(result.goal, "runtime");
      refreshUi(ctx);
    }
  };

  const maybeContinue = (ctx: ExtensionContext): void => {
    if (!goal || goal.status !== "active" || continuationQueuedFor === goal.goalId) {
      return;
    }

    const goalId = goal.goalId;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      if (continuationScheduledFor === goalId) {
        return;
      }
      continuationScheduledFor = goalId;
      continuationTimer = setTimeout(() => {
        continuationTimer = null;
        continuationScheduledFor = null;
        maybeContinue(ctx);
      }, CONTINUATION_RETRY_MS);
      continuationTimer.unref?.();
      return;
    }

    clearContinuationTimer();
    if (!goal || goal.status !== "active" || goal.goalId !== goalId) {
      return;
    }
    sendContinuation(goal, ctx);
  };

  registerGoalTools(pi, {
    getGoal: () => goalForDisplay(),
    setGoal(nextGoal, source, ctx) {
      persistGoal(nextGoal, source);
      refreshUi(ctx);
    },
    completeGoal,
  });

  registerGoalCommand(pi, {
    getGoal: () => goalForDisplay(),
    setGoal(nextGoal, source, ctx) {
      persistGoal(nextGoal, source);
      if (source === "command" && nextGoal.status === "active") {
        continuationQueuedFor = nextGoal.goalId;
      }
      refreshUi(ctx);
    },
    clearGoal(source, ctx) {
      persistClear(source);
      refreshUi(ctx);
    },
  });

  pi.on("context", async (event): Promise<{ messages: typeof event.messages } | undefined> => {
    let changed = false;
    const messages: typeof event.messages = event.messages.map((message) => {
      const queuedGoalId = queuedGoalWorkMessageId(message);
      if (queuedGoalId === null || (goal?.goalId === queuedGoalId && goal.status === "active")) {
        return message;
      }

      changed = true;
      return {
        ...message,
        content: staleGoalContinuationMessage(queuedGoalId, goal),
        display: false,
        details: {
          kind: "stale_continuation",
          goalId: queuedGoalId,
          currentGoalId: goal?.goalId ?? null,
          currentStatus: goal?.status ?? null,
        },
      } as typeof message;
    });

    return changed ? { messages } : undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    reloadFromSession(ctx);
    beginAccounting();
    if (event.reason === "resume" && goal?.status === "paused" && ctx.hasUI) {
      const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${goal.objective}`);
      if (shouldResume) {
        resumePausedGoal(ctx);
        beginAccounting();
      }
    }
    maybeContinue(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reloadFromSession(ctx);
    beginAccounting();
    maybeContinue(ctx);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const continuationGoalId = continuationGoalIdFromPrompt(_event.prompt);
    if (continuationGoalId !== null) {
      continuationQueuedFor = null;
      clearContinuationTimer();
      if (!goal || goal.goalId !== continuationGoalId || goal.status !== "active") {
        ctx.abort();
        refreshUi(ctx);
        return {
          systemPrompt: [_event.systemPrompt, "", staleGoalContinuationMessage(continuationGoalId, goal)].join("\n"),
        };
      }
    } else {
      clearContinuationState();
    }
  });

  pi.on("turn_start", async (_event, ctx) => {
    clearContinuationState();
    beginAccounting();
    refreshUi(ctx);
  });

  pi.on("tool_call", async (_event, ctx) => {
    toolCallInputs.set(_event.toolCallId, _event.input);
    const decision = recordToolCallOrLimit(_event.toolName, _event.input, ctx);
    if (decision.block) {
      return decision.reason ? { block: true, reason: decision.reason } : { block: true };
    }
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    const args = toolCallInputs.get(_event.toolCallId) ?? {};
    toolCallInputs.delete(_event.toolCallId);
    if (_event.isError) {
      recordToolErrorOrLimit(_event.toolName, args, _event.result, ctx);
    } else {
      clearToolErrorIfNeeded(ctx);
    }
    accountProgress(ctx, true, 0, true);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const completedTurnTokens = assistantTurnTokens(_event.message);
    accountProgress(ctx, true, completedTurnTokens);
    if (isAbortedAssistantMessage(_event.message)) {
      pauseForAbort(ctx);
      return;
    }
    if (!isToolUseAssistantMessage(_event.message)) {
      maybeContinue(ctx);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const abortedMessages = event.messages.filter(isAbortedAssistantMessage);
    const abortedTurnTokens = abortedMessages.reduce((sum, message) => {
      return sum + assistantTurnTokens(message);
    }, 0);
    accountProgress(ctx, false, abortedTurnTokens, true);
    if (abortedMessages.length > 0) {
      pauseForAbort(ctx);
      return;
    }
    maybeContinue(ctx);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    accountProgress(ctx, false, 0, true);
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (goal) {
      persistGoal(goal, "runtime");
    }
    refreshUi(ctx);
    maybeContinue(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    accountProgress(ctx, false, 0, true);
    clearContinuationTimer();
    stopStatusRefresh();
  });
}
