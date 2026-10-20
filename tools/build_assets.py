#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 memora-core 的内置资产（工作流模板 / 智能体登记 / 提示词；算法目录直接维护）。

运行：python tools/build_assets.py
产物：memora_core/data/builtin/*.json

这些 JSON 是**契约**：后端工作流引擎按 spec 执行，前端工作流画布按 spec 渲染，
算法目录只做展示与元数据，不执行（本机算力不足，运行标记 runnable=0）。
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "memora_core" / "data" / "builtin"


def node(nid, name, nkind, role=None, **params):
    n = {"id": nid, "name": name, "kind": nkind, "role": role, "params": params}
    return n


def chain(*specs):
    return [{"from": a, "to": b, "when": "always"} for a, b in zip(specs, specs[1:])]


TEMPLATES = [
    {
        "id": "session-distill", "name": "智能体会话沉淀", "category": "ingest", "version": 3,
        "description": "把一次智能体会话（任务描述、分析、工具调用、结论）提炼成候选记忆，"
                       "经判重、来源核验后写入为**候选**（待人工审核），并写入按日期的 Markdown。",
        "trigger": {"kind": "session-end", "sources": ["agent_session"]},
        "inputs": {"session": "会话对象", "scope": "作用域路径", "agent": "智能体 id"},
        "nodes": [
            node("capture", "接收会话", "input"),
            node("normalize", "归一化与分片", "transform", chunk_tokens=900, overlap=120),
            node("extract", "候选记忆提炼", "extract", role="extractor", quote_required=True),
            node("classify", "类型与领域分类", "classify", role="judge", kinds=[
                "fact", "knowledge", "decision", "preference", "procedure", "experience", "task", "tool"]),
            node("dedup_recall", "相似旧记忆召回", "retrieve", role="embedding", top_k=12, min_score=0.55),
            node("dedup_judge", "重复/冲突判定", "judge", role="judge", actions=[
                "add", "update", "supersede", "merge", "link", "noop", "ask"]),
            node("verify_source", "来源核验", "verify", require_quote=True, reject_agent_only_claims=True),
            # 1.1.0：智能体自述的内容只能是候选，绝不自动批准（README 硬规则）
            node("persist", "沉淀入 SQLite（候选）", "persist", op="memory", status="candidate",
                 **{"from": "classify"}),
            node("mirror", "写入日期 Markdown", "persist", op="markdown", target="markdown", layout="daily"),
            node("index", "增量索引", "index", role="embedding", incremental=True),
        ],
        "edges": chain("capture", "normalize", "extract", "classify", "dedup_recall", "dedup_judge",
                       "verify_source", "persist", "mirror", "index"),
        "fallbacks": {"extract": "rule-extract", "classify": "rule-classify", "dedup_judge": "score-threshold",
                      "verify_source": "quote-check-only"},
    },
    {
        "id": "study-notes-review", "name": "学习笔记与复习", "category": "learn", "version": 3,
        "description": "把笔记拆成定义/定理/特征/公式/推导/例题六层，生成复习卡片与到期计划（SM-2），"
                       "并按艾宾浩斯式间隔提醒复习。",
        "trigger": {"kind": "manual", "sources": ["document", "memory"]},
        "inputs": {"text": "笔记正文或文档 id"},
        "nodes": [
            node("ingest", "读取笔记", "input"),
            node("segment", "结构化切分", "transform", headings=True, math=True),
            node("didactic", "教学分层抽取", "extract", role="extractor",
                 layers=["definition", "theorem", "property", "formula", "derivation", "example"]),
            node("formula_latex", "公式转 LaTeX", "transform", role="extractor", output="katex"),
            node("link_entities", "概念实体与先修关系", "graph", rels=["prerequisite", "hypernym", "part_of"]),
            node("cards", "生成复习卡", "generate", role="chat", types=["blank"]),
            node("schedule", "计算到期时间", "schedule", algorithm="sm2", ease=2.5),
            node("persist", "落库（带复习到期时间）", "persist", op="memory", kind="knowledge",
                 review_due_from="schedule", **{"from": "didactic"}),
        ],
        "edges": chain("ingest", "segment", "didactic", "formula_latex", "link_entities", "cards", "schedule", "persist"),
        "fallbacks": {"didactic": "heading-based-split", "formula_latex": "keep-source-tex", "cards": "cloze-from-text"},
    },
    {
        "id": "doc-knowledgeize", "name": "外部文档知识化", "category": "ingest", "version": 3,
        "description": "吸收 Markdown/PDF/TXT/HTML/JSONL 外部文档：切块、摘要、抽实体、建关系、"
                       "写入文档库并纳入检索，保留原始出处哈希。",
        "trigger": {"kind": "manual", "sources": ["file", "folder"]},
        "inputs": {"path": "文件或目录", "scope": "目标作用域"},
        "nodes": [
            node("read", "读取文档", "input", formats=["md", "txt", "pdf", "html", "json", "jsonl"]),
            node("dedupe_file", "文档级去重", "verify", by="content_hash"),
            node("chunk", "语义切块", "transform", tokens=900, overlap=120, keep_headings=True),
            # 先写文档库（document + chunk + vault 镜像），向量化才有真实的块 id 可写
            node("persist", "写入文档库", "persist", op="document", mirror="markdown"),
            node("summarize", "分块摘要", "generate", role="chat", max_tokens=180),
            node("entities", "实体抽取", "extract", role="extractor", kinds=["concept", "person", "project", "tool", "term"]),
            node("relations", "关系抽取", "graph", rels=["hypernym", "hyponym", "part_of", "causes", "supports"]),
            node("embed", "向量化", "embed", role="embedding", owner_kind="chunk", **{"from": "persist"}),
            node("index_fts", "全文索引", "index", engine="fts5", tokenize="unicode61"),
        ],
        "edges": chain("read", "dedupe_file", "chunk", "persist", "summarize", "entities", "relations", "embed", "index_fts"),
        "fallbacks": {"summarize": "lead-sentences", "entities": "capitalized-noun-phrase",
                      "relations": "cooccurrence-window", "embed": "char-ngram-hash"},
    },
    {
        "id": "hybrid-recall-rerank", "name": "混合召回与重排序", "category": "recall", "version": 3,
        "description": "BM25 + 向量 + 实体图三路召回，RRF 融合，cross-encoder 重排，"
                       "MMR 去冗余，最后按 token 预算打包成上下文，附引用与降级标记。",
        "trigger": {"kind": "agent", "sources": ["query"]},
        "inputs": {"query": "检索语句", "scope": "作用域", "budget": "token 预算"},
        "nodes": [
            node("query_parse", "查询解析", "transform", extract_filters=True),
            node("bm25", "全文召回", "retrieve", engine="fts5", top_k=40),
            node("vector", "向量召回", "retrieve", role="embedding", top_k=40),
            node("graph", "实体图扩展召回", "retrieve", engine="graph", hops=1, top_k=20),
            node("fuse", "RRF 融合", "fuse", algorithm="rrf", k=60, weights={"bm25": 1.0, "vector": 1.0, "graph": 0.6}),
            node("rerank", "精排", "rerank", role="reranker", top_k=20),
            node("mmr", "去冗余", "fuse", algorithm="mmr", lambda_=0.7),
            node("pack", "预算打包", "transform", algorithm="greedy-budget", cite=True),
        ],
        "edges": [
            {"from": "query_parse", "to": "bm25", "when": "always"},
            {"from": "query_parse", "to": "vector", "when": "always"},
            {"from": "query_parse", "to": "graph", "when": "always"},
            {"from": "bm25", "to": "fuse", "when": "always"},
            {"from": "vector", "to": "fuse", "when": "always"},
            {"from": "graph", "to": "fuse", "when": "always"},
            {"from": "fuse", "to": "rerank", "when": "always"},
            {"from": "rerank", "to": "mmr", "when": "always"},
            {"from": "mmr", "to": "pack", "when": "always"},
        ],
        "fallbacks": {"vector": "bm25-only", "graph": "skip", "rerank": "score-passthrough"},
    },
    {
        "id": "conflict-source-audit", "name": "冲突与来源审计", "category": "audit", "version": 3,
        "description": "扫描互斥记忆与低信任来源，按证据强度、时间、来源类型排序，产出审计报告与建议动作，"
                       "人工裁决后写回。",
        "trigger": {"kind": "schedule", "cron": "0 3 * * *"},
        "inputs": {"scope": "作用域", "since": "时间窗"},
        "nodes": [
            node("collect", "收集候选对", "input", strategy="entity-overlap + vector-near"),
            node("score_conflict", "冲突打分", "fuse", algorithm="conflict-score"),
            node("evidence_rank", "证据强度排序", "judge", role="judge", rubric="source-trust"),
            node("report", "生成审计报告", "generate", role="chat", output="markdown+json"),
            node("propose", "建议动作", "decide", actions=["supersede", "merge", "mark_stale", "ask_user"]),
            node("persist", "写入冲突表与报告文档", "persist", op="conflict", min_score=0.5),
        ],
        "edges": chain("collect", "score_conflict", "evidence_rank", "report", "propose", "persist"),
        "fallbacks": {"evidence_rank": "trust-weight-order", "report": "template-report"},
    },
    {
        "id": "project-retro", "name": "项目决策与经验复盘", "category": "learn", "version": 3,
        "description": "从会话与提交记录中抽取决策（背景/选项/取舍/结果），沉淀为可复用的经验条目并关联工作区。",
        "trigger": {"kind": "manual", "sources": ["agent_session", "workspace"]},
        "inputs": {"workspace": "工作区路径", "window": "时间窗"},
        "nodes": [
            node("gather", "汇集素材", "input", collect="workspace-sessions"),
            node("decision_extract", "决策抽取", "extract", role="extractor", fields=[
                "context", "options", "choice", "rationale", "outcome", "reusable_lesson"]),
            node("outcome_verify", "结果核验", "verify", by="tool_output_or_user_confirm"),
            node("lessons", "经验条目化", "transform", kind="experience"),
            node("link", "关联工作区与任务", "graph", rels=["derived_from", "supports"]),
            node("persist", "沉淀", "persist", op="memory", kind="experience", **{"from": "lessons"}),
        ],
        "edges": chain("gather", "decision_extract", "outcome_verify", "lessons", "link", "persist"),
        "fallbacks": {"decision_extract": "keyword-time-slice"},
    },
    {
        "id": "detail-abstraction", "name": "细节与抽象线索", "category": "transform", "version": 3,
        "description": "把原始细节与抽象线索分离：细节保真留存，抽象生成可检索的 cue（线索），"
                       "检索时线索命中细节，降低遗忘与错配。",
        "trigger": {"kind": "manual", "sources": ["memory", "document"]},
        "inputs": {"items": "记忆或文档块列表"},
        "nodes": [
            node("load", "载入原始细节", "input"),
            node("abstract", "生成抽象线索", "generate", role="chat", style="cue-question"),
            node("keep_detail", "细节原样留存", "transform"),
            node("pair", "线索-细节配对", "persist", op="link", rel="cue_of"),
            node("cues_index", "线索索引", "index"),
        ],
        "edges": chain("load", "abstract", "keep_detail", "pair", "cues_index"),
        "fallbacks": {"abstract": "title-as-cue"},
    },
    {
        "id": "incremental-index", "name": "增量索引维护", "category": "maintain", "version": 2,
        "description": "监听库内变更，只对新增/变更对象重建 FTS 与向量，清理孤儿向量，保证索引与真源一致。",
        "trigger": {"kind": "schedule", "cron": "*/10 * * * *"},
        "inputs": {"since": "上次水位"},
        "nodes": [
            node("diff", "变更检测", "input", by=["updated_at", "hash"]),
            node("reindex_fts", "FTS 重建", "index", engine="fts5"),
            node("reindex_vec", "向量增量", "embed", role="embedding", incremental=True),
            node("gc", "孤儿清理", "verify", rules=["missing_owner", "hash_mismatch", "dim_mismatch"]),
            node("report", "索引健康报告", "generate", role="chat"),
        ],
        "edges": chain("diff", "reindex_fts", "reindex_vec", "gc", "report"),
        "fallbacks": {"reindex_vec": "mark-degraded-keep-old"},
    },
    {
        "id": "dedup-merge", "name": "新记忆去重与合并", "category": "judge", "version": 4,
        "description": "新记忆入库前的核心闸门：近似召回旧记忆 → 打分分层（自动合并/进入判定/新建）→ "
                       "判定层给出 ADD/UPDATE/MERGE/SUPERSEDE/LINK/NOOP/ASK，并保留被合并来源。",
        "trigger": {"kind": "ingest", "sources": ["candidate"]},
        "inputs": {"candidate": "候选记忆"},
        "nodes": [
            node("candidate_in", "候选接收", "input"),
            node("near_dup", "近似召回", "retrieve", role="embedding", top_k=10,
                 methods=["cosine", "simhash", "jaccard"]),
            node("band", "分层打分", "fuse", bands={"auto_merge": 0.92, "judge": 0.80, "new": 0.0}),
            node("judge", "判定层裁决", "judge", role="judge",
                 actions=["add", "update", "supersede", "merge", "link", "noop", "ask"]),
            node("merge_write", "合并写回", "persist", op="merge", keep_sources=True, keep_history=True),
            node("audit", "审计留痕", "persist", op="audit", table="audit"),
        ],
        "edges": chain("candidate_in", "near_dup", "band", "judge", "merge_write", "audit"),
        "fallbacks": {"judge": "score-rule", "near_dup": "fts-near"},
    },
    {
        "id": "update-supersede", "name": "记忆更新与推翻", "category": "judge", "version": 3,
        "description": "处理迟到事实与版本演进：为新记忆设定生效时间，把旧记忆置为 superseded 并保留历史链，"
                       "查询默认只返回当前有效版本。",
        "trigger": {"kind": "ingest", "sources": ["candidate"]},
        "inputs": {"new_id": "推翻者条目 id（可选，须已批准）", "old_id": "被推翻条目 id（可选）",
                   "candidate": "候选（可选：已入库条目 id，配合 target_id）", "valid_from": "生效时间"},
        "nodes": [
            node("load_pair", "加载新旧对", "input"),
            node("temporal", "时间关系判定", "judge", role="judge",
                 relations=["before", "after", "overlap", "unknown"]),
            node("supersede", "标记推翻", "persist", op="supersede",
                 set_fields=["valid_to", "superseded_by", "status"]),
            node("history", "历史链保留", "persist", op="link", rel="supersedes"),
            node("notify", "变更提示", "emit", channel="review"),
        ],
        "edges": chain("load_pair", "temporal", "supersede", "history", "notify"),
        "fallbacks": {"temporal": "timestamp-order"},
    },
    {
        "id": "split-decompose", "name": "记忆拆解与原子化", "category": "transform", "version": 3,
        "description": "把长句/复合记忆拆成单一命题的原子记忆，各自可独立检索、独立判真、独立追溯来源。",
        "trigger": {"kind": "ingest", "sources": ["memory"]},
        "inputs": {"memory": "待拆解对象"},
        "nodes": [
            node("read", "读取", "input"),
            node("split", "原子化拆解", "transform", role="extractor", one_proposition=True),
            node("entity_bind", "实体绑定", "graph", rels=["mentions"]),
            # 先写出子记忆，父子边才有真实的端点
            node("persist", "写回子记忆", "persist", op="memory", **{"from": "split"}),
            node("child_links", "父子关系", "persist", op="link", rel="part_of", **{"from": "persist"}),
        ],
        "edges": chain("read", "split", "entity_bind", "persist", "child_links"),
        "fallbacks": {"split": "sentence-split"},
    },
    {
        "id": "cross-agent-transfer", "name": "跨智能体记忆分发", "category": "protocol", "version": 2,
        "description": "把记忆按作用域与策略分发给不同智能体：生成该智能体可读的摘要包（digest），"
                       "记录谁在何时取走了什么，并支持导出统一交换格式。",
        "trigger": {"kind": "agent", "sources": ["agent"]},
        "inputs": {"agent": "目标智能体", "scope": "作用域", "budget": "token 预算"},
        "nodes": [
            node("who", "识别请求方", "input", by=["heartbeat", "mcp_call", "process"]),
            node("scope_resolve", "作用域解析", "transform", inherit=["global", "workspace", "agent"]),
            node("select", "按策略挑选", "retrieve", strategy="hybrid", top_k=30),
            node("digest", "生成摘要包", "generate", role="chat", format="markdown", cite=True),
            node("export", "导出交换格式", "emit", format="jsonl", schema="memora-exchange/1"),
            node("log", "分发留痕", "persist", op="recall_log", table="recall_log"),
        ],
        "edges": chain("who", "scope_resolve", "select", "digest", "export", "log"),
        "fallbacks": {"digest": "template-digest"},
    },
    {
        "id": "forget-decay", "name": "遗忘与衰减归档", "category": "maintain", "version": 3,
        "description": "按重要度、最近使用、复习稳定性计算衰减；低价值记忆归档而不删除；"
                       "硬删除只在显式同意（explicit_consent=true + purge_ids）时执行并审计。",
        "trigger": {"kind": "schedule", "cron": "30 4 * * *"},
        "inputs": {"scope": "作用域", "explicit_consent": "硬删除同意（true 才会执行硬删除）",
                   "purge_ids": "要硬删除的条目 id 列表（需同时给 explicit_consent=true）"},
        "nodes": [
            node("candidates", "候选集合", "input", strategy="unused-90d + low-importance"),
            node("decay", "衰减打分", "fuse", algorithm="exponential-decay", half_life_days=30,
                 archive_below=0.1),
            node("archive", "归档", "persist", op="archive"),
            node("purge", "硬删除（需显式同意）", "persist", op="purge", require="explicit_consent", audit=True),
        ],
        "edges": chain("candidates", "decay", "archive", "purge"),
        "fallbacks": {"decay": "simple-age-rule"},
    },
    {
        "id": "contradiction-investigation", "name": "矛盾调查", "category": "audit", "version": 2,
        "description": "当两条记忆互斥时，回溯各自证据链、来源可信度与时间，产出一份可读调查报告，"
                       "由用户或高信任判定层裁决，而不是静默覆盖。",
        "trigger": {"kind": "manual", "sources": ["conflict"]},
        "inputs": {"a_id": "记忆 A", "b_id": "记忆 B"},
        "nodes": [
            node("trace_a", "取证 A", "retrieve", by="evidence_chain"),
            node("trace_b", "取证 B", "retrieve", by="evidence_chain"),
            node("compare", "逐项比对", "judge", role="judge", rubric="contradiction"),
            node("report", "调查报告", "generate", role="chat"),
            node("decide", "裁决", "decide", actions=["keep_a", "keep_b", "merge", "ask_user"]),
        ],
        "edges": [{"from": "trace_a", "to": "compare", "when": "always"},
                  {"from": "trace_b", "to": "compare", "when": "always"},
                  {"from": "compare", "to": "report", "when": "always"},
                  {"from": "report", "to": "decide", "when": "always"}],
        "fallbacks": {"compare": "trust-and-time-order", "report": "template-report"},
    },
    {
        "id": "preference-learning", "name": "用户习惯学习", "category": "learn", "version": 3,
        "description": "从对话与操作中归纳用户偏好（语言、风格、工具偏好、禁忌），以独立作用域存续，"
                       "并提供给所有智能体作为默认上下文。",
        "trigger": {"kind": "schedule", "cron": "0 2 * * *"},
        "inputs": {"window": "近 N 天会话"},
        "nodes": [
            node("collect", "汇集行为样本", "input", collect="recent-sessions"),
            node("pattern", "模式归纳", "extract", role="extractor", kinds=["preference", "routine", "aversion"]),
            node("evidence", "证据绑定", "verify", min_occurrences=2),
            node("profile", "偏好档案更新", "persist", op="memory", scope="global", kind="preference",
                 **{"from": "evidence"}),
        ],
        "edges": chain("collect", "pattern", "evidence", "profile"),
        "fallbacks": {"pattern": "frequency-count"},
    },
    {
        "id": "quick-capture", "name": "快速捕获", "category": "ingest", "version": 2,
        "description": "低延迟通道：先把原始内容原样落库（candidate/draft），保证零丢失，"
                       "再异步走正式沉淀工作流。",
        "trigger": {"kind": "agent", "sources": ["message", "tool_result"]},
        "inputs": {"content": "原始内容", "agent": "来源智能体", "event_id": "幂等键"},
        "nodes": [
            node("append_raw", "原文落库", "persist", op="memory", status="draft", idempotent_by="event_id"),
            node("mirror", "镜像 Markdown 草稿", "persist", op="markdown", target="markdown", layout="daily"),
            node("enqueue", "入队沉淀任务", "schedule", job="session-distill"),
        ],
        "edges": chain("append_raw", "mirror", "enqueue"),
        "fallbacks": {},
    },
    {
        "id": "knowledge-graph-build", "name": "知识图谱构建", "category": "maintain", "version": 3,
        "description": "从记忆与文档中构建实体-关系图：词义关系、层级关系、因果关系、时序关系，"
                       "并计算社区与中心度，为脑图提供分层数据。",
        "trigger": {"kind": "schedule", "cron": "0 5 * * *"},
        "inputs": {"scope": "作用域"},
        "nodes": [
            node("entities", "实体归一", "extract", role="extractor", alias_merge=True, scope_memories=True),
            node("relations", "关系抽取", "graph", rels=["hypernym", "hyponym", "part_of", "causes", "supports", "contradicts"]),
            node("prune", "弱边剪枝", "fuse", algorithm="weight-threshold", min_weight=0.2),
            node("community", "社区发现", "graph", algorithm="louvain"),
            node("centrality", "中心度", "graph", algorithm="pagerank"),
            node("persist", "写图库（汇总）", "persist", op="graph"),
        ],
        "edges": chain("entities", "relations", "prune", "community", "centrality", "persist"),
        "fallbacks": {"relations": "cooccurrence", "community": "connected-components", "centrality": "degree"},
    },
    {
        "id": "review-quiz-generate", "name": "复习题生成与批改", "category": "learn", "version": 3,
        "description": "基于已审核知识生成单选/填空/简答/推导题；带上作答（answers）再运行时批改并更新掌握度，"
                       "驱动下一次复习间隔。",
        "trigger": {"kind": "manual", "sources": ["memory", "knowledge"]},
        "inputs": {"topic": "主题或实体", "count": "题目数量", "answers": "作答列表（可选，按出题顺序）"},
        "nodes": [
            node("select", "选题素材", "retrieve", strategy="coverage", top_k=8),
            node("generate", "出题", "generate", role="chat", types=["single", "blank", "short", "derive"]),
            node("validate", "题目校验", "verify", rules=["answerable", "no_leak", "not_trivial"]),
            node("present", "呈现", "emit", channel="ui"),
            node("grade", "批改", "judge", role="judge", rubric="grade"),
            node("update", "更新掌握度", "persist", op="review_log"),
        ],
        "edges": chain("select", "generate", "validate", "present", "grade", "update"),
        "fallbacks": {"generate": "cloze-template", "grade": "string-similarity"},
    },
]


