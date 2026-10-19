"""Default runtime: connect → capture → classify → consolidate → retrieve.

SQLite remains authoritative. Model roles, leased accumulation and document workflows
load on demand; external-agent task reasoning remains with the connected host.
"""
import copy
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from functools import cached_property

from . import __version__, config, vectors
from .errors import Conflict, InvalidInput, MemoraError, ModelOutputInvalid
from .schema import now
from .service import MemoryService
from .store import CATEGORIES, Store, scope

TITLES = {'fact': '事实', 'knowledge': '知识', 'decision': '决策',
          'preference': '偏好', 'procedure': '操作步骤', 'lesson': '经验教训'}


# Roles that may be configured from the UI. rerank is optional: an empty role disables the stage.
ROLES = ('embedding', 'judge', 'rerank')
# Role -> environment prefix, so one loop configures every role identically.
ROLE_PREFIX = {'embedding': 'EMBED', 'judge': 'JUDGE', 'rerank': 'RERANK'}

# The real probe (POST /api/agent/model-probe) is a button a user waits on, so it carries its own
# hard ceiling instead of trusting each provider's configured timeout: a role saved with
# timeout=300 must still answer the page within seconds, and a caller cannot raise it.
PROBE_TIMEOUT = 15.0
# The probe payloads. Deliberately tiny and content-free: a probe spends the minimum tokens that
# still proves the endpoint, the credential and the response shape work together.
PROBE_TEXT = 'memora connection probe'
PROBE_QUERY = 'memory retrieval'
PROBE_DOCUMENTS = ('the dog sat on the mat', 'the cat slept on the sofa')


def _factories():
    # Imported lazily: core must stay importable without the provider module's optional backends.
    return {'embedding': config.embedding_from_env, 'judge': config.judge_from_env, 'rerank': config.rerank_from_env}


# --- model connectivity probes ---------------------------------------------------------------
# Module-level, not methods, so the timeout/redirect/response-size rules apply to every call site
# and a test can exercise one role without building a whole runtime.

def _probe_transport(provider, limit):
    """Copy the provider and give it the probe's own ceiling.

    A copy is essential: provider.timeout is part of the object the SERVICE uses for real
    retrieval, so tightening it in place would silently shorten every later embed/chat call.
    """
    probe = copy.copy(provider)
    probe.timeout = min(float(getattr(provider, 'timeout', limit) or limit), float(limit))
    return probe


def _health_one(provider, probed):
    """GET {base}/models once. configured/reachable/advertised, never a generated token."""
    from .providers import NoRedirect
    if provider is None:
        return {'configured': False, 'reachable': False, 'advertised': None, 'model': None,
                'latency_ms': None, 'probed_at': probed}
    base = getattr(provider, 'base', None)
    model = getattr(provider, 'model', None)
    if not base:
        # An in-process backend (sentence-transformers, llama-cpp) has no endpoint to poll. Saying
        # reachable=True would claim a measurement nobody made; None says "not probed this way".
        return {'configured': True, 'reachable': None, 'advertised': None, 'model': model,
                'kind': 'in-process', 'latency_ms': None, 'probed_at': probed}
    headers = {}
    if getattr(provider, 'key', ''): headers['Authorization'] = 'Bearer ' + provider.key
    request = urllib.request.Request(base.rstrip('/') + '/models', headers=headers)
    started = time.monotonic()
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=4) as response: data = json.loads(response.read(200000))
        names = [m.get('id') for m in data.get('data', []) if isinstance(m, dict)]
        return {'configured': True, 'reachable': True, 'model': model,
                'advertised': model in names,
                'latency_ms': round((time.monotonic() - started) * 1000, 1), 'probed_at': probed}
    except Exception as exc:
        return {'configured': True, 'reachable': False, 'model': model,
                'advertised': None, 'latency_ms': round((time.monotonic() - started) * 1000, 1),
                'error': type(exc).__name__, 'probed_at': probed}


