#!/usr/bin/env bash
set -euo pipefail
model_root="${MEMORA_MODEL_ROOT:?set MEMORA_MODEL_ROOT to the directory that holds the model weights}"
runtime_root="$HOME/.local/share/memora/source-b11695/build/bin"
export LD_LIBRARY_PATH="$runtime_root:/usr/local/cuda-13.0/lib64:/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}"
exec "$runtime_root/llama-server" --model "$model_root/Qwen3.8-2B-Q4_K_M.gguf" \
    --alias qwen3.8-2b-judge --host 127.0.0.1 --port 18182 --n-gpu-layers 99 \
    --ctx-size 16384 --parallel 2 --batch-size 1024 --ubatch-size 256 \
    --jinja --chat-template-kwargs '{"enable_thinking":false}' --reasoning-budget 0 --flash-attn on