# 算法目录（algorithms.json）不再由本文件生成：1.1.0 起它直接维护、是唯一真源。
# 1.0.0 这里有一份副本，与 JSON 已经不同步（runnable 标记与描述被更正过），整体重生成会把
# 更正悄悄改回去。工作流模板、智能体、提示词仍由本文件生成，tests/test_docs_drift.py 校验一致。


AGENTS = [
    {"id": "dsh-desktop", "name": "DeepSeek Harness (DSH)", "ecosystem": "dsh", "kind": "chat",
     "protocols": ["mcp-stdio", "mcp-http", "plugin"],
     "probes": [{"type": "process", "match": ["DeepSeek Harness", "dsh.exe", "electron"]},
                {"type": "port", "match": [52527]},
                {"type": "file", "match": ["~/.dsh/heartbeat.json"]}],
     "config_hint": "在 DSH 插件目录安装 memora-core 连接器，或用 MCP 服务器配置指向 memora-core。"},
    {"id": "claude-code", "name": "Claude Code", "ecosystem": "claude-code", "kind": "coding",
     "protocols": ["mcp-stdio", "hooks"],
     "probes": [{"type": "process", "match": ["claude", "claude-code"]},
                {"type": "file", "match": ["~/.claude.json", "~/.claude/settings.json"]}],
     "config_hint": "在 ~/.claude.json 的 mcpServers 增加 memora-core，并可挂 SessionStart/Stop hooks 调 REST。"},
    {"id": "codex-cli", "name": "OpenAI Codex CLI", "ecosystem": "codex", "kind": "coding",
     "protocols": ["mcp-stdio"],
     "probes": [{"type": "process", "match": ["codex"]},
                {"type": "file", "match": ["~/.codex/config.toml"]}],
     "config_hint": "在 ~/.codex/config.toml 的 [mcp_servers.memora] 增加 command/args 指向 memora-core。"},
    {"id": "cursor", "name": "Cursor", "ecosystem": "cursor", "kind": "coding",
     "protocols": ["mcp-stdio"],
     "probes": [{"type": "process", "match": ["Cursor.exe"]},
                {"type": "file", "match": ["~/.cursor/mcp.json"]}],
     "config_hint": "在 ~/.cursor/mcp.json 增加 memora-core 服务。"},
    {"id": "claude-desktop", "name": "Claude Desktop", "ecosystem": "claude", "kind": "chat",
     "protocols": ["mcp-stdio"],
     "probes": [{"type": "process", "match": ["Claude.exe"]},
                {"type": "file", "match": ["~/AppData/Roaming/Claude/claude_desktop_config.json"]}],
     "config_hint": "claude_desktop_config.json 的 mcpServers 增加 memora-core。"},
    {"id": "generic-mcp", "name": "通用 MCP 客户端", "ecosystem": "generic-mcp", "kind": "mcp-client",
     "protocols": ["mcp-stdio", "mcp-http"],
     "probes": [{"type": "mcp", "match": ["initialize"]}],
     "config_hint": "任何 MCP 客户端都可 stdio 启动 python -m memora_core --mcp，或 HTTP 连 /mcp。"},
]


