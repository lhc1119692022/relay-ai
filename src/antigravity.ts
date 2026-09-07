import pc from 'picocolors';

const SHUTDOWN_DRAIN_MS = 500;
import * as p from '@clack/prompts';
import { loadPreferences, savePreferences } from './config.js';
import { fetchProviderCatalog, providersForPicker } from './provider-catalog.js';
import { providersForTarget } from './target-compatibility.js';
import { detectConflicts, buildAntigravityChildEnv } from './env.js';
import { buildAntigravityRoutes } from './antigravity/catalog.js';
import { startCloudCodeGateway, type CloudCodeGatewayHandle } from './antigravity/cloud-code-gateway.js';
import { evaluateAgySwitchCompatibility } from './antigravity/slot-registry.js';
import { resolveAntigravityLaunchRoutes } from './antigravity/launch-routes.js';
import { launchAntigravityCli, readAntigravityCliVersion } from './antigravity/launch-cli.js';
import catalogFixtureRaw from './antigravity/fixtures/fetchAvailableModels.json' with { type: 'json' };
import {
  forceQuitAntigravityApp,
  forceQuitAntigravityIde,
  isAntigravityAppRunning,
  isAntigravityIdeRunning,
  launchAntigravityApp,
  launchAntigravityIde,
  quitAntigravityAppGracefully,
  quitAntigravityIdeGracefully,
  waitForAntigravityAppQuit,
  waitForAntigravityIdeQuit,
} from './antigravity/launch-ide.js';
import {
  getAntigravityMainLogOffset,
  getAntigravityLanguageServerLogOffset,
  resetAntigravityLaunchLogs,
  waitForAntigravityReady,
} from './antigravity/readiness.js';
import { pickLocalModel } from './prompts.js';
import { getAntigravityDebugLogPath, makeTraceLogger } from './trace-log.js';
import { providerSelectOption, formatModelLabel, relayIntro, relayOutro } from './ui.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FavoriteModel, UserPreferences, LocalProvider, LocalProviderModel } from './types.js';
import type { CatalogFixture } from './antigravity/types.js';

const AGY_FAVORITES_PROVIDER_ID = '__relay_agy_favorites__';
const AGY_FAVORITES_PROVIDER_LABEL = '★ Antigravity CLI Favorites';

/** True when child args already select a model (--model or --model=). */
export function agyArgsIncludeModelFlag(args: string[]): boolean {
  return args.some(arg => arg === '--model' || arg.startsWith('--model='));
}

/** Prepend --model <display label> unless the user already passed --model. */
export function buildAgyLaunchArgs(modelLabel: string, childArgs: string[]): string[] {
  if (agyArgsIncludeModelFlag(childArgs)) return childArgs;
  return ['--model', modelLabel, ...childArgs];
}

export function agyArgsAreNonInteractive(args: string[]): boolean {
  return args.some(arg => arg === '-p' || arg === '--prompt' || arg.startsWith('--prompt='));
}

export function formatAgyCapacityWarning(validatedSlotCount: number, skippedFavoriteCount: number): string {
  const slotWord = validatedSlotCount === 1 ? 'slot' : 'slots';
  const favoritePhrase = skippedFavoriteCount === 1
    ? '1 favorite was not exposed'
    : `${skippedFavoriteCount} favorites were not exposed`;
  return `AGY can switch among ${validatedSlotCount} validated model ${slotWord}; ${favoritePhrase}.`;
}

