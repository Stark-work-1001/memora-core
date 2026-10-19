"""Local-only OpenAI embedding endpoint for the supplied safetensors, running in WSL.

Last-token pooling follows the Qwen model card. Weights are never downloaded and
oversized input is rejected instead of being silently truncated.
"""
import argparse
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model', required=True); p.add_argument('--port', type=int, default=18181)
    p.add_argument('--max-tokens', type=int, default=8192); p.add_argument('--device', default='cuda')
    # Hard cap on this process's CUDA allocations, in MiB. The card is shared with other
    # work, and an unbounded embedding server will happily grow into whatever is free.
    # torch.cuda.set_per_process_memory_fraction enforces the limit at the allocator,
    # so exceeding it raises instead of silently starving the rest of the machine.
    p.add_argument('--max-gpu-mem', type=int, default=0, help='CUDA memory cap in MiB; 0 = no cap')
    p.add_argument('--max-batch', type=int, default=4, help='texts per forward pass')
    args = p.parse_args()
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
    import torch
    import torch.nn.functional as F
    from transformers import AutoModel, AutoTokenizer

    total_mib = None
    if args.device.startswith('cuda') and args.max_gpu_mem > 0:
        if not torch.cuda.is_available():
            raise SystemExit('--max-gpu-mem was given but CUDA is not available')
        total_mib = torch.cuda.get_device_properties(0).total_memory // (1024 * 1024)
        if args.max_gpu_mem >= total_mib:
            raise SystemExit('--max-gpu-mem %d MiB is not below the card total %d MiB'
                             % (args.max_gpu_mem, total_mib))
        fraction = args.max_gpu_mem / float(total_mib)
        torch.cuda.set_per_process_memory_fraction(fraction, 0)
        # Reduce fragmentation: expandable segments let a shrinking working set stay resident.
        os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
        print(json.dumps({'gpu_cap': {'requested_mib': args.max_gpu_mem,
                                       'card_total_mib': total_mib,
                                       'fraction': round(fraction, 4)}}), flush=True)
    tokenizer = AutoTokenizer.from_pretrained(args.model, padding_side='left', local_files_only=True, trust_remote_code=False)
    dtype = torch.float16 if args.device.startswith('cuda') else torch.float32
    model = AutoModel.from_pretrained(args.model, dtype=dtype, attn_implementation='sdpa', local_files_only=True, trust_remote_code=False).to(args.device).eval()
    lock = threading.Lock(); counters = {'requests': 0, 'tokens': 0, 'last_latency_ms': None}
    identity = {'id': 'qwen3-embedding-0.6b', 'object': 'model', 'owned_by': 'local', 'dimension': model.config.hidden_size}

    class Handler(BaseHTTPRequestHandler):
        def send(self, code, data):
            raw = json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_response(code); self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)

        def do_GET(self):
            if self.path == '/health': return self.send(200, {'status': 'ok', 'model': identity['id'], 'device': args.device, 'dimension': identity['dimension'], **counters})
            if self.path == '/v1/models': return self.send(200, {'object': 'list', 'data': [identity]})
            self.send(404, {'error': {'message': 'not found'}})

        def do_POST(self):
            if self.path != '/v1/embeddings': return self.send(404, {'error': {'message': 'not found'}})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 500000: raise ValueError('invalid request size')
                request = json.loads(self.rfile.read(size)); texts = request.get('input')
                if request.get('model') != identity['id']: raise ValueError('unknown model')
                if isinstance(texts, str): texts = [texts]
                if not isinstance(texts, list) or not 1 <= len(texts) <= 32 or any(not isinstance(t, str) or not t.strip() or len(t) > 20000 for t in texts):
                    raise ValueError('input must contain 1..32 non-empty texts, each <=20000 characters')
                started = time.monotonic(); embeddings = []; tokens = 0
                with lock, torch.inference_mode():
                    for offset in range(0, len(texts), max(1, args.max_batch)):
                        batch = tokenizer(texts[offset:offset + max(1, args.max_batch)], padding=True, truncation=False, return_tensors='pt')
                        if batch['input_ids'].shape[1] > args.max_tokens: raise ValueError('input exceeds token limit; split the document first')
                        tokens += int(batch['attention_mask'].sum())
                        batch = {k: v.to(args.device) for k, v in batch.items()}
                        hidden = model(**batch).last_hidden_state
                        # Left padding guarantees that the last column is the final non-padding token.
                        pooled = F.normalize(hidden[:, -1].float(), p=2, dim=1)
                        embeddings.extend(pooled.cpu().tolist())
                    counters.update(requests=counters['requests'] + 1, tokens=counters['tokens'] + tokens, last_latency_ms=round((time.monotonic() - started) * 1000, 2))
                self.send(200, {'object': 'list', 'model': identity['id'], 'data': [{'object': 'embedding', 'index': i, 'embedding': v} for i, v in enumerate(embeddings)], 'usage': {'prompt_tokens': tokens, 'total_tokens': tokens}})
            except (ValueError, KeyError, TypeError): self.send(400, {'error': {'message': 'invalid input, model name or token limit'}})
            except Exception as e:
                print('embedding failure:', type(e).__name__, flush=True)
                self.send(503, {'error': {'message': 'embedding unavailable; see local service log'}})

        def log_message(self, *args): pass

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(json.dumps({'ready': True, 'port': args.port, 'model': identity['id'], 'device': args.device,
                      'max_gpu_mem_mib': args.max_gpu_mem or None, 'max_batch': args.max_batch}), flush=True)
    server.serve_forever()


if __name__ == '__main__': main()
