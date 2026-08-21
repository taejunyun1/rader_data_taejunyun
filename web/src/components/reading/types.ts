import type { SourceAccess } from "../../lib/sourceAccess";

export interface SourceIndexItem {
  id: string;
  title: string;
  meta: string;
  tags: string[];
  access: SourceAccess;
}

export interface ReadingDocument {
  id: string;
  title: string;
  byline: string;
  provenance: string;
  access: SourceAccess;
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
