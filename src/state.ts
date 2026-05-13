import { randomUUID } from "node:crypto";

import {
  CUSTOM_ENTRY_TYPE,
  MAX_OBJECTIVE_CHARS,
  type GoalCustomEntry,
  type GoalEntrySource,
  type GoalLimitReason,
  type GoalPolicy,
  type GoalProgress,
  type GoalResult,
  type GoalSnapshot,
  type GoalStatus,
  type SessionEntryLike,
  type ThreadGoal,
} from "./types.js";

export const DEFAULT_GOAL_POLICY: GoalPolicy = {
  maxContinuationTurns: null,
  maxRepeatedToolCalls: 3,
  maxRepeatedToolErrors: 3,
};

export const DEFAULT_GOAL_PROGRESS: GoalProgress = {
  continuationTurns: 0,
};

export interface ApplyUsageOptions {
  expectedGoalId?: string | null;
  accountBudgetLimited?: boolean;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  const clone: ThreadGoal = {
    ...goal,
    usage: { ...goal.usage },
  };
  if (goal.policy) {
    clone.policy = { ...goal.policy };
  }
  if (goal.progress) {
    clone.progress = cloneProgress(goal.progress);
  }
  return clone;
}

export function goalPolicy(goal: ThreadGoal): GoalPolicy {
  return {
    maxContinuationTurns: goal.policy?.maxContinuationTurns ?? DEFAULT_GOAL_POLICY.maxContinuationTurns,
    maxRepeatedToolCalls: goal.policy?.maxRepeatedToolCalls ?? DEFAULT_GOAL_POLICY.maxRepeatedToolCalls,
    maxRepeatedToolErrors: goal.policy?.maxRepeatedToolErrors ?? DEFAULT_GOAL_POLICY.maxRepeatedToolErrors,
  };
}

export function goalProgress(goal: ThreadGoal): GoalProgress {
  return cloneProgress({
    ...DEFAULT_GOAL_PROGRESS,
    ...goal.progress,
  });
}

function cloneProgress(progress: GoalProgress): GoalProgress {
  const clone: GoalProgress = {
    continuationTurns: progress.continuationTurns,
  };
  if (progress.repeatedToolCall) {
    clone.repeatedToolCall = { ...progress.repeatedToolCall };
  }
  if (progress.repeatedToolError) {
    clone.repeatedToolError = { ...progress.repeatedToolError };
  }
  return clone;
}

export function validateObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }
  if ([...trimmed].length > MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}

export function validateTokenBudget(tokenBudget: number | null | undefined): string | null {
  if (tokenBudget === null || tokenBudget === undefined) {
    return null;
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return "Token budget must be a positive integer.";
  }
  return null;
}

export function statusAfterBudgetLimit(status: GoalStatus, tokensUsed: number, tokenBudget: number | null): GoalStatus {
  if (status === "active" && tokenBudget !== null && tokensUsed >= tokenBudget) {
    return "budgetLimited";
  }
  return status;
}

function isTerminalLimitedStatus(status: GoalStatus): boolean {
  return (
    status === "budgetLimited" || status === "safetyLimited" || status === "loopLimited" || status === "errorLimited"
  );
}

function statusForLimitReason(reason: GoalLimitReason): GoalStatus {
  if (reason === "repeatedToolCall") {
    return "loopLimited";
  }
  if (reason === "repeatedToolError") {
    return "errorLimited";
  }
  return "safetyLimited";
}

export function createThreadGoal(objective: string, tokenBudget?: number | null, now = unixSeconds()): ThreadGoal {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    tokenBudget: tokenBudget ?? null,
    usage: {
      tokensUsed: 0,
      activeSeconds: 0,
    },
    policy: { ...DEFAULT_GOAL_POLICY },
    progress: { ...DEFAULT_GOAL_PROGRESS },
    createdAt: now,
    updatedAt: now,
  };
}

export function setEntry(goal: ThreadGoal, source: GoalEntrySource, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
    at,
  };
}

export function clearEntry(clearedGoalId: string | null, source: GoalEntrySource, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "clear",
    source,
    clearedGoalId,
    at,
  };
}

export function isGoalCustomEntry(data: unknown): data is GoalCustomEntry {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as GoalCustomEntry;
  if (entry.version !== 1 || typeof entry.at !== "number") {
    return false;
  }
  if (entry.kind === "clear") {
    return entry.clearedGoalId === null || typeof entry.clearedGoalId === "string";
  }
  return entry.kind === "set" && isThreadGoal(entry.goal);
}

