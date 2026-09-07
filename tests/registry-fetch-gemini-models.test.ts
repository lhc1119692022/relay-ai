import { describe, expect, it, vi } from 'vitest';
import { fetchGeminiModels } from '../src/registry/fetch-gemini-models.js';

describe('fetchGeminiModels', () => {
  it('lists native Gemini models and preserves provider metadata', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1_000_000, supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await fetchGeminiModels('https://relay.example/v1beta', 'secret', { 'X-Plan': 'pro' });
    expect(result.baseUrl).toBe('https://relay.example/v1beta');
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      id: 'gemini-2.5-pro',
      npm: '@ai-sdk/google',
      apiUrl: 'https://relay.example/v1beta',
      contextWindow: 1_000_000,
      contextWindowSource: 'provider',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://relay.example/v1beta/models', expect.objectContaining({
      headers: expect.objectContaining({ 'x-goog-api-key': 'secret', 'X-Plan': 'pro' }),
    }));
    fetchMock.mockRestore();
  });
});
