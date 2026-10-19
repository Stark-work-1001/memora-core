"""Legacy import alias; implementation lives in memora."""
import importlib
import sys

if __name__ == "__main__":
    importlib.import_module("memora.vectors").main()
else:
    sys.modules[__name__] = importlib.import_module("memora.vectors")
