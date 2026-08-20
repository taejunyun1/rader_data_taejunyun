import type { RadarPeriod } from "@radar/shared";
import { computeStats, saveSnapshot, windowFor } from "./snapshot";
import { callOpenAi } from "../lib/openai";

export interface SynthesisSection {
  heading: string;
  items: string[];
}

export interface RadarSynthesis {
  period: RadarPeriod;
  narrative: string;
  sections: SynthesisSection[];
  biasWatch: string[];
  costUsd: number;
}
