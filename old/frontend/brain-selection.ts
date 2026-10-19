/** Stable memory identity survives switching renderer, dimension and camera layout. */
export function memoryIdentity(body: string): string | null {
  return body.match(/记忆 ID[：:]\s*([A-Za-z0-9_-]+)/)?.[1] || null;
}

export function selectionKey(): string {
  const params = new URLSearchParams(location.search);
  return 'memora-brain-selection:' + (params.get('project') || 'default') + ':' + (params.get('preview') === '1' ? 'preview' : 'real');
}

export function rememberMemory(id: string): void {
  if (!id || id.startsWith('category:')) return;
  try { localStorage.setItem(selectionKey(), id); } catch {}
}

export function rememberedMemory(): string | null {
  try { return localStorage.getItem(selectionKey()); } catch { return null; }
}
