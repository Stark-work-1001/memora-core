"""One-time namespace absorption; retained as a record of the 1.0.2 refactor."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    package = ROOT / 'memora'
    compatibility = ROOT / 'memory_merge'
    compatibility.mkdir(exist_ok=True)
    for path in package.glob('*.py'):
        if path.stem in {'__main__', '__init__', 'advanced'}: continue
        # Cross-package absolute imports must point into the absorbed implementation.
        source = path.read_text('utf-8').replace('from memory_merge.', 'from memora.').replace('import memory_merge.', 'import memora.')
        source = source.replace("logging.getLogger('memory_merge.", "logging.getLogger('memora.")
        path.write_text(source, 'utf-8')
        shim = ('"""Legacy import alias; implementation lives in memora."""\n'
                'import importlib\nimport sys\n'
                f'if __name__ == "__main__":\n    importlib.import_module("memora.{path.stem}").main()\n'
                f'else:\n    sys.modules[__name__] = importlib.import_module("memora.{path.stem}")\n')
        (compatibility / path.name).write_text(shim, 'utf-8')
    (compatibility / '__init__.py').write_text('"""Compatibility namespace for pre-1.0.2 integrations."""\nfrom memora import __version__\n', 'utf-8')
    (compatibility / '__main__.py').write_text('"""Legacy full CLI; use python -m memora for the default application."""\nfrom memora.advanced import *\nif __name__ == "__main__": main()\n', 'utf-8')
    (package / '__init__.py').write_text('"""Memora: agent-connected retrieval, classification and durable memory."""\n__version__ = "1.0.2"\n', 'utf-8')
    path = ROOT / 'pyproject.toml'
    s = path.read_text('utf-8').replace('memory_merge/__init__.py', 'memora/__init__.py')
    s = s.replace('Memora: local-first memory entity, model assembly, agent archives, MCP and dual 3D knowledge views', 'Memora: agent memory retrieval, classification, Markdown and knowledge graphs')
    s = s.replace('memora = "memory_merge.__main__:main"', 'memora = "memora.__main__:main"')
    s = s.replace('memora-mcp = "memory_merge.server:main"', 'memora-mcp = "memora.mcp:main"')
    s = s.replace('memory_merge.__version__', 'memora.__version__').replace('include = ["memory_merge*"]', 'include = ["memora*", "memory_merge*"]')
    s = s.replace('memory_merge = ["static/', 'memora = ["static/')
    path.write_text(s, 'utf-8')
    for name in ('Cargo.toml', 'Cargo.lock', 'pyproject.toml', 'src/lib.rs'):
        path = ROOT / 'native' / name
        s = path.read_text('utf-8').replace('memory_merge_native', 'memora_native').replace('memory-merge-native', 'memora-native')
        s = s.replace('version = "1.0.1"', 'version = "1.0.2"').replace('for Memory Merge', 'for Memora')
        path.write_text(s, 'utf-8')
    path = package / 'vectors.py'
    path.write_text(path.read_text('utf-8').replace('memory_merge_native', 'memora_native'), 'utf-8')
    for name in ('package.json', 'package-lock.json'):
        path = ROOT / 'desktop' / name
        s = path.read_text('utf-8').replace('"version": "1.0.1"', '"version": "1.0.2"')
        if name == 'package.json': s = s.replace('"output": "release"', '"output": "../dist/desktop"')
        path.write_text(s, 'utf-8')
    path = ROOT / 'desktop' / 'main.cjs'
    s = path.read_text('utf-8').replace('process.env.MM_DATA||', 'process.env.MEMORA_DATA||process.env.MM_DATA||')
    s = s.replace("args=['-m','memory_merge']", "args=['-m','memora']").replace("'agent','--port'", "'serve','--port'")
    path.write_text(s, 'utf-8')
    path = ROOT / 'start-memora.ps1'
    path.write_text(path.read_text('utf-8').replace('-m memory_merge', '-m memora').replace(' agent --port', ' serve --port'), 'utf-8')

if __name__ == '__main__': main()
