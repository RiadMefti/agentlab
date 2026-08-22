export function isTrustedAppUrl(candidate: string, appUrl: string): boolean {
  try {
    return new URL(candidate).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