def _is_timeout(exc):
    """True for a socket/urllib timeout, including the ProviderError that wraps it.

    providers.Provider.post re-raises urllib's TimeoutError/URLError as
    ProviderError('provider unreachable: TimeoutError') with no cause chain, so the type is not
    enough and the message is checked as well.
    """
    seen, queue = set(), [exc]
    while queue:                                  # walk __cause__/__context__ for a real timeout
        current = queue.pop()
        if current is None or id(current) in seen: continue
        seen.add(id(current))
        if isinstance(current, (TimeoutError, socket.timeout)): return True
        for attr in ('__cause__', '__context__'):
            queue.append(getattr(current, attr, None))
    text = str(exc).lower()
    return 'timeouterror' in text or 'timed out' in text


def _probe_detail(exc):
    """The one-line reason a probe failed: what kind of failure, and its HTTP status if it had one.

    providers.Provider.post turns urllib's HTTPError into ProviderError('provider returned HTTP
    N', status=N) -- the status lives in MemoraError.details, not as an attribute -- so read both
    places rather than reporting a 401 as a generic failure with no number in it.
    """
    details = getattr(exc, 'details', None) or {}
    status = details.get('status') if isinstance(details, dict) else None
    if status is None: status = getattr(exc, 'status', None) or getattr(exc, 'code', None)
    status = status if isinstance(status, int) else None
    name = type(exc).__name__
    if status is not None: return status, name + ' (HTTP %d)' % status
    text = str(exc).strip()
    return None, name + (': ' + text if text and text != name else '')


def _probe_role(role, provider, limit, probed):
    """One real minimal inference for one saved role. Never claims success it did not observe.

    embedding -> POST /embeddings, one short input, a vector must come back
    judge     -> POST /chat/completions, one word out, choices[0].message.content must exist
    rerank    -> POST /rerank, one query + two documents, numeric scores must come back
    """
    result = {'configured': provider is not None, 'ok': False, 'latency_ms': None,
              'model': getattr(provider, 'model', None) if provider is not None else None,
              'probed_at': probed}
    if provider is None:
        result['error'] = 'not configured: no saved endpoint for this role'
        return result
    if not getattr(provider, 'base', None):
        # In-process backends cannot be probed without loading model weights into this process,
        # which a button must never do. Report that honestly instead of a fake latency.
        result.update(ok=None, kind='in-process',
                      error='in-process backend: no HTTP endpoint to probe')
        return result
    started = time.monotonic()
    try:
        probe = _probe_transport(provider, limit)
        if role == 'embedding':
            vector = probe.embed(PROBE_TEXT)
            if not vector: raise ModelOutputInvalid('embedding response had no vector')
            result['vector_dim'] = len(vector)
        elif role == 'judge':
            reply = probe.chat([{'role': 'user', 'content': 'Reply with the single word: ok'}], max_tokens=4)
            if not isinstance(reply, str): raise ModelOutputInvalid('chat response had no text')
            result['reply_chars'] = len(reply)
        elif role == 'rerank':
            scored = probe.rerank(PROBE_QUERY, list(PROBE_DOCUMENTS))
            if not scored: raise ModelOutputInvalid('rerank returned no scored documents')
            result['scored'] = len(scored)
        else:                                     # a role ROLES does not know cannot be probed
            result['error'] = 'no probe defined for role ' + role
            return result
        result['ok'] = True
    except Exception as exc:                      # every failure is reported, never swallowed
        status, detail = _probe_detail(exc)
        if status is not None: result['http_status'] = status
        result['error'] = detail
        # A timeout is a DIFFERENT story from a rejection: the endpoint is usually fine and the
        # model was cold (a large reranker can need >10 s on first call). Marking it separately
        # lets the page say "retry" instead of "broken", without pretending the call succeeded.
        if _is_timeout(exc):
            result['timeout'] = True
    result['latency_ms'] = round((time.monotonic() - started) * 1000, 1)
    return result