export function isThreadGoal(goal: unknown): goal is ThreadGoal {
  if (!goal || typeof goal !== "object") {
    return false;
  }
  const candidate = goal as ThreadGoal;
  return (
    typeof candidate.goalId === "string" &&
    typeof candidate.objective === "string" &&
    isGoalStatus(candidate.status) &&
    (candidate.tokenBudget === null || typeof candidate.tokenBudget === "number") &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    candidate.usage !== undefined &&
    typeof candidate.usage.tokensUsed === "number" &&
    typeof candidate.usage.activeSeconds === "number" &&
    isOptionalGoalPolicy(candidate.policy) &&
    isOptionalGoalProgress(candidate.progress) &&
    isOptionalGoalLimitReason(candidate.limitReason)
  );
}

function isOptionalGoalPolicy(policy: unknown): policy is GoalPolicy | undefined {
  if (policy === undefined) {
    return true;
  }
  if (!policy || typeof policy !== "object") {
    return false;
  }
  const candidate = policy as GoalPolicy;
  return (
    isOptionalLimit(candidate.maxContinuationTurns) &&
    isOptionalLimit(candidate.maxRepeatedToolCalls) &&
    isOptionalLimit(candidate.maxRepeatedToolErrors)
  );
}

function isOptionalGoalProgress(progress: unknown): progress is GoalProgress | undefined {
  if (progress === undefined) {
    return true;
  }
  if (!progress || typeof progress !== "object") {
    return false;
  }
  const candidate = progress as GoalProgress;
  return (
    Number.isInteger(candidate.continuationTurns) &&
    candidate.continuationTurns >= 0 &&
    isOptionalRepeatedToolCallProgress(candidate.repeatedToolCall) &&
    isOptionalRepeatedToolErrorProgress(candidate.repeatedToolError)
  );
}

function isOptionalLimit(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function isOptionalRepeatedToolCallProgress(progress: unknown): progress is GoalProgress["repeatedToolCall"] {
  if (progress === undefined) {
    return true;
  }
  if (!progress || typeof progress !== "object") {
    return false;
  }
  const candidate = progress as { signature?: unknown; toolName?: unknown; count?: unknown };
  return (
    typeof candidate.signature === "string" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.count === "number" &&
    Number.isInteger(candidate.count) &&
    candidate.count >= 0
  );
}

function isOptionalRepeatedToolErrorProgress(progress: unknown): progress is GoalProgress["repeatedToolError"] {
  if (progress === undefined) {
    return true;
  }
  if (!progress || typeof progress !== "object") {
    return false;
  }
  const candidate = progress as { normalizedError?: unknown };
  return isOptionalRepeatedToolCallProgress(progress) && typeof candidate.normalizedError === "string";
}

function isOptionalGoalLimitReason(reason: unknown): reason is GoalLimitReason | undefined {
  return (
    reason === undefined ||
    reason === "maxContinuationTurns" ||
    reason === "repeatedToolCall" ||
    reason === "repeatedToolError"
  );
}

export function isGoalStatus(status: unknown): status is GoalStatus {
  return (
    status === "active" ||
    status === "paused" ||
    status === "budgetLimited" ||
    status === "safetyLimited" ||
    status === "loopLimited" ||
    status === "errorLimited" ||
    status === "complete"
  );
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): GoalSnapshot {
  let goal: ThreadGoal | null = null;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "clear") {
      goal = null;
    } else {
      goal = cloneGoal(entry.data.goal);
    }
  }

  return {
    goal,
    hasGoal: goal !== null,
  };
}

export function createGoal(current: ThreadGoal | null, objective: string, tokenBudget?: number | null): GoalResult {
  if (current) {
    return {
      ok: false,
      message:
        "cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete",
      goal: current,
    };
  }

  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal created.",
    goal,
  };
}

export function replaceGoal(objective: string, tokenBudget?: number | null): GoalResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal set.",
    goal,
  };
}

export function updateGoalStatus(current: ThreadGoal | null, status: GoalStatus): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  const goal = cloneGoal(current);
  if (current.status === "budgetLimited" && (status === "active" || status === "paused")) {
    goal.status = "budgetLimited";
  } else if (isTerminalLimitedStatus(current.status) && (status === "active" || status === "paused")) {
    goal.status = current.status;
  } else {
    goal.status = statusAfterBudgetLimit(status, goal.usage.tokensUsed, goal.tokenBudget);
  }
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: `Goal marked ${goal.status}.`,
    goal,
  };
}

