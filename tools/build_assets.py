#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 memora-core 的内置资产（工作流模板 / 算法目录 / 智能体登记 / 提示词）。

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
        "id": "session-distill", "name": "智能体会话沉淀", "category": "ingest", "version": 2,
        "description": "把一次智能体会话（任务描述、分析、工具调用、结论）提炼成候选记忆，"
                       "经判重、来源核验与判定层后沉淀为已审核记忆，并写入按日期的 Markdown。",
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
            node("persist", "沉淀入 SQLite", "persist", status="approved"),
            node("mirror", "写入日期 Markdown", "persist", target="markdown", layout="daily"),
            node("index", "增量索引", "index", role="embedding", incremental=True),
        ],
        "edges": chain("capture", "normalize", "extract", "classify", "dedup_recall", "dedup_judge",
                       "verify_source", "persist", "mirror", "index"),
        "fallbacks": {"extract": "rule-extract", "classify": "rule-classify", "dedup_judge": "score-threshold",
                      "verify_source": "quote-check-only"},
    },
    {
        "id": "study-notes-review", "name": "学习笔记与复习", "category": "learn", "version": 2,
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
            node("cards", "生成复习卡", "generate", role="chat", algorithm="SM-2"),
            node("schedule", "计算到期时间", "schedule", algorithm="sm2", ease=2.5),
            node("persist", "落库并镜像", "persist"),
        ],
        "edges": chain("ingest", "segment", "didactic", "formula_latex", "link_entities", "cards", "schedule", "persist"),
        "fallbacks": {"didactic": "heading-based-split", "formula_latex": "keep-source-tex", "cards": "cloze-from-text"},
    },
    {
        "id": "doc-knowledgeize", "name": "外部文档知识化", "category": "ingest", "version": 2,
        "description": "吸收 Markdown/PDF/TXT/HTML/JSONL 外部文档：切块、摘要、抽实体、建关系、"
                       "写入文档库并纳入检索，保留原始出处哈希。",
        "trigger": {"kind": "manual", "sources": ["file", "folder"]},
        "inputs": {"path": "文件或目录", "scope": "目标作用域"},
        "nodes": [
            node("read", "读取文档", "input", formats=["md", "txt", "pdf", "html", "json", "jsonl"]),
            node("dedupe_file", "文档级去重", "verify", by="content_hash"),
            node("chunk", "语义切块", "transform", tokens=900, overlap=120, keep_headings=True),
            node("summarize", "分块摘要", "generate", role="chat", max_tokens=180),
            node("entities", "实体抽取", "extract", role="extractor", kinds=["concept", "person", "project", "tool", "term"]),
            node("relations", "关系抽取", "graph", rels=["hypernym", "hyponym", "part_of", "causes", "supports"]),
            node("embed", "向量化", "embed", role="embedding"),
            node("index_fts", "全文索引", "index", engine="fts5", tokenize="unicode61"),
            node("persist", "写入文档库", "persist", mirror="markdown"),
        ],
        "edges": chain("read", "dedupe_file", "chunk", "summarize", "entities", "relations", "embed", "index_fts", "persist"),
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
        "id": "conflict-source-audit", "name": "冲突与来源审计", "category": "audit", "version": 2,
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
            node("persist", "写入冲突表与报告文档", "persist"),
        ],
        "edges": chain("collect", "score_conflict", "evidence_rank", "report", "propose", "persist"),
        "fallbacks": {"evidence_rank": "trust-weight-order", "report": "template-report"},
    },
    {
        "id": "project-retro", "name": "项目决策与经验复盘", "category": "learn", "version": 2,
        "description": "从会话与提交记录中抽取决策（背景/选项/取舍/结果），沉淀为可复用的经验条目并关联工作区。",
        "trigger": {"kind": "manual", "sources": ["agent_session", "workspace"]},
        "inputs": {"workspace": "工作区路径", "window": "时间窗"},
        "nodes": [
            node("gather", "汇集素材", "input"),
            node("decision_extract", "决策抽取", "extract", role="extractor", fields=[
                "context", "options", "choice", "rationale", "outcome", "reusable_lesson"]),
            node("outcome_verify", "结果核验", "verify", by="tool_output_or_user_confirm"),
            node("lessons", "经验条目化", "transform", kind="experience"),
            node("link", "关联工作区与任务", "graph", rels=["derived_from", "supports"]),
            node("persist", "沉淀", "persist"),
        ],
        "edges": chain("gather", "decision_extract", "outcome_verify", "lessons", "link", "persist"),
        "fallbacks": {"decision_extract": "keyword-time-slice"},
    },
    {
        "id": "detail-abstraction", "name": "细节与抽象线索", "category": "transform", "version": 2,
        "description": "把原始细节与抽象线索分离：细节保真留存，抽象生成可检索的 cue（线索），"
                       "检索时线索命中细节，降低遗忘与错配。",
        "trigger": {"kind": "manual", "sources": ["memory", "document"]},
        "inputs": {"items": "记忆或文档块列表"},
        "nodes": [
            node("load", "载入原始细节", "input"),
            node("abstract", "生成抽象线索", "generate", role="chat", style="cue-question"),
            node("keep_detail", "细节原样留存", "transform"),
            node("pair", "线索-细节配对", "persist", rel="cue_of"),
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
        "id": "dedup-merge", "name": "新记忆去重与合并", "category": "judge", "version": 3,
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
            node("merge_write", "合并写回", "persist", keep_sources=True, keep_history=True),
            node("audit", "审计留痕", "persist", table="audit"),
        ],
        "edges": chain("candidate_in", "near_dup", "band", "judge", "merge_write", "audit"),
        "fallbacks": {"judge": "score-rule", "near_dup": "fts-near"},
    },
    {
        "id": "update-supersede", "name": "记忆更新与推翻", "category": "judge", "version": 2,
        "description": "处理迟到事实与版本演进：为新记忆设定生效时间，把旧记忆置为 superseded 并保留历史链，"
                       "查询默认只返回当前有效版本。",
        "trigger": {"kind": "ingest", "sources": ["candidate"]},
        "inputs": {"candidate": "候选", "valid_from": "生效时间"},
        "nodes": [
            node("load_pair", "加载新旧对", "input"),
            node("temporal", "时间关系判定", "judge", role="judge",
                 relations=["before", "after", "overlap", "unknown"]),
            node("supersede", "标记推翻", "persist", set_fields=["valid_to", "superseded_by", "status"]),
            node("history", "历史链保留", "persist", rel="supersedes"),
            node("notify", "变更提示", "emit", channel="review"),
        ],
        "edges": chain("load_pair", "temporal", "supersede", "history", "notify"),
        "fallbacks": {"temporal": "timestamp-order"},
    },
    {
        "id": "split-decompose", "name": "记忆拆解与原子化", "category": "transform", "version": 2,
        "description": "把长句/复合记忆拆成单一命题的原子记忆，各自可独立检索、独立判真、独立追溯来源。",
        "trigger": {"kind": "ingest", "sources": ["memory"]},
        "inputs": {"memory": "待拆解对象"},
        "nodes": [
            node("read", "读取", "input"),
            node("split", "原子化拆解", "transform", role="extractor", one_proposition=True),
            node("entity_bind", "实体绑定", "graph", rels=["mentions"]),
            node("child_links", "父子关系", "persist", rel="part_of"),
            node("persist", "写回", "persist"),
        ],
        "edges": chain("read", "split", "entity_bind", "child_links", "persist"),
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
            node("log", "分发留痕", "persist", table="recall_log"),
        ],
        "edges": chain("who", "scope_resolve", "select", "digest", "export", "log"),
        "fallbacks": {"digest": "template-digest"},
    },
    {
        "id": "forget-decay", "name": "遗忘与衰减归档", "category": "maintain", "version": 2,
        "description": "按重要度、最近使用、复习稳定性计算衰减；低价值记忆归档而不删除，敏感记忆走硬删除与审计。",
        "trigger": {"kind": "schedule", "cron": "30 4 * * *"},
        "inputs": {"scope": "作用域"},
        "nodes": [
            node("candidates", "候选集合", "input", strategy="unused-90d + low-importance"),
            node("decay", "衰减打分", "fuse", algorithm="exponential-decay", half_life_days=30),
            node("archive", "归档", "persist", status="archived"),
            node("purge", "硬删除（敏感）", "persist", require="explicit_consent", audit=True),
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
        "id": "preference-learning", "name": "用户习惯学习", "category": "learn", "version": 2,
        "description": "从对话与操作中归纳用户偏好（语言、风格、工具偏好、禁忌），以独立作用域存续，"
                       "并提供给所有智能体作为默认上下文。",
        "trigger": {"kind": "schedule", "cron": "0 2 * * *"},
        "inputs": {"window": "近 N 天会话"},
        "nodes": [
            node("collect", "汇集行为样本", "input"),
            node("pattern", "模式归纳", "extract", role="extractor", kinds=["preference", "routine", "aversion"]),
            node("evidence", "证据绑定", "verify", min_occurrences=2),
            node("profile", "偏好档案更新", "persist", scope="global"),
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
            node("append_raw", "原文落库", "persist", status="draft", idempotent_by="event_id"),
            node("mirror", "镜像 Markdown 草稿", "persist", target="markdown", layout="daily"),
            node("enqueue", "入队沉淀任务", "schedule", job="session-distill"),
        ],
        "edges": chain("append_raw", "mirror", "enqueue"),
        "fallbacks": {},
    },
    {
        "id": "knowledge-graph-build", "name": "知识图谱构建", "category": "maintain", "version": 2,
        "description": "从记忆与文档中构建实体-关系图：词义关系、层级关系、因果关系、时序关系，"
                       "并计算社区与中心度，为脑图提供分层数据。",
        "trigger": {"kind": "schedule", "cron": "0 5 * * *"},
        "inputs": {"scope": "作用域"},
        "nodes": [
            node("entities", "实体归一", "extract", role="extractor", alias_merge=True),
            node("relations", "关系抽取", "graph", rels=["hypernym", "hyponym", "part_of", "causes", "supports", "contradicts"]),
            node("prune", "弱边剪枝", "fuse", algorithm="weight-threshold", min_weight=0.2),
            node("community", "社区发现", "graph", algorithm="louvain"),
            node("centrality", "中心度", "graph", algorithm="pagerank"),
            node("persist", "写图库", "persist"),
        ],
        "edges": chain("entities", "relations", "prune", "community", "centrality", "persist"),
        "fallbacks": {"relations": "cooccurrence", "community": "connected-components", "centrality": "degree"},
    },
    {
        "id": "review-quiz-generate", "name": "复习题生成与批改", "category": "learn", "version": 2,
        "description": "基于已审核知识生成单选/填空/简答/推导题，用户作答后由判定层批改并更新掌握度，"
                       "驱动下一次复习间隔。",
        "trigger": {"kind": "manual", "sources": ["memory", "knowledge"]},
        "inputs": {"topic": "主题或实体", "count": "题目数量"},
        "nodes": [
            node("select", "选题素材", "retrieve", strategy="coverage", top_k=8),
            node("generate", "出题", "generate", role="chat", types=["single", "blank", "short", "derive"]),
            node("validate", "题目校验", "verify", rules=["answerable", "no_leak", "not_trivial"]),
            node("present", "呈现", "emit", channel="ui"),
            node("grade", "批改", "judge", role="judge"),
            node("update", "更新掌握度", "persist", rel="review_log"),
        ],
        "edges": chain("select", "generate", "validate", "present", "grade", "update"),
        "fallbacks": {"generate": "cloze-template", "grade": "string-similarity"},
    },
]


