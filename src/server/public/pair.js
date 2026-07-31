/**
 * @typedef {import('../../types.js').DiffLine} DiffLine
 * @typedef {{old: DiffLine|null, new: DiffLine|null}} Pair
 */

/**
 * Zips each run of deletions against the additions that immediately follow, so
 * a replacement reads across one row rather than down two.
 * @param {DiffLine[]} lines
 * @returns {Pair[]}
 */
export const pairLines = (lines) => {
  /** @type {Pair[]} */
  const pairs = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.kind === 'context') {
      pairs.push({ old: line, new: line });
      i += 1;
      continue;
    }

    const dels = [];
    while (i < lines.length && lines[i].kind === 'del') { dels.push(lines[i]); i += 1; }

    const adds = [];
    while (i < lines.length && lines[i].kind === 'add') { adds.push(lines[i]); i += 1; }

    for (let j = 0; j < Math.max(dels.length, adds.length); j += 1) {
      pairs.push({ old: dels[j] ?? null, new: adds[j] ?? null });
    }
  }

  return pairs;
};
