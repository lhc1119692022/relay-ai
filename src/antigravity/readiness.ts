import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAIN_LOG_NAME = join('logs', 'main.log');
const LANGUAGE_SERVER_LOG_NAME = join('logs', 'language_server.log');
// A cold Windows login can take longer than Electron's 30-second page-load
// deadline while the language server refreshes Google auth. Keep the Relay
// session alive long enough for that startup work to finish.
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_PROBE_TIMEOUT_MS = 750;
const DEFAULT_PROCESS_MISSING_GRACE_MS = 5_000;
// Do not declare success on the first successful socket response. Electron's
// initial navigation can still be in flight at that point, and the renderer
// may log ERR_TIMED_OUT a moment later when Windows is recovering its network
// stack after login. A short quiet period lets us catch that failure and make
// the caller reload the window instead of leaving a black screen behind.
const READY_STABILITY_MS = 2_000;

export type AntigravityReadinessReason =
  | 'ready'
  | 'listening'
  | 'timeout'
  | 'load-timeout'
  | 'process-exited';

export interface AntigravityReadinessResult {
  ready: boolean;
  reason: AntigravityReadinessReason;
  url?: string;
  /** The loopback TCP listener accepted a connection at least once. */
  portListening?: boolean;
  /** The local HTTPS/HTTP page returned a response below HTTP 500. */
  httpReady?: boolean;
  /** Electron logged a renderer load failure during this launch. */
  sawLoadFailure?: boolean;
}

export interface AntigravityReadinessOptions {
  /** Character offset captured immediately before spawning the app. */
  logOffset?: number;
  /** Character offset captured immediately before spawning the language server. */
  languageServerLogOffset?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  /** Consecutive milliseconds of successful HTTP probes before declaring ready. */
  readyStabilityMs?: number;
  processCheckIntervalMs?: number;
  /** Consecutive milliseconds without a process before reporting process-exited. */
  processMissingGraceMs?: number;
  readLog?: (profileDir: string, offset: number) => string;
  readLanguageServerLog?: (profileDir: string, offset: number) => string;
  probe?: (url: string, timeoutMs: number) => Promise<boolean>;
  probePort?: (url: string, timeoutMs: number) => Promise<boolean>;
  isProcessRunning?: () => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mainLogPath(profileDir: string): string {
  return join(profileDir, MAIN_LOG_NAME);
}

function languageServerLogPath(profileDir: string): string {
  return join(profileDir, LANGUAGE_SERVER_LOG_NAME);
}

/** Return the current character offset in Antigravity's Electron log. */
export function getAntigravityMainLogOffset(profileDir: string): number {
  try {
    return readFileSync(mainLogPath(profileDir), 'utf8').length;
  } catch {
    return 0;
  }
}

/**
 * Remove log records from a previous managed launch before spawning Electron.
 *
 * `language_server.log` is reused by Antigravity and can still contain the
 * previous HTTPS port during the first few polling cycles.  The main log can
 * also be rotated while a restart is in flight.  Both files belong to the
 * Relay-owned profile, so truncating them at the launch boundary gives the
 * readiness loop an unambiguous, per-launch source of truth while retaining
 * the separate Relay trace log for request diagnostics.
 */
export function resetAntigravityLaunchLogs(profileDir: string): void {
  for (const path of [mainLogPath(profileDir), languageServerLogPath(profileDir)]) {
    try {
      writeFileSync(path, '', 'utf8');
    } catch {
      // The app may still be releasing a log handle. Readiness remains
      // defensive and will fall back to the current file contents.
    }
  }
}

function readMainLogSince(profileDir: string, offset: number): string {
  try {
    const raw = readFileSync(mainLogPath(profileDir), 'utf8');
    // Antigravity may rotate/truncate the log while restarting. In that case,
    // reading from the beginning is safer than silently skipping the new URL.
    return raw.length >= offset ? raw.slice(offset) : raw;
  } catch {
    return '';
  }
}

function readLanguageServerLogSince(profileDir: string, offset: number): string {
  try {
    const raw = readFileSync(languageServerLogPath(profileDir), 'utf8');
    // The language server replaces this file on every process start. A byte
    // offset cannot reliably distinguish a replacement whose new file happens
    // to be longer than the previous one, so read the small log in full. The
    // Electron main log offset still prevents stale launch records from being
    // treated as the current attempt.
    void offset;
    return raw;
  } catch {
    return '';
  }
}

/** Return the current character offset in the language-server log. */
export function getAntigravityLanguageServerLogOffset(profileDir: string): number {
  try {
    return readFileSync(languageServerLogPath(profileDir), 'utf8').length;
  } catch {
    return 0;
  }
}

/**
 * Extract the newest local UI URL from an Electron main.log fragment.
 * Only loopback URLs are accepted because this value is later probed with
 * certificate verification disabled.
 */
export function extractAntigravityLocalUrl(logText: string): string | null {
  const matches = [...logText.matchAll(/Local:\s+(https?:\/\/[^\s]+)/gi)];
  for (let index = matches.length - 1; index >= 0; index--) {
    const candidate = matches[index]?.[1];
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') continue;
      return parsed.toString();
    } catch {
      // Ignore a partially written log line and keep looking for an older,
      // complete local URL in the same fragment.
    }
  }
  return null;
}

