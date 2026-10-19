"""Legacy full CLI; use python -m memora for the default application."""
# Named import, not `import *`: the wildcard re-exported every public name in memora.advanced, so a
# linter could not tell what this module provides and a reader could not either. `main` is the
# whole surface -- `python -m memory_merge` and the legacy test both call exactly that.
from memora.advanced import main

if __name__ == "__main__":
    main()
