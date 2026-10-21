"""Builds a FAKE microCT project for testing `npm run prep` (python-pptx, python-docx, reportlab).

Everything here is invented test data. Usage: python test/fixtures/make_fixtures.py <out_dir>
"""
import json
import os
import sys
from datetime import datetime, timedelta

from docx import Document
from pptx import Presentation
from pptx.util import Inches
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

out = os.path.abspath(sys.argv[1])
repo = os.path.join(out, "scale-microct")


def w(path, text, encoding="utf-8"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding=encoding, newline="\n") as f:
        f.write(text)


# ---------------- repo ----------------
w(os.path.join(repo, "README.md"), """# scale-microct (FAKE TEST DATA)

Pipeline for segmenting microCT scans of compressed tissue samples from the SCANCO microCT100HE.

## Stages
1. `load_dicom_stack()` reads DICOM series (pydicom) and converts to physical units using the
   voxel size from the JSON sidecar (isotropic 10.0 um in our test scans).
2. `segment_volume()` applies Gaussian smoothing (sigma=1.0) then Otsu thresholding per slice.
3. `export_per_slice_csv()` writes area, porosity and mean intensity per slice.
4. Compression-state registration aligns the uncompressed scan to the TD-309 compressed scan.

Memory-mapped loading (`np.memmap`) keeps the 2048-slice volumes (about 16 GB) out of RAM.
Runtime on the lab workstation: about 6 minutes per sample.

Next: export a tetrahedral mesh for Abaqus FEM.
""")
w(os.path.join(repo, "src", "segmentation.py"), '''"""Segmentation of microCT volumes (FAKE TEST DATA)."""
import numpy as np
from scipy import ndimage
from skimage.filters import threshold_otsu

SIGMA = 1.0  # Gaussian smoothing before thresholding
MIN_OBJECT_VOXELS = 64


def segment_volume(volume, roi=None):
    """Segment a 3D volume slice by slice with Otsu thresholding.

    I chose per-slice Otsu instead of a single global threshold because beam hardening makes the
    top slices darker than the bottom ones.
    """
    if roi is not None:
        volume = crop_roi(volume, roi)
    smoothed = ndimage.gaussian_filter(volume, SIGMA)
    mask = np.zeros(volume.shape, dtype=bool)
    for z in range(volume.shape[0]):
        t = threshold_otsu(smoothed[z])
        mask[z] = smoothed[z] > t
    return remove_small(mask)


def crop_roi(volume, roi):
    """Crop to (z0, z1, y0, y1, x0, x1)."""
    z0, z1, y0, y1, x0, x1 = roi
    return volume[z0:z1, y0:y1, x0:x1]


def remove_small(mask):
    labels, n = ndimage.label(mask)
    sizes = ndimage.sum(mask, labels, range(1, n + 1))
    keep = np.isin(labels, np.where(sizes >= MIN_OBJECT_VOXELS)[0] + 1)
    return keep
''' + "\n".join(f"# filler line {i} to make this file longer" for i in range(200)))
w(os.path.join(repo, "src", "dicom_io.py"), '''"""DICOM loading with physical units (FAKE TEST DATA)."""
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
''')
w(os.path.join(repo, "src", "export_csv.py"), '''"""Per-slice CSV export (FAKE TEST DATA)."""
import csv


def export_per_slice_csv(mask, volume, path, voxel_um):
    """Write slice index, area (mm^2), porosity and mean intensity."""
    with open(path, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["slice", "area_mm2", "porosity", "mean_intensity"])
        for z in range(mask.shape[0]):
            area = mask[z].sum() * (voxel_um / 1000) ** 2
            wr.writerow([z, round(area, 4), round(1 - mask[z].mean(), 4), float(volume[z][mask[z]].mean())])
''')
w(os.path.join(repo, "results", "sample01_per_slice.csv"), "slice,area_mm2,porosity,mean_intensity\n" + "\n".join(f"{i},{3.1 + i * 0.001:.4f},{0.21:.4f},{812 + i % 7}" for i in range(2048)))
w(os.path.join(repo, "data", "sidecars", "sample01.json"), json.dumps({"sample": "sample01", "scanner": "SCANCO microCT100HE", "voxel_size_um": 10.0, "energy_kVp": 70, "compression_state": "uncompressed"}, indent=2))
for s in ("sample01", "sample02"):
    d = os.path.join(repo, "data", "raw", s)
    os.makedirs(d, exist_ok=True)
    for i in range(12):
        with open(os.path.join(d, f"IM_{i:04d}.dcm"), "wb") as f:
            f.write(b"\x00" * 128 + b"DICM" + bytes(256))