/**
 * The Electron log can announce the URL before the Go server has completed
 * binding. The language-server log is the authoritative second source for
 * the HTTPS port, so use it when the Electron line is delayed or truncated.
 */
export function extractAntigravityLanguageServerUrl(logText: string): string | null {
  // The log is normally replaced for each language-server process, but some
  // Antigravity versions append to it during a restart.  Restrict extraction
  // to the newest process-start block when that marker is available.
  const startMarkers = [...logText.matchAll(/Starting language server process\b/gi)];
  const currentLog = startMarkers.length > 0
    ? logText.slice(startMarkers[startMarkers.length - 1]!.index ?? 0)
    : logText;
  const matches = [
    ...currentLog.matchAll(/listening on (?:random )?port at\s+(\d+)\s+for HTTPS\b/gi),
    ...currentLog.matchAll(/HTTPS(?:\s*\(gRPC\))?\s*(?:server\s*)?port\s*(?:is|at|:)\s*(\d+)/gi),
  ].sort((left, right) => (right.index ?? 0) - (left.index ?? 0));
  const port = matches
    .map(match => Number.parseInt(match[1] ?? '', 10))
    .find(value => Number.isInteger(value) && value > 0 && value < 65536);
  return port ? `https://127.0.0.1:${port}/` : null;
}

/** Detect the exact Electron failure that leaves a black Antigravity window. */
export function antigravityLogHasLoadTimeout(logText: string): boolean {
  return /ERR_(?:TIMED_OUT|NETWORK_CHANGED|CONNECTION_RESET|CONNECTION_REFUSED)/i.test(logText);
}

/**
 * Probe the local language-server page without using the process' proxy stack.
 * A response below HTTP 500 means the listener is reachable; the renderer can
 * then load the page instead of racing the server's initialization.
 */
export function probeAntigravityLocalUrl(
  url: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ready);
    };

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      finish(false);
      return;
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
      finish(false);
      return;
    }

    const requestOptions = {
      method: 'GET',
      headers: { Connection: 'close' },
      timeout: timeoutMs,
      ...(parsed.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    };
    const request = (parsed.protocol === 'https:' ? https : http).request(
      parsed,
      requestOptions,
      response => {
        const status = response.statusCode ?? 0;
        response.resume();
        finish(status > 0 && status < 500);
      },
    );
    request.once('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.once('error', () => finish(false));
    request.end();
  });
}

/** Check that the language server's loopback TCP listener is accepting connections. */
export function probeAntigravityLocalPort(
  url: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise(resolve => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(false); return; }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
      resolve(false);
      return;
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
      resolve(false);
      return;
    }
    // Complete a TLS handshake for HTTPS instead of opening a raw socket and
    // immediately closing it. The latter makes the Go server log a TLS EOF on
    // every readiness poll and can look like a real startup failure.
    const tlsOptions: tls.ConnectionOptions = {
      host: hostname,
      port,
      rejectUnauthorized: false,
    };
    // Node emits DEP0123 when `servername` is an IP literal.  Loopback HTTPS
    // uses a self-signed certificate and does not need SNI for an IP address;
    // retain SNI only for a hostname such as `localhost`.
    if (net.isIP(hostname) === 0) tlsOptions.servername = hostname;
    const socket = parsed.protocol === 'https:'
      ? tls.connect(tlsOptions)
      : net.createConnection({ host: hostname, port });
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.once('connect', () => {
      if (parsed.protocol !== 'https:') {
        finish(true);
      }
    });
    if (parsed.protocol === 'https:') {
      socket.once('secureConnect', () => {
        finish(true);
      });
    }
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