function isInteractiveTerminal(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

function resolveFavoriteModel(
  favorite: FavoriteModel,
  allProviders: LocalProvider[],
): { provider: LocalProvider; model: LocalProviderModel } | null {
  const provider = allProviders.find(candidate => candidate.id === favorite.providerId);
  const model = provider?.models.find(candidate => candidate.id === favorite.modelId);
  return provider && model ? { provider, model } : null;
}

function normalizeAgyModelSelector(value: string): string {
  return value
    .trim()
    .replace(/\s*\(Relay(?: - .*)?\)\s*$/i, '')
    .toLowerCase();
}

export function resolveAntigravityBootModel(
  provider: LocalProvider,
  modelSelector: string,
): { model: LocalProviderModel | null; error?: string } {
  const selector = normalizeAgyModelSelector(modelSelector);
  const exact = provider.models.filter(model =>
    normalizeAgyModelSelector(model.id) === selector
    || normalizeAgyModelSelector(model.name) === selector
    || normalizeAgyModelSelector(model.upstreamModelId) === selector
  );
  if (exact.length === 1) return { model: exact[0]! };

  const prefix = provider.models.filter(model =>
    normalizeAgyModelSelector(model.id).startsWith(selector)
    || normalizeAgyModelSelector(model.name).startsWith(selector)
    || normalizeAgyModelSelector(model.upstreamModelId).startsWith(selector)
  );
  if (prefix.length === 1) return { model: prefix[0]! };

  const candidates = (exact.length > 1 ? exact : prefix).slice(0, 5);
  const candidateText = candidates.length > 0
    ? ` Did you mean: ${candidates.map(model => `${model.name || model.id} (${model.id})`).join(', ')}?`
    : '';
  return {
    model: null,
    error: exact.length > 1 || prefix.length > 1
      ? `Model selector is ambiguous: ${modelSelector}.${candidateText}`
      : `Model not found: ${modelSelector} on provider ${provider.name}.${candidateText}`,
  };
}

async function pickAntigravityCliFavoriteLaunchModel(
  favorites: FavoriteModel[],
  allProviders: LocalProvider[],
): Promise<{ provider: LocalProvider; model: LocalProviderModel } | null> {
  const resolved = favorites
    .map(favorite => resolveFavoriteModel(favorite, allProviders))
    .filter((entry): entry is { provider: LocalProvider; model: LocalProviderModel } => entry !== null);

  if (resolved.length === 0) {
    p.log.warn('No Antigravity CLI favorites are available.');
    p.log.info(pc.dim('Manage them with `relay-ai favorites --agy`.'));
    return null;
  }

  const picked = await p.select<string>({
    message: 'Launch from Antigravity CLI favorites',
    options: resolved.map(({ provider, model }) => ({
      value: `${provider.id}:${model.id}`,
      label: formatModelLabel(model),
      hint: provider.name,
    })),
    initialValue: `${resolved[0]!.provider.id}:${resolved[0]!.model.id}`,
  });

  if (p.isCancel(picked)) {
    p.cancel('Cancelled.');
    return null;
  }

  const [providerId, ...modelParts] = picked.split(':');
  const modelId = modelParts.join(':');
  return resolved.find(entry => entry.provider.id === providerId && entry.model.id === modelId) ?? null;
}

async function resolveAntigravityLaunch(
  prefs: UserPreferences,
  boot: { launchProvider?: string; launchModel?: string } | undefined,
): Promise<{ provider: LocalProvider; model: LocalProviderModel; allProviders: LocalProvider[] } | null> {
  // Load the provider catalog
  let catalog;
  const catalogSpinner = p.spinner();
  catalogSpinner.start('Loading providers...');
  try {
    catalog = await fetchProviderCatalog();
  } catch (err) {
    catalogSpinner.stop('');
    p.log.error(String(err instanceof Error ? err.message : err));
    return null;
  }
  catalogSpinner.stop('');

  const allProviders = providersForTarget(providersForPicker(catalog), 'antigravity');
  if (allProviders.length === 0) {
    p.log.warn('No providers available.');
    p.log.info(pc.dim('Run relay-ai providers add or import to get started.'));
    return null;
  }

  // Check for explicit --provider + --model
  if (boot?.launchProvider && boot?.launchModel) {
    const provider = allProviders.find(p => p.id === boot.launchProvider);
    if (!provider) {
      p.log.error(`Provider not found: ${boot.launchProvider}`);
      return null;
    }
    const { model, error } = resolveAntigravityBootModel(provider, boot.launchModel);
    if (!model) {
      p.log.error(error ?? `Model not found: ${boot.launchModel} on provider ${provider.name}`);
      return null;
    }
    return { provider, model, allProviders };
  }

  // Interactive provider + model selection
  const providerOptions = [
    {
      value: AGY_FAVORITES_PROVIDER_ID,
      label: pc.cyan(AGY_FAVORITES_PROVIDER_LABEL),
      hint: `${prefs.antigravityCliFavoriteModels?.length ?? 0}/6 saved · manage with relay-ai favorites --agy`,
    },
    ...allProviders.map(lp => providerSelectOption(lp)),
  ];

  const initialProvider =
    prefs.lastAntigravityProvider && providerOptions.some(o => o.value === prefs.lastAntigravityProvider)
      ? prefs.lastAntigravityProvider
      : providerOptions[0]!.value;

  const conflicts = detectConflicts();

  let currentInitialProvider = initialProvider;
  while (true) {
    const chosen = await p.select<string>({
      message: 'Which provider?',
      options: providerOptions,
      initialValue: currentInitialProvider,
    });

    if (p.isCancel(chosen)) {
      p.cancel('Cancelled.');
      return null;
    }

    if (chosen === AGY_FAVORITES_PROVIDER_ID) {
      const favoriteSelection = await pickAntigravityCliFavoriteLaunchModel(
        prefs.antigravityCliFavoriteModels ?? [],
        allProviders,
      );
      if (!favoriteSelection) {
        currentInitialProvider = AGY_FAVORITES_PROVIDER_ID;
        continue;
      }
      return { ...favoriteSelection, allProviders };
    }

    const activeProvider = allProviders.find(lp => lp.id === chosen)!;
    const pickedModelResult = await pickLocalModel(activeProvider, conflicts, prefs);
    if (pickedModelResult === 'back') {
      currentInitialProvider = activeProvider.id;
      continue;
    }
    if (!pickedModelResult) return null;

    return { provider: activeProvider, model: pickedModelResult, allProviders };
  }
}

async function resolveAndBuildRoutes(
  provider: LocalProvider,
  model: LocalProviderModel,
  allProviders: LocalProvider[],
  prefs: UserPreferences,
  opts: {
    maxRoutes: number;
    validatedSlotCount: number;
    pauseForCapacityWarning: boolean;
    childArgs: string[];
  },
): Promise<{ routes: ReturnType<typeof buildAntigravityRoutes>; apiKey: string } | null> {
  const result = await resolveAntigravityLaunchRoutes({
    provider,
    model,
    allProviders,
    favorites: prefs.antigravityCliFavoriteModels ?? [],
    maxRoutes: opts.maxRoutes,
  });
  if (!result) {
    p.log.error(`No credential for ${provider.name}. Run: relay-ai providers auth ${provider.id} or add an API key.`);
    return null;
  }

  if (result.routes.length > 1) {
    p.log.info(
      `Favorites mode active — Antigravity picker will show ${result.routes.length} models.`,
    );
    p.log.info('Edit with `relay-ai favorites --agy`.');
  }
  if (result.droppedFavorites.length > 0) {
    p.log.warn(
      `Skipped ${result.droppedFavorites.length} stale/unauthorized favorite(s): `
      + result.droppedFavorites.map(fav => `${fav.providerId}:${fav.modelId}`).join(', '),
    );
  }
  if (result.capacitySkippedFavorites.length > 0) {
    p.log.warn(formatAgyCapacityWarning(opts.validatedSlotCount, result.capacitySkippedFavorites.length));
    p.log.warn(
      'Not exposed: '
      + result.capacitySkippedFavorites.map(fav => `${fav.providerId}:${fav.modelId}`).join(', '),
    );

    if (
      opts.pauseForCapacityWarning
      && isInteractiveTerminal()
      && !agyArgsAreNonInteractive(opts.childArgs)
    ) {
      const proceed = await p.confirm({
        message: 'Continue with the validated AGY switch catalog?',
        initialValue: true,
      });
      if (p.isCancel(proceed) || !proceed) {
        p.cancel('Cancelled.');
        return null;
      }
    }
  }

  return { routes: result.routes, apiKey: result.apiKey };
}

export function waitForShutdown(
  input: NodeJS.ReadStream = process.stdin,
  platform: NodeJS.Platform = process.platform,
  isProcessRunning?: () => boolean,
  processPollIntervalMs = 2_000,
): Promise<'sigint' | 'sigterm' | 'sighup' | 'process-exited'> {
  return new Promise(resolve => {
    const captureWindowsCtrlC = platform === 'win32' && input.isTTY;
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    let processPoll: NodeJS.Timeout | undefined;
    // Readiness has already observed the managed process before this wait
    // loop starts. Treat it as seen so an immediate close is not mistaken for
    // a permanent startup gap.
    let processWasSeen = true;
    let missingSince = 0;
    const cleanup = (): void => {
      if (processPoll) clearInterval(processPoll);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGHUP', onSighup);
      if (captureWindowsCtrlC) {
        input.removeListener('data', onInput);
        input.setRawMode(wasRaw);
        if (wasPaused) input.pause();
      }
    };
    const processPollFn = isProcessRunning
      ? (): void => {
        let running = false;
        try { running = isProcessRunning(); } catch { /* treat a probe error as transient */ }
        if (running) {
          processWasSeen = true;
          missingSince = 0;
          return;
        }
        if (!processWasSeen) return;
        missingSince ||= Date.now();
        // Process enumeration can briefly miss a process during Electron's
        // self-restart. Require two consecutive seconds before treating it as
        // a user-closed app and tearing down the Relay gateway.
        if (Date.now() - missingSince >= Math.max(processPollIntervalMs, 2_000)) {
          cleanup();
          resolve('process-exited');
        }
      }
      : undefined;
    const onSigint = (): void => { cleanup(); resolve('sigint'); };
    const onSigterm = (): void => { cleanup(); resolve('sigterm'); };
    const onSighup = (): void => { cleanup(); resolve('sighup'); };
    const onInput = (chunk: Buffer | string): void => {
      const receivedCtrlC = typeof chunk === 'string'
        ? chunk.includes('\u0003')
        : chunk.includes(0x03);
      if (receivedCtrlC) onSigint();
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    process.once('SIGHUP', onSighup);
    if (captureWindowsCtrlC) {
      input.on('data', onInput);
      input.setRawMode(true);
      input.resume();
    }
    if (processPollFn) {
      processPoll = setInterval(processPollFn, processPollIntervalMs);
    }
  });
}

const ANTIGRAVITY_STARTUP_ATTEMPTS = 2;
// Antigravity's Go language server can spend 30+ seconds refreshing Google
// auth after a Windows reboot. A short deadline turns a recoverable boot race
// into the "attempt 2/2" failure the user sees in the terminal.
const ANTIGRAVITY_STARTUP_TIMEOUT_MS = 90_000;

type DesktopRecoveryOptions = {
  label: string;
  profileDir: string;
  env: NodeJS.ProcessEnv;
  gatewayUrl: string;
  childArgs: string[];
  launch: (
    env: NodeJS.ProcessEnv,
    profileDir: string,
    gatewayUrl: string,
    childArgs: string[],
  ) => Promise<number>;
  quitGracefully: (profileDir: string) => void;
  forceQuit: (profileDir: string) => void;
  waitForQuit: (profileDir: string) => Promise<boolean>;
  isRunning: (profileDir: string) => boolean;
};

/**
 * Antigravity reports its local port before the language server is ready to
 * serve the Electron page. Probe that page before handing control to the
 * terminal wait loop, and recover once from the cold-start race that otherwise
 * leaves a permanent black window after ERR_TIMED_OUT.
 */
export async function launchDesktopWithRecovery(opts: DesktopRecoveryOptions): Promise<number> {
  let logOffset = 0;
  let languageServerLogOffset = 0;

  for (let attempt = 1; attempt <= ANTIGRAVITY_STARTUP_ATTEMPTS; attempt++) {
    // The profile is Relay-owned and the previous managed process has already
    // been stopped (or is about to be stopped by the retry path). Reset both
    // logs before each attempt so a stale HTTPS port can never win readiness.
    resetAntigravityLaunchLogs(opts.profileDir);
    logOffset = getAntigravityMainLogOffset(opts.profileDir);
    languageServerLogOffset = getAntigravityLanguageServerLogOffset(opts.profileDir);
    const launchCode = await opts.launch(
      opts.env,
      opts.profileDir,
      opts.gatewayUrl,
      opts.childArgs,
    );
    if (launchCode !== 0) return launchCode;

    const readiness = await waitForAntigravityReady(opts.profileDir, {
      logOffset,
      languageServerLogOffset,
      timeoutMs: ANTIGRAVITY_STARTUP_TIMEOUT_MS,
      isProcessRunning: () => opts.isRunning(opts.profileDir),
    });
    if (readiness.ready) return 0;

    if (readiness.reason === 'process-exited') {
      if (attempt < ANTIGRAVITY_STARTUP_ATTEMPTS && process.platform !== 'darwin') {
        p.log.warn(`${opts.label} exited before its local UI became ready. Restarting the managed instance (attempt ${attempt + 1}/${ANTIGRAVITY_STARTUP_ATTEMPTS})...`);
        opts.quitGracefully(opts.profileDir);
        if (!(await opts.waitForQuit(opts.profileDir))) {
          opts.forceQuit(opts.profileDir);
          await opts.waitForQuit(opts.profileDir);
        }
        continue;
      }
      p.log.error(`${opts.label} exited before its local UI became ready.`);
      p.log.info(pc.dim(`See ${join(opts.profileDir, 'logs', 'main.log')} for details.`));
      return 1;
    }

    const reason = readiness.sawLoadFailure || readiness.reason === 'load-timeout'
      ? 'Electron reported a transient local-page load failure'
      : readiness.reason === 'listening'
        ? 'the local language server is listening but is still finishing initialization'
        : readiness.url
          ? 'Antigravity logged its local URL but has not answered yet'
          : 'the local language server did not become reachable';
    const stillRunning = opts.isRunning(opts.profileDir);
    if (
      attempt < ANTIGRAVITY_STARTUP_ATTEMPTS
      && process.platform !== 'darwin'
      && (!stillRunning || readiness.sawLoadFailure)
    ) {
      p.log.warn(`${opts.label} startup failed: ${reason}. Restarting the managed instance (attempt ${attempt + 1}/${ANTIGRAVITY_STARTUP_ATTEMPTS})...`);
      opts.quitGracefully(opts.profileDir);
      if (!(await opts.waitForQuit(opts.profileDir))) {
        opts.forceQuit(opts.profileDir);
        await opts.waitForQuit(opts.profileDir);
      }
      continue;
    }

    // Keep the local gateway alive when Electron/Google is still recovering.
    // Returning success here is intentional: the foreground terminal remains
    // the lifecycle owner, and the watchdog can still clean everything up if
    // the terminal is closed. A warning gives the user the exact evidence path
    // without destroying a potentially recoverable instance.
    if (stillRunning || readiness.url) {
      p.log.warn(`${opts.label} is still starting: ${reason}. Relay will keep the gateway active while the app finishes initialization.`);
      if (readiness.url) p.log.info(pc.dim(`Local language-server URL: ${readiness.url}`));
      p.log.info(pc.dim(`Electron log: ${join(opts.profileDir, 'logs', 'main.log')}`));
      p.log.info(pc.dim(`Language-server log: ${join(opts.profileDir, 'logs', 'language_server.log')}`));
      return 0;
    }

    p.log.error(`${opts.label} did not become ready: ${reason}.`);
    p.log.info(pc.dim(`See ${join(opts.profileDir, 'logs', 'main.log')} for details.`));
    return 1;
  }

  return 1;
}


async function runAntigravityCommand(
  intro: string,
  tracePrefix: string,
  trace: boolean,
  boot: { launchProvider?: string; launchModel?: string } | undefined,
  launch: (env: NodeJS.ProcessEnv, routes: ReturnType<typeof buildAntigravityRoutes>, gatewayHandle: CloudCodeGatewayHandle) => Promise<number>,
  opts: {
    childArgs?: string[];
    versionGuard?: boolean;
    pauseForCapacityWarning?: boolean;
  } = {},
): Promise<number> {
  const prefs = loadPreferences();

  relayIntro(intro);
  if (
    tracePrefix === 'agy'
    && (prefs.favoriteModels?.length ?? 0) > 0
    && (prefs.antigravityCliFavoriteModels?.length ?? 0) === 0
    && !prefs.antigravityCliFavoritesHintShown
  ) {
    p.log.info('Tip: AGY uses its own favorites list. Run `relay-ai favorites --agy` to set up switching.');
    savePreferences({ antigravityCliFavoritesHintShown: true });
  }

  const selection = await resolveAntigravityLaunch(prefs, boot);
  if (!selection) return 1;

  const { provider, model, allProviders } = selection;

  const versionResult = opts.versionGuard
    ? readAntigravityCliVersion()
    : { version: '1.0.10' };
  const compatibility = evaluateAgySwitchCompatibility({
    version: versionResult.version,
    versionReadError: 'error' in versionResult ? versionResult.error : undefined,
    fixture: catalogFixtureRaw as unknown as CatalogFixture,
  });
  for (const warning of compatibility.warnings) {
    p.log.warn(warning);
  }

  const routeLimit = compatibility.mode === 'multi-model'
    ? compatibility.validatedSwitchSlotCount
    : 1;
  const routeResult = await resolveAndBuildRoutes(provider, model, allProviders, prefs, {
    maxRoutes: routeLimit,
    validatedSlotCount: routeLimit,
    pauseForCapacityWarning: opts.pauseForCapacityWarning ?? false,
    childArgs: opts.childArgs ?? [],
  });
  if (!routeResult) return 1;

  savePreferences({
    lastAntigravityProvider: provider.id,
    lastAntigravityModel: model.id,
  });

  const traceLogPath = trace ? getAntigravityDebugLogPath(tracePrefix) : undefined;
  const logFn = traceLogPath ? makeTraceLogger(traceLogPath) : undefined;

  let gatewayHandle: CloudCodeGatewayHandle;
  try {
    gatewayHandle = await startCloudCodeGateway(routeResult.routes, { trace, logFn });
  } catch (err) {
    p.log.error(`Failed to start Cloud Code gateway: ${err}`);
    return 1;
  }

  p.log.info(`Cloud Code gateway on ${pc.cyan(`127.0.0.1:${gatewayHandle.port}`)}`);
  p.log.success(`Active model: ${formatModelLabel(model)} ${pc.dim('via')} ${provider.name}`);
  if (traceLogPath) p.log.info(`Gateway trace → ${pc.dim(traceLogPath)}`);

  relayOutro('Launching', `${formatModelLabel(model)} (${provider.name})`);

  try {
    const cleanEnv = buildAntigravityChildEnv(gatewayHandle.url);
    return await launch(cleanEnv, routeResult.routes, gatewayHandle);
  } finally {
    await gatewayHandle.close();
  }
}

export async function runAgyCommand(
  childArgs: string[],
  trace = false,
  boot?: { launchProvider?: string; launchModel?: string },
): Promise<number> {
  return runAntigravityCommand(
    'relay-ai agy — Antigravity CLI', 'agy', trace, boot,
    (env, routes) => launchAntigravityCli(env, buildAgyLaunchArgs(routes[0]!.displayName, childArgs)),
    { childArgs, versionGuard: true, pauseForCapacityWarning: true },
  );
}

export async function runAntigravityAppCommand(
  childArgs: string[],
  trace = false,
  boot?: { launchProvider?: string; launchModel?: string },
): Promise<number> {
  return runAntigravityCommand(
    'relay-ai antigravity — Antigravity app', 'antigravity', trace, boot,
    async (env, _routes, gatewayHandle) => {
      const profileDir = join(homedir(), '.relay-ai', 'antigravity', 'app-profile');
      if (isAntigravityAppRunning(profileDir)) {
        const restart = await p.confirm({
          message: 'Restart Antigravity to apply this Relay gateway?',
          initialValue: true,
        });
        if (p.isCancel(restart) || !restart) {
          p.log.info('Quit and reopen Antigravity when you are ready for the new gateway to take effect.');
          return 0;
        }
        quitAntigravityAppGracefully(profileDir);
        if (!(await waitForAntigravityAppQuit(profileDir))) {
          forceQuitAntigravityApp(profileDir);
          await waitForAntigravityAppQuit(profileDir);
        }
      }

      p.log.info(pc.dim('Waiting for the local Antigravity UI to become ready...'));
      const launchCode = await launchDesktopWithRecovery({
        label: 'Antigravity',
        profileDir,
        env,
        gatewayUrl: gatewayHandle.url,
        childArgs,
        launch: launchAntigravityApp,
        quitGracefully: quitAntigravityAppGracefully,
        forceQuit: forceQuitAntigravityApp,
        waitForQuit: waitForAntigravityAppQuit,
        isRunning: isAntigravityAppRunning,
      });
      if (launchCode !== 0) return launchCode;

      p.log.info('Antigravity is using the Relay Cloud Code gateway.');
      p.log.info(pc.cyan('Press Ctrl+C to stop the gateway.'));
      const shutdownReason = await waitForShutdown(
        process.stdin,
        process.platform,
        () => isAntigravityAppRunning(profileDir),
      );
      if (shutdownReason === 'process-exited') {
        p.log.step('Antigravity closed. Gateway stopped.');
        return 0;
      }
      await new Promise(r => setTimeout(r, SHUTDOWN_DRAIN_MS));
      console.log('');
      p.log.step('Gateway stopped.');
      const shouldClose = await p.confirm({
        message: 'Close Antigravity?',
        initialValue: true,
      });
      if (!p.isCancel(shouldClose) && shouldClose) {
        p.log.step('Stopping Antigravity...');
        quitAntigravityAppGracefully(profileDir);
        if (!(await waitForAntigravityAppQuit(profileDir))) {
          forceQuitAntigravityApp(profileDir);
          await waitForAntigravityAppQuit(profileDir);
        }
      }
      return 0;
    },
    { childArgs, versionGuard: false, pauseForCapacityWarning: false },
  );
}

export async function runAntigravityIdeCommand(
  childArgs: string[],
  trace = false,
  boot?: { launchProvider?: string; launchModel?: string },
): Promise<number> {
  return runAntigravityCommand(
    'relay-ai antigravity-ide — Antigravity IDE', 'ide', trace, boot,
    async (env, _routes, gatewayHandle) => {
      const profileDir = join(homedir(), '.relay-ai', 'antigravity', 'profile');
      if (isAntigravityIdeRunning(profileDir)) {
        const restart = await p.confirm({
          message: 'Restart Antigravity IDE to apply this Relay gateway?',
          initialValue: true,
        });
        if (p.isCancel(restart) || !restart) {
          p.log.info('Quit and reopen Antigravity IDE when you are ready for the new gateway to take effect.');
          return 0;
        }
        quitAntigravityIdeGracefully(profileDir);
        if (!(await waitForAntigravityIdeQuit(profileDir))) {
          forceQuitAntigravityIde(profileDir);
          await waitForAntigravityIdeQuit(profileDir);
        }
      }

      p.log.info(pc.dim('Waiting for the local Antigravity IDE UI to become ready...'));
      const launchCode = await launchDesktopWithRecovery({
        label: 'Antigravity IDE',
        profileDir,
        env,
        gatewayUrl: gatewayHandle.url,
        childArgs,
        launch: launchAntigravityIde,
        quitGracefully: quitAntigravityIdeGracefully,
        forceQuit: forceQuitAntigravityIde,
        waitForQuit: waitForAntigravityIdeQuit,
        isRunning: isAntigravityIdeRunning,
      });
      if (launchCode !== 0) return launchCode;

      p.log.info('Antigravity IDE is using the Relay Cloud Code gateway.');
      p.log.info(pc.cyan('Press Ctrl+C to stop the gateway.'));
      const shutdownReason = await waitForShutdown(
        process.stdin,
        process.platform,
        () => isAntigravityIdeRunning(profileDir),
      );
      if (shutdownReason === 'process-exited') {
        p.log.step('Antigravity IDE closed. Gateway stopped.');
        return 0;
      }
      await new Promise(r => setTimeout(r, SHUTDOWN_DRAIN_MS));
      console.log('');
      p.log.step('Gateway stopped.');
      const shouldClose = await p.confirm({
        message: 'Close Antigravity IDE?',
        initialValue: true,
      });
      if (!p.isCancel(shouldClose) && shouldClose) {
        p.log.step('Stopping Antigravity IDE...');
        quitAntigravityIdeGracefully(profileDir);
        if (!(await waitForAntigravityIdeQuit(profileDir))) {
          forceQuitAntigravityIde(profileDir);
          await waitForAntigravityIdeQuit(profileDir);
        }
      }
      return 0;
    },
    { childArgs, versionGuard: false, pauseForCapacityWarning: false },
  );
}
