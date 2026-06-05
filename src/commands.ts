import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatGoalSummary } from "./format.js";
import { continuationPrompt } from "./prompts.js";
import {
  hasReachedContinuationLimit,
  limitGoal,
  recordContinuationQueued,
  replaceGoal,
  updateGoalStatus,
} from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.js";

export interface CommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
}

const COMMANDS = ["pause", "resume", "clear"] as const;

export type GoalCommandPi = Pick<ExtensionAPI, "registerCommand" | "sendMessage">;

export interface GoalCommandContext {
  hasUI: boolean;
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "notify" | "setStatus">;
}

function completions(prefix: string) {
  return COMMANDS.filter((command) => command.startsWith(prefix)).map((command) => ({
    value: command,
    label: command,
    description: `goal ${command}`,
  }));
}

interface QueueGoalTurnResult {
  queued: boolean;
  message: string;
  notifyType?: "warning" | "error";
}

function queueGoalTurn(
  pi: GoalCommandPi,
  host: CommandHost,
  goal: ThreadGoal,
  kind: "command_start" | "command_resume",
  ctx: GoalCommandContext,
): QueueGoalTurnResult {
  if (hasReachedContinuationLimit(goal)) {
    const result = limitGoal(goal, "maxContinuationTurns");
    if (!result.ok || !result.goal) {
      return {
        queued: false,
        message: result.message,
        notifyType: "error",
      };
    }
    host.setGoal(result.goal, "runtime", ctx);
    return {
      queued: false,
      message: result.message,
      notifyType: "warning",
    };
  }

  const result = recordContinuationQueued(goal);
  if (!result.ok || !result.goal) {
    return {
      queued: false,
      message: result.message,
      notifyType: "error",
    };
  }

  host.setGoal(result.goal, "runtime", ctx);
  pi.sendMessage(
    {
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(result.goal),
      display: false,
      details: { kind, goalId: result.goal.goalId },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );

  return {
    queued: true,
    message: result.message,
  };
}

export async function handleGoalCommand(
  pi: GoalCommandPi,
  host: CommandHost,
  args: string,
  ctx: GoalCommandContext,
): Promise<void> {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    ctx.ui.notify(formatGoalSummary(host.getGoal()));
    return;
  }

  if (trimmed === "clear") {
    const goal = host.getGoal();
    if (!goal) {
      ctx.ui.notify("No goal is set.", "warning");
      return;
    }
    host.clearGoal("command", ctx);
    ctx.ui.notify("Goal cleared.");
    return;
  }

  if (trimmed === "pause" || trimmed === "resume") {
    const current = host.getGoal();
    const status = trimmed === "pause" ? "paused" : "active";
    const result = updateGoalStatus(current, status);
    if (!result.ok || !result.goal) {
      ctx.ui.notify(result.message, "warning");
      return;
    }
    host.setGoal(result.goal, "command", ctx);

    if (trimmed === "resume" && result.goal.status === "active") {
      const queueResult = queueGoalTurn(pi, host, result.goal, "command_resume", ctx);
      if (!queueResult.queued) {
        ctx.ui.notify(queueResult.message, queueResult.notifyType);
        return;
      }
    }

    ctx.ui.notify(result.message);
    return;
  }

  const current = host.getGoal();
  if (current && current.status !== "complete") {
    if (!ctx.hasUI) {
      ctx.ui.notify("Clear the existing goal before replacing it.", "error");
      return;
    }
    const shouldReplace = await ctx.ui.confirm(
      "Replace goal?",
      `Current goal:\n${current.objective}\n\nNew goal:\n${trimmed}`,
    );
    if (!shouldReplace) {
      ctx.ui.notify("Goal unchanged.");
      return;
    }
  }

  const result = replaceGoal(trimmed);
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "error");
    return;
  }
  host.setGoal(result.goal, "command", ctx);
  const queueResult = queueGoalTurn(pi, host, result.goal, "command_start", ctx);
  if (!queueResult.queued) {
    ctx.ui.notify(queueResult.message, queueResult.notifyType);
    return;
  }

  ctx.ui.notify(result.message);
}

export function registerGoalCommand(pi: GoalCommandPi, host: CommandHost): void {
  pi.registerCommand("goal", {
    description: "Show or manage the current Codex-style goal.",
    getArgumentCompletions(argumentPrefix) {
      return completions(argumentPrefix.trim());
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleGoalCommand(pi, host, args, ctx);
    },
  });
}
