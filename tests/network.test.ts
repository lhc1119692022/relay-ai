import { describe, expect, it } from 'vitest';
import {
  normalizeProxyUrl,
  normalizeWindowsProxyBypass,
  readWindowsProxySettings,
} from '../src/network.js';

describe('Windows proxy discovery', () => {
  it('normalizes WinINet per-scheme proxy mappings', () => {
    expect(normalizeProxyUrl('https=127.0.0.1:7890;http=127.0.0.1:8080'))
      .toBe('http://127.0.0.1:7890');
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
  });

  it('converts WinINet bypass separators for NO_PROXY', () => {
    expect(normalizeWindowsProxyBypass('<local>;127.*;localhost;')).toBe('<local>,127.*,localhost');
    expect(normalizeWindowsProxyBypass(undefined)).toBeUndefined();
  });

  it.skipIf(process.platform !== 'win32')('reads enabled proxy settings from a registry query result', () => {
    const settings = readWindowsProxySettings(() => [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '    ProxyEnable    REG_DWORD    0x1',
      '    ProxyServer    REG_SZ       https=127.0.0.1:7890;http=127.0.0.1:8080',
      '    ProxyOverride  REG_SZ       <local>;127.*',
    ].join('\r\n'));

    expect(settings).toEqual({
      enabled: true,
      proxy: 'http://127.0.0.1:7890',
      bypass: '<local>;127.*',
    });
  });
});
