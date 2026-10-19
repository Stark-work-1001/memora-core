"""Compatibility namespace for pre-1.0.2 integrations."""
from memora import __version__

# Re-exported on purpose: the pre-1.0.2 namespace exposed `memory_merge.__version__`, and older
# integrations read it from here. Listing it in __all__ says so to both a reader and a linter, and
# stops the import reading as leftover.
__all__ = ['__version__']
