import { z } from 'zod';

export const EvidenceSchema = z.object({
  repo: z.string(), // org/repo
  file: z.string(),
  line: z.number().optional(),
  quote: z.string().optional(),
});

export const FindingSchema = z.object({
  file: z.string(), // path within the PR repo, as in the numbered diff
  line: z.number().optional(), // new-file line number, as in the numbered diff
  severity: z.enum(['error', 'warning', 'info']),
  title: z.string(),
  body: z.string(),
  evidence: z.array(EvidenceSchema).max(5).default([]),
});

export const ReviewSchema = z.object({
  summary: z.string(),
  overall: z.enum(['changes_requested', 'comment', 'approve']),
  findings: z.array(FindingSchema).max(20),
});

export type Review = z.infer<typeof ReviewSchema>;
export type Finding = z.infer<typeof FindingSchema>;

// Parse Claude's text as a JSON review (handles ```json fences) and validate it.
export function parseReviewText(text: string): Review {
  const body = stripCodeFence(text);
  const json = JSON.parse(body) as unknown;
  return ReviewSchema.parse(json);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (fence?.[1] ?? trimmed).trim();
}