with open(os.path.join(repo, "data", "raw", "sample01_full.aim"), "wb") as f:
    f.write(bytes(4096))
if "--big" in sys.argv:
    with open(os.path.join(repo, "data", "big_unknown.bin2"), "wb") as f:
        f.write(os.urandom(3 * 1024 * 1024))
w(os.path.join(repo, ".git", "config"), "[core]\n")
w(os.path.join(repo, "node_modules", "x", "index.js"), "module.exports = 1\n")
w(os.path.join(repo, "venv", "lib", "site.py"), "print('venv')\n")
w(os.path.join(repo, "package-lock.json"), "{}")
nb = {
    "cells": [
        {"cell_type": "markdown", "source": ["# Exploring sample01 (FAKE TEST DATA)\n", "Checking porosity distribution."]},
        {"cell_type": "code", "source": ["import pandas as pd\n", "df = pd.read_csv('results/sample01_per_slice.csv')\n", "df.porosity.mean()"],
         "outputs": [{"output_type": "execute_result", "data": {"text/plain": ["0.2104"]}}]},
        {"cell_type": "code", "source": ["%time segment_volume(vol)"], "outputs": [{"output_type": "stream", "text": ["Wall time: 5min 52s\n"]}]},
    ],
    "metadata": {}, "nbformat": 4, "nbformat_minor": 5,
}
w(os.path.join(repo, "notebooks", "explore.ipynb"), json.dumps(nb))

# ---------------- docs ----------------
docs = os.path.join(out, "lab notes")
os.makedirs(docs, exist_ok=True)
doc = Document()
doc.add_heading("Lab notebook (FAKE TEST DATA)", 1)
doc.add_paragraph("2026-09-03: Prof. asked for validation of the segmentation against manual tracing.")
doc.add_paragraph("Manual tracing of 20 slices by the lab tech gave a Dice score of 0.91 against my Otsu masks.")
doc.add_heading("TD-309 compression", 2)
doc.add_paragraph("The TD-309 device was set up by the lab (not me). Compression steps: 0%, 10%, 20% strain.", style="List Bullet")
doc.save(os.path.join(docs, "lab_notebook.docx"))
c = canvas.Canvas(os.path.join(docs, "background_paper.pdf"), pagesize=letter)
c.drawString(72, 720, "Background paper (FAKE TEST DATA): microCT-based finite element models of bone.")
c.drawString(72, 700, "FEM meshes are typically generated with voxel-to-element conversion.")
c.showPage()
c.drawString(72, 720, "Page 2: Abaqus C3D4 tetrahedral elements are common for trabecular bone.")
c.save()
w(os.path.join(docs, "meeting_prep.md"), "# Questions I expect (FAKE TEST DATA)\n- Why Otsu?\n- How do you handle beam hardening?\n")
w(os.path.join(docs, "old_notes_utf16.txt"), "Registration uses rigid ICP between compression states (FAKE TEST DATA).\n", encoding="utf-16")

# ---------------- deck ----------------
prs = Presentation()
slides = [
    ("microCT Pipeline Progress (FAKE)", "Mithun · SCALE Lab", "Introduce myself and the goal."),
    ("Pipeline overview", "DICOM loading → segmentation → per-slice CSV → registration", "Walk through the four stages."),
    ("Segmentation", "Per-slice Otsu after Gaussian smoothing\nDice 0.91 vs manual tracing", "Mention beam hardening as the reason."),
    ("Compression states", "TD-309 at 0/10/20% strain\nRigid ICP registration", "The lab set up the TD-309."),
    ("Next steps: Abaqus FEM", "Tetrahedral mesh export\nMaterial properties from intensity", "Ask about element type."),
]
for title, body, notes in slides:
    s = prs.slides.add_slide(prs.slide_layouts[1])
    s.shapes.title.text = title
    s.placeholders[1].text = body
    s.notes_slide.notes_text_frame.text = notes
prs.save(os.path.join(out, "progress_update.pptx"))

