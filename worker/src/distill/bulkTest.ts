/**
 * Deterministic, provider-free harness for exercising large Distill runs.
 *
 * This module deliberately does not call OpenAI, D1, R2, or Workers AI. It is
 * used to validate chunking, provenance, budget admission, concurrency, and
 * artifact reuse before a live cost-bearing run is enabled.
 */

export type BulkModelRole = "base" | "review";
export type BulkStageKind =
  | "MAP"
  | "REDUCE"
  | "SYNTHESIS"
  | "CRITIC"
  | "COUNTER"
  | "VALIDATION"
  | "REPAIR";

export interface BulkSource {
  id: string;
  versionId: string;
  title: string;
  kind: string;
  text: string;
}

export interface BulkChunk {
  id: string;
  sourceId: string;
  versionId: string;
  sourceIndex: number;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  text: string;
  estimatedInputTokens: number;
}

export interface BulkPriceRate {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface BulkPlanOptions {
  targetChunkTokens?: number;
  reduceFanIn?: number;
  includeCounter?: boolean;
  concurrency?: number;
  capUsd?: number;
  monthRemainingUsd?: number;
  reserveMultiplier?: number;
  mapOutputTokens?: number;
  reduceOutputTokens?: number;
  synthesisOutputTokens?: number;
  criticOutputTokens?: number;
  counterOutputTokens?: number;
  validationOutputTokens?: number;
  repairOutputTokens?: number;
  rates?: Partial<Record<BulkModelRole, BulkPriceRate>>;
}

export interface BulkStageEstimate {
  kind: BulkStageKind;
  count: number;
  modelRole: BulkModelRole;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface BulkPlan {
  capUsd: number;
  monthRemainingUsd: number;
  concurrency: number;
  chunks: BulkChunk[];
  stages: BulkStageEstimate[];
  estimatedCostUsd: number;
  reserveUsd: number;
  blocked: boolean;
  blockReason?: "CAP_EXCEEDED" | "MONTHLY_BUDGET_EXCEEDED";
}

export interface BulkSimulationRequest {
  stage: BulkStageKind;
  artifactKey: string;
  inputTokens: number;
  outputTokens: number;
  modelRole: BulkModelRole;
  sourceIds: string[];
}

export interface BulkSimulationResponse {
  outputRef: string;
  costUsd: number;
  needsRepair?: boolean;
}

export interface BulkSimulationExecutor {
  call(request: BulkSimulationRequest): Promise<BulkSimulationResponse>;
}

export interface BulkArtifact {
  outputRef: string;
  costUsd: number;
  needsRepair?: boolean;
}

export interface BulkArtifactCache {
  get(key: string): Promise<BulkArtifact | undefined>;
  set(key: string, value: BulkArtifact): Promise<void>;
}

export interface BulkSimulationResult {
  status: "SUCCEEDED" | "PARTIAL_BUDGET_STOP" | "BLOCKED";
  actualCostUsd: number;
  cacheHits: number;
  calls: number;
  maxConcurrency: number;
  completedStages: BulkStageKind[];
  plan: BulkPlan;
  cache: BulkArtifactCache;
}

const DEFAULT_RATES: Record<BulkModelRole, BulkPriceRate> = {
  base: { inputPerMillionUsd: 0.25, outputPerMillionUsd: 2 },
  review: { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5 },
};

const DEFAULTS = {
  targetChunkTokens: 8_000,
  reduceFanIn: 8,
  includeCounter: true,
  concurrency: 4,
  capUsd: 3,
  monthRemainingUsd: Number.POSITIVE_INFINITY,
  reserveMultiplier: 1.15,
  mapOutputTokens: 350,
  reduceOutputTokens: 500,
  synthesisOutputTokens: 1_000,
  criticOutputTokens: 400,
  counterOutputTokens: 650,
  validationOutputTokens: 250,
  repairOutputTokens: 700,
};

type ResolvedBulkOptions = Omit<Required<BulkPlanOptions>, "rates"> & {
  rates: Record<BulkModelRole, BulkPriceRate>;
};

interface StageShape {
  kind: BulkStageKind;
  modelRole: BulkModelRole;
  count: number;
  inputTokens: number;
  outputTokens: number;
}

interface PipelineArtifact {
  key: string;
  outputRef: string;
  estimatedTokens: number;
  needsRepair?: boolean;
}

interface StageExecutionResult {
  artifact: PipelineArtifact;
  cacheHit: boolean;
}

interface StageWork {
  artifactKey: string;
  inputTokens: number;
  outputTokens: number;
  sourceIds: string[];
}

function resolveOptions(options: BulkPlanOptions = {}): ResolvedBulkOptions {
  const resolved = {
    ...DEFAULTS,
    ...options,
    rates: {
      ...DEFAULT_RATES,
      ...(options.rates ?? {}),
    },
  };

  if (!Number.isInteger(resolved.targetChunkTokens) || resolved.targetChunkTokens < 1) {
    throw new Error("targetChunkTokens must be a positive integer");
  }
  if (!Number.isInteger(resolved.reduceFanIn) || resolved.reduceFanIn < 2) {
    throw new Error("reduceFanIn must be an integer greater than one");
  }
  if (!Number.isInteger(resolved.concurrency) || resolved.concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  if (resolved.reserveMultiplier < 1) {
    throw new Error("reserveMultiplier must be at least one");
  }

  return resolved;
}

function estimatedTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function costFor(role: BulkModelRole, inputTokens: number, outputTokens: number, rates: Record<BulkModelRole, BulkPriceRate>): number {
  const rate = rates[role];
  return (inputTokens / 1_000_000) * rate.inputPerMillionUsd + (outputTokens / 1_000_000) * rate.outputPerMillionUsd;
}

function lastBoundary(text: string, start: number, end: number): number {
  const slice = text.slice(start, end);
  const paragraph = slice.lastIndexOf("\n\n");
  if (paragraph >= 0) return start + paragraph + 2;
  const line = slice.lastIndexOf("\n");
  if (line >= 0) return start + line + 1;
  return end;
}

function splitSource(source: BulkSource, sourceIndex: number, targetChunkTokens: number): BulkChunk[] {
  if (!source.text.trim()) return [];

  const maxChars = Math.max(1, targetChunkTokens * 4);
  const chunks: BulkChunk[] = [];
  let start = 0;
  let chunkIndex = 0;

  while (start < source.text.length) {
    const hardEnd = Math.min(source.text.length, start + maxChars);
    let end = hardEnd;
    if (hardEnd < source.text.length) {
      const boundary = lastBoundary(source.text, start, hardEnd);
      const boundaryLength = boundary - start;
      if (boundaryLength >= Math.max(1, Math.floor(maxChars * 0.4))) {
        end = boundary;
      }
    }

    const rawText = source.text.slice(start, end);
    const text = rawText.trim();
    const leadingWhitespace = rawText.length - rawText.trimStart().length;
    const actualStart = start + leadingWhitespace;
    const actualEnd = actualStart + text.length;
    if (text.length > 0) {
      chunks.push({
        id: `${source.id}:${source.versionId}:${chunkIndex}`,
        sourceId: source.id,
        versionId: source.versionId,
        sourceIndex,
        chunkIndex,
        startChar: actualStart,
        endChar: actualEnd,
        text,
        estimatedInputTokens: estimatedTokens(text),
      });
      chunkIndex += 1;
    }

    // Always advance using the untrimmed range. This keeps offsets monotonic
    // and avoids an infinite loop on whitespace-only separators.
    start = end;
  }

  return chunks;
}

function stageEstimate(shape: StageShape, rates: Record<BulkModelRole, BulkPriceRate>): BulkStageEstimate {
  return {
    ...shape,
    estimatedCostUsd: roundUsd(costFor(shape.modelRole, shape.inputTokens, shape.outputTokens, rates)),
  };
}

function buildStageShapes(chunks: BulkChunk[], options: ResolvedBulkOptions): StageShape[] {
  const shapes: StageShape[] = [];
  const mapInput = chunks.reduce((sum, chunk) => sum + chunk.estimatedInputTokens, 0);
  if (chunks.length > 0) {
    shapes.push({
      kind: "MAP",
      modelRole: "base",
      count: chunks.length,
      inputTokens: mapInput,
      outputTokens: chunks.length * options.mapOutputTokens,
    });
  }

  let levelCount = chunks.length;
  let levelInput = chunks.reduce((sum, chunk) => sum + options.mapOutputTokens, 0);
  while (levelCount > options.reduceFanIn) {
    const nextCount = Math.ceil(levelCount / options.reduceFanIn);
    shapes.push({
      kind: "REDUCE",
      modelRole: "base",
      count: nextCount,
      inputTokens: levelInput,
      outputTokens: nextCount * options.reduceOutputTokens,
    });
    levelCount = nextCount;
    levelInput = nextCount * options.reduceOutputTokens;
  }

  if (chunks.length > 0) {
    shapes.push({
      kind: "SYNTHESIS",
      modelRole: "base",
      count: 1,
      inputTokens: Math.max(levelInput, options.mapOutputTokens),
      outputTokens: options.synthesisOutputTokens,
    });
    shapes.push({
      kind: "CRITIC",
      modelRole: "review",
      count: 1,
      inputTokens: options.synthesisOutputTokens,
      outputTokens: options.criticOutputTokens,
    });
    if (options.includeCounter) {
      shapes.push({
        kind: "COUNTER",
        modelRole: "review",
        count: 1,
        inputTokens: options.synthesisOutputTokens,
        outputTokens: options.counterOutputTokens,
      });
      shapes.push({
        kind: "VALIDATION",
        modelRole: "review",
        count: 1,
        inputTokens: options.synthesisOutputTokens + options.counterOutputTokens,
        outputTokens: options.validationOutputTokens,
      });
      // Reserve the repair path up front. A live run must not discover that
      // its worst-case correction path has no remaining budget halfway through.
      shapes.push({
        kind: "REPAIR",
        modelRole: "review",
        count: 1,
        inputTokens: options.synthesisOutputTokens + options.counterOutputTokens,
        outputTokens: options.repairOutputTokens,
      });
    }
  }

  return shapes;
}

export function planBulkDistill(sources: BulkSource[], options: BulkPlanOptions = {}): BulkPlan {
  const resolved = resolveOptions(options);
  const chunks = sources.flatMap((source, sourceIndex) => splitSource(source, sourceIndex, resolved.targetChunkTokens));
  const stages = buildStageShapes(chunks, resolved).map((shape) => stageEstimate(shape, resolved.rates));
  const estimatedCostUsd = roundUsd(stages.reduce((sum, stage) => sum + stage.estimatedCostUsd, 0));
  const reserveUsd = roundUsd(estimatedCostUsd * resolved.reserveMultiplier);
  const capUsd = resolved.capUsd;
  const monthRemainingUsd = resolved.monthRemainingUsd;
  let blockReason: BulkPlan["blockReason"];
  if (reserveUsd > capUsd) {
    blockReason = "CAP_EXCEEDED";
  } else if (reserveUsd > monthRemainingUsd) {
    blockReason = "MONTHLY_BUDGET_EXCEEDED";
  }

  return {
    capUsd,
    monthRemainingUsd,
    concurrency: resolved.concurrency,
    chunks,
    stages,
    estimatedCostUsd,
    reserveUsd,
    blocked: Boolean(blockReason),
    ...(blockReason ? { blockReason } : {}),
  };
}

export async function runBoundedParallel<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runWorker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

export function createBulkArtifactCache(): BulkArtifactCache {
  const artifacts = new Map<string, BulkArtifact>();
  return {
    async get(key) {
      return artifacts.get(key);
    },
    async set(key, value) {
      artifacts.set(key, value);
    },
  };
}

function sourceIdsForArtifacts(artifacts: PipelineArtifact[]): string[] {
  return artifacts.flatMap((artifact) => artifact.key.split("|").filter((part) => part.startsWith("source:")).map((part) => part.slice("source:".length)));
}

export async function runBulkDistillSimulation(
  sources: BulkSource[],
  options: BulkPlanOptions = {},
  executor: BulkSimulationExecutor,
  cache: BulkArtifactCache = createBulkArtifactCache(),
): Promise<BulkSimulationResult> {
  const plan = planBulkDistill(sources, options);
  if (plan.blocked) {
    return {
      status: "BLOCKED",
      actualCostUsd: 0,
      cacheHits: 0,
      calls: 0,
      maxConcurrency: 0,
      completedStages: [],
      plan,
      cache,
    };
  }

  const resolved = resolveOptions(options);
  let actualCostUsd = 0;
  let cacheHits = 0;
  let calls = 0;
  let active = 0;
  let maxConcurrency = 0;
  let reservedEstimateUsd = 0;
  let budgetStopped = false;
  const completedStages: BulkStageKind[] = [];

  const executeStage = async (kind: BulkStageKind, modelRole: BulkModelRole, work: StageWork[]): Promise<PipelineArtifact[]> => {
    if (work.length === 0 || budgetStopped) return [];

    const results = await runBoundedParallel<StageWork, StageExecutionResult | null>(work, plan.concurrency, async (item) => {
      const cached = await cache.get(item.artifactKey);
      if (cached) {
        cacheHits += 1;
        return {
          cacheHit: true,
          artifact: {
            key: item.artifactKey,
            outputRef: cached.outputRef,
            estimatedTokens: item.outputTokens,
            needsRepair: cached.needsRepair,
          },
        };
      }

      const estimatedCallCost = costFor(modelRole, item.inputTokens, item.outputTokens, resolved.rates);
      if (actualCostUsd + reservedEstimateUsd + estimatedCallCost > plan.capUsd) {
        budgetStopped = true;
        return null;
      }

      reservedEstimateUsd += estimatedCallCost;
      active += 1;
      maxConcurrency = Math.max(maxConcurrency, active);
      try {
        const response = await executor.call({
          stage: kind,
          artifactKey: item.artifactKey,
          inputTokens: item.inputTokens,
          outputTokens: item.outputTokens,
          modelRole,
          sourceIds: item.sourceIds,
        });
        calls += 1;
        actualCostUsd = roundUsd(actualCostUsd + Math.max(0, response.costUsd));
        if (actualCostUsd > plan.capUsd) budgetStopped = true;
        const artifact = {
          outputRef: response.outputRef,
          costUsd: response.costUsd,
          needsRepair: response.needsRepair,
        } satisfies BulkArtifact;
        await cache.set(item.artifactKey, artifact);
        return {
          cacheHit: false,
          artifact: {
            key: item.artifactKey,
            outputRef: response.outputRef,
            estimatedTokens: item.outputTokens,
            needsRepair: response.needsRepair,
          },
        };
      } finally {
        active -= 1;
        reservedEstimateUsd -= estimatedCallCost;
      }
    });

    const completed = results.filter((result): result is StageExecutionResult => result !== null).map((result) => result.artifact);
    if (completed.length === work.length) completedStages.push(kind);
    return completed;
  };

  const mapWork: StageWork[] = plan.chunks.map((chunk) => ({
    artifactKey: `MAP|source:${chunk.sourceId}|version:${chunk.versionId}|chunk:${chunk.chunkIndex}`,
    inputTokens: chunk.estimatedInputTokens,
    outputTokens: resolved.mapOutputTokens,
    sourceIds: [chunk.sourceId],
  }));
  let current = await executeStage("MAP", "base", mapWork);

  while (current.length > resolved.reduceFanIn && !budgetStopped) {
    const groups: StageWork[] = [];
    for (let index = 0; index < current.length; index += resolved.reduceFanIn) {
      const group = current.slice(index, index + resolved.reduceFanIn);
      groups.push({
        artifactKey: `REDUCE|${group.map((artifact) => artifact.key).join("|")}`,
        inputTokens: group.reduce((sum, artifact) => sum + artifact.estimatedTokens, 0),
        outputTokens: resolved.reduceOutputTokens,
        sourceIds: sourceIdsForArtifacts(group),
      });
    }
    current = await executeStage("REDUCE", "base", groups);
  }

  if (current.length > 0 && !budgetStopped) {
    const synthesis = await executeStage("SYNTHESIS", "base", [{
      artifactKey: `SYNTHESIS|${current.map((artifact) => artifact.key).join("|")}`,
      inputTokens: current.reduce((sum, artifact) => sum + artifact.estimatedTokens, 0),
      outputTokens: resolved.synthesisOutputTokens,
      sourceIds: sourceIdsForArtifacts(current),
    }]);
    current = synthesis;

    const critic = await executeStage("CRITIC", "review", current.map((artifact) => ({
      artifactKey: `CRITIC|${artifact.key}`,
      inputTokens: artifact.estimatedTokens,
      outputTokens: resolved.criticOutputTokens,
      sourceIds: sourceIdsForArtifacts([artifact]),
    })));
    const needsRepair = critic.some((artifact) => artifact.needsRepair);

    if (resolved.includeCounter && !budgetStopped) {
      const counter = await executeStage("COUNTER", "review", current.map((artifact) => ({
        artifactKey: `COUNTER|${artifact.key}`,
        inputTokens: artifact.estimatedTokens,
        outputTokens: resolved.counterOutputTokens,
        sourceIds: sourceIdsForArtifacts([artifact]),
      })));
      const validation = await executeStage("VALIDATION", "review", current.map((artifact, index) => ({
        artifactKey: `VALIDATION|${artifact.key}|${counter[index]?.key ?? "missing-counter"}`,
        inputTokens: artifact.estimatedTokens + (counter[index]?.estimatedTokens ?? resolved.counterOutputTokens),
        outputTokens: resolved.validationOutputTokens,
        sourceIds: sourceIdsForArtifacts([artifact]),
      })));
      const validationNeedsRepair = validation.some((artifact) => artifact.needsRepair);
      if ((needsRepair || validationNeedsRepair) && !budgetStopped) {
        await executeStage("REPAIR", "review", current.map((artifact) => ({
          artifactKey: `REPAIR|${artifact.key}`,
          inputTokens: artifact.estimatedTokens + resolved.counterOutputTokens,
          outputTokens: resolved.repairOutputTokens,
          sourceIds: sourceIdsForArtifacts([artifact]),
        })));
      }
    }
  }

  return {
    status: budgetStopped ? "PARTIAL_BUDGET_STOP" : "SUCCEEDED",
    actualCostUsd,
    cacheHits,
    calls,
    maxConcurrency,
    completedStages,
    plan,
    cache,
  };
}
