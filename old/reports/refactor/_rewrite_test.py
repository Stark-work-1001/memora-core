"""Replace the old anchor-link contract class with the in-page view contract."""
import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

p = REPO / 'tests' / 'test_release_consistency.py'
text = p.read_text('utf-8')
start = text.index('class CanvasIsReachableFromTheNav(unittest.TestCase):')
end = text.index("if __name__ == '__main__':")

new = '''class CanvasIsAViewNotASeparatePage(unittest.TestCase):
    """The workflow canvas must be a workbench VIEW, reachable from the sidebar.

    This class used to assert the opposite design: the canvas was a standalone page at /dag/,
    reached by an <a data-canvas> in the nav, and every rule here existed to keep that link a real
    link (served route, directory-rooted, project query). That design was the bug users reported:
    clicking 工作流画布 left the workbench, the sidebar vanished, and the only way back was the
    Back button or a link the page had to provide itself.

    The canvas is now <section id="workflows"> inside <main>, switched by the same mechanism as
    every other view, with the DAG bundle embedded into it by dag-embed.js. These assertions
    encode that: an in-page section, a data-view nav button, and a served embed script. The
    standalone /dag/ route is kept only as a compatibility entry point and is asserted to survive.
    """

    def nav(self):
        html = read(HTML)
        return html[html.index('<nav'):html.index('</nav>')]

    def test_the_entry_is_a_view_button(self):
        """show() binds 'nav button' and toggles .active by data-view; an <a> is never a view."""
        entry = re.search(r'<button\\b[^>]*\\bdata-view="workflows"[^>]*>', self.nav())
        self.assertIsNotNone(entry, 'memory.html has no nav button for the workflows view')
        self.assertNotIn('<a', self.nav(), 'the sidebar must not link away to a separate page')

    def test_the_view_section_exists_in_the_document(self):
        """A data-view button with no matching <section> is a dead click."""
        html = read(HTML)
        self.assertRegex(html, r'<section\\s+id="workflows"\\s+class="view"',
                         'memory.html has no <section id="workflows" class="view"> for the canvas')
        self.assertIn('id="workflow-visual"', html,
                      'the canvas needs a mount point inside the workflows section')

    def test_the_embed_script_is_served(self):
        """memora/web.py dispatches on 'parsed.path in assets' EXACTLY, so an unserved path 404s."""
        self.assertIn('/dag-embed.js', workbench.ASSETS,
                      'memory.html loads /dag-embed.js but the server has no ASSETS entry for it')
        name, mime = workbench.ASSETS['/dag-embed.js']
        self.assertEqual(name, 'dag-embed.js')
        self.assertEqual(mime, 'text/javascript')
        self.assertTrue(os.path.isfile(os.path.join(ROOT, 'memora', 'static', 'dag-embed.js')),
                        'ASSETS serves dag-embed.js but the file does not exist')
        self.assertRegex(read(HTML), r'<script[^>]+src="/dag-embed\\.js"',
                         'memory.html does not load the embed script, so no canvas renders')

    def test_the_canvas_bundle_and_stylesheet_are_served(self):
        """The embedded canvas fetches these at runtime; both must be real served routes."""
        for path, name in (('/dag/app.js', 'dag/app.js'), ('/dag/styles.css', 'dag/styles.css')):
            self.assertIn(path, workbench.ASSETS, '%s is not a served route' % path)
            self.assertEqual(workbench.ASSETS[path][0], name)
        embed = read(os.path.join(ROOT, 'memora', 'static', 'dag-embed.js'))
        self.assertIn('/dag/styles.css', embed, 'the embed loader must add the canvas stylesheet')
        self.assertIn('/dag/app.js', embed, 'the embed loader must load the canvas bundle')

    def test_the_standalone_page_is_still_served_for_old_bookmarks(self):
        name, mime = workbench.ASSETS['/dag']
        self.assertEqual(name, 'dag/index.html')
        self.assertEqual(mime, 'text/html')
        self.assertTrue(os.path.isfile(os.path.join(ROOT, 'memora', 'static', 'dag', 'index.html')),
                        'ASSETS serves dag/index.html but the file does not exist')

    def test_the_canvas_requests_only_served_routes(self):
        """Every URL the standalone document requests must itself be a served ASSETS route.

        Absolute and relative references both appear in real pages, so this asserts the OUTCOME --
        each requested URL resolves to something the server actually serves -- rather than one
        spelling of the fix. A broken one is how the canvas arrived unstyled with a dead script,
        verified in a real browser.
        """
        page = read(os.path.join(ROOT, 'memora', 'static', 'dag', 'index.html'))
        refs = re.findall(r'(?:href|src)="([^"]+)"', page)
        self.assertTrue(refs, 'the canvas requests no stylesheet or script; the parser is wrong')
        for ref in refs:
            resolved = ref.split('?')[0].split('#')[0]
            self.assertTrue(resolved.startswith('/'),
                            'the canvas requests the relative URL %r; it must be absolute so it '
                            'resolves from every path the server exposes' % ref)
            self.assertIn(resolved, workbench.ASSETS,
                          'the canvas requests %r, which is not a served route' % resolved)

    def test_the_canvas_entry_sits_with_its_neighbours(self):
        nav = self.nav()
        entries = re.findall(r'<(?:button|a)\\b[^>]*>(.*?)</(?:button|a)>', nav, re.S)
        self.assertGreaterEqual(len(entries), 7,
                                'the nav lost entries; expected 7 view buttons')
        last = entries[-1]
        self.assertRegex(last, r'[\\u4e00-\\u9fff]',
                         'the workflows label %r has no Chinese text, unlike its neighbours' % last)
        self.assertRegex(last, r'<span>\\d+</span>',
                         'the workflows label %r lacks the <span>NN</span> ordinal its neighbours '
                         'carry' % last)

    def test_no_second_nav_entry_is_injected_at_runtime(self):
        """orchestration.js must fill the existing view, not append its own nav entry or section.

        It appended both (a button and a <section>) before this change, which is how the canvas
        and the orchestration panels became two unrelated destinations.
        """
        js = read(os.path.join(ROOT, 'memora', 'static', 'orchestration.js'))
        self.assertNotIn("document.querySelector('nav').append", js,
                         'orchestration.js still injects its own sidebar entry')
        self.assertNotIn("document.querySelector('main').append", js,
                         'orchestration.js still injects its own view section')
        self.assertIn('workflow-visual', js,
                      'orchestration.js must fill #workflow-visual inside the workflows view')


'''
p.write_text(text[:start] + new + text[end:], 'utf-8')
print('rewritten')
