import type { FileDiff } from '../util/diff.js';
import type { Finding, Review } from './schema.js';

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT';
  body: string;
}

export interface FormattedReview {
  event: 'REQUEST_CHANGES' | 'COMMENT';
  body: string;
  comments: ReviewComment[];
  /** Findings that could not be anchored to a diff line — rendered in the review body. */
  dropped: Finding[];
}

export function formatReview(review: Review, files: FileDiff[], maxComments: number): FormattedReview {
  const anchored = anchoredLines(files);
  const comments: ReviewComment[] = [];
  const dropped: Finding[] = [];
  const seen = new Set<string>();

  for (const finding of review.findings) {
    const comment = toComment(finding, anchored);
    const key = comment ? `${comment.path}:${comment.line}:${comment.body}` : '';
    if (comment && !seen.has(key) && comments.length < maxComments) {
      seen.add(key);
      comments.push(comment);
    } else {
      dropped.push(finding);
    }
  }

  return {
    event: review.overall === 'changes_requested' ? 'REQUEST_CHANGES' : 'COMMENT',
    body: buildReviewBody(review, dropped),
    comments,
    dropped,
  };
}

/** New-file line numbers present in the diff hunks, per file path. */
function anchoredLines(files: FileDiff[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const file of files) {
    if (!file.path) continue;
    const lines = new Set<number>();
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newLine !== undefined) lines.add(line.newLine);
      }
    }
    map.set(file.path, lines);
  }
  return map;
}

/** A finding becomes an inline comment only when its line exists in the diff hunks. */
function toComment(finding: Finding, anchored: Map<string, Set<number>>): ReviewComment | null {
  if (!finding.line) return null;
  const lines = anchored.get(finding.file);
  if (!lines?.has(finding.line)) return null;
  return { path: finding.file, line: finding.line, side: 'RIGHT', body: commentBody(finding) };
}

function commentBody(finding: Finding): string {
  const lines = [`**${finding.title}**`, finding.body];
  if (finding.category) lines.push(`**Category:** \`${finding.category}\``);
  if (finding.suggestion) lines.push(`**Suggestion:** ${finding.suggestion}`);
  for (const e of finding.evidence) {
    const loc = `${e.repo}/${e.file}${e.line ? `:${e.line}` : ''}`;
    lines.push(`> Evidence: \`${loc}\`${e.quote ? ` — "${e.quote}"` : ''}`);
  }
  return lines.join('\n\n');
}

// Review body: summary, strengths, and findings that could not be anchored inline.
export function buildReviewBody(review: Review, dropped: Finding[]): string {
  const parts = [review.summary];
  if (review.strengths.length > 0) {
    parts.push('## What’s good', ...review.strengths.map((s) => `- ${s}`));
  }
  if (dropped.length > 0) {
    parts.push('## Findings');
    for (const f of dropped) {
      const cat = f.category ? ` \`${f.category}\`` : '';
      parts.push(`- **[${f.severity}]${cat} ${f.title}** — ${f.body}${f.suggestion ? `\n  - Suggestion: ${f.suggestion}` : ''}`);
    }
  }
  parts.push('---', '_Reviewed by Peer (cross-repo context)._');
  return parts.join('\n\n');
}

/** Local report written to the workspace when not posting. */
export function buildReviewMarkdown(review: Review, files: FileDiff[], maxComments: number): string {
  const formatted = formatReview(review, files, maxComments);
  const parts = [`# Code Review (${formatted.event})`, review.summary, ''];
  if (review.strengths.length > 0) {
    parts.push('## What’s good', ...review.strengths.map((s) => `- ${s}`), '');
  }
  for (const f of review.findings) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    parts.push(`## [${f.severity}] ${f.title} — ${loc}`, f.body);
    if (f.category) parts.push(`- Category: \`${f.category}\``);
    if (f.suggestion) parts.push(`- Suggestion: ${f.suggestion}`);
    for (const e of f.evidence) {
      parts.push(`- Evidence: ${e.repo}/${e.file}${e.line ? `:${e.line}` : ''}${e.quote ? ` — "${e.quote}"` : ''}`);
    }
    parts.push('');
  }
  parts.push('---', '_Reviewed by Peer (cross-repo context)._');
  return parts.join('\n');
}
