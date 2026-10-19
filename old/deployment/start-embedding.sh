#!/usr/bin/env bash
set -euo pipefail
project_root="${MEMORA_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
model_root="${MEMORA_MODEL_ROOT:?set MEMORA_MODEL_ROOT to the directory that holds the model weights}"
private_python="$HOME/.local/share/memora/venv/bin/python"
python_runtime="${MEMORA_ML_PYTHON:-$private_python}"
[[ -x "$python_runtime" ]] || { echo 'Install the private inference environment with deployment/install-rocky.sh first.' >&2; exit 1; }
exec "$python_runtime" "$project_root/deployment/embedding_server.py" --model "$model_root/Qwen3-Embedding-0.6B" --port 18181 --device cuda --max-gpu-mem "${MEMORA_EMBED_GPU_MIB:-7500}" --max-batch "${MEMORA_EMBED_BATCH:-4}"