def _restrict(path):
    """Best-effort owner-only permissions for a file holding a credential.

    POSIX: chmod 0600, which is exact and enforced by the kernel.
    Windows: chmod only toggles the read-only flag, so the real permission is the ACL. The
    inheritance is removed and only the current user is granted access, which is the closest
    equivalent of 0600 available without a service account. This is reported honestly rather
    than claimed as 0600: see restrict_effect() for what actually happened on this host.
    Failures are swallowed - a preference that cannot be tightened must not lose the settings."""
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    if sys.platform != 'win32': return
    try:
        user = os.environ.get('USERNAME') or ''
        if not user: return
        # /inheritance:r strips inherited ACEs; /grant:r replaces the remaining ones.
        subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', f'{user}:F'],
                       capture_output=True, timeout=10, check=False,
                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.SubprocessError):
        pass


# --- which copy of the application is running ------------------------------------------------
# The version banner under the wordmark answers "which copy am I looking at?", and only the running
# PROCESS can answer it: the same page source is served by the development tree and by the frozen
# desktop build. The decision is therefore derived from how this interpreter was started, not from a
# path guess or a build-time constant:
#
#   frozen  -> PyInstaller bootloader set sys.frozen; this is the packaged, unzip-and-run app
#   source  -> everything else (python -m memora, pytest, a script importing the package)
#
# MEMORA_EDITION is an explicit override for the two cases the default cannot express (a frozen
# build used instrumentally, a source checkout labelled as something else). It is an override and
# not the primary signal: a page that trusted an unset variable would render "unknown", and a label
# that is wrong is worse than no label at all.
EDITION_STANDALONE = 'standalone'
EDITION_DEVEL = 'devel'
EDITIONS = (EDITION_DEVEL, EDITION_STANDALONE)
EDITION_ENV = 'MEMORA_EDITION'
# What the two editions are called when a human reads them. The banner itself shows the raw
# edition id next to the version (memora / <edition> / v<version>); this label is for tooltips and
# for any surface that wants prose. Kept here, next to the ids, so the two can never drift.
EDITION_LABELS = {EDITION_DEVEL: '开发测试版 devel', EDITION_STANDALONE: '独立版 standalone'}


def running_edition(frozen=None, env=None):
    """'standalone' for a frozen build, 'devel' for source execution, overridable by env.

    frozen defaults to the real getattr(sys, 'frozen', False); tests pass it explicitly so both
    branches are exercised without building a release. An unknown env value is IGNORED rather than
    trusted: a typo must not invent a third edition the UI has no styling for.
    """
    frozen = bool(getattr(sys, 'frozen', False)) if frozen is None else bool(frozen)
    override = str((os.environ if env is None else env).get(EDITION_ENV, '')).strip().lower()
    if override in EDITIONS: return override
    return EDITION_STANDALONE if frozen else EDITION_DEVEL


