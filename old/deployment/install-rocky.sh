#!/usr/bin/env bash
# Repeatable install confined to Memora's own user environment. Weights stay on the local disk.
set -euo pipefail
project_root="${MEMORA_PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
model_root="${MEMORA_MODEL_ROOT:?set MEMORA_MODEL_ROOT to the directory that holds the model weights}"
state_root="$HOME/.local/share/memora"
tag=b11695
[[ -f "$project_root/deployment/inference-rocky.lock.txt" ]] || { echo 'Project files missing'; exit 1; }
[[ -f "$model_root/Qwen3-Embedding-0.6B/model.safetensors" && -f "$model_root/Qwen3.8-2B-Q4_K_M.gguf" ]] || { echo 'Supply the two existing models first; no weights are downloaded.'; exit 1; }
for program in python3 cmake g++ curl tar; do command -v "$program" >/dev/null || { echo "Missing prerequisite: $program"; exit 1; }; done
cuda_root="${CUDA_HOME:-/usr/local/cuda-13.0}"
[[ -x "$cuda_root/bin/nvcc" ]] || { echo 'CUDA 13.0 compiler required; install it separately.'; exit 1; }
mkdir -p "$state_root" "$HOME/.config/systemd/user"
if [[ ! -x "$state_root/venv/bin/python" ]]; then python3 -m venv "$state_root/venv"; fi
"$state_root/venv/bin/python" -m pip install -r "$project_root/deployment/inference-rocky.lock.txt" --extra-index-url https://download.pytorch.org/whl/cu130
"$state_root/venv/bin/python" -m pip check
source_root="$state_root/source-$tag"
if [[ ! -f "$source_root/CMakeLists.txt" ]]; then
  archive="$project_root/artifacts/cache/llama-$tag-source.tar.gz"
  if [[ ! -f "$archive" ]]; then
    archive="$state_root/llama-$tag-source.tar.gz"
    curl --fail --location --proto '=https' --retry 3 "https://codeload.github.com/ggml-org/llama.cpp/tar.gz/refs/tags/$tag" -o "$archive"
  fi
  echo "6ad5750a1de4635253c01427776f8eb64a5c44cc428befcdf1febe8edba155c6  $archive" | sha256sum --check --status || { echo 'Pinned llama.cpp archive hash mismatch'; exit 1; }
  mkdir -p "$source_root"
  tar -xzf "$archive" -C "$source_root" --strip-components=1
fi
cmake -S "$source_root" -B "$source_root/build" -DGGML_CUDA=ON -DCMAKE_CUDA_COMPILER="$cuda_root/bin/nvcc" -DCMAKE_CUDA_ARCHITECTURES=120 -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build "$source_root/build" --target llama-server --parallel "${MEMORA_BUILD_JOBS:-4}"
for role in embedding judge; do
  cat > "$HOME/.config/systemd/user/memora-$role.service" <<EOF
[Unit]
Description=Memora local $role service
After=network.target
[Service]
Environment="MEMORA_PROJECT_ROOT=$project_root"
Environment="MEMORA_MODEL_ROOT=$model_root"
ExecStart=/bin/bash $project_root/deployment/start-$role.sh
Restart=on-failure
RestartSec=5
[Install]
WantedBy=default.target
EOF
done
systemctl --user daemon-reload
systemctl --user enable --now memora-embedding.service memora-judge.service
echo 'Installed. Use Windows Start-Memora.cmd to keep WSL alive and launch the application.'
