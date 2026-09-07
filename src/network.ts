import { execFileSync } from 'node:child_process';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

let configured = false;

export interface WindowsProxySettings {
  enabled: boolean;
  proxy?: string;
  bypass?: string;
}

type RegQuery = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; stdio: ['ignore', 'pipe', 'pipe'] },
) => string;

const defaultRegQuery: RegQuery = (file, args, options) => execFileSync(file, args, options);

/**
 * Read the current user's WinINet proxy without changing Windows settings.
 * Explorer-launched shortcuts do not reliably expose WinINet values as
 * HTTP_PROXY environment variables, while Antigravity's Go server consumes
 * those variables on Windows.
 */
export function readWindowsProxySettings(regQuery: RegQuery = defaultRegQuery): WindowsProxySettings | null {
  if (process.platform !== 'win32') return null;
  try {
    const raw = regQuery(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const enabledMatch = raw.match(/^\s*ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/im);
    const serverMatch = raw.match(/^\s*ProxyServer\s+REG_SZ\s+(.+)$/im);
    const bypassMatch = raw.match(/^\s*ProxyOverride\s+REG_SZ\s+(.+)$/im);
    const enabled = enabledMatch ? Number.parseInt(enabledMatch[1]!, 16) !== 0 : false;
    return {
      enabled,
      proxy: enabled && serverMatch ? normalizeProxyUrl(serverMatch[1]!.trim()) : undefined,
      bypass: bypassMatch?.[1]?.trim() || undefined,
    };
  } catch {
    return null;
  }
}

/** Convert a WinINet proxy value (including per-scheme mappings) to a URL. */
export function normalizeProxyUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const mappings = new Map<string, string>();
  for (const item of trimmed.split(';')) {
    const separator = item.indexOf('=');
    if (separator > 0) {
      mappings.set(item.slice(0, separator).trim().toLowerCase(), item.slice(separator + 1).trim());
    }
  }
  const selected = mappings.get('https') ?? mappings.get('http') ?? mappings.get('proxy') ?? trimmed;
  if (!selected) return undefined;
  return /^[a-z][a-z\d+.-]*:\/\//i.test(selected) ? selected : `http://${selected}`;
}

/** Turn WinINet's semicolon-separated bypass list into a NO_PROXY value. */
export function normalizeWindowsProxyBypass(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(';')
    .map(entry => entry.trim())
    .filter(Boolean)
    .join(',');
}

/** Resolve an explicit environment proxy, then fall back to WinINet settings. */
export function resolveConfiguredProxy(): string | undefined {
  const inherited = [
    process.env['HTTPS_PROXY'],
    process.env['https_proxy'],
    process.env['HTTP_PROXY'],
    process.env['http_proxy'],
    process.env['ALL_PROXY'],
    process.env['all_proxy'],
  ].find(value => value?.trim());
  if (inherited?.trim()) return inherited.trim();
  return readWindowsProxySettings()?.proxy;
}

/** Add the resolved proxy and WinINet bypass list to a child environment. */
export function applyConfiguredProxyEnv(env: NodeJS.ProcessEnv): void {
  const settings = readWindowsProxySettings();
  const proxy = resolveConfiguredProxy();
  if (proxy) {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const) {
      if (!env[name]?.trim()) env[name] = proxy;
    }
  }
  const bypass = normalizeWindowsProxyBypass(settings?.bypass);
  if (bypass) {
    for (const name of ['NO_PROXY', 'no_proxy'] as const) {
      if (!env[name]?.trim()) env[name] = bypass;
    }
  }
  for (const [upper, lower] of [
    ['HTTP_PROXY', 'http_proxy'],
    ['HTTPS_PROXY', 'https_proxy'],
    ['ALL_PROXY', 'all_proxy'],
    ['NO_PROXY', 'no_proxy'],
  ] as const) {
    if (env[upper]?.trim() && !env[lower]?.trim()) env[lower] = env[upper];
    if (env[lower]?.trim() && !env[upper]?.trim()) env[upper] = env[lower];
  }
}

/** Make Node's fetch (including AI SDK providers) honor the user's proxy settings. */
export function configureNetworkProxy(): void {
  if (configured) return;
  configured = true;
  applyConfiguredProxyEnv(process.env);
  const proxy = resolveConfiguredProxy();
  if (!proxy) return;
  try {
    setGlobalDispatcher(new ProxyAgent(proxy));
  } catch {
    // Leave the default dispatcher in place when the proxy URL is malformed.
  }
}
