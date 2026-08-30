/** Matches normalized repository paths against the factory's deliberately small glob language. */
export function repositoryPathMatches(path: string, pattern: string): boolean {
  const pathSegments = path.split("/");
  const patternSegments = pattern.split("/");
  const memo = new Map<string, boolean>();

  const visit = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${String(pathIndex)}:${String(patternIndex)}`;
    const known = memo.get(key);
    if (known !== undefined) return known;

    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === "**") {
      result =
        visit(pathIndex, patternIndex + 1) ||
        (pathIndex < pathSegments.length && visit(pathIndex + 1, patternIndex));
    } else {
      result =
        pathIndex < pathSegments.length &&
        matchSegment(pathSegments[pathIndex] ?? "", patternSegments[patternIndex] ?? "") &&
        visit(pathIndex + 1, patternIndex + 1);
    }
    memo.set(key, result);
    return result;
  };

  return visit(0, 0);
}

const maximumOverlapStates = 100_000;

/**
 * Conservatively decides whether two normalized path globs can select a common concrete path.
 * Complexity exhaustion returns true so an adversarial scope can only raise, never lower, risk.
 */
export function repositoryPatternsMayOverlap(left: string, right: string): boolean {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const pending: OverlapState[] = [{ left: 0, right: 0, consumed: false }];
  const seen = new Set<string>();
  let cursor = 0;

  while (cursor < pending.length) {
    if (seen.size >= maximumOverlapStates) return true;
    const state = pending[cursor];
    cursor += 1;
    if (state === undefined) return true;
    const key = overlapStateKey(state);
    if (seen.has(key)) continue;
    seen.add(key);

    if (
      state.left === leftSegments.length &&
      state.right === rightSegments.length &&
      state.consumed
    ) {
      return true;
    }

    const leftSegment = leftSegments[state.left];
    const rightSegment = rightSegments[state.right];
    if (leftSegment === "**") {
      pending.push({ ...state, left: state.left + 1 });
    }
    if (rightSegment === "**") {
      pending.push({ ...state, right: state.right + 1 });
    }
    if (leftSegment === undefined || rightSegment === undefined) continue;

    if (leftSegment === "**" && rightSegment === "**") {
      pending.push({ ...state, consumed: true });
    } else if (leftSegment === "**") {
      pending.push({ left: state.left, right: state.right + 1, consumed: true });
    } else if (rightSegment === "**") {
      pending.push({ left: state.left + 1, right: state.right, consumed: true });
    } else if (segmentPatternsMayOverlap(leftSegment, rightSegment)) {
      pending.push({ left: state.left + 1, right: state.right + 1, consumed: true });
    }
  }
  return false;
}

export function repositoryPathIsInScope(
  path: string,
  includePatterns: readonly string[],
  excludePatterns: readonly string[]
): boolean {
  return (
    includePatterns.some((pattern) => repositoryPathMatches(path, pattern)) &&
    !excludePatterns.some((pattern) => repositoryPathMatches(path, pattern))
  );
}

function matchSegment(value: string, pattern: string): boolean {
  const valueTokens = Array.from(value);
  const patternTokens = Array.from(pattern);
  let previous = new Array<boolean>(valueTokens.length + 1).fill(false);
  previous[0] = true;
  for (const token of patternTokens) {
    const current = new Array<boolean>(valueTokens.length + 1).fill(false);
    if (token === "*") {
      current[0] = previous[0] ?? false;
      for (let index = 1; index <= valueTokens.length; index += 1) {
        current[index] = (previous[index] ?? false) || (current[index - 1] ?? false);
      }
    } else {
      for (let index = 1; index <= valueTokens.length; index += 1) {
        current[index] = (previous[index - 1] ?? false) && valueTokens[index - 1] === token;
      }
    }
    previous = current;
  }
  return previous[valueTokens.length] ?? false;
}

interface OverlapState {
  readonly left: number;
  readonly right: number;
  readonly consumed: boolean;
}

function segmentPatternsMayOverlap(left: string, right: string): boolean {
  const leftTokens = Array.from(left);
  const rightTokens = Array.from(right);
  const pending: OverlapState[] = [{ left: 0, right: 0, consumed: false }];
  const seen = new Set<string>();
  let cursor = 0;

  while (cursor < pending.length) {
    if (seen.size >= maximumOverlapStates) return true;
    const state = pending[cursor];
    cursor += 1;
    if (state === undefined) return true;
    const key = overlapStateKey(state);
    if (seen.has(key)) continue;
    seen.add(key);

    if (state.left === leftTokens.length && state.right === rightTokens.length && state.consumed) {
      return true;
    }

    const leftToken = leftTokens[state.left];
    const rightToken = rightTokens[state.right];
    if (leftToken === "*") pending.push({ ...state, left: state.left + 1 });
    if (rightToken === "*") pending.push({ ...state, right: state.right + 1 });
    if (leftToken === undefined || rightToken === undefined) continue;

    if (leftToken === "*" && rightToken === "*") {
      pending.push({ ...state, consumed: true });
    } else if (leftToken === "*") {
      pending.push({ left: state.left, right: state.right + 1, consumed: true });
    } else if (rightToken === "*") {
      pending.push({ left: state.left + 1, right: state.right, consumed: true });
    } else if (leftToken === rightToken) {
      pending.push({ left: state.left + 1, right: state.right + 1, consumed: true });
    }
  }
  return false;
}

function overlapStateKey(state: OverlapState): string {
  return `${String(state.left)}:${String(state.right)}:${state.consumed ? "1" : "0"}`;
}