export function hasReachedContinuationLimit(goal: ThreadGoal): boolean {
  const policy = goalPolicy(goal);
  if (policy.maxContinuationTurns === null) {
    return false;
  }
  return goalProgress(goal).continuationTurns >= policy.maxContinuationTurns;
}

export function recordContinuationQueued(current: ThreadGoal | null): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  const goal = cloneGoal(current);
  goal.policy = goalPolicy(goal);
  goal.progress = {
    ...goalProgress(goal),
    continuationTurns: goalProgress(goal).continuationTurns + 1,
  };
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: "Goal continuation recorded.",
    goal,
  };
}

export function recordToolCallObserved(current: ThreadGoal | null, toolName: string, signature: string): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  const goal = cloneGoal(current);
  const progress = goalProgress(goal);
  const previous = progress.repeatedToolCall;
  progress.repeatedToolCall = {
    signature,
    toolName,
    count: previous?.signature === signature ? previous.count + 1 : 1,
  };
  goal.policy = goalPolicy(goal);
  goal.progress = progress;
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: "Goal tool call recorded.",
    goal,
  };
}

export function recordToolErrorObserved(
  current: ThreadGoal | null,
  toolName: string,
  signature: string,
  normalizedError: string,
): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  const goal = cloneGoal(current);
  const progress = goalProgress(goal);
  const previous = progress.repeatedToolError;
  progress.repeatedToolError = {
    signature,
    toolName,
    normalizedError,
    count: previous?.signature === signature ? previous.count + 1 : 1,
  };
  goal.policy = goalPolicy(goal);
  goal.progress = progress;
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: "Goal tool error recorded.",
    goal,
  };
}

export function clearToolErrorProgress(current: ThreadGoal | null): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  const progress = goalProgress(current);
  if (!progress.repeatedToolError) {
    return {
      ok: true,
      message: "Goal tool error progress unchanged.",
      goal: current,
    };
  }

  const goal = cloneGoal(current);
  const nextProgress = goalProgress(goal);
  delete nextProgress.repeatedToolError;
  goal.progress = nextProgress;
  goal.updatedAt = unixSeconds();
  return {
    ok: true,
    message: "Goal tool error progress cleared.",
    goal,
  };
}

export function limitGoal(current: ThreadGoal | null, reason: GoalLimitReason): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  const goal = cloneGoal(current);
  goal.status = statusForLimitReason(reason);
  goal.limitReason = reason;
  goal.policy = goalPolicy(goal);
  goal.progress = goalProgress(goal);
  goal.updatedAt = unixSeconds();

  return {
    ok: true,
    message: `Goal limited by ${reason}.`,
    goal,
  };
}

export function applyUsage(
  current: ThreadGoal | null,
  tokensDelta: number,
  activeSecondsDelta: number,
  options: ApplyUsageOptions = {},
): { goal: ThreadGoal | null; changed: boolean; crossedBudget: boolean } {
  if (!current) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  if (
    options.expectedGoalId !== undefined &&
    options.expectedGoalId !== null &&
    current.goalId !== options.expectedGoalId
  ) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const canAccount =
    current.status === "active" || (options.accountBudgetLimited === true && current.status === "budgetLimited");
  if (!canAccount) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const tokens = Math.max(0, Math.trunc(tokensDelta));
  const seconds = Math.max(0, Math.trunc(activeSecondsDelta));
  if (tokens === 0 && seconds === 0) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const goal = cloneGoal(current);
  const wasUnderBudget = goal.tokenBudget === null || goal.usage.tokensUsed < goal.tokenBudget;
  goal.usage.tokensUsed += tokens;
  goal.usage.activeSeconds += seconds;
  goal.status = statusAfterBudgetLimit(goal.status, goal.usage.tokensUsed, goal.tokenBudget);
  goal.updatedAt = unixSeconds();

  const crossedBudget =
    current.status === "active" &&
    wasUnderBudget &&
    goal.tokenBudget !== null &&
    goal.usage.tokensUsed >= goal.tokenBudget;

  return { goal, changed: true, crossedBudget };
}

export function goalWithLiveUsage(
  current: ThreadGoal | null,
  activeGoalId: string | null,
  lastAccountedAt: number | null,
  now = Date.now(),
): ThreadGoal | null {
  if (!current || current.status !== "active" || activeGoalId !== current.goalId || lastAccountedAt === null) {
    return current;
  }

  const liveSeconds = Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
  if (liveSeconds === 0) {
    return current;
  }

  const goal = cloneGoal(current);
  goal.usage.activeSeconds += liveSeconds;
  return goal;
}
