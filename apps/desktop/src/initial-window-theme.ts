import {
  appearanceCookieName,
  parseAppearance,
  resolveAppearance,
  themeBackgroundColors,
  type Appearance,
  type ResolvedTheme
} from "@orchestrator/contracts";

interface AppearanceCookieReader {
  get(filter: {
    readonly name: string;
    readonly url: string;
  }): Promise<readonly { readonly value: string }[]>;
}

interface NativeThemeTarget {
  readonly shouldUseDarkColors: boolean;
  themeSource: Appearance;
}

interface AppearanceCookieChange {
  readonly domain?: string;
  readonly name: string;
  readonly path?: string;
}

export interface InitialWindowTheme {
  readonly appearance: Appearance;
  readonly backgroundColor: string;
  readonly resolvedTheme: ResolvedTheme;
}

export async function synchronizeNativeWindowTheme(
  cookies: AppearanceCookieReader,
  nativeTheme: NativeThemeTarget,
  serverUrl: string
): Promise<InitialWindowTheme> {
  const storedAppearance = await readStoredAppearance(cookies, serverUrl);
  const appearance = parseAppearance(storedAppearance) ?? "system";
  nativeTheme.themeSource = appearance;
  const resolvedTheme = resolveAppearance(
    appearance,
    nativeTheme.shouldUseDarkColors ? "dark" : "light"
  );
  return {
    appearance,
    resolvedTheme,
    backgroundColor: themeBackgroundColors[resolvedTheme]
  };
}

export function isAppearanceCookieChangeForUrl(
  cookie: AppearanceCookieChange,
  serverUrl: string
): boolean {
  let hostname: string;
  try {
    hostname = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const domain = cookie.domain?.toLowerCase().replace(/^\./u, "");
  return (
    cookie.name === appearanceCookieName &&
    cookie.path === "/" &&
    domain !== undefined &&
    domain === hostname
  );
}

async function readStoredAppearance(
  cookies: AppearanceCookieReader,
  serverUrl: string
): Promise<string | null> {
  try {
    const stored = await cookies.get({ name: appearanceCookieName, url: serverUrl });
    return stored[0]?.value ?? null;
  } catch {
    return null;
  }
}