/** Wait until the newly spawned Antigravity language server accepts requests. */
export async function waitForAntigravityReady(
  profileDir: string,
  options: AntigravityReadinessOptions = {},
): Promise<AntigravityReadinessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const readyStabilityMs = options.readyStabilityMs ?? READY_STABILITY_MS;
  const processCheckIntervalMs = options.processCheckIntervalMs ?? 2_000;
  const processMissingGraceMs = options.processMissingGraceMs ?? DEFAULT_PROCESS_MISSING_GRACE_MS;
  const offset = options.logOffset ?? 0;
  const languageServerLogOffset = options.languageServerLogOffset ?? 0;
  const readLog = options.readLog ?? readMainLogSince;
  const readLanguageServerLog = options.readLanguageServerLog ?? readLanguageServerLogSince;
  const probe = options.probe ?? probeAntigravityLocalUrl;
  const probePort = options.probePort ?? (options.probe ? undefined : probeAntigravityLocalPort);
  const deadline = Date.now() + timeoutMs;
  let latestUrl: string | undefined;
  // Only the Electron main log is tied to this launch via logOffset. The
  // language-server log is reused/replaced asynchronously and may still
  // contain the previous session's port during the first polling cycles.
  let sawCurrentLaunchLog = false;
  let launchLogSeenAt = 0;
  let sawPortListening = false;
  let sawHttpReady = false;
  let sawLoadFailure = false;
  let httpReadySince = 0;
  let httpReadyUrl = '';
  let lastProcessCheckAt = 0;
  let processMissingSince = 0;

  while (Date.now() < deadline) {
    const logText = readLog(profileDir, offset);
    const languageServerLogText = readLanguageServerLog(profileDir, languageServerLogOffset);
    sawLoadFailure ||= antigravityLogHasLoadTimeout(logText);

    const mainUrl = extractAntigravityLocalUrl(logText);
    const url = mainUrl ?? extractAntigravityLanguageServerUrl(languageServerLogText);
    if (url) {
      latestUrl = url;
      if (mainUrl && !sawCurrentLaunchLog) {
        sawCurrentLaunchLog = true;
        launchLogSeenAt = Date.now();
      }
      const httpReady = await probe(url, probeTimeoutMs);
      const portListening = !httpReady && probePort
        ? await probePort(url, probeTimeoutMs)
        : false;
      sawHttpReady ||= httpReady;
      sawPortListening ||= portListening;
      if (httpReady) {
        if (httpReadyUrl !== url) {
          httpReadyUrl = url;
          httpReadySince = Date.now();
        }
        httpReadySince ||= Date.now();
        // If Electron already reported a failed navigation, the local server
        // being reachable is not enough: the existing window is usually
        // black and will not recover by itself. Return a failure so the
        // orchestrator can restart the managed app and load the URL afresh.
        if (sawLoadFailure) {
          return {
            ready: false,
            reason: 'load-timeout',
            url,
            portListening: true,
            httpReady: true,
            sawLoadFailure: true,
          };
        }
        if (Date.now() - httpReadySince >= readyStabilityMs) {
          return { ready: true, reason: 'ready', url };
        }
      } else {
        // Require a consecutive healthy interval; a single successful probe
        // followed by a reset must not make a still-starting server look ready.
        httpReadySince = 0;
        httpReadyUrl = '';
      }
    }

    // If the app logged a launch and then disappeared, reopening it blindly
    // would be surprising. The caller can decide whether a retry is safe.
    if (
      sawCurrentLaunchLog
      && Date.now() - launchLogSeenAt >= 1_500
      && options.isProcessRunning
      && Date.now() - lastProcessCheckAt >= processCheckIntervalMs
    ) {
      lastProcessCheckAt = Date.now();
      if (!options.isProcessRunning()) {
        processMissingSince ||= Date.now();
        if (Date.now() - processMissingSince >= processMissingGraceMs) {
          return {
            ready: false,
            reason: 'process-exited',
            url: latestUrl,
            portListening: sawPortListening,
            httpReady: sawHttpReady,
            sawLoadFailure,
          };
        }
      } else {
        processMissingSince = 0;
      }
    }

    await sleep(pollIntervalMs);
  }

  const finalLog = readLog(profileDir, offset);
  const finalLanguageServerLog = readLanguageServerLog(profileDir, languageServerLogOffset);
  const finalUrl = latestUrl
    ?? extractAntigravityLocalUrl(finalLog)
    ?? extractAntigravityLanguageServerUrl(finalLanguageServerLog)
    ?? undefined;
  // A URL without a successful probe is still useful evidence: the app has
  // handed off to its local server and may finish after a delayed auth/network
  // retry. Let the caller keep the gateway alive instead of killing the app.
  const reason: AntigravityReadinessReason = sawPortListening
    ? 'listening'
    : sawLoadFailure
      ? 'load-timeout'
      : 'timeout';
  return {
    ready: false,
    reason,
    url: finalUrl,
    portListening: sawPortListening,
    httpReady: sawHttpReady,
    sawLoadFailure,
  };
}
