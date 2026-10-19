"""Bind verification to the complete desktop tree, including assets and guides."""
import hashlib


def tree_sha256(root):
    digest = hashlib.sha256()
    for file in sorted(root.rglob('*'), key=lambda p: p.relative_to(root).as_posix()):
        if file.is_symlink(): raise ValueError('Unexpected symlink in desktop artifact')
        if not file.is_file(): continue
        checksum = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''): checksum.update(block)
        digest.update(file.relative_to(root).as_posix().encode('utf-8') + b'\0' + checksum.digest())
    return digest.hexdigest()
