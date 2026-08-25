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

export interface VisualExtractionVisionGate {
  execute<T>(modelCall: () => Promise<T>): Promise<T>;
  snapshot(): VisualExtractionVisionDiagnostics;
}

export class VisualExtractionVisionBlockedError extends Error {
  constructor(public readonly reason: VisualExtractionVisionBlockReason) {
    super(reason);
    this.name = "VisualExtractionVisionBlockedError";
  }
}

export function createVisualExtractionVisionGate(input: {
  budgetReserved: boolean;
  reservationUsd: number;
  callLimit?: number;
}): VisualExtractionVisionGate {
  const callLimit = input.callLimit ?? VISUAL_EXTRACTION_VISION_CALL_LIMIT;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let blocked = 0;
  let capBlocked = 0;

  return {
    async execute<T>(modelCall: () => Promise<T>): Promise<T> {
      attempted += 1;
      if (!input.budgetReserved) {
        blocked += 1;
        throw new VisualExtractionVisionBlockedError("monthly_budget_exhausted");
      }
      if (attempted - blocked > callLimit) {
        blocked += 1;
        capBlocked += 1;
        throw new VisualExtractionVisionBlockedError("visual_extraction_call_limit");
      }
      try {
        const result = await modelCall();
        completed += 1;
        return result;
      } catch (error) {
        failed += 1;
        throw error;
      }
    },
    snapshot(): VisualExtractionVisionDiagnostics {
      return {
        callLimit,
        reservationUsd: input.reservationUsd,
        budgetReserved: input.budgetReserved,
        budgetBlocked: !input.budgetReserved,
        attempted,
        completed,
        failed,
        blocked,
        capBlocked,
      };
    },
  };
}

export function isVisualExtractionVisionBlocked(error: unknown): error is VisualExtractionVisionBlockedError {
  return error instanceof VisualExtractionVisionBlockedError;
}
