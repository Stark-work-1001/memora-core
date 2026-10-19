"""Point the static harness at the real status() shape: keys[role].key_set, not a bare map."""
import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

p = REPO / 'tests' / 'test_model_connect_ui_static.py'
text = p.read_text('utf-8')

# The harness used to override a top-level `key_set: {role: bool}` map that the server never sent.
# Mirror the real payload instead: keys/ (authoritative) and settings[role].key_set (convenience).
replacements = [
    (
        "let area = await render({key_set: {embedding: true, judge: false}});",
        "let area = await render({keys: {embedding: {key_set: true, source: 'literal'},\n"
        "                                judge: {key_set: false, source: null}},\n"
        "                           settings: {embedding: role({key_set: true}), judge: role({key_set: false})}});",
    ),
    (
        "  area = await render({});                    // backend reports no key_set at all",
        "  // Backend reports neither shape: the page must say 未知 rather than guess 未配置.\n"
        "  area = await render({keys: {}, settings: {embedding: role({}), judge: role({})}});",
    ),
    (
        "  area = await render({key_set: {embedding: true, judge: true}});",
        "  area = await render({keys: {embedding: {key_set: true, source: 'literal'},\n"
        "                              judge: {key_set: true, source: 'literal'}},\n"
        "                         settings: {embedding: role({key_set: true}), judge: role({key_set: true})}});",
    ),
    (
        "  area = await render({});",
        "  area = await render({keys: {}, settings: {embedding: role({}), judge: role({})}});",
    ),
]

for old, new in replacements:
    if old not in text:
        print('MISS:', old[:70])
        continue
    count = text.count(old)
    text = text.replace(old, new)
    print('replaced %dx: %s' % (count, old[:60]))

p.write_text(text, 'utf-8')
print('done')
