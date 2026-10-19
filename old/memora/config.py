"""Configuration comes from environment variables only: MCP hosts pass env per server, and nothing
is read from files a capture client could edit. `summary()` shows the effective configuration
without secrets (used by `doctor`)."""
import json
import os
import sys
from pathlib import Path

from .errors import ProviderConfigError


def environment(env=None):
    """MEMORA_* is canonical; MM_* remains an input compatibility alias."""
    values = dict(os.environ if env is None else env)
    for key, value in tuple(values.items()):
        if key.startswith('MEMORA_'):
            values['MM_' + key[7:]] = value
    return values


def default_data_dir(env=None):
    env = environment(env)
    if env.get('MM_DATA'): return Path(env['MM_DATA'])
    # 0.1 defaulted to <checkout>/data. Keep using it if it holds a database, or upgrading would
    # silently present an empty store.
    #
    # The level is derived, not hardcoded, because it has already moved once: the source tree used
    # to sit one level deeper (in a `devel/` directory), which made parents[2] correct and parents[1]
    # point at an empty directory — and because the fallback is silent, the symptom was "my memories
    # are gone" rather than an error. So walk up from this file and take the first ancestor that
    # actually holds a store; fall back to the platform directory only when none does.
    #
    # A packaged build never reaches this: main.cjs passes --data next to the executable.
    here = Path(__file__).resolve()
    for candidate in here.parents:
        if (candidate / 'data' / 'memory.sqlite3').exists():
            return candidate / 'data'
    legacy = here.parents[1] / 'data'
    if (legacy / 'memory.sqlite3').exists(): return legacy
    if sys.platform == 'win32':
        base = Path(env.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local')
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support'
    else:
        base = Path(env.get('XDG_DATA_HOME') or Path.home() / '.local' / 'share')
    old = base / 'memory-merge'
    current = base / 'memora'
    return old if (old / 'memory.sqlite3').exists() and not (current / 'memory.sqlite3').exists() else current


def _int(env, key, default=None):
    v = env.get(key)
    if v in (None, ''): return default
    try:
        return int(v)
    except ValueError:
        raise ProviderConfigError(f'{key} must be an integer') from None


def _flag(env, key):
    return env.get(key) == '1'


def _need(env, key, why):
    if not env.get(key): raise ProviderConfigError(f'{key} is required {why}')
    return env[key]


def embedding_from_env(env=None):
    from . import providers
    env = environment(env)
    backend = env.get('MM_EMBED_BACKEND') or ('openai' if env.get('MM_EMBED_URL') else None)
    if not backend: return None
    common = dict(dimensions=_int(env, 'MM_EMBED_DIM'), query_template=env.get('MM_EMBED_QUERY_TEMPLATE'), task=env.get('MM_EMBED_TASK'))
    if backend == 'openai':
        return providers.Provider(_need(env, 'MM_EMBED_URL', 'for the openai backend'), env.get('MM_EMBED_MODEL', ''),
                                  env.get('MM_EMBED_KEY', ''), _flag(env, 'MM_ALLOW_REMOTE'), timeout=_int(env, 'MM_EMBED_TIMEOUT', 30),
                                  preset=env.get('MM_EMBED_PRESET', 'none'), revision=env.get('MM_EMBED_REVISION'),
                                  batch_size=_int(env, 'MM_EMBED_BATCH', 32), **common)
    if backend == 'sentence-transformers':
        return providers.SentenceTransformersEmbedder(_need(env, 'MM_EMBED_MODEL', 'for sentence-transformers (hub id or path)'),
                                                      revision=env.get('MM_EMBED_REVISION'), device=env.get('MM_EMBED_DEVICE'),
                                                      preset=env.get('MM_EMBED_PRESET', 'qwen3-embedding'),
                                                      allow_remote=_flag(env, 'MM_ALLOW_REMOTE'), **common)
    if backend == 'llama-cpp':
        return providers.LlamaCppEmbedder(_need(env, 'MM_EMBED_PATH', 'for llama-cpp (path to a .gguf file)'),
                                          preset=env.get('MM_EMBED_PRESET', 'qwen3-embedding'),
                                          n_gpu_layers=_int(env, 'MM_EMBED_GPU_LAYERS', 0), **common)
    raise ProviderConfigError('MM_EMBED_BACKEND must be openai, sentence-transformers or llama-cpp')


def rerank_from_env(env=None):
    """Optional second-stage reranker. None means recall() never makes a second call."""
    from . import providers
    env = environment(env)
    backend = env.get('MM_RERANK_BACKEND') or ('openai' if env.get('MM_RERANK_URL') else None)
    if not backend: return None
    if backend == 'openai':
        return providers.Provider(_need(env, 'MM_RERANK_URL', 'for the openai backend'), _need(env, 'MM_RERANK_MODEL', 'for rerank'),
                                  env.get('MM_RERANK_KEY', ''), _flag(env, 'MM_ALLOW_REMOTE'), timeout=_int(env, 'MM_RERANK_TIMEOUT', 30),
                                  revision=env.get('MM_RERANK_REVISION'))
    raise ProviderConfigError('MM_RERANK_BACKEND must be openai')


def judge_from_env(env=None):
    from . import providers
    env = environment(env)
    backend = env.get('MM_JUDGE_BACKEND') or ('openai' if env.get('MM_JUDGE_URL') else None)
    if not backend: return None
    if backend == 'openai':
        try:
            extra = json.loads(env.get('MM_JUDGE_EXTRA') or '{}')
        except ValueError:
            raise ProviderConfigError('MM_JUDGE_EXTRA must be a JSON object') from None
        if not isinstance(extra, dict): raise ProviderConfigError('MM_JUDGE_EXTRA must be a JSON object')
        return providers.Provider(_need(env, 'MM_JUDGE_URL', 'for the openai backend'), env.get('MM_JUDGE_MODEL', ''),
                                  env.get('MM_JUDGE_KEY', ''), _flag(env, 'MM_ALLOW_REMOTE'), timeout=_int(env, 'MM_JUDGE_TIMEOUT', 60),
                                  revision=env.get('MM_JUDGE_REVISION'), response_format=env.get('MM_JUDGE_RESPONSE_FORMAT', 'json_schema'),
                                  no_think=_flag(env, 'MM_JUDGE_NO_THINK'), extra=extra)
    if backend == 'llama-cpp':
        return providers.LlamaCppJudge(_need(env, 'MM_JUDGE_PATH', 'for llama-cpp (path to a .gguf file)'),
                                       n_gpu_layers=_int(env, 'MM_JUDGE_GPU_LAYERS', 0), no_think=_flag(env, 'MM_JUDGE_NO_THINK'))
    raise ProviderConfigError('MM_JUDGE_BACKEND must be openai or llama-cpp')


# Never rendered, never logged, never returned: summary() replaces each with '<set>' so an operator
# can see THAT a credential exists without the value ever leaving the process.
SECRET_KEYS = ('MM_EMBED_KEY', 'MM_JUDGE_KEY', 'MM_RERANK_KEY')


def redact(value):
    """Render a secret as a fixed marker. Used wherever a value could otherwise be echoed back."""
    return '<set>' if value else '<empty>'


def summary(env=None):
    env = environment(env)
    shown = {k: (redact(v) if k in SECRET_KEYS else v) for k, v in sorted(env.items()) if k.startswith('MM_')}
    return {'data_dir': str(default_data_dir(env)), 'environment': shown,
            'review_tools': _flag(env, 'MM_ENABLE_REVIEW'), 'agent_confirm_allowed': _flag(env, 'MM_TRUST_AGENT_CONFIRM'),
            'remote_providers_allowed': _flag(env, 'MM_ALLOW_REMOTE')}