# ---------------- chats ----------------
cc = os.path.join(out, "claude-projects", "C--Users-Mithun-code-scale-microct")
os.makedirs(cc, exist_ok=True)
t = datetime(2026, 9, 10, 14, 0)
recs = [
    {"type": "summary", "summary": "Memory mapping for large DICOM stacks"},
    {"type": "user", "cwd": "C:\\Users\\Mithun\\code\\scale-microct", "timestamp": t.isoformat() + "Z", "message": {"role": "user", "content": "My 2048-slice volume crashes with MemoryError on my 16 GB laptop. How do I load it?"}},
    {"type": "assistant", "timestamp": (t + timedelta(seconds=20)).isoformat() + "Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "Use np.memmap so slices are paged from disk instead of loaded into RAM."}, {"type": "tool_use", "name": "Edit", "input": {"file_path": "src/dicom_io.py"}}]}},
    {"type": "user", "timestamp": (t + timedelta(seconds=40)).isoformat() + "Z", "message": {"role": "user", "content": [{"type": "tool_result", "content": "File edited: 300 lines of output..."}]}},
    {"type": "assistant", "timestamp": (t + timedelta(seconds=50)).isoformat() + "Z", "message": {"role": "assistant", "content": [{"type": "text", "text": "Here is the diff:\n```diff\n--- a/src/dicom_io.py\n+++ b/src/dicom_io.py\n@@ -1 +1 @@\n-x\n+y\n```"}]}},
    {"type": "user", "timestamp": (t + timedelta(minutes=5)).isoformat() + "Z", "message": {"role": "user", "content": "<system-reminder>noise</system-reminder>That worked, I decided to keep memmap for all samples. Loading now takes 40 s instead of crashing."}},
]
w(os.path.join(cc, "a1b2c3d4-session.jsonl"), "\n".join(json.dumps(r) for r in recs) + "\n")
w(os.path.join(cc, "unrelated-session.jsonl"), json.dumps({"type": "user", "cwd": "C:\\Users\\Mithun\\games", "timestamp": "2026-08-01T10:00:00Z", "message": {"role": "user", "content": "Help me with my history essay about Rome."}}) + "\n")

codex = os.path.join(out, "codex-sessions", "2026", "09", "20")
os.makedirs(codex, exist_ok=True)
lines = [
    {"timestamp": "2026-09-20T18:00:00Z", "type": "session_meta", "payload": {"id": "cdx1", "cwd": "C:\\Users\\Mithun\\code\\scale-microct", "timestamp": "2026-09-20T18:00:00Z"}},
    {"timestamp": "2026-09-20T18:00:05Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>cwd</environment_context>Should I use rigid or affine registration between compression states?"}]}},
    {"timestamp": "2026-09-20T18:00:30Z", "type": "response_item", "payload": {"type": "function_call", "name": "shell", "arguments": "{}"}},
    {"timestamp": "2026-09-20T18:01:00Z", "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Rigid ICP first; affine would absorb the compression strain you want to measure."}]}},
    {"timestamp": "2026-09-20T18:03:00Z", "type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Ok going with rigid ICP so the strain stays measurable."}]}},
]
w(os.path.join(codex, "rollout-2026-09-20-cdx1.jsonl"), "\n".join(json.dumps(r) for r in lines) + "\n")

chatgpt = [{
    "title": "DICOM vs TIFF for microCT", "create_time": 1756000000, "id": "gpt1",
    "mapping": {
        "a": {"message": {"author": {"role": "user"}, "content": {"content_type": "text", "parts": ["Should my microCT pipeline support DICOM or just TIFF stacks from the SCANCO export?"]}, "create_time": 1756000000}},
        "b": {"message": {"author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["Support DICOM: it carries voxel spacing metadata."]}, "create_time": 1756000060}},
    },
}, {
    "title": "Cookie recipe", "create_time": 1756100000, "id": "gpt2",
    "mapping": {"a": {"message": {"author": {"role": "user"}, "content": {"content_type": "text", "parts": ["Best chocolate chip cookie recipe?"]}, "create_time": 1756100000}}},
}]
w(os.path.join(out, "chatgpt-export", "conversations.json"), json.dumps(chatgpt))
claude_ai = [{"uuid": "cai1", "name": "Abaqus element choice", "created_at": "2026-10-01T12:00:00Z", "chat_messages": [
    {"sender": "human", "text": "For Abaqus FEM of my segmented microCT volume, C3D4 or C3D8?", "created_at": "2026-10-01T12:00:00Z"},
    {"sender": "assistant", "text": "C3D4 tets mesh complex geometry more easily; voxel C3D8 is simpler but jagged.", "created_at": "2026-10-01T12:00:30Z"},
]}]
w(os.path.join(out, "claude-export.json"), json.dumps(claude_ai))
print("fixtures written to", out)
