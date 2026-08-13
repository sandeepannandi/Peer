export type DiffLineKind = 'context' | 'added' | 'removed';

export interface HunkLine {
  kind: DiffLineKind;
  /** Line content without the diff marker. */
  text: string;
  /** Old-file line number (context/removed lines). */
  oldLine?: number;
  /** New-file line number (context/added lines). */
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export interface FileDiff {
  oldPath: string | null;
  path: string | null;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Hunk-state-gated parser: diff headers only count between hunks.
export function parseUnifiedDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const addLine = (kind: DiffLineKind, text: string) => {
    if (!hunk) return;
    const line: HunkLine = { kind, text };
    if (kind === 'removed') {
      line.oldLine = oldLine;
      oldLine += 1;
    } else if (kind === 'added') {
      line.newLine = newLine;
      newLine += 1;
    } else {
      line.oldLine = oldLine;
      line.newLine = newLine;
      oldLine += 1;
      newLine += 1;
    }
    hunk.lines.push(line);
  };

  const startHunk = (m: RegExpExecArray) => {
    hunk = {
      oldStart: Number(m[1]),
      oldLines: Number(m[2] ?? 1),
      newStart: Number(m[3]),
      newLines: Number(m[4] ?? 1),
      lines: [],
    };
    oldLine = hunk.oldStart;
    newLine = hunk.newStart;
    file!.hunks.push(hunk);
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      file = { oldPath: null, path: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    if (hunk) {
      // A hunk header starts the next hunk (body lines never begin with '@').
      const next = HUNK_HEADER.exec(rawLine);
      if (next) {
        startHunk(next);
        continue;
      }
      if (rawLine.startsWith('-')) addLine('removed', rawLine.slice(1));
      else if (rawLine.startsWith('+')) addLine('added', rawLine.slice(1));
      else if (rawLine.startsWith(' ')) addLine('context', rawLine.slice(1));
      // "\ No newline at end of file" and unexpected lines are skipped.
      continue;
    }

    if (rawLine.startsWith('--- ')) {
      const path = stripPrefix(rawLine.slice(4));
      file.oldPath = path === '/dev/null' ? null : path;
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      const path = stripPrefix(rawLine.slice(4));
      file.path = path === '/dev/null' ? null : path;
      continue;
    }
    const m = HUNK_HEADER.exec(rawLine);
    if (m) startHunk(m);
    // index / similarity / rename / blank lines are ignored.
  }

  return files;
}

function stripPrefix(p: string): string {
  return p.replace(/\t.*$/, '').replace(/^[ab]\//, '');
}

function marker(kind: DiffLineKind): string {
  return kind === 'added' ? '+' : kind === 'removed' ? '-' : ' ';
}

// Annotate new-file line numbers (removed lines get a blank column).
export function buildNumberedDiff(files: FileDiff[]): string {
  const out: string[] = [];
  for (const file of files) {
    out.push(`--- a/${file.oldPath ?? ''}`);
    out.push(`+++ b/${file.path ?? ''}`);
    for (const hunk of file.hunks) {
      out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const line of hunk.lines) {
        const num = line.newLine !== undefined ? String(line.newLine) : '';
        out.push(`${num.padStart(6)}| ${marker(line.kind)}${line.text}`);
      }
    }
  }
  return out.join('\n');
}