PROMPTS = {
    "extract": "你是记忆提炼器。从下面的会话片段中，抽取可长期复用的记忆条目。\n"
               "规则：\n1) 每条必须是单一命题；\n2) 必须给出原文中的**精确引句**作为证据，不得改写引句；\n"
               "3) 智能体自述而未经验证的内容，trust 不得高于 0.5；\n4) 用户明确表达的偏好优先保留；\n"
               "5) 输出 JSON 数组，字段：title, body, kind, category, importance, confidence, quote。\n"
               "会话片段：\n{{chunk}}",
    "classify": "把记忆归入以下 kind 之一：fact, knowledge, decision, preference, procedure, "
                "experience, task, tool, turn, artifact。并给出 category（领域）与 0-1 的重要度。"
                "只输出 JSON：{kind, category, importance, reason}。记忆：\n{{body}}",
    "dedup_judge": "比较“新记忆”与“已有记忆”，判定应采取的动作：\n"
                   "add（全新）、update（同义但更完整）、supersede（新版本取代旧版本）、"
                   "merge（互补且同主题）、link（相关但独立）、noop（完全重复）、ask（证据不足需人工）。\n"
                   "必须给出理由与置信度。只输出 JSON：{action, target_id, confidence, reason, "
                   "merged_body?}。\n新记忆：{{new}}\n已有记忆：{{old}}",
    "verify": "检查这条候选记忆的每条断言是否都有原文引句支撑。没有支撑的断言必须列在 unsupported 中。"
              "只输出 JSON：{supported:[], unsupported:[], verdict:'pass'|'fail'}。\n"
              "候选：{{candidate}}\n引句池：{{quotes}}",
    "conflict": "两条记忆矛盾时，逐项比对：实体、数值、极性、时间、来源可信度。给出更可信的一方与理由，"
                "或建议人工裁决。只输出 JSON：{preferred:'a'|'b'|'ask', reasons:[], confidence}。",
    "digest": "为智能体生成记忆摘要包：保留可执行的事实、约束与偏好，去掉过程性冗余。"
              "每条必须带编号引用。预算 {{budget}} tokens。",
    "quiz": "基于给定已审核知识出 {{count}} 道题，覆盖定义/特征/公式/推导。不得引入知识之外的断言。"
            "输出 JSON 数组：{type, question, options?, answer, explanation, source_id}。",
    "abstraction": "为下面的细节生成 2-4 条可检索的抽象线索（问句式），线索必须能在不看到原文的情况下"
                   "指向该细节。只输出 JSON：{cues:[]}。",
}


def main(argv=None) -> int:
    """全部重新生成；`--only workflow_templates`（可多次）只生成指定文件。

    algorithms.json 不由本文件生成（直接维护）。
    """
    import argparse

    parser = argparse.ArgumentParser(prog="build_assets")
    parser.add_argument("--only", action="append", default=[],
                        choices=["workflow_templates", "agents", "prompts"])
    args = parser.parse_args(argv)
    wanted = set(args.only) or {"workflow_templates", "agents", "prompts"}
    OUT.mkdir(parents=True, exist_ok=True)
    outputs = {"workflow_templates": TEMPLATES, "agents": AGENTS, "prompts": PROMPTS}
    for name in sorted(wanted):
        (OUT / ("%s.json" % name)).write_text(
            json.dumps(outputs[name], ensure_ascii=False, indent=2), encoding="utf-8")
    print("wrote:", ", ".join(sorted(wanted)), "| templates:", len(TEMPLATES),
          "agents:", len(AGENTS), "prompts:", len(PROMPTS))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
