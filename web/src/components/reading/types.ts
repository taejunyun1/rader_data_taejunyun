import type { SourceAccess } from "../../lib/sourceAccess";

export interface SourceIndexItem {
  id: string;
  title: string;
  meta: string;
  tags: string[];
  access: SourceAccess;
}

export interface SourceAcquisitionView {
  textScope: "FULLTEXT" | "PARTIAL" | "METADATA_ONLY" | "EMPTY" | "UNKNOWN";
  extractionMethod: string;
  qualityStatus: string;
  charCount: number;
  acquisitionLabel: string;
  canDeepAnalyze: boolean;
  originalTextUrl: string | null;
  acquisitionError?: string | null;
}

export interface ReadingDocument {
  id: string;
  title: string;
  originalTitle?: string;
  byline: string;
  provenance: string;
  access: SourceAccess;
  acquisition?: SourceAcquisitionView | null;
  originalText?: string | null;
  summary: string | null;
  fragments: string[];
  questions: string[];
  keywords: string[];
}

export interface DecisionAction {
  id: "develop" | "keep" | "watch" | "ignore";
  label: string;
  description: string;
}
