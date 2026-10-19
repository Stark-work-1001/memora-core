"""Scope tiers for memory reads: global -> workspace -> project -> conversation.

A memory store is not one bucket. Some facts are global (this machine, this user, this toolchain),
some belong to a workspace, some to one project, and some only make sense inside the conversation
they came from. memora already had two levels — a project string and the `:user` pseudo-project —
and every read path hard-coded that pair. This module names the whole ladder so the UI can offer
it, the store can query a set of tiers, and adding or renaming a level later does not mean touching
every call site.

WHY FOUR LEVELS, AND HOW EACH ONE IS STORED
-------------------------------------------
The schema already supports all four without a migration:

* `memories.project` is plain TEXT, so `:global`, `:workspace` and the existing `:user` are just
  values of it. Nothing about existing rows, FTS indexes or digests changes.
* `memories.session_id` already references `sessions(id)`. That column IS the conversation level:
  a memory that belongs to one conversation keeps its project AND its session_id, and a
  conversation-scoped read filters on it.

So three tiers are "which project value", and the fourth is "rows that came from this session".

ORDERING AND VISIBILITY
-----------------------
Tiers run widest -> narrowest, and a read at a tier also sees every wider tier. That is what "this
fact applies here too" means: a conversation read may surface a project decision, a global
preference, and a workspace convention; a global read must never leak project-private rows.

`include_wider=False` is available for callers that want exactly one level (a "what is global?"
report), but retrieval defaults to the cumulative behaviour because that is what makes a shared
fact usable.

RESERVED NAMES
--------------
Reserved scopes start with a colon, which `store.scope()` rejects for ordinary project names
(it only accepts [\\w-]), so a user can never create a project that collides with one of these.
"""
from .errors import InvalidInput

GLOBAL_SCOPE = ':global'
WORKSPACE_SCOPE = ':workspace'
USER_SCOPE = ':user'
RESERVED_SCOPES = (GLOBAL_SCOPE, WORKSPACE_SCOPE, USER_SCOPE)

# Ordered widest -> narrowest.
TIERS = ('global', 'workspace', 'project', 'conversation')

TIER_TITLES = {
    'global': ('全局', '所有项目共享的事实：用户身份、长期偏好、本地环境约定。'),
    'workspace': ('工作区', '当前工作区（一组相关项目）共用的事实；跨项目但不必全局。'),
    'project': ('项目', '当前项目的记忆；不含具体某次对话的临时细节。'),
    'conversation': ('对话', '只属于当前这次对话的临时记忆；换一个对话就看不到。'),
}

# Which stored `project` values a project-based tier reads. The conversation tier is not a
# project value: it is the current project narrowed by session_id, so it has no entry here.
TIER_SCOPES = {
    'global': (GLOBAL_SCOPE, USER_SCOPE),
    'workspace': (WORKSPACE_SCOPE,),
    'project': (),
    'conversation': (),
}

_TIER_ORDER = {tier: index for index, tier in enumerate(TIERS)}


def tier_of(project, session_id=None):
    """The tier a stored row belongs to, given its project and (optionally) its session."""
    if project in (GLOBAL_SCOPE, USER_SCOPE):
        return 'global'
    if project == WORKSPACE_SCOPE:
        return 'workspace'
    return 'conversation' if session_id else 'project'


def normalize_tier(value, default='project'):
    if value is None or value == '':
        return default
    if value not in TIERS:
        raise InvalidInput('tier must be one of ' + ', '.join(TIERS))
    return value


def scopes_for(project, tier='project', include_wider=True, session_id=None):
    """How a read at `tier` must be filtered.

    Returns {'tier', 'projects', 'session_id'}. `projects` is the set of `project` values to match
    (deduplicated, project last). `session_id` is non-None only for the conversation tier, where the
    query additionally pins the session column.

    A conversation read needs a session_id. Without one it cannot be narrower than the project
    level, so it degrades to project scope and says so in the returned dict — silently returning
    project rows while claiming to be conversation-scoped would be a lie the caller cannot see.
    """
    tier = normalize_tier(tier)
    projects = []
    if include_wider:
        for candidate in TIERS[:_TIER_ORDER[tier] + 1]:
            projects.extend(TIER_SCOPES[candidate])
    else:
        projects.extend(TIER_SCOPES[tier])
    if tier in ('project', 'conversation'):
        projects.append(project)
    # The conversation tier is project rows narrowed to one session; it adds no project value of
    # its own, so the project list is identical to the project tier's.
    seen = set()
    ordered = [name for name in projects if not (name in seen or seen.add(name))]

    pinned = session_id if tier == 'conversation' and session_id else None
    degraded = tier == 'conversation' and not session_id
    return {'tier': 'project' if degraded else tier, 'projects': ordered,
            'session_id': pinned, 'degraded_from': 'conversation' if degraded else None}


def describe(project, session_id=None):
    """Payload for the UI: the ladder, what each level holds, and what is visible right now."""
    tiers = []
    for tier in TIERS:
        title, description = TIER_TITLES[tier][0], TIER_TITLES[tier][1]
        plan = scopes_for(project, tier, session_id=session_id)
        tiers.append({'id': tier, 'title': title, 'description': description,
                      'scopes': plan['projects'],
                      'needs_session': tier == 'conversation',
                      'available': not (tier == 'conversation' and not session_id)})
    return {'project': project, 'session_id': session_id, 'tiers': tiers, 'default': 'project'}
