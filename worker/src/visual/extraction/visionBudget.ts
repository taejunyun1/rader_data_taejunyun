export const VISUAL_EXTRACTION_VISION_CALL_LIMIT = 80;

export type VisualExtractionVisionBlockReason =
  | "monthly_budget_exhausted"
  | "visual_extraction_call_limit";

export interface VisualExtractionVisionDiagnostics {
  callLimit: number;
  reservationUsd: number;
  budgetReserved: boolean;
  budgetBlocked: boolean;
  attempted: number;
  completed: number;
  failed: number;
  blocked: number;
  capBlocked: number;
}

export interface VisualExtractionVisionPersistenceState {
  diagnostics: VisualExtractionVisionDiagnostics;
  slotsUsed: number;
}

export interface VisualExtractionVisionPersistence {
  load(): Promise<VisualExtractionVisionPersistenceState>;
  seed(input: { budgetReserved: boolean; reservationUsd: number }): Promise<VisualExtractionVisionPersistenceState>;
  recordRequest(): Promise<VisualExtractionVisionPersistenceState>;
  claimSlot(): Promise<{ claimed: boolean; state: VisualExtractionVisionPersistenceState }>;
  recordBlocked(reason: VisualExtractionVisionBlockReason): Promise<VisualExtractionVisionPersistenceState>;
  recordCompleted(): Promise<VisualExtractionVisionPersistenceState>;
  recordFailed(): Promise<VisualExtractionVisionPersistenceState>;
}

export interface VisualExtractionVisionGate {
  execute<T>(modelCall: () => Promise<T>): Promise<T>;
  snapshot(): VisualExtractionVisionDiagnostics;
  refresh(): Promise<VisualExtractionVisionDiagnostics>;
}

export class VisualExtractionVisionBlockedError extends Error {
  constructor(public readonly reason: VisualExtractionVisionBlockReason) {
    super(reason);
    this.name = "VisualExtractionVisionBlockedError";
  }
}

export function createVisualExtractionVisionGate(input: {
  budgetReserved?: boolean;
  reservationUsd?: number;
  callLimit?: number;
  initialState?: VisualExtractionVisionPersistenceState;
  persistence?: VisualExtractionVisionPersistence;
}): VisualExtractionVisionGate {
  let state: VisualExtractionVisionPersistenceState = input.initialState ?? {
    diagnostics: {
      callLimit: input.callLimit ?? VISUAL_EXTRACTION_VISION_CALL_LIMIT,
      reservationUsd: input.reservationUsd ?? 0,
      budgetReserved: input.budgetReserved ?? false,
      budgetBlocked: !(input.budgetReserved ?? false),
      attempted: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      capBlocked: 0,
    },
    slotsUsed: 0,
  };

  const update = (next: VisualExtractionVisionPersistenceState): void => {
    state = next;
  };

  const localPersistence: VisualExtractionVisionPersistence = {
    async load() {
      return state;
    },
    async seed(seedInput) {
      update({
        diagnostics: {
          ...state.diagnostics,
          reservationUsd: Math.max(state.diagnostics.reservationUsd, seedInput.reservationUsd),
          budgetReserved: state.diagnostics.budgetReserved || seedInput.budgetReserved,
          budgetBlocked: state.diagnostics.budgetBlocked && !seedInput.budgetReserved,
        },
        slotsUsed: state.slotsUsed,
      });
      return state;
    },
    async recordRequest() {
      update({ ...state, diagnostics: { ...state.diagnostics, attempted: state.diagnostics.attempted + 1 } });
      return state;
    },
    async claimSlot() {
      if (!state.diagnostics.budgetReserved || state.slotsUsed >= state.diagnostics.callLimit) {
        return { claimed: false, state };
      }
      update({ ...state, slotsUsed: state.slotsUsed + 1 });
      return { claimed: true, state };
    },
    async recordBlocked(reason) {
      update({
        ...state,
        diagnostics: {
          ...state.diagnostics,
          blocked: state.diagnostics.blocked + 1,
          budgetBlocked: state.diagnostics.budgetBlocked || reason === "monthly_budget_exhausted",
          capBlocked: state.diagnostics.capBlocked + (reason === "visual_extraction_call_limit" ? 1 : 0),
        },
      });
      return state;
    },
    async recordCompleted() {
      update({ ...state, diagnostics: { ...state.diagnostics, completed: state.diagnostics.completed + 1 } });
      return state;
    },
    async recordFailed() {
      update({ ...state, diagnostics: { ...state.diagnostics, failed: state.diagnostics.failed + 1 } });
      return state;
    },
  };
  const persistence = input.persistence ?? localPersistence;

  return {
    async execute<T>(modelCall: () => Promise<T>): Promise<T> {
      update(await persistence.recordRequest());
      if (!state.diagnostics.budgetReserved) {
        update(await persistence.recordBlocked("monthly_budget_exhausted"));
        throw new VisualExtractionVisionBlockedError("monthly_budget_exhausted");
      }
      const slot = await persistence.claimSlot();
      update(slot.state);
      if (!slot.claimed) {
        update(await persistence.recordBlocked("visual_extraction_call_limit"));
        throw new VisualExtractionVisionBlockedError("visual_extraction_call_limit");
      }
      try {
        const result = await modelCall();
        update(await persistence.recordCompleted());
        return result;
      } catch (error) {
        update(await persistence.recordFailed());
        throw error;
      }
    },
    snapshot(): VisualExtractionVisionDiagnostics {
      return { ...state.diagnostics };
    },
    async refresh(): Promise<VisualExtractionVisionDiagnostics> {
      update(await persistence.load());
      return { ...state.diagnostics };
    },
  };
}

export function isVisualExtractionVisionBlocked(error: unknown): error is VisualExtractionVisionBlockedError {
  return error instanceof VisualExtractionVisionBlockedError;
}
