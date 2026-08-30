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
