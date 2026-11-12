export interface LineDiff {
  text: string;
  added: number;
  removed: number;
  changed: boolean;
}

// The table is rows × columns bytes; larger middles fall back to a set comparison.
const TABLE_LIMIT = 4_000_000;

/** Line diff of two snapshots. Lines keep their indentation so the tree position stays readable. */
export function diffLines(before: string, after: string): LineDiff {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const left = a.slice(start, endA);
  const right = b.slice(start, endB);
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  const remove = (line: string) => {
    lines.push('- ' + line);
    removed++;
  };
  const add = (line: string) => {
    lines.push('+ ' + line);
    added++;
  };
  if (left.length * right.length > TABLE_LIMIT) {
    const kept = new Set(right);
    const known = new Set(left);
    for (const line of left) if (!kept.has(line)) remove(line);
    for (const line of right) if (!known.has(line)) add(line);
  } else {
    const columns = right.length + 1;
    // Longest common subsequence lengths of the suffixes.
    const table = new Uint16Array((left.length + 1) * columns);
    for (let i = left.length - 1; i >= 0; i--)
      for (let j = right.length - 1; j >= 0; j--)
        table[i * columns + j] =
          left[i] === right[j]
            ? table[(i + 1) * columns + j + 1] + 1
            : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) {
        i++;
        j++;
      } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) remove(left[i++]);
      else add(right[j++]);
    }
    while (i < left.length) remove(left[i++]);
    while (j < right.length) add(right[j++]);
  }
  return { text: lines.join('\n'), added, removed, changed: added + removed > 0 };
}
