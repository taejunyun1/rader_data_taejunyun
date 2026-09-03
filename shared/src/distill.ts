export interface DistillThoughtDetail {
  summaryIndex: number;
  rationale: string;
  sourceIds: string[];
  uncertainty: string;
  nextCheck: string;
}

export interface DistillQuestionDetail {
  summaryIndex: number;
  whyNow: string;
  method: string;
  evidenceNeeded: string;
  sourceIds: string[];
}

export interface DistillResearchGapDetail {
  summaryIndex: number;
  diagnosis: string;
  researchMethod: string;
  sourceIds: string[];
}

export interface DistillResearchDirectionDetail {
  summaryIndex: number;
  rationale: string;
  method: string;
  expectedOutcome: string;
  sourceIds: string[];
}

export interface DistillArtworkDirectionDetail {
  summaryIndex: number;
  rationale: string;
  materials: string[];
  procedure: string;
  observation: string;
  sourceIds: string[];
}

export interface DistillDetails {
  thoughts: DistillThoughtDetail[];
  questions: DistillQuestionDetail[];
  researchGaps: DistillResearchGapDetail[];
  researchDirections: DistillResearchDirectionDetail[];
  artworkDirections: DistillArtworkDirectionDetail[];
}

export interface DistillOutput {
  keywords: string[];
  thoughts_fragments: string[];
  questions: string[];
  read_next: { title: string; author?: string; why_read: string; related_question?: string }[];
  research_gaps: { gap: string; kind: string }[];
  research_directions: string[];
  artwork_directions: string[];
  small_experiment?: string;
  details?: DistillDetails;
}
