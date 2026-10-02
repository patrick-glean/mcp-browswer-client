// Lines removed and added between two texts, to show what changed between two runs. The common
// start and end are set aside first, so only the part that differs is compared line by line.

// Above this many line pairs the comparison would be too slow to run in the page.
export const MAX_COMPARED_PAIRS = 4_000_000;

// [{ kind: 'same' | 'removed' | 'added', text }], or null when the texts differ too much to compare.
export function lineDiff(before, after) {
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
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    if (midA.length * midB.length > MAX_COMPARED_PAIRS) return null;

    // Lengths of the longest common subsequence of every pair of suffixes.
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const common = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            common[i * width + j] = midA[i] === midB[j]
                ? common[(i + 1) * width + j + 1] + 1
                : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
        }
    }

    const lines = a.slice(0, start).map(text => ({ kind: 'same', text }));
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (midA[i] === midB[j]) {
            lines.push({ kind: 'same', text: midA[i] });
            i++;
            j++;
        } else if (common[(i + 1) * width + j] >= common[i * width + j + 1]) {
            lines.push({ kind: 'removed', text: midA[i++] });
        } else {
            lines.push({ kind: 'added', text: midB[j++] });
        }
    }
    while (i < n) lines.push({ kind: 'removed', text: midA[i++] });
    while (j < m) lines.push({ kind: 'added', text: midB[j++] });
    lines.push(...a.slice(endA).map(text => ({ kind: 'same', text })));
    return lines;
}

// The changed lines with `context` unchanged lines around them; runs of unchanged lines left out
// become { kind: 'gap', count }.
export function hunks(lines, context = 3) {
    const keep = new Array(lines.length).fill(false);
    lines.forEach((line, index) => {
        if (line.kind === 'same') return;
        for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
    });
    const shown = [];
    let skipped = 0;
    lines.forEach((line, index) => {
        if (!keep[index]) {
            skipped++;
            return;
        }
        if (skipped) shown.push({ kind: 'gap', count: skipped });
        skipped = 0;
        shown.push(line);
    });
    if (skipped) shown.push({ kind: 'gap', count: skipped });
    return shown;
}