class MemoryRuntime:
    def __init__(self, root, env=None, service=None):
        self.store = Store(root)
        self.env = dict(os.environ if env is None else env)
        self.lock = threading.RLock()
        self.settings_path = self.store.root / 'memora.json'
        self.settings = self._read_settings()
        self.service = service or self._service(self.settings)
        self._settings_stamp = self.settings_path.stat().st_mtime_ns if self.settings_path.exists() else None

    def refresh_settings(self):
        """Separate MCP host processes observe UI changes on their next request."""
        stamp = self.settings_path.stat().st_mtime_ns if self.settings_path.exists() else None
        if stamp == self._settings_stamp: return
        with self.lock:
            settings = self._read_settings()
            service = self._service(settings)
            self.settings, self.service, self._settings_stamp = settings, service, stamp

    @cached_property
    def documents(self):
        from .documents import Documents
        return Documents(self.store)

    @cached_property
    def control(self):
        from .control import Control
        return Control(self.store)

    @cached_property
    def model_registry(self):
        from .model_registry import ModelRegistry
        return ModelRegistry(self)

    @property
    def profiles(self): return self.model_registry.profiles()

    def get_adapter(self, pid): return self.model_registry.get_adapter(pid)

    def adapter_for_profile(self, profile, timeout=None):
        """A chat adapter for one model profile, carrying the credential that profile is entitled to.

        A profile is the durable identity of a model; it does NOT carry a credential. Credentials
        live in the role settings (memora.json: the user's literal api_key, else key_env), and this
        is the one place that joins the two for the workflow path -- the same precedence
        _resolve_key() already applies to the memory pipeline (Judge/embedding).

        Why this exists: workflows call adapter_for_profile(), and before this join the adapter
        read ONLY os.environ[key_env]. A profile derived from the saved settings has an empty
        key_env (the workbench stores the literal key, and that field is never echoed), so every
        workflow node sent no Authorization header and the provider answered 401 -- while the same
        credential worked for Judge/embedding, which go through _service(). That difference is the
        bug this method removes; it was a configuration-resolution gap, not a dead endpoint.

        The key is passed as an argument, never written to the environment, never put on the
        profile and never recorded: run traces keep the model name and hashes, not credentials.
        """
        from .chat_models import adapter
        return adapter(profile, self._profile_key(profile), timeout)

    def _profile_key(self, profile):
        """The saved credential for the role whose endpoint and model this profile names.

        Matched on (base, model) against each saved role, so a renamed profile id still finds its
        credential. Returns '' when no role matches -- a profile the user added for some other
        endpoint simply has no saved role credential, and the adapter falls back to key_env.
        """
        if not isinstance(profile, dict): return ''
        base = (profile.get('base') or '').rstrip('/')
        model = profile.get('model') or ''
        if not base or not model: return ''
        for role in ROLES:
            saved = self.settings.get(role) or {}
            if (saved.get('url') or '').rstrip('/') != base: continue
            if (saved.get('model') or '') != model: continue
            key = self._resolve_key(saved)
            if key: return key
        return ''

    @cached_property
    def workflows(self):
        from .workflows import Workflows
        return Workflows(self)

    @cached_property
    def knowledge(self):
        from .knowledge import Knowledge
        return Knowledge(self)

    @cached_property
    def jobs(self):
        from .jobs import Jobs
        return Jobs(self)

    @cached_property
    def accumulation(self):
        from .accumulation import Accumulation
        return Accumulation(self)

    def close(self):
        if 'jobs' in self.__dict__: self.jobs.close()
        if 'workflows' in self.__dict__:
            with self.workflows.lock:
                for event in self.workflows.cancellations.values(): event.set()

    # --- model connectivity ---------------------------------------------------------------
    # Two questions, two routes, deliberately different:
    #   model_health()  is the endpoint up, and does it ADVERTISE the configured model? One
    #                   GET /models per role -- cheap enough to run whenever the workflow view
    #                   paints, and it never spends a generation token.
    #   model_probe()   do a real minimal inference per role (/embeddings, /chat/completions,
    #                   /rerank) against the SAVED configuration and report the HTTP status,
    #                   latency, model and the actual error. This is the 测试连接 button.
    # Neither route accepts an endpoint or a key from the caller: the destination comes only
    # from memora.json, so neither can be used as an SSRF hop.

    def role_providers(self):
        """The configured provider object per role, including rerank. Read once per call."""
        service = self.service
        return {'embedding': service.embedding, 'judge': service.judge_provider,
                'rerank': service.rerank_provider}

    def model_health(self):
        """Per-role reachability AT THE MOMENT OF THIS CALL. Not a cache and not a promise.

        Keys are role names taken from ROLES, so a role added there appears here without editing
        this loop. Each value keeps the configured/reachable/advertised/latency_ms semantics and
        adds probed_at, so a page can say when the observation was made.
        """
        providers = self.role_providers()
        probed = now()
        return {role: _health_one(providers.get(role), probed) for role in ROLES}

    def model_probe(self, roles=None, timeout=None):
        """POST /api/agent/model-probe -- one real minimal call per SAVED role.

        Returns {'probed_at': ..., 'roles': {role: {configured, ok, latency_ms, model,
        http_status?, error?, probed_at}}}. 'ok' is True only when the provider really answered
        and the answer parsed: an HTTP error, a timeout, a redirect, an unparseable body and an
        unreachable host are all reported as ok=False with the reason. Nothing is cached and
        nothing is written.

        roles: optional subset of ROLES (a list). Asking for any other name is rejected -- the
        route never probes an endpoint the caller supplies.
        timeout: optional seconds, clamped to PROBE_TIMEOUT. Tests use it to keep a slow fake
        server from turning a unit test into a 15 s wait; the HTTP route never passes it.
        """
        if timeout is None:
            limit = float(PROBE_TIMEOUT)
        else:
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < float(timeout):
                raise InvalidInput('probe timeout must be a positive number of seconds')
            limit = min(float(timeout), float(PROBE_TIMEOUT))
        providers = self.role_providers()
        if roles is None:
            selected = list(ROLES)
        else:
            if isinstance(roles, str) or not isinstance(roles, (list, tuple)):
                raise InvalidInput('model-probe roles must be a list of role names')
            unknown = [role for role in roles if role not in ROLES]
            if unknown:
                raise InvalidInput('model-probe roles are ' + ', '.join(ROLES))
            wanted = set(roles)
            selected = [role for role in ROLES if role in wanted]
            if not selected:
                raise InvalidInput('model-probe roles must name at least one role')
        probed = now()
        from concurrent.futures import ThreadPoolExecutor
        # Parallel because each call may take up to the full timeout: sequential probing of three
        # roles would make the page wait three times as long for the same answer.
        with ThreadPoolExecutor(max_workers=len(selected)) as pool:
            futures = {role: pool.submit(_probe_role, role, providers.get(role), limit, probed)
                       for role in selected}
            out = {role: futures[role].result() for role in selected}
        return {'probed_at': probed, 'roles': out}

    def _read_settings(self):
        if self.settings_path.exists():
            return self.validate_settings(json.loads(self.settings_path.read_text('utf-8')))
        # Absorb existing model bindings without loading the extended Agent runtime.
        assembly = self.store.root / 'agent-assembly.json'
        profiles = self.store.root / 'agent-models.json'
        migrated = {}
        if assembly.exists() and profiles.exists():
            bindings = json.loads(assembly.read_text('utf-8'))
            models = {p['id']: p for p in json.loads(profiles.read_text('utf-8'))}
            for role in ('embedding', 'judge'):
                p = models.get(bindings.get(role))
                if not p or p.get('kind') not in ('openai', 'ollama'): continue
                migrated[role] = {'backend': 'openai', 'url': p['base'].rstrip('/') + ('/v1' if p['kind'] == 'ollama' else ''),
                                 'model': p['model'], 'key_env': p.get('key_env', ''), 'remote': p.get('remote', False)}
        return self.validate_settings(migrated)

    @staticmethod
    def validate_settings(body):
        if not isinstance(body, dict) or set(body) - set(ROLES):
            raise InvalidInput('settings contain only ' + ', '.join(ROLES))
        out = {}
        for role in ROLES:
            p = body.get(role) or {}
            if not isinstance(p, dict) or set(p) - {'backend', 'url', 'model', 'key_env', 'api_key', 'api_key_clear', 'remote', 'preset', 'response_format', 'revision', 'timeout'}:
                raise InvalidInput('model settings: backend, url, model, key_env, api_key, remote, preset, response_format')
            value = {k: p.get(k, '') for k in ('backend', 'url', 'model', 'key_env')}
            if any(not isinstance(v, str) or len(v) > 1000 for v in value.values()):
                raise InvalidInput('model settings must be text, max 1000 characters')
            if value['backend'] not in ('', 'openai'): raise InvalidInput('UI uses OpenAI-compatible endpoints; other backends use environment configuration')
            if value['key_env'] and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,99}', value['key_env']):
                raise InvalidInput('key_env must be an environment variable name, never a key')
            if type(p.get('remote', False)) is not bool: raise InvalidInput('remote must be a boolean')
            value.update(remote=p.get('remote', False), preset=p.get('preset', 'none'), response_format=p.get('response_format', 'json_schema'))
            if 'revision' in p:
                if not isinstance(p['revision'], str) or len(p['revision']) > 200: raise InvalidInput('invalid model revision')
                value['revision'] = p['revision']
            if 'timeout' in p:
                if type(p['timeout']) is not int or not 1 <= p['timeout'] <= 300: raise InvalidInput('timeout must be 1..300 seconds')
                value['timeout'] = p['timeout']
            if 'api_key' in p:
                # A literal credential supplied by the user, stored only in memora.json (0600).
                # Never echoed: validate_settings returns it, but every read path -- status(),
                # summary(), doctor -- goes through _public(), which drops it for a boolean.
                key = p['api_key']
                if key is None or key == '': pass
                elif not isinstance(key, str) or len(key) > 4096 or any(ch in key for ch in '\r\n\x00'):
                    raise InvalidInput('api_key must be a single-line string, max 4096 characters')
                else: value['api_key'] = key.strip()
            if p.get('api_key_clear') is True: value['api_key'] = ''
            out[role] = value
        return out

    @staticmethod
    def _public(settings):
        """The only shape any read path may return: a literal key becomes the boolean key_set."""
        out = {}
        for role, value in settings.items():
            shown = {k: v for k, v in value.items() if k != 'api_key'}
            shown['key_set'] = bool(value.get('api_key'))
            out[role] = shown
        return out

    def _service(self, settings):
        env = config.environment(self.env)
        # Per-role persisted settings override that role's env defaults.
        for role, prefix in ROLE_PREFIX.items():
            p = settings[role]
            if not p['backend']: continue
            for suffix, key in (('BACKEND', 'backend'), ('URL', 'url'), ('MODEL', 'model'), ('PRESET', 'preset'), ('RESPONSE_FORMAT', 'response_format')):
                env['MM_' + prefix + '_' + suffix] = p[key]
            # Key precedence is fixed and documented on _resolve_key: a literal key saved by the
            # user wins; the environment variable named by key_env is the fallback.
            env['MM_' + prefix + '_KEY'] = self._resolve_key(p)
            for suffix, key in (('REVISION', 'revision'), ('TIMEOUT', 'timeout')):
                if key in p: env['MM_' + prefix + '_' + suffix] = str(p[key])
            # Remote consent is scoped to a single provider, never shared across roles.
        built = []
        for role in ROLES:
            role_env = {k: v for k, v in env.items() if not k.startswith('MEMORA_')}
            if settings[role]['backend']: role_env['MM_ALLOW_REMOTE'] = '1' if settings[role]['remote'] else '0'
            built.append(_factories()[role](role_env))
        return MemoryService(self.store, built[0], built[1], rerank=built[2])

    def _resolve_key(self, p):
        """The credential for one role. Precedence: literal api_key, then the key_env variable.

        The literal key is read from memora.json only; it is never placed in os.environ, never
        interpolated into a message, and never returned by status()/summary()/doctor.
        key_env stays a variable NAME - validate_settings rejects anything that looks like a key."""
        if p.get('api_key'): return p['api_key']
        return self.env.get(p['key_env'], '') if p['key_env'] else ''

    def save_settings(self, body):
        # A role the caller did not mention keeps its stored literal key. Without this, every UI
        # save that omits api_key (all of them, when the field is left blank) would silently
        # delete a credential the user already saved. Clearing is explicit: api_key_clear.
        incoming = dict(body) if isinstance(body, dict) else {}
        for role in ROLES:
            sent = incoming.get(role)
            if isinstance(sent, dict) and 'api_key' not in sent and sent.get('api_key_clear') is not True:
                kept = self.settings.get(role, {}).get('api_key')
                if kept: incoming[role] = dict(sent, api_key=kept)
        settings = self.validate_settings(incoming)
        candidate = self._service(settings)  # Validate endpoints before persisting.
        with self.lock:
            temporary = self.settings_path.with_suffix('.tmp')
            temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2), 'utf-8')
            _restrict(temporary)   # tighten BEFORE the secret is at its final name
            os.replace(temporary, self.settings_path)
            _restrict(self.settings_path)
            self.settings, self.service = settings, candidate
            self._settings_stamp = self.settings_path.stat().st_mtime_ns
        return self.status()

    def key_state(self):
        """Per-role credential presence, with no value in it. Safe for any read path."""
        return {role: {'key_set': bool(self.settings[role].get('api_key')) or bool(self.settings[role]['key_env']),
                       'source': 'literal' if self.settings[role].get('api_key') else ('env' if self.settings[role]['key_env'] else None)}
                for role in ROLES}

    def status(self):
        # settings go out through _public(): a literal api_key becomes key_set: true. This is the
        # single read path the UI uses, so a secret cannot leak by being added to settings later.
        edition = running_edition(env=self.env)
        return {'name': 'memora', 'version': __version__, 'edition': edition,
                'edition_label': EDITION_LABELS[edition], 'kernel': vectors.kernel(),
                'data_dir': str(self.store.root),
                'embedding': self.service.embedding is not None, 'judge': self.service.judge_provider is not None,
                'rerank': self.service.rerank_provider is not None,
                'keys': self.key_state(),
                'settings': self._public(self.settings), 'categories': TITLES,
                'provider_status': 'configured does not mean reachable; retrieval/classification reports actual results',
                'components': ['agents', 'retrieval', 'classification', 'markdown', 'brain', 'accumulation', 'workflows', 'model-orchestration']}

    def capture(self, project, content, source, event_id=None, category=None):
        with self.lock:
            memory = self.store.capture(project, content, source, event_id=event_id, category=category, actor='memora')
            # Retries must not undo a user's category edit or repeat a successful model call.
            with self.store.connect() as c:
                saved = c.execute('SELECT value FROM meta WHERE key=?', ('memora.route.' + memory['id'],)).fetchone()
            route = json.loads(saved[0]) if saved else None
            if memory['status'] == 'pending' and route is None: route = self.classify(project, memory['id'])
            return {'memory': self.store.get(project, memory['id']), 'classification': route, 'export': self.store.flush()}

    def classify(self, project, id):
        with self.lock:
            before = self.store.get(project, id)
            if before['status'] != 'pending': raise Conflict('only pending memories can be reclassified')
            result = self.service.judge(project, id)
            proposal = result.get('proposal', {})
            category = proposal.get('category', before['category'])
            if category not in CATEGORIES: raise InvalidInput('invalid category from classifier')
            risky = proposal.get('sensitive') or proposal.get('instruction_like') or result.get('instruction_like')
            destination = 'review' if risky or result['mode'] == 'failed_closed' else ('transient' if proposal.get('durability') == 'ephemeral' else category)
            route = dict(result, category=category, destination=destination, updated=now(), approval='user_required')
            with self.store.connect() as c:
                c.execute('BEGIN IMMEDIATE')
                current = self.store._get(c, project, id)
                if current['status'] != 'pending' or current['digest'] != before['digest']:
                    raise Conflict('memory changed during classification; retry')
                if current['category'] != category:
                    c.execute('UPDATE memories SET category=?,version=version+1,updated=? WHERE id=?', (category, now(), id))
                    self.store._outbox(c, id, current['version'] + 1)
                c.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', ('memora.route.' + id, json.dumps(route, ensure_ascii=False)))
                self.store._audit(c, id, 'classify:' + destination, current['digest'], 'memora')
            self.store.flush()
            return route

    def queue(self, project, status='pending', cursor=None):
        page = self.store.page(project, status=status, limit=50, cursor=cursor)
        with self.store.connect() as c:
            for item in page['items']:
                row = c.execute('SELECT value FROM meta WHERE key=?', ('memora.route.' + item['id'],)).fetchone()
                item['classification'] = json.loads(row[0]) if row else None
        return page

    def review(self, project, id, action):
        with self.lock:
            memory = self.store.review(project, id, action, actor='memora-user')
            export = self.store.flush()
            index = {'mode': 'not_requested'}
            if memory['status'] == 'approved':
                try: index = self.service.index(project)
                except MemoraError as e: index = {'mode': 'pending_retry', 'error': e.to_dict()['error']}
            return {'memory': memory, 'export': export, 'index': index}

    def set_category(self, project, id, category):
        if category not in CATEGORIES: raise InvalidInput('invalid memory category')
        with self.lock, self.store.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            current = self.store._get(c, project, id)
            if current['status'] != 'pending': raise Conflict('edit the category before approving')
            c.execute('UPDATE memories SET category=?,version=version+1,updated=? WHERE id=?', (category, now(), id))
            route = {'mode': 'user', 'category': category, 'destination': category, 'updated': now(), 'approval': 'user_required'}
            c.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', ('memora.route.' + id, json.dumps(route)))
            self.store._outbox(c, id, current['version'] + 1)
            self.store._audit(c, id, 'classify:user:' + category, current['digest'], 'memora-user')
        self.store.flush()
        return route

    def recall(self, project, query, mode='auto', limit=10, tier='project', session_id=None):
        with self.lock:
            return self.service.recall(project, query, mode=mode, limit=limit, record_access=True,
                                       tier=tier, session_id=session_id)

    def scopes(self, project, session_id=None):
        """The four-rung scope ladder and what each rung currently holds.

        Counts are read from the same database retrieval uses, so the numbers the UI shows and the
        rows a search can return never disagree. `visible_count` is cumulative — a project read sees
        global + workspace + project — which is exactly what scopes_for() returns.
        """
        from . import scopes as scopes_mod
        ladder = scopes_mod.describe(project, session_id=session_id)
        with self.store.connect() as c:
            def count(names, pinned=None, statuses=('approved',)):
                names = [n for n in names if n]
                if not names: return 0
                marks = ','.join('?' * len(names))
                sql = (f'SELECT count(*) FROM memories WHERE project IN ({marks}) '
                       f'AND status IN ({",".join("?" * len(statuses))})')
                args = names + list(statuses)
                if pinned:
                    # Conversation rows are project rows carrying this session_id; the wider rungs
                    # are unaffected by the pin, so they stay counted in full.
                    sql += ' AND (session_id=? OR project!=?)'
                    args.extend([pinned, project])
                return c.execute(sql, args).fetchone()[0]
            for entry in ladder['tiers']:
                plan = scopes_mod.scopes_for(project, entry['id'], session_id=session_id)
                entry['count'] = count(plan['projects'], plan['session_id'])
                entry['projects'] = plan['projects']
                if plan['session_id']:
                    entry['session_count'] = c.execute(
                        'SELECT count(*) FROM memories WHERE project=? AND session_id=?',
                        (project, plan['session_id'])).fetchone()[0]
            ladder['project_count'] = count([project])
            ladder['sessions'] = [
                dict(row) for row in c.execute(
                    'SELECT session_id, count(*) AS memories FROM memories '
                    'WHERE project=? AND session_id IS NOT NULL GROUP BY session_id '
                    'ORDER BY memories DESC LIMIT 50', (project,)).fetchall()]
        return ladder

    def brain(self, project):
        from .projections import brain
        return brain(self, project)

    def graph(self, project):
        graph = self.store.graph(scope(project), limit=1000)
        visible = {n['id'] for n in graph['nodes']}
        return dict(graph, hierarchy=[h for h in self.control.hierarchy(project) if h['parent'] in visible and h['child'] in visible])

    def document_index(self, project, slug, audience='human', version=None):
        from . import ingest
        revision = self.documents.read(project, slug, audience, version)
        target = self.documents.export(revision)
        result = ingest.import_file(self.store, project, target, f"memora-document:{revision['id']}:{audience}:v{revision['version']}", actor='memora', approve=False)
        self.store.flush()
        return result
