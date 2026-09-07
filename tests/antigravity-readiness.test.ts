import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  antigravityLogHasLoadTimeout,
  extractAntigravityLocalUrl,
  extractAntigravityLanguageServerUrl,
  probeAntigravityLocalUrl,
  resetAntigravityLaunchLogs,
  waitForAntigravityReady,
} from '../src/antigravity/readiness.js';

describe('Antigravity startup readiness', () => {
  it('extracts the newest loopback URL from the Electron log', () => {
    const log = [
      '[info] Local: https://127.0.0.1:10001/',
      '[info] Local: https://127.0.0.1:10002/',
    ].join('\n');
    expect(extractAntigravityLocalUrl(log)).toBe('https://127.0.0.1:10002/');
  });

  it('ignores non-loopback URLs before probing', async () => {
    expect(extractAntigravityLocalUrl('[info] Local: https://example.com:1234/')).toBeNull();
    await expect(probeAntigravityLocalUrl('https://example.com:1234/', 1)).resolves.toBe(false);
  });

  it('recognizes the black-window timeout marker', () => {
    expect(antigravityLogHasLoadTimeout('electron: Failed to load URL: ERR_TIMED_OUT')).toBe(true);
    expect(antigravityLogHasLoadTimeout('initialized server successfully')).toBe(false);
  });

  it('extracts the HTTPS port from the language-server log', () => {
    expect(extractAntigravityLanguageServerUrl(
      'server.go:599] Language server listening on random port at 5181 for HTTPS (gRPC)',
    )).toBe('https://127.0.0.1:5181/');
  });

  it('only extracts a port from the newest language-server process block', () => {
    const log = [
      'Starting language server process with pid 100',
      'Language server listening on random port at 41001 for HTTPS (gRPC)',
      'Starting language server process with pid 200',
      'Language server is still initializing',
    ].join('\n');

    expect(extractAntigravityLanguageServerUrl(log)).toBeNull();
  });

  it('clears both Relay-owned launch logs before a new attempt', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'relay-ai-antigravity-readiness-'));
    const logsDir = join(profileDir, 'logs');
    mkdirSync(logsDir);
    const mainLog = join(logsDir, 'main.log');
    const languageServerLog = join(logsDir, 'language_server.log');
    writeFileSync(mainLog, 'old Electron URL', 'utf8');
    writeFileSync(languageServerLog, 'old language-server port', 'utf8');

    try {
      resetAntigravityLaunchLogs(profileDir);
      expect(readFileSync(mainLog, 'utf8')).toBe('');
      expect(readFileSync(languageServerLog, 'utf8')).toBe('');
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it('waits for the local listener instead of trusting the early port log', async () => {
    let reads = 0;
    const probe = vi.fn(async () => reads >= 2);
    const result = await waitForAntigravityReady('/profile', {
      timeoutMs: 100,
      pollIntervalMs: 1,
      readLog: () => {
        reads += 1;
        return '[info] Local: https://127.0.0.1:12345/';
      },
      probe,
      readyStabilityMs: 0,
      isProcessRunning: () => true,
    });

    expect(result).toEqual({
      ready: true,
      reason: 'ready',
      url: 'https://127.0.0.1:12345/',
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('treats an Electron load failure as failed even after the local server responds', async () => {
    const result = await waitForAntigravityReady('/profile', {
      timeoutMs: 100,
      pollIntervalMs: 1,
      readyStabilityMs: 0,
      readLog: () => [
        '[info] Local: https://127.0.0.1:12345/',
        'electron: Failed to load URL: ERR_TIMED_OUT',
      ].join('\n'),
      probe: async () => true,
      isProcessRunning: () => true,
    });

    expect(result).toMatchObject({
      ready: false,
      reason: 'load-timeout',
      httpReady: true,
      sawLoadFailure: true,
    });
  });

  it('returns a bounded timeout when the listener never responds', async () => {
    const result = await waitForAntigravityReady('/profile', {
      timeoutMs: 5,
      pollIntervalMs: 1,
      readLog: () => '[info] Local: https://127.0.0.1:12345/',
      probe: async () => false,
      isProcessRunning: () => true,
    });

    expect(result.ready).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(result.url).toBe('https://127.0.0.1:12345/');
  });

  it('does not treat one transient Windows process-list miss as an exit', async () => {
    let processChecks = 0;
    const result = await waitForAntigravityReady('/profile', {
      timeoutMs: 3_000,
      pollIntervalMs: 1,
      processCheckIntervalMs: 1,
      processMissingGraceMs: 100,
      readLog: () => '[info] Local: https://127.0.0.1:12345/',
      probe: async () => false,
      isProcessRunning: () => {
        processChecks += 1;
        return processChecks > 1;
      },
    });

    expect(result.reason).toBe('timeout');
    expect(processChecks).toBeGreaterThan(1);
  });

  it('does not check process liveness from a stale language-server URL', async () => {
    let processChecks = 0;
    const result = await waitForAntigravityReady('/profile', {
      timeoutMs: 8,
      pollIntervalMs: 1,
      processCheckIntervalMs: 1,
      readLog: () => '',
      readLanguageServerLog: () => 'Language server listening on random port at 12345 for HTTPS (gRPC)',
      probe: async () => false,
      isProcessRunning: () => {
        processChecks += 1;
        return false;
      },
    });

    expect(result.reason).toBe('timeout');
    expect(processChecks).toBe(0);
  });
});