ALGORITHMS = [
    ("bm25", "BM25 相关性打分", "retrieval",
     "经典概率检索模型，按词频饱和与文档长度归一给分；FTS5 内置 bm25() 可直接用。",
     "score(q,d)=Σ IDF(t)·(f(t,d)·(k1+1))/(f(t,d)+k1·(1-b+b·|d|/avgdl))",
     "Robertson & Zaragoza 2009", 1),
    ("bm25plus", "BM25+", "retrieval", "对长文档中低词频命中的下界补偿，改善短查询召回。", "score = BM25 + δ·|q∩d|", "Lv & Zhai 2011", 1),
    ("fts5-trigram", "SQLite FTS5 三元组索引", "retrieval", "支持中文/无空格语言子串匹配，牺牲体积换召回。", "tokenize='trigram'", "SQLite 文档", 1),
    ("char-ngram-hash", "字符 n-gram 哈希向量", "embedding",
     "无云端 embedding 时的确定性替代：把字符 3-gram 哈希到 256 维并 L2 归一。",
     "v[i]=Σ_{g∈grams} h(g)%D==i ? 1 : 0; v←v/||v||", "本项目设定（离线兜底）", 1),
    ("tfidf-cosine", "TF-IDF 余弦相似度", "retrieval", "语料内统计的词权相似度，作为向量通道的离线版本。", "cos(a,b)=a·b/(||a||·||b||)", "Salton 1975", 1),
    ("rrf", "倒数排名融合 RRF", "fusion",
     "多路召回结果按名次融合，无需分数可比；k 越大越平滑。", "score(d)=Σ_i w_i/(k+rank_i(d)), k=60",
     "Cormack et al. 2009", 1),
    ("weighted-fusion", "加权分数融合", "fusion", "各通道归一化后线性加权，需分数可比。", "s=Σ w_i·norm(s_i)", "工业界常用", 1),
    ("mmr", "最大边际相关 MMR", "fusion", "在相关性与冗余之间折中，用于上下文去重。",
     "MMR=argmax_{d∈R\\S}[λ·sim(d,q)−(1−λ)·max_{s∈S}sim(d,s)], λ=0.7", "Carbonell & Goldstein 1998", 1),
    ("cosine", "余弦相似度", "embedding", "向量方向相似度，忽略模长。", "cos(a,b)=a·b/(||a||₂·||b||₂)", "—", 1),
    ("simhash", "SimHash 近似去重", "dedup", "64 位指纹，汉明距离 ≤3 视为近重复，O(1) 比较。",
     "h=Σ sign(w_i)·v_i 逐位取符号", "Charikar 2002", 1),
    ("jaccard-shingle", "Jaccard 词袋相似", "dedup", "5-gram shingle 集合交并比，抗改写。", "J=|A∩B|/|A∪B|", "—", 1),
    ("levenshtein-norm", "归一化编辑距离", "dedup", "字符级差异度量，适合短事实句判重。", "sim=1−dist(a,b)/max(|a|,|b|)", "Levenshtein 1966", 1),
    ("exponential-decay", "指数遗忘衰减", "decay", "越久未用的记忆权重按半衰期指数下降，用于排序与归档。",
     "w(t)=w0·exp(−λ·Δt), λ=ln2/half_life", "Ebbinghaus 1885 / Generative Agents 2023", 1),
    ("ga-recency-importance", "记忆流三元打分", "ranking",
     "Generative Agents 的检索函数：近因、重要度、相关性的加权和。",
     "score=α·recency+β·importance+γ·relevance，α=β=γ=1（等权）", "Park et al. 2023", 1),
    ("importance-heuristic", "重要度启发式", "ranking",
     "无 LLM 时用长度、实体密度、显式意图词（记住/别忘/总是）估算重要度。",
     "imp=clip(0.3+0.2·has_intent+0.1·entities+0.1·log(len))", "本项目设定", 1),
    ("pagerank", "PageRank 中心度", "graph", "在实体图上传播重要性，识别枢纽概念。", "PR(u)=(1−d)/N+d·Σ PR(v)/L(v)", "Page & Brin 1998", 1),
    ("ppr", "个性化 PageRank 检索", "retrieval", "HippoRAG 式图检索：从查询实体出发的带重启随机游走。",
     "π=(1−α)·r+α·Pᵀπ, α=0.85", "HippoRAG 2024", 1),
    ("louvain", "Louvain 社区发现", "graph", "把图切成主题社区，支撑脑图的分层折叠与聚合。", "最大化模块度 Q", "Blondel et al. 2008", 1),
    ("force-atlas2", "ForceAtlas2 布局", "layout", "带吸引力/排斥力与重力项的力导向布局，适合大图。",
     "F_a=k_a·d, F_r=k_r·deg·1/d", "Jacomy et al. 2014", 1),
    ("fruchterman-reingold", "FR 力导向布局", "layout", "经典斥力-引力迭代，小图质量高。", "F_r=k²/d, F_a=d²/k", "Fruchterman & Reingold 1991", 1),
    ("barnes-hut", "Barnes-Hut 近似", "layout", "用四叉树把 O(n²) 斥力降到 O(n log n)，是万节点布局的前提。", "θ 判据开角", "Barnes & Hut 1986", 1),
    ("tidy-tree", "Reingold-Tilford 层次树", "layout", "层级脑图的紧凑树布局，父居中、子树不重叠。", "后序累计偏移", "Reingold & Tilford 1981", 1),
    ("radial-tree", "径向树布局", "layout", "层级 × 时间混合视图，半径编码深度。", "r=f(depth), θ=f(index)", "—", 1),
    ("umap", "UMAP 降维预布局", "layout", "把高维向量投影到 2D 供语义脑图使用，保留全局结构。", "基于模糊拓扑与交叉熵优化", "McInnes et al. 2018", 0),
    ("hnsw", "HNSW 近似最近邻", "retrieval", "分层可导航小世界图索引，向量检索的工业标准。", "贪心逐层下降 + ef 搜索", "Malkov & Yashunin 2016", 0),
    ("ivf-pq", "IVF-PQ 倒排乘积量化", "retrieval", "大规模向量的压缩索引，内存换速度。", "k-means 聚类 + 子空间量化", "Jégou et al. 2011", 0),
    ("raptor", "RAPTOR 递归摘要树", "transform", "自底向上聚类摘要，形成可多层检索的抽象树。", "聚类 + LLM 摘要迭代", "Sarthi et al. 2024", 0),
    ("sm2", "SM-2 间隔复习", "review", "按回忆质量 0–5 调整间隔与难度因子，生成复习排程。",
     "EF'=EF+(0.1−(5−q)·(0.08+(5−q)·0.02)), I1=1, I2=6, In=I_{n−1}·EF", "Wozniak 1987", 1),
    ("fsrs", "FSRS 记忆稳定性模型", "review", "以稳定性 DSR 三变量刻画遗忘曲线，间隔更精确。", "R=(1+t/(9S))^(−1)", "Free Spaced Repetition Scheduler", 1),
    ("semantic-chunking", "语义边界切块", "transform", "按标题与语义相似度断点切块，避免把语义切碎。", "相邻句相似度谷值处断开", "—", 1),
    ("greedy-budget-pack", "预算贪心打包", "transform", "在 token 预算下按边际收益选择条目，最大化信息密度。",
     "按 score/len 排序贪心装入，直到预算耗尽", "本项目设定", 1),
    ("conflict-score", "冲突强度打分", "judge", "结合实体重叠、数值矛盾、极性反转给出冲突分。",
     "c=0.4·entity_overlap+0.35·polarity_flip+0.25·numeric_conflict", "本项目设定", 1),
    ("temporal-validity", "双时间有效性", "judge", "区分“何时为真”与“何时被记录”，用于迟到事实与历史查询。",
     "(valid_from,valid_to) × (recorded_at)", "Graphiti / bitemporal 建模", 1),
    ("contextual-prefix", "上下文前缀嵌入", "embedding", "Anthropic Contextual Retrieval：为块补一句上下文再嵌入，显著降低错配。",
     "embed(context || chunk)", "Anthropic 2024", 0),
]


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


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "workflow_templates.json").write_text(
        json.dumps(TEMPLATES, ensure_ascii=False, indent=2), encoding="utf-8")
    algos = [dict(id=a[0], name=a[1], category=a[2], summary=a[3], formula=a[4],
                  reference=a[5], offline=1, runnable=a[6]) for a in ALGORITHMS]
    (OUT / "algorithms.json").write_text(
        json.dumps(algos, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "agents.json").write_text(
        json.dumps(AGENTS, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "prompts.json").write_text(
        json.dumps(PROMPTS, ensure_ascii=False, indent=2), encoding="utf-8")
    print("templates:", len(TEMPLATES), "algorithms:", len(algos), "agents:", len(AGENTS),
          "prompts:", len(PROMPTS))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
