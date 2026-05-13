export const CUSTOM_ENTRY_TYPE = "pi-goalkeeper";
export const MAX_OBJECTIVE_CHARS = 8000;

export type GoalStatus = "active" | "paused" | "budgetLimited" | "loopLimited" | "complete";

export type GoalLimitReason = "maxContinuationTurns";

export interface GoalPolicy {
  maxContinuationTurns: number | null;
}

export interface GoalProgress {
  continuationTurns: number;
}

export interface GoalUsage {
  tokensUsed: number;
  activeSeconds: number;
}

export interface ThreadGoal {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  usage: GoalUsage;
  policy?: GoalPolicy;
  progress?: GoalProgress;
  limitReason?: GoalLimitReason;
  createdAt: number;
  updatedAt: number;
}

export type GoalEntrySource = "command" | "tool" | "runtime";

export type GoalCustomEntry =
  | {
      version: 1;
      kind: "set";
      source: GoalEntrySource;
      goal: ThreadGoal;
      at: number;
    }
  | {
      version: 1;
      kind: "clear";
      source: GoalEntrySource;
      clearedGoalId: string | null;
      at: number;
    };

export interface GoalResult {
  ok: boolean;
  message: string;
  goal: ThreadGoal | null;
}

export interface GoalSnapshot {
  goal: ThreadGoal | null;
  hasGoal: boolean;
}

export interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}
