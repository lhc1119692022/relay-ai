import { deriveBrand } from '../models.js';
import { resolveContextWindow } from '../context-window.js';
import type { CachedModel } from './types.js';

type GeminiModel = {
  name?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
};

function nativeRoot(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (/\/v1(?:beta)?$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1beta`;
}

export async function fetchGeminiModels(
  baseUrl: string,
  apiKey: string,
  extraHeaders?: Record<string, string>,
): Promise<{ models: CachedModel[]; baseUrl: string; error?: string; hint?: string }> {
  const root = nativeRoot(baseUrl);
  const modelsUrl = `${root}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(modelsUrl, {
      headers: {
        'x-goog-api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...extraHeaders,
      },
      signal: controller.signal,
    });
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { models: [], baseUrl: root, error: 'API key was rejected.', hint: 'Check the Gemini API key and endpoint.' };
      }
      return { models: [], baseUrl: root, error: `Could not list Gemini models (HTTP ${response.status}).`, hint: 'Verify the endpoint exposes the native Gemini /models API.' };
    }
    let rows: GeminiModel[] = [];
    try { rows = (JSON.parse(raw) as { models?: GeminiModel[] }).models ?? []; } catch { /* malformed response */ }
    const models = rows
      .filter(row => row.name && (row.supportedGenerationMethods ?? ['generateContent']).some(m => /generateContent/i.test(m)))
      .map(row => {
        const id = row.name!.replace(/^models\//, '');
        return {
          id,
          name: row.displayName?.trim() || id,
          upstreamModelId: id,
          family: id.split('-')[0] ?? id,
          brand: deriveBrand(id),
          contextWindow: row.inputTokenLimit ?? resolveContextWindow(id),
          contextWindowSource: row.inputTokenLimit ? 'provider' as const : undefined,
          modelFormat: 'openai' as const,
          npm: '@ai-sdk/google',
          apiUrl: root,
        };
      });
    if (!models.length) return { models: [], baseUrl: root, error: 'No Gemini generateContent models returned.', hint: 'Check the endpoint path and model permissions.' };
    return { models, baseUrl: root };
  } catch {
    return { models: [], baseUrl: root, error: 'Could not reach the Gemini-compatible server.', hint: 'Check the base URL and network connection.' };
  } finally {
    clearTimeout(timer);
  }
}
