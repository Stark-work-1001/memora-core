# -*- coding: utf-8 -*-
"""模型网关：chat / embedding / reranker / judge 四种角色 + 秘密存储 + 调用留痕 + 显式降级。

设计铁律（见 docs/ARCHITECTURE.md §4.4 §8）：

1. **绝不伪造**。任何失败都抛 ModelUnavailable；本模块不会返回零向量、假 embedding
   或编造的 JSON。上层（retrieval / workflows / judge）拿到异常后自行走确定性降级，
   并把 degraded=true 暴露到界面。
2. **只用标准库**。HTTP 走 urllib.request，加密只做「避免明文落盘」级别的实现。
3. **每次调用留痕**。无论成功失败都写一条 model_call（role/provider/model/ok/http_status/
   latency_ms/tokens/error/degraded）。

存储优先级：store 提供 _model_conn()/con/db_path 时直接复用；否则自建 sqlite3 连接。
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import hmac
import json
import math
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .paths import Paths, package_dir

__all__ = [
    "ROLES",
    "PROVIDERS",
    "ModelUnavailable",
    "JudgeFormatError",
    "SecretBox",
    "ModelProfile",
    "ModelGateway",
    "estimate_tokens",
    "parse_json_payload",
    "render_prompt",
    "load_prompt",
]

ROLES = ("chat", "embedding", "reranker", "judge", "extractor", "vision")
PROVIDERS = ("openai", "openai-compatible", "dashscope", "deepseek", "ollama", "none")

#: 重试策略默认值：网络错误与 5xx 重试 2 次，指数退避 0.5s / 1.5s
DEFAULT_RETRIES = 2
DEFAULT_BACKOFF = (0.5, 1.5)
DEFAULT_TIMEOUT_MS = 60000
DEFAULT_BATCH = 16

#: 交互式调用（检索）：不重试，单次请求超时 ≤ INTERACTIVE_TIMEOUT_MS，整段 ≤ INTERACTIVE_BUDGET_MS。
#: 1.0.0 没有这层，挂死的端点让一次检索等 3 次重试 × (pool embed + query embed + rerank) + 退避。
INTERACTIVE_TIMEOUT_MS = 4000
INTERACTIVE_BUDGET_MS = 8000
#: 熔断：某角色出现传输层失败（超时 / 连不上 / 5xx / 429）后，冷却期内直接判不可用、不发请求。
BREAKER_COOLDOWN_S = 60.0

# 熔断状态按 (数据库, 角色, 档位身份) 放在模块级：服务端 / MCP 会多次构造网关，状态不能丢。
_BREAKERS: dict = {}
_BREAKER_LOCK = threading.Lock()


# ============================================================
# 异常
# ============================================================
class ModelUnavailable(RuntimeError):
    """模型不可用。携带 role / 原因 / 是否可重试，便于上层决定降级还是重试。"""

    def __init__(self, role, reason, *, retryable=False, provider=None, model=None,
                 http_status=None, detail=""):
        self.role = role
        self.reason = reason
        self.retryable = bool(retryable)
        self.provider = provider
        self.model = model
        self.http_status = http_status
        self.detail = detail
        super().__init__("[%s/%s] %s" % (role, provider or "-", reason))

    def as_dict(self) -> dict:
        return {
            "role": self.role,
            "reason": self.reason,
            "retryable": self.retryable,
            "provider": self.provider,
            "model": self.model,
            "http_status": self.http_status,
        }


class JudgeFormatError(ValueError):
    """模型返回的内容无法解析成约定的 JSON。**不允许**用猜测值兜底。"""

    def __init__(self, message, *, role="judge", raw="", provider=None, model=None):
        self.role = role
        self.raw = raw
        self.provider = provider
        self.model = model
        super().__init__("%s (raw=%r)" % (message, (raw or "")[:400]))

    def as_dict(self) -> dict:
        return {"role": self.role, "error": str(self), "raw": (self.raw or "")[:2000]}


# ============================================================
# 秘密存储
# ============================================================
class SecretKeyUnavailable(ValueError):
    """主密钥读不出来：文件损坏，或是另一台电脑 / 另一个 Windows 用户用 DPAPI 封装的。"""


_DPAPI_MAGIC = b"MKDPAPI1"


def _dpapi(data: bytes, protect: bool) -> bytes | None:
    """Windows DPAPI（当前用户范围）加解密；非 Windows 或调用失败返回 None。只用 ctypes。"""
    if os.name != "nt":
        return None
    try:
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None

    class _Blob(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    try:
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
        fn.argtypes = [ctypes.POINTER(_Blob), wintypes.LPCWSTR, ctypes.POINTER(_Blob),
                       ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
        fn.restype = wintypes.BOOL
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        buffer = ctypes.create_string_buffer(bytes(data), len(data))
        blob_in = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
        blob_out = _Blob()
        description = "memora-core master key" if protect else None
        if not fn(ctypes.byref(blob_in), description, None, None, None, 0x1, ctypes.byref(blob_out)):
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData)
        finally:
            kernel32.LocalFree(ctypes.cast(blob_out.pbData, ctypes.c_void_p))
    except Exception:  # noqa: BLE001
        return None


class SecretBox:
    """把密钥加密后写进 secret(key, cipher, hint, updated_at)。

    **这不是军规级加密**。它是「避免明文落盘」级别：
      - master key 首次生成 32 字节随机数，写入 data/master.key。1.1.0 起在 Windows 上用 DPAPI
        封装（文件以 MKDPAPI1 开头，绑定当前 Windows 用户）：把 data/ 拷到别的电脑或别的用户，
        已保存的 API key 需要重新填写；1.0.0 留下的 32 字节明文主密钥照常可用、不被改写；
      - 记录密钥 k_i = HMAC-SHA256(master, b"MEMORA-SECRETS-V1|" + i)
        与明文字节流异或（计数器模式流密码）；
      - 随机 16 字节 nonce 参与每条密钥的派生，同一明文每次密文不同；
      - 用 HMAC-SHA256 做完整性校验，篡改密文导致 get_secret 直接报错；
      - 没有认证密钥交换、没有 KDF 抗暴力（master 本身就是 32 字节随机数）、
        没有内存清零保护 —— 因此拿到 data/ 目录的本地攻击者仍可解密。

    它防的是：密钥明文出现在数据库、备份、日志、导出文件和 git 里。
    """

    MAGIC = "mbx1"
    AUTH_LABEL = b"MEMORA-SECRETS-AUTH-V1"

    def __init__(self, paths: Paths):
        self.paths = paths
        self.key_path = Path(paths.root) / "master.key"
        self._key: bytes | None = None

    # -- master key ------------------------------------------------
    def _master(self) -> bytes:
        """读（或首次创建）主密钥。

        1.0.0 的两个问题：长度不对的密钥文件会被**静默替换**（之前保存的全部密钥从此解不开，
        也没有任何提示）；两个进程第一次同时使用时会各写一把不同的钥匙，先写的那把加密的密钥作废。
        现在：已有文件绝不覆盖，读不出来就明确报错（SecretKeyUnavailable）；首次创建用独占创建，
        输掉竞争的一方读取对方的钥匙。
        """
        if self._key is not None:
            return self._key
        try:
            data = self.key_path.read_bytes()
        except FileNotFoundError:
            self._key = self._create_master()
            return self._key
        except OSError as exc:
            raise SecretKeyUnavailable("读不到 %s：%s" % (self.key_path.name, exc)) from exc
        self._key = self._parse_master(data)
        return self._key

    @staticmethod
    def _parse_master(data: bytes) -> bytes:
        if len(data) == 32:
            return data  # 1.0.0 的明文主密钥：照常可用
        if data.startswith(_DPAPI_MAGIC):
            plain = _dpapi(data[len(_DPAPI_MAGIC):], protect=False)
            if plain is not None and len(plain) == 32:
                return plain
            raise SecretKeyUnavailable(
                "master.key 由 Windows DPAPI 绑定在另一台电脑或另一个 Windows 用户上，这里解不开："
                "已保存的 API key 无法恢复，请在模型页重新填写")
        raise SecretKeyUnavailable(
            "master.key 损坏（%d 字节，应为 32 字节或 DPAPI 封装）：已保存的 API key 无法解密。"
            "文件保持原样、没有被改动；把它改名备份后重新填写 API key 即可" % len(data))

    def _create_master(self) -> bytes:
        key = os.urandom(32)
        wrapped = _dpapi(key, protect=True)
        payload = _DPAPI_MAGIC + wrapped if wrapped else key
        self.key_path.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        try:
            fd = os.open(str(self.key_path), flags, 0o600)
        except FileExistsError:
            # 另一个进程刚创建了它：等它写完，用它的钥匙
            data = b""
            for _ in range(40):
                data = self.key_path.read_bytes()
                if len(data) >= 32:
                    break
                time.sleep(0.05)
            return self._parse_master(data)
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        return key

    def _keystream(self, nonce: bytes, length: int) -> bytes:
        master = self._master()
        out = bytearray()
        counter = 0
        while len(out) < length:
            block = b"MEMORA-SECRETS-V1|" + nonce + counter.to_bytes(8, "big")
            out.extend(hmac.new(master, block, hashlib.sha256).digest())
            counter += 1
        return bytes(out[:length])

    def _auth(self, nonce: bytes, body: bytes) -> bytes:
        master = self._master()
        return hmac.new(master, self.AUTH_LABEL + nonce + body, hashlib.sha256).digest()[:16]

    # -- 对外 ------------------------------------------------------
    def encrypt(self, plaintext: str) -> str:
        if plaintext is None:
            raise ValueError("plaintext 不能为 None")
        raw = str(plaintext).encode("utf-8")
        nonce = os.urandom(16)
        body = bytes(a ^ b for a, b in zip(raw, self._keystream(nonce, len(raw))))
        tag = self._auth(nonce, body)
        blob = self.MAGIC.encode("ascii") + nonce + tag + body
        return base64.b64encode(blob).decode("ascii")

    def decrypt(self, cipher: str) -> str:
        try:
            blob = base64.b64decode((cipher or "").encode("ascii"), validate=True)
        except Exception as exc:  # noqa: BLE001 - 任何解码失败都算密文损坏
            raise ValueError("密文不是合法 base64：%s" % exc) from exc
        if len(blob) < 4 + 16 + 16 or blob[:4] != self.MAGIC.encode("ascii"):
            raise ValueError("密文格式不匹配（可能被截断或来自其它版本）")
        nonce = blob[4:20]
        tag = blob[20:36]
        body = blob[36:]
        if not hmac.compare_digest(tag, self._auth(nonce, body)):
            raise ValueError("密文完整性校验失败：密钥文件变更或密文被篡改")
        raw = bytes(a ^ b for a, b in zip(body, self._keystream(nonce, len(body))))
        return raw.decode("utf-8", "strict")


def secret_hint(plaintext: str) -> str:
    """只回显后 4 位，API 永不返回明文。"""
    text = "" if plaintext is None else str(plaintext)
    return ("****" + text[-4:]) if len(text) > 4 else "****"


# ============================================================
# 工具函数
# ============================================================
def estimate_tokens(text) -> int:
    """没有 usage 时的保守估算：CJK 字符按 1 token，其余按 1 token / 4 字符。"""
    if text is None:
        return 0
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    return max(0, cjk) + max(0, (len(text) - cjk) // 4)


def _strip_fences(text: str) -> str:
    s = (text or "").strip()
    if "```" not in s:
        return s
    out = []
    in_fence = False
    for line in s.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            out.append(line)
    return "\n".join(out).strip() if out else s


def _balanced_span(text: str, open_ch: str, close_ch: str):
    """返回第一个平衡块 (start, end_after)；跳过字符串内的括号。"""
    start = text.find(open_ch)
    while start != -1:
        depth = 0
        in_str = False
        quote = ""
        esc = False
        for idx in range(start, len(text)):
            ch = text[idx]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == quote:
                    in_str = False
                continue
            if ch in ('"', "'"):
                in_str = True
                quote = ch
            elif ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    return start, idx + 1
        start = text.find(open_ch, start + 1)
    return None


def parse_json_payload(text, *, role="judge", expect: type | tuple = dict):
    """容错解析模型返回的 JSON：剥离 markdown 围栏 → 截取第一个平衡 {} / [] 块。

    解析不出来抛 JudgeFormatError —— 绝不返回猜测值。
    """
    raw = "" if text is None else str(text)
    if isinstance(text, (dict, list)):
        return text
    body = _strip_fences(raw)
    candidates = [body]
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        span = _balanced_span(body, open_ch, close_ch)
        if span:
            candidates.append(body[span[0]:span[1]])
    for chunk in candidates:
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            value = json.loads(chunk)
        except ValueError:
            continue
        if expect is not None and not isinstance(value, expect):
            continue
        return value
    raise JudgeFormatError("模型返回的不是预期 JSON", role=role, raw=raw)


def render_prompt(template: str, **variables) -> str:
    """把 {{var}} 替换成变量值；未提供的变量渲染为空串，不做二次解析。"""
    text = template or ""
    for key, value in variables.items():
        if isinstance(value, (dict, list, tuple)):
            value = json.dumps(value, ensure_ascii=False)
        text = text.replace("{{%s}}" % key, "" if value is None else str(value))
    return text


def load_prompt(name: str, default: str = "") -> str:
    """读取 data/builtin/prompts.json 里的模板（每次重新读，便于用户热改）。"""
    path = package_dir() / "data" / "builtin" / "prompts.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default
    value = data.get(name)
    return value if isinstance(value, str) else default


def _as_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _now_ms() -> float:
    return time.time() * 1000.0


# ============================================================
# 档位
# ============================================================
class ModelProfile:
    """model_profile 一行。"""

    __slots__ = ("id", "role", "label", "provider", "model", "base_url", "api_key_ref",
                 "dim", "batch", "timeout_ms", "params", "priority", "enabled", "created_at")

    def __init__(self, row: dict):
        get = row.get
        self.id = str(get("id") or "")
        self.role = str(get("role") or "")
        self.label = get("label") or ""
        self.provider = str(get("provider") or "openai")
        self.model = str(get("model") or "")
        self.base_url = (get("base_url") or "").rstrip("/")
        self.api_key_ref = get("api_key_ref") or ""
        self.dim = int(get("dim") or 0)
        self.batch = int(get("batch") or DEFAULT_BATCH)
        self.timeout_ms = int(get("timeout_ms") or DEFAULT_TIMEOUT_MS)
        self.params = get("params")
        if isinstance(self.params, str):
            try:
                self.params = json.loads(self.params or "{}")
            except ValueError:
                self.params = {}
        if not isinstance(self.params, dict):
            self.params = {}
        self.priority = int(get("priority") or 0)
        self.enabled = _as_bool(get("enabled") if get("enabled") is not None else 1)
        self.created_at = get("created_at") or ""

    def to_dict(self, *, with_secret=False, hint=None) -> dict:
        out = {
            "id": self.id, "role": self.role, "label": self.label, "provider": self.provider,
            "model": self.model, "base_url": self.base_url, "api_key_ref": self.api_key_ref,
            "dim": self.dim, "batch": self.batch, "timeout_ms": self.timeout_ms,
            "params": dict(self.params), "priority": self.priority, "enabled": self.enabled,
            "created_at": self.created_at,
        }
        if with_secret:
            out["hint"] = hint
        return out

    def __repr__(self):  # pragma: no cover - debug
        return "<ModelProfile %s %s/%s>" % (self.role, self.provider, self.model)


# ============================================================
# 网关
# ============================================================
class ModelGateway:
    """从 model_profile + 加密密钥读取配置，按 role 调用云端模型。"""

    def __init__(self, store=None, *, db_path=None, data_dir=None, retries=DEFAULT_RETRIES,
                 backoff=DEFAULT_BACKOFF, sleep=None, breaker_cooldown=BREAKER_COOLDOWN_S,
                 clock=None):
        self.store = store
        self._self_con = None
        self.paths = Paths(data_dir or self._infer_data_dir(db_path))
        if db_path is not None:
            self.db_path = Path(db_path)
        else:
            self.db_path = self.paths.db
        self.retries = int(retries)
        self.backoff = tuple(backoff)
        self._sleep = sleep or time.sleep
        self._box = SecretBox(self.paths)
        self._roles_cache = None
        self.breaker_cooldown = float(breaker_cooldown)
        self._clock = clock or time.monotonic
        self._tls = threading.local()

    # -- 快速失败与熔断 --------------------------------------------
    @contextlib.contextmanager
    def interactive(self, budget_ms=None, timeout_ms=None):
        """交互式调用（检索）的快速失败模式，作用于当前线程，可嵌套（取更紧的一层）：
        不重试；单次请求超时 ≤ timeout_ms；整段调用总预算 budget_ms，用完后余下的请求
        直接抛 ModelUnavailable，不再发出。"""
        prev = getattr(self._tls, "interactive", None)
        deadline = self._clock() + float(budget_ms or INTERACTIVE_BUDGET_MS) / 1000.0
        cap = float(timeout_ms or INTERACTIVE_TIMEOUT_MS) / 1000.0
        if prev:
            deadline = min(deadline, prev["deadline"])
            cap = min(cap, prev["cap"])
        self._tls.interactive = {"deadline": deadline, "cap": cap,
                                 "budget_ms": int(budget_ms or INTERACTIVE_BUDGET_MS)}
        try:
            yield self
        finally:
            self._tls.interactive = prev

    def _breaker_key(self, prof: "ModelProfile") -> tuple:
        return (str(self.db_path), prof.role, prof.id, prof.provider, prof.model, prof.base_url)

    def _breaker_check(self, prof: "ModelProfile") -> None:
        """熔断打开时直接抛 ModelUnavailable（不发请求、不记 model_call）。冷却期过后放行
        一次（半开）：成功则关闭，失败则重新打开。连通性测试（test()）不受熔断限制。"""
        if getattr(self._tls, "bypass_breaker", False):
            return
        with _BREAKER_LOCK:
            state = _BREAKERS.get(self._breaker_key(prof))
        if not state:
            return
        remaining = state["until"] - self._clock()
        if remaining <= 0:
            return
        exc = ModelUnavailable(
            prof.role, "熔断中：%.0f 秒内不再请求（%s 起，最近失败：%s）"
            % (remaining, state["opened_at"], state["reason"]),
            retryable=True, provider=prof.provider, model=prof.model)
        exc.no_call = True
        raise exc

    def _breaker_trip(self, prof: "ModelProfile", exc: "ModelUnavailable") -> None:
        if getattr(exc, "no_call", False) or getattr(exc, "budget_clipped", False):
            return      # 没发出请求，或超时是我们自己的预算截短的：不怪端点
        if not (exc.retryable or exc.http_status == 429):
            return      # 4xx（鉴权、参数）立即失败，不会挂住调用方，改好配置应马上生效
        key = self._breaker_key(prof)
        with _BREAKER_LOCK:
            prev = _BREAKERS.get(key) or {}
            _BREAKERS[key] = {"until": self._clock() + self.breaker_cooldown,
                              "reason": str(exc.reason)[:200], "opened_at": _utc_now(),
                              "failures": int(prev.get("failures") or 0) + 1}

    def _breaker_reset(self, prof: "ModelProfile") -> None:
        with _BREAKER_LOCK:
            _BREAKERS.pop(self._breaker_key(prof), None)

    def breaker_state(self, role) -> dict:
        """{open, retry_in_s, reason, opened_at, failures}；没有熔断记录时 open=False。"""
        prof = self.roles().get(role)
        if prof is None:
            return {"open": False}
        with _BREAKER_LOCK:
            state = dict(_BREAKERS.get(self._breaker_key(prof)) or {})
        if not state:
            return {"open": False}
        remaining = state["until"] - self._clock()
        return {"open": remaining > 0, "retry_in_s": round(max(0.0, remaining), 1),
                "reason": state.get("reason"), "opened_at": state.get("opened_at"),
                "failures": state.get("failures")}

    def _log_failure(self, role, prof, exc, started) -> None:
        """失败留痕；没有真正发出请求的失败（熔断、预算用完）不记 model_call。"""
        if getattr(exc, "no_call", False):
            return
        self.log_call(role, prof.provider, prof.model, False,
                      http_status=getattr(exc, "http_status", None),
                      latency_ms=_now_ms() - started,
                      error=getattr(exc, "reason", None) or str(exc), degraded=True)

    # -- 存储适配 --------------------------------------------------
    def _infer_data_dir(self, db_path):
        """没给 data_dir 时，从 db_path / store / 默认路径推断 data/ 根目录。"""
        if db_path is not None:
            return Path(db_path).parent
        for attr in ("data_dir", "root", "data_root"):
            value = getattr(self.store, attr, None)
            if value:
                return Path(value)
        for attr in ("db_path", "db", "path"):
            value = getattr(self.store, attr, None)
            if isinstance(value, (str, Path)) and str(value).endswith(".db"):
                return Path(value).parent
        return Paths().root

    def _db(self):
        """优先复用 store 的连接，其次 store.db_path，最后自建连接。"""
        if self.store is not None:
            for attr in ("_model_conn", "con", "conn", "connection"):
                getter = getattr(self.store, attr, None)
                if callable(getter) and attr.startswith("_model"):
                    try:
                        con = getter()
                    except Exception:  # noqa: BLE001
                        con = None
                    if isinstance(con, sqlite3.Connection):
                        return con, False
                elif isinstance(getter, sqlite3.Connection):
                    return getter, False
            for attr in ("db_path", "db", "path"):
                value = getattr(self.store, attr, None)
                if isinstance(value, (str, Path)) and str(value).endswith(".db"):
                    return self._open(Path(value)), True
        if self._self_con is None:
            self._self_con = self._open(self.db_path)
        return self._self_con, False

    @staticmethod
    def _open(path: Path) -> sqlite3.Connection:
        con = sqlite3.connect(str(path), timeout=15.0, check_same_thread=False,
                              isolation_level=None)
        con.row_factory = sqlite3.Row
        return con

    def _rows(self, sql, args=()):
        con, temp = self._db()
        try:
            return [dict(r) for r in con.execute(sql, args).fetchall()]
        except sqlite3.Error:
            return []
        finally:
            if temp:
                con.close()

    def _exec(self, sql, args=()):
        con, temp = self._db()
        try:
            con.execute(sql, args)
        except sqlite3.Error as exc:  # 表缺失/只读库都不应该让调用方崩
            if os.environ.get("MEMORA_DEBUG"):
                raise RuntimeError("model 存储写入失败: %s" % exc) from exc
        finally:
            if temp:
                con.close()

    def close(self):
        if self._self_con is not None:
            try:
                self._self_con.close()
            finally:
                self._self_con = None

    # -- 配置读取 --------------------------------------------------
    def reload(self):
        self._roles_cache = None
        return self.roles()

    def profiles(self, role=None) -> list[ModelProfile]:
        sql = "SELECT * FROM model_profile"
        args = ()
        if role:
            sql += " WHERE role=?"
            args = (role,)
        sql += " ORDER BY priority DESC, id ASC"
        return [ModelProfile(r) for r in self._rows(sql, args)]

    def roles(self) -> dict:
        """role -> 选中的 profile（按 priority 降序、enabled=1 的第一个）。"""
        if self._roles_cache is not None:
            return dict(self._roles_cache)
        chosen = {role: None for role in ROLES}
        for prof in self.profiles():
            if prof.role not in chosen or chosen[prof.role] is not None:
                continue
            if prof.enabled:
                chosen[prof.role] = prof
        for prof in self.profiles():
            if prof.role not in chosen and prof.enabled and chosen.get(prof.role) is None:
                chosen[prof.role] = prof
        self._roles_cache = chosen
        return dict(chosen)

    def profile(self, role) -> ModelProfile:
        prof = self.roles().get(role)
        if prof is None:
            raise ModelUnavailable(role, "未配置")
        if prof.provider == "none":
            raise ModelUnavailable(role, "该角色被显式禁用（provider=none）", provider="none",
                                   model=prof.model)
        if not prof.model:
            raise ModelUnavailable(role, "档位缺少 model 字段", provider=prof.provider)
        return prof

    # -- 秘密 ------------------------------------------------------
    def set_secret(self, key, value) -> str:
        """加密写入 secret 表，返回 hint（后 4 位）。API 层只应返回 hint。"""
        key = str(key or "").strip()
        if not key:
            raise ValueError("secret key 不能为空")
        cipher = self._box.encrypt(value)
        hint = secret_hint(value)
        self._exec(
            "INSERT INTO secret(key, cipher, hint, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET cipher=excluded.cipher, hint=excluded.hint, "
            "updated_at=excluded.updated_at",
            (key, cipher, hint, _utc_now()),
        )
        if not self._rows("SELECT 1 FROM secret WHERE key=?", (key,)):
            raise RuntimeError("密钥写入失败：secret 表不可写（key=%s）" % key)
        return hint

    def get_secret(self, key, default=None):
        rows = self._rows("SELECT cipher FROM secret WHERE key=?", (str(key or ""),))
        if not rows:
            return default
        try:
            return self._box.decrypt(rows[0]["cipher"])
        except ValueError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ValueError("密钥解密失败：%s" % exc) from exc

    def secret_hint(self, key) -> str:
        rows = self._rows("SELECT hint FROM secret WHERE key=?", (str(key or ""),))
        return (rows[0]["hint"] or "") if rows else ""

    def has_secret(self, key) -> bool:
        return bool(self._rows("SELECT 1 FROM secret WHERE key=?", (str(key or ""),)))

    def delete_secret(self, key) -> None:
        self._exec("DELETE FROM secret WHERE key=?", (str(key or ""),))

    def list_secrets(self) -> list[dict]:
        """只返回 key 与 hint，**永不**返回明文。"""
        return [{"key": r["key"], "hint": r.get("hint") or "", "updated_at": r.get("updated_at")}
                for r in self._rows("SELECT key, hint, updated_at FROM secret ORDER BY key")]

    def _api_key(self, prof: ModelProfile):
        ref = (prof.api_key_ref or "").strip()
        if not ref:
            return None
        if ref.startswith("env:"):
            return os.environ.get(ref[4:]) or None
        if ref.startswith("plain:"):
            return ref[6:]
        return self.get_secret(ref)

    # -- 留痕 ------------------------------------------------------
    def log_call(self, role, provider, model, ok, *, http_status=None, latency_ms=None,
                 prompt_tokens=None, completion_tokens=None, error=None, degraded=False,
                 run_id=None) -> str:
        call_id = uuid.uuid4().hex
        self._exec(
            "INSERT INTO model_call(id, role, provider, model, ok, http_status, latency_ms, "
            "prompt_tokens, completion_tokens, error, degraded, run_id, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (call_id, role, provider, model, 1 if ok else 0, http_status,
             int(latency_ms) if latency_ms is not None else None,
             int(prompt_tokens or 0), int(completion_tokens or 0),
             (error or "")[:1000] or None, 1 if degraded else 0, run_id, _utc_now()),
        )
        return call_id

    def calls(self, *, role=None, limit=50) -> list[dict]:
        sql = "SELECT * FROM model_call"
        args = ()
        if role:
            sql += " WHERE role=?"
            args = (role,)
        sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
        return self._rows(sql, args + (int(limit),))

    # -- HTTP ------------------------------------------------------
    def _request(self, prof: ModelProfile, url: str, payload, *, headers=None):
        """返回 (http_status, body_dict, latency_ms)。重试网络错误与 5xx，4xx 不重试。"""
        headers = dict(headers or {})
        headers.setdefault("Content-Type", "application/json")
        token = self._api_key(prof)
        if token:
            headers.setdefault("Authorization", "Bearer " + token)
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        timeout = max(1.0, prof.timeout_ms / 1000.0)
        attempts = self.retries + 1
        clipped = False     # 超时是被交互预算的剩余时间截短的（不是端点本身慢到 cap）
        mode = getattr(self._tls, "interactive", None)
        if mode:
            remaining = mode["deadline"] - self._clock()
            if remaining <= 0.05:
                exc = ModelUnavailable(
                    prof.role, "交互式调用预算（%d ms）已用完，未发出请求" % mode["budget_ms"],
                    retryable=False, provider=prof.provider, model=prof.model)
                exc.no_call = True
                raise exc
            attempts = 1
            full = min(timeout, mode["cap"])
            timeout = max(0.05, min(full, remaining))
            clipped = timeout < full
        last = None
        for attempt in range(attempts):
            started = _now_ms()
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read()
                    status = getattr(resp, "status", 200)
                    latency = _now_ms() - started
                    try:
                        body = json.loads(raw.decode("utf-8", "replace") or "null")
                    except ValueError:
                        body = {"_raw": raw.decode("utf-8", "replace")}
                    return status, body, latency
            except urllib.error.HTTPError as exc:
                latency = _now_ms() - started
                detail = ""
                try:
                    detail = exc.read().decode("utf-8", "replace")
                except Exception:  # noqa: BLE001
                    detail = ""
                if 400 <= exc.code < 500:
                    raise ModelUnavailable(
                        prof.role, "HTTP %d：%s" % (exc.code, (detail or exc.reason or "")[:300]),
                        retryable=False, provider=prof.provider, model=prof.model,
                        http_status=exc.code, detail=detail[:1000],
                    ) from exc
                last = ModelUnavailable(
                    prof.role, "HTTP %d：%s" % (exc.code, (detail or exc.reason or "")[:300]),
                    retryable=True, provider=prof.provider, model=prof.model,
                    http_status=exc.code, detail=detail[:1000],
                )
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
                latency = _now_ms() - started
                reason = str(getattr(exc, "reason", exc)) or exc.__class__.__name__
                timed_out = "timeout" in reason.lower() or "timed out" in reason.lower()
                last = ModelUnavailable(
                    prof.role, ("请求超时：" if timed_out else "网络错误：") + reason[:300],
                    retryable=True, provider=prof.provider, model=prof.model,
                )
                if timed_out and clipped:
                    last.reason = "交互式调用预算用完（%.1f 秒内未返回）" % timeout
                    last.budget_clipped = True
            if attempt < attempts - 1:
                delay = self.backoff[min(attempt, len(self.backoff) - 1)]
                self._sleep(delay)
        assert last is not None
        raise last

    # -- URL 与协议 ------------------------------------------------
    @staticmethod
    def _join(base: str, path: str) -> str:
        base = (base or "").rstrip("/")
        if not path.startswith("/"):
            path = "/" + path
        return base + path

    def _endpoints(self, prof: ModelProfile, kind: str) -> list[str]:
        """按 provider 给候选 URL 列表（依次尝试，前一个 404 再试后一个）。"""
        base = prof.base_url
        provider = (prof.provider or "openai").lower()
        if provider in ("dashscope", "aliyun", "bailian"):
            if kind == "chat":
                return [self._join(base, "/compatible-mode/v1/chat/completions")]
            if kind == "embedding":
                return [self._join(base, "/compatible-mode/v1/embeddings")]
            if kind == "rerank":
                return [self._join(base, "/api/v1/services/rerank/text-rerank/text-rerank")]
            return [self._join(base, "/compatible-mode/v1/chat/completions")]
        if provider == "ollama":
            if kind == "chat":
                return [self._join(base, "/api/chat")]
            if kind == "embedding":
                return [self._join(base, "/api/embed")]
            if kind == "rerank":
                return [self._join(base, "/api/rerank"), self._join(base, "/v1/rerank")]
            return [self._join(base, "/api/chat")]
        # openai / openai-compatible / deepseek / custom
        if kind == "chat":
            return [self._join(base, "/v1/chat/completions")]
        if kind == "embedding":
            return [self._join(base, "/v1/embeddings")]
        if kind == "rerank":
            return [self._join(base, "/v1/rerank"), self._join(base, "/rerank")]
        return [self._join(base, "/v1/chat/completions")]

    def _post(self, prof: ModelProfile, kind: str, payload) -> tuple:
        """按候选 URL 依次尝试；404/405 视为「该端点不存在」继续下一个。"""
        urls = self._endpoints(prof, kind)
        last = None
        for url in urls:
            try:
                return self._request(prof, url, payload)
            except ModelUnavailable as exc:
                last = exc
                if exc.http_status in (404, 405) and url != urls[-1]:
                    continue
                raise
        assert last is not None
        raise last

    @staticmethod
    def _extract_text(body) -> str:
        """从 chat 响应中取文本；取不到抛 ValueError 由调用方转 ModelUnavailable。"""
        if not isinstance(body, dict):
            raise ValueError("响应不是 JSON 对象")
        if "choices" in body and body["choices"]:
            choice = body["choices"][0] or {}
            msg = choice.get("message") or {}
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, str):
                    return content
                if isinstance(content, list):
                    parts = [p.get("text", "") for p in content if isinstance(p, dict)]
                    joined = "".join(parts)
                    if joined:
                        return joined
            if isinstance(choice.get("text"), str):
                return choice["text"]
        if isinstance(body.get("response"), str):
            return body["response"]
        if isinstance(body.get("message"), dict) and isinstance(body["message"].get("content"), str):
            return body["message"]["content"]
        if isinstance(body.get("output"), dict):
            parts = body["output"].get("text")
            if isinstance(parts, str):
                return parts
        if isinstance(body.get("output_text"), str):
            return body["output_text"]
        raise ValueError("响应里没有可用的文本内容")

    @staticmethod
    def _usage(body) -> tuple:
        usage = (body or {}).get("usage") or {}
        pin = usage.get("prompt_tokens", usage.get("input_tokens"))
        pout = usage.get("completion_tokens", usage.get("output_tokens"))
        return (int(pin) if isinstance(pin, (int, float)) else None,
                int(pout) if isinstance(pout, (int, float)) else None)

    # -- 四个能力 --------------------------------------------------
    def chat(self, messages, role="chat", max_tokens=1024, temperature=0.2,
             json_mode=False) -> str:
        prof = self.profile(role)
        self._breaker_check(prof)
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        payload = {
            "model": prof.model,
            "messages": list(messages),
            "temperature": float(temperature),
            "max_tokens": int(max_tokens),
        }
        payload.update({k: v for k, v in (prof.params or {}).items()
                        if k in ("top_p", "top_k", "stop", "seed", "frequency_penalty",
                                 "presence_penalty")})
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        started = _now_ms()
        try:
            status, body, latency = self._post(prof, "chat", payload)
            text = self._extract_text(body)
        except ModelUnavailable as exc:
            self._log_failure(role, prof, exc, started)
            self._breaker_trip(prof, exc)
            raise
        except ValueError as exc:
            self.log_call(role, prof.provider, prof.model, False, latency_ms=_now_ms() - started,
                          error=str(exc), degraded=True)
            raise ModelUnavailable(role, "响应解析失败：%s" % exc, provider=prof.provider,
                                   model=prof.model) from exc
        pin, pout = self._usage(body)
        self._breaker_reset(prof)
        self.log_call(role, prof.provider, prof.model, True, http_status=status,
                      latency_ms=latency,
                      prompt_tokens=pin if pin is not None else estimate_tokens(
                          json.dumps(messages, ensure_ascii=False)),
                      completion_tokens=pout if pout is not None else estimate_tokens(text))
        return text

    def embed(self, texts, role="embedding", batch=None) -> list:
        """批量向量化；默认 batch=16，**强制 L2 归一化**。失败抛 ModelUnavailable。"""
        prof = self.profile(role)
        self._breaker_check(prof)
        single = isinstance(texts, str)
        items = [texts] if single else list(texts or [])
        if not items:
            return []
        if not all(isinstance(t, str) for t in items):
            raise TypeError("embed 只接受字符串或字符串列表")
        size = int(batch or prof.batch or DEFAULT_BATCH)
        size = max(1, size)
        vectors: list = []
        for start in range(0, len(items), size):
            chunk = items[start:start + size]
            payload = {"model": prof.model, "input": chunk}
            extra = (prof.params or {}).get("dimensions") or (prof.params or {}).get("dim")
            if extra:
                payload["dimensions"] = int(extra)
            if (prof.provider or "").lower() == "dashscope":
                payload["input"] = chunk
                payload["encoding_format"] = "float"
            started = _now_ms()
            try:
                status, body, latency = self._post(prof, "embedding", payload)
                got = self._extract_embeddings(body, len(chunk))
            except ModelUnavailable as exc:
                self._log_failure(role, prof, exc, started)
                self._breaker_trip(prof, exc)
                raise
            except ValueError as exc:
                self.log_call(role, prof.provider, prof.model, False,
                              latency_ms=_now_ms() - started, error=str(exc), degraded=True)
                raise ModelUnavailable(role, "向量响应不合法：%s" % exc, provider=prof.provider,
                                       model=prof.model) from exc
            pin, _pout = self._usage(body)
            self._breaker_reset(prof)
            self.log_call(role, prof.provider, prof.model, True, http_status=status,
                          latency_ms=latency,
                          prompt_tokens=pin if pin is not None else sum(
                              estimate_tokens(t) for t in chunk),
                          completion_tokens=0)
            vectors.extend(got)
        if prof.dim and vectors and len(vectors[0]) != prof.dim:
            raise ModelUnavailable(role, "向量维度 %d 与档位声明 dim=%d 不一致"
                                   % (len(vectors[0]), prof.dim), provider=prof.provider,
                                   model=prof.model)
        return vectors[0] if single else vectors

    @staticmethod
    def _extract_embeddings(body, expected: int) -> list:
        if not isinstance(body, dict):
            raise ValueError("响应不是 JSON 对象")
        rows = body.get("data")
        if rows is None and isinstance(body.get("embeddings"), list):
            rows = [{"embedding": e} for e in body["embeddings"]]
        if rows is None and isinstance(body.get("output"), dict):
            rows = [{"embedding": e} for e in (body["output"].get("embeddings") or [])]
        if not isinstance(rows, list) or len(rows) != expected:
            raise ValueError("期望 %d 条向量，实际 %s"
                             % (expected, len(rows) if isinstance(rows, list) else "无"))
        out = []
        for row in rows:
            vec = row.get("embedding") if isinstance(row, dict) else row
            if not isinstance(vec, list) or not vec:
                raise ValueError("向量为空或不是数组")
            floats = []
            for value in vec:
                if not isinstance(value, (int, float)) or math.isnan(float(value)):
                    raise ValueError("向量包含非数值或 NaN")
                floats.append(float(value))
            out.append(_l2_normalize(floats))
        return out

    def rerank(self, query, docs, top_k=20, role="reranker") -> list:
        """返回 [(index, score)] 降序；不支持 rerank 的端点抛 ModelUnavailable。"""
        prof = self.profile(role)
        self._breaker_check(prof)
        items = [d if isinstance(d, str) else json.dumps(d, ensure_ascii=False)
                 for d in (docs or [])]
        if not items:
            return []
        provider = (prof.provider or "openai").lower()
        if provider == "dashscope":
            payload = {"model": prof.model,
                       "input": {"query": query, "documents": items},
                       "parameters": {"return_documents": False,
                                      "top_n": int(top_k or len(items))}}
        else:
            payload = {"model": prof.model, "query": query, "documents": items,
                       "top_n": int(top_k or len(items))}
        started = _now_ms()
        try:
            status, body, latency = self._post(prof, "rerank", payload)
            pairs = self._extract_rerank(body, len(items))
        except ModelUnavailable as exc:
            self._log_failure(role, prof, exc, started)
            self._breaker_trip(prof, exc)
            raise
        except ValueError as exc:
            self.log_call(role, prof.provider, prof.model, False, latency_ms=_now_ms() - started,
                          error=str(exc), degraded=True)
            raise ModelUnavailable(role, "重排响应不合法：%s" % exc, provider=prof.provider,
                                   model=prof.model) from exc
        pin, _pout = self._usage(body)
        self._breaker_reset(prof)
        self.log_call(role, prof.provider, prof.model, True, http_status=status,
                      latency_ms=latency,
                      prompt_tokens=pin if pin is not None else estimate_tokens(query) + sum(
                          estimate_tokens(d) for d in items),
                      completion_tokens=0)
        return pairs[:int(top_k or len(pairs))] if top_k else pairs

    @staticmethod
    def _extract_rerank(body, count: int) -> list:
        if not isinstance(body, dict):
            raise ValueError("响应不是 JSON 对象")
        # DashScope 原生重排把结果放在 output.results，OpenAI 兼容放在顶层 results
        rows = body.get("results")
        if rows is None and isinstance(body.get("output"), dict):
            rows = body["output"].get("results")
        if rows is None and isinstance(body.get("data"), list):
            rows = body["data"]
        if not isinstance(rows, list):
            raise ValueError("响应缺少 results 数组")
        if isinstance(rows, list) and not rows and isinstance(body.get("output"), list):
            rows = body["output"]
        pairs = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            idx = row.get("index", row.get("document_index"))
            score = row.get("relevance_score", row.get("score"))
            if idx is None or score is None:
                continue
            idx = int(idx)
            if 0 <= idx < count:
                pairs.append((idx, float(score)))
        if not pairs:
            raise ValueError("results 为空或缺少 index/score")
        pairs.sort(key=lambda p: -p[1])
        return pairs

    def judge(self, prompt, schema_hint="", role="judge") -> dict:
        """调用 judge 角色并解析 JSON；解析失败抛 JudgeFormatError（绝不猜）。"""
        system = ("你是严格的判定器。只输出 JSON 对象，不要解释、不要 markdown 围栏。"
                  + ((" 期望结构：" + schema_hint) if schema_hint else ""))
        text = self.chat([{"role": "system", "content": system},
                          {"role": "user", "content": prompt}],
                         role=role, temperature=0.0, json_mode=True)
        prof = self.roles().get(role)
        try:
            return parse_json_payload(text, role=role, expect=dict)
        except JudgeFormatError:
            raise JudgeFormatError("判定模型返回的 JSON 无法解析", role=role, raw=text,
                                   provider=getattr(prof, "provider", None),
                                   model=getattr(prof, "model", None)) from None

    # -- 测试与健康 ------------------------------------------------
    def test(self, profile_id) -> dict:
        """连通性测试，写 model_call。返回 {ok, mode, detail, latency_ms}。"""
        rows = self._rows("SELECT * FROM model_profile WHERE id=?", (str(profile_id),))
        if not rows:
            return {"ok": False, "mode": "unknown", "detail": "档位不存在", "latency_ms": 0}
        prof = ModelProfile(rows[0])
        started = _now_ms()
        prev_bypass = getattr(self._tls, "bypass_breaker", False)
        self._tls.bypass_breaker = True      # 用户主动测连通性：不受熔断限制，成功即关闭熔断
        try:
            if prof.role in ("embedding",):
                vectors = self.embed(["ping"], role=prof.role)
                ok, mode, detail = True, "embedding", "维度 %d" % len(vectors[0])
            elif prof.role in ("reranker",):
                pairs = self.rerank("ping", ["ping", "pong"], top_k=2, role=prof.role)
                ok, mode, detail = True, "rerank", "返回 %d 条" % len(pairs)
            else:
                text = self.chat([{"role": "user", "content": "只回复 ok"}],
                                 role=prof.role, max_tokens=16, temperature=0.0)
                ok, mode, detail = True, "chat", (text or "")[:80]
        except ModelUnavailable as exc:
            ok, mode, detail = False, exc.role, exc.reason
        except (JudgeFormatError, ValueError) as exc:
            ok, mode, detail = False, prof.role, str(exc)[:300]
        finally:
            self._tls.bypass_breaker = prev_bypass
        return {"ok": ok, "mode": mode, "detail": detail,
                "latency_ms": int(_now_ms() - started), "provider": prof.provider,
                "model": prof.model}

    def health(self) -> dict:
        """每个 role 返回 {configured, model, provider, ok, degraded, last_error, calls_24h,
        avg_latency_ms}，0 配置 / 部分配置 / 全配置结构一致。

        熔断打开期间该角色 ok=false、degraded=true，last_error 写明"熔断中（N 秒后重试）：原因"；
        完整熔断状态见 breaker_state(role) 与 status()["circuits"]。"""
        window = "strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours')"
        counters = {}
        for row in self._rows(
                "SELECT role, count(*) AS n, sum(CASE WHEN ok=0 THEN 1 ELSE 0 END) AS fails, "
                "avg(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avg_ms, "
                "max(CASE WHEN ok=0 THEN created_at END) AS last_fail_at "
                "FROM model_call WHERE created_at >= %s GROUP BY role" % window):
            counters[row.get("role") or ""] = row
        errors = {}
        for row in self._rows(
                "SELECT role, error, created_at FROM model_call WHERE ok=0 AND error IS NOT NULL "
                "AND created_at >= %s ORDER BY created_at DESC" % window):
            errors.setdefault(row.get("role") or "", row.get("error"))

        roles = self.roles()
        out = {}
        for role in ROLES:
            prof = roles.get(role)
            stat = counters.get(role) or {}
            calls = int(stat.get("n") or 0)
            fails = int(stat.get("fails") or 0)
            disabled = prof is not None and prof.provider == "none"
            configured = bool(prof) and not disabled and bool(prof.model)
            last_error = None
            if prof is None:
                last_error = "未配置"
            elif disabled:
                last_error = "该角色被显式禁用（provider=none）"
            elif calls and fails:
                last_error = errors.get(role) or (stat.get("last_fail_at") and "最近调用失败")
            elif calls == 0 and configured:
                last_error = None
            circuit = self.breaker_state(role) if configured else {"open": False}
            if circuit.get("open"):
                last_error = "熔断中（%.0f 秒后重试）：%s" % (circuit.get("retry_in_s") or 0,
                                                       circuit.get("reason") or "")
            out[role] = {
                "configured": configured,
                "model": prof.model if prof else None,
                "provider": prof.provider if prof else None,
                "ok": configured and not (calls and fails == calls) and not circuit.get("open"),
                "degraded": (not configured) or bool(calls and fails) or bool(circuit.get("open")),
                "last_error": last_error,
                "calls_24h": calls,
                "avg_latency_ms": int(stat.get("avg_ms") or 0),
            }
        return out

    def status(self) -> dict:
        health = self.health()
        degraded_roles = [r for r, v in health.items() if v["degraded"]]
        return {"roles": health, "degraded": bool(degraded_roles),
                "degraded_roles": degraded_roles, "db": str(self.db_path),
                "circuits": {role: self.breaker_state(role) for role in ROLES}}

    # -- 角色别名（供上层按语义调用）--------------------------------
    def extractor(self):
        return self.roles().get("extractor") or self.roles().get("chat")

    def vision(self):
        return self.roles().get("vision")


# ============================================================
# 小工具
# ============================================================
def _l2_normalize(vec: list) -> list:
    norm = math.sqrt(sum(v * v for v in vec))
    if not norm or math.isnan(norm):
        raise ValueError("向量范数为 0，无法归一化（拒绝返回零向量）")
    return [v / norm for v in vec]


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
