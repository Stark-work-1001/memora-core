# -*- coding: utf-8 -*-
"""tests/test_docs_drift.py — 文档里的数字与清单，和代码对账。

HANDOVER §2："README 写错了表的数量……这说明没有人拿文档去对代码，所以多半还有更多。"
确实还有：README 23 张表（实为 28）、"四个角色"（代码 6 个）、"十三种关系"（14 种）……
这里把文档里**每一个**可数的断言登记成一行，期望值从代码算出来；改了代码忘了改文档就会失败。
新增文档断言时，在 CLAIMS 里加一行。
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from memora_core import __version__, db, exchange, mcp, models, server, store  # noqa: E402

CN = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def number(text: str) -> int:
    """'28' / '十三' / '二十八' / 'Four' → int。"""
    text = text.strip()
    if text.isdigit():
        return int(text)
    words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
             "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12}
    if text.lower() in words:
        return words[text.lower()]
    if "十" in text:
        tens, _, ones = text.partition("十")
        return (CN.get(tens, 1) if tens else 1) * 10 + (CN.get(ones, 0) if ones else 0)
    return CN[text]


def builtin(name: str) -> int:
    return len(json.loads((ROOT / "memora_core" / "data" / "builtin" / name).read_text(encoding="utf-8")))


NUM = r"([0-9]+|[一二两三四五六七八九十]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten)"
FACTS = {
    "tables": len(db.expected_tables()["real"]),
    "routes": len(server.ROUTES),
    "tools": len(mcp.TOOL_NAMES),
    "templates": builtin("workflow_templates.json"),
    "algorithms": builtin("algorithms.json"),
    "agents": builtin("agents.json"),
    "prompts": builtin("prompts.json"),
    "roles": len(models.ROLES),
    "relations": len(exchange.EDGE_RELS),
    "scope_kinds": len(store.SCOPE_KINDS),
    "memory_kinds": len(store.MEMORY_KINDS),
    "evidence_kinds": len(store.EVIDENCE_KINDS),
}

# (文件, 正则（第一个分组是数字）, 事实名)
CLAIMS = [
    ("README.md", NUM + r" 张表", "tables"),
    ("README.md", NUM + r" 工作流 /", "templates"),
    ("README.md", NUM + r" 条内置记忆工作流", "templates"),
    ("README.md", NUM + r" built-in memory workflows", "templates"),
    ("README.md", r"/ " + NUM + r" 算法 /", "algorithms"),
    ("README.md", NUM + r" 个记忆算法", "algorithms"),
    ("README.md", NUM + r" 智能体登记", "agents"),
    ("README.md", NUM + r" 提示词", "prompts"),
    ("README.md", NUM + r"个角色分别配置", "roles"),
    ("README.md", NUM + r" roles configured separately", "roles"),
    ("docs/models.md", NUM + r"种角色接到云端", "roles"),
    ("docs/server.md", r"当前 \*\*" + NUM + r"\*\* 条", "routes"),
    ("docs/protocols.md", NUM + r" 个工具", "tools"),
    ("RELEASE_NOTES.md", NUM + r" 个工具", "tools"),
    ("docs/API.md", NUM + r" 个模板", "templates"),
    ("docs/OPERATIONS.md", NUM + r" 条工作流模板", "templates"),
    ("docs/OPERATIONS.md", NUM + r" 条算法目录", "algorithms"),
    ("docs/OPERATIONS.md", NUM + r" 个智能体", "agents"),
    ("docs/protocols.md", NUM + r" 个智能体", "agents"),
    ("docs/INDEX.md", NUM + r"种关系", "relations"),
    ("docs/INDEX.md", NUM + r"层作用域", "scope_kinds"),
    ("docs/INDEX.md", NUM + r"种类型", "memory_kinds"),
    ("docs/INDEX.md", NUM + r"类证据", "evidence_kinds"),
]


class NumericClaimsTest(unittest.TestCase):
    def test_every_registered_claim_matches_the_code(self):
        problems = []
        for rel, pattern, fact in CLAIMS:
            path = ROOT / rel
            if not path.exists():
                problems.append("%s: 文件不存在" % rel)
                continue
            matches = re.findall(pattern, path.read_text(encoding="utf-8"))
            if not matches:
                problems.append("%s: 找不到断言 /%s/（改了措辞就同步更新 CLAIMS）" % (rel, pattern))
                continue
            for raw in matches:
                if number(raw) != FACTS[fact]:
                    problems.append("%s: 写的是 %s，代码里 %s = %d" % (rel, raw, fact, FACTS[fact]))
        self.assertEqual(problems, [], "\n" + "\n".join(problems))


class GeneratedAssetsTest(unittest.TestCase):
    def test_generator_matches_the_shipped_json(self):
        """tools/build_assets.py 生成的模板 / 智能体 / 提示词必须与提交的 JSON 一致。
        （1.0.0 的生成器里还有一份算法目录副本，已与 JSON 不同步；1.1.0 删掉了那份副本。）"""
        import importlib.util
        spec = importlib.util.spec_from_file_location("build_assets", ROOT / "tools" / "build_assets.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for name, data in (("workflow_templates", module.TEMPLATES), ("agents", module.AGENTS),
                           ("prompts", module.PROMPTS)):
            with self.subTest(asset=name):
                shipped = json.loads((ROOT / "memora_core" / "data" / "builtin" / ("%s.json" % name))
                                     .read_text(encoding="utf-8"))
                self.assertEqual(shipped, data)
        self.assertFalse(hasattr(module, "ALGORITHMS"), "算法目录只在 algorithms.json 里维护")


class ListCoverageTest(unittest.TestCase):
    def test_every_http_route_is_documented(self):
        docs = "".join((ROOT / "docs" / name).read_text(encoding="utf-8")
                       for name in ("API.md", "server.md"))
        missing = sorted({path for path, _method in server.ROUTES if path not in docs})
        self.assertEqual(missing, [], "这些路由在 docs/API.md 与 docs/server.md 里都没出现")

    def test_every_mcp_tool_is_documented_for_agents(self):
        text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        self.assertEqual([t for t in mcp.TOOL_NAMES if t not in text], [])

    def test_versions_agree(self):
        versions = {"memora_core": __version__}
        for rel in ("frontend/package.json", "desktop/package.json"):
            versions[rel] = json.loads((ROOT / rel).read_text(encoding="utf-8"))["version"]
        self.assertEqual(len(set(versions.values())), 1, versions)
        self.assertIn("## [%s]" % __version__, (ROOT / "CHANGELOG.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
