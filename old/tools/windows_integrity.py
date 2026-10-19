"""Inspect Windows mandatory labels separately from artifact content hashes."""
import ctypes
from ctypes import wintypes
from pathlib import Path


def integrity_level(path):
    """Return the mandatory-label RID (an absent label means Medium)."""
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pointer = ctypes.c_void_p
    advapi.GetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                                            pointer, pointer, pointer, ctypes.POINTER(pointer), ctypes.POINTER(pointer)]
    advapi.GetNamedSecurityInfoW.restype = wintypes.DWORD
    advapi.GetAce.argtypes = [pointer, wintypes.DWORD, ctypes.POINTER(pointer)]
    advapi.GetAce.restype = wintypes.BOOL
    advapi.GetSidSubAuthorityCount.argtypes = [pointer]
    advapi.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
    advapi.GetSidSubAuthority.argtypes = [pointer, wintypes.DWORD]
    advapi.GetSidSubAuthority.restype = ctypes.POINTER(wintypes.DWORD)
    kernel.LocalFree.argtypes = [pointer]
    kernel.LocalFree.restype = pointer
    sacl, descriptor = pointer(), pointer()
    error = advapi.GetNamedSecurityInfoW(str(Path(path)), 1, 0x10, None, None, None,
                                        ctypes.byref(sacl), ctypes.byref(descriptor))
    if error:
        raise ctypes.WinError(error)
    try:
        if sacl.value:
            count = ctypes.c_ushort.from_address(sacl.value + 4).value
            for index in range(count):
                ace = pointer()
                if not advapi.GetAce(sacl, index, ctypes.byref(ace)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if ctypes.c_ubyte.from_address(ace.value).value == 0x11:
                    sid = pointer(ace.value + 8)
                    last = advapi.GetSidSubAuthorityCount(sid).contents.value - 1
                    return advapi.GetSidSubAuthority(sid, last).contents.value
        return 8192
    finally:
        kernel.LocalFree(descriptor)


def inspect_program_labels(directory):
    root = Path(directory)
    paths = [root, *(p for p in root.iterdir() if p.is_file())]
    for name in ('resources', 'locales'):
        folder = root / name
        if folder.exists():
            paths.extend([folder, *folder.rglob('*')])
    bad = [str(p.relative_to(root)) for p in paths if integrity_level(p) != 8192]
    if bad:
        raise RuntimeError('Application files must have Medium integrity: ' + repr(bad[:12]))
    return {'checked_paths': len(paths), 'mandatory_integrity': 'Medium', 'data_folders_excluded': True}
