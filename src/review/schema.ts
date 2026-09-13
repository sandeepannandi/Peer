import { z } from 'zod';

export const EvidenceSchema = z.object({
  repo: z.string(), // org/repo
  file: z.string(),
  line: z.number().optional(),
  quote: z.string().optional(),
});

export const FindingCategory = z.enum([
  'bug_risk',
  'performance',
  'security',
  'correctness',
  'style',
  'maintainability',
  'cross_repo',
]);

export const FindingSchema = z.object({
  file: z.string(), // path within the PR repo, as in the numbered diff
  line: z.number().optional(), // new-file line number, as in the numbered diff
  severity: z.enum(['error', 'warning', 'info']),
  category: FindingCategory.optional(),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().optional(), // concrete, actionable fix
  evidence: z.array(EvidenceSchema).max(5).default([]),
});

export const ReviewSchema = z.object({
  summary: z.string(),
  overall: z.enum(['changes_requested', 'comment', 'approve']),
  strengths: z.array(z.string()).max(10).default([]),
  findings: z.array(FindingSchema).max(20),
});

export type Review = z.infer<typeof ReviewSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type FindingCategory = z.infer<typeof FindingCategory>;

// Strip emoji ranges so none ever reach the output.
const EMOJI_RE =
  /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0F}]/gu;

function stripEmojis(value: string): string {
  return value
    .replace(EMOJI_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Recursively remove emoji from every string in the parsed review data. */
function stripEmojisDeep<T>(value: T): T {
  if (typeof value === 'string') return stripEmojis(value) as T;
  if (Array.isArray(value)) return value.map(stripEmojisDeep) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = stripEmojisDeep(val);
    return out as T;
  }
  return value;
}

// Parse, validate, and de-emoji the model's review text (tolerates ```json fences).
export function parseReviewText(text: string): Review {
  const body = stripCodeFence(text);
  const json = JSON.parse(body) as unknown;
  const review = ReviewSchema.parse(json);
  return stripEmojisDeep(review);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (fence?.[1] ?? trimmed).trim();
}
