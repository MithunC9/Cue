"""DICOM loading with physical units (FAKE TEST DATA)."""
import json
import numpy as np
import pydicom


def load_dicom_stack(folder, sidecar=None, mmap_path=None):
    """Load a DICOM series into a (z, y, x) array, memory-mapped if mmap_path is given."""
    files = sorted(f for f in __import__("os").listdir(folder) if f.endswith(".dcm"))
    first = pydicom.dcmread(f"{folder}/{files[0]}")
    shape = (len(files), first.Rows, first.Columns)
    vol = np.memmap(mmap_path, dtype=np.int16, mode="w+", shape=shape) if mmap_path else np.empty(shape, np.int16)
    for i, f in enumerate(files):
        vol[i] = pydicom.dcmread(f"{folder}/{f}").pixel_array
    voxel_um = json.load(open(sidecar))["voxel_size_um"] if sidecar else None
    return vol, voxel_um
