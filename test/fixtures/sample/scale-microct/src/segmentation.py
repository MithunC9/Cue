"""Segmentation of microCT volumes (FAKE TEST DATA)."""
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
# filler line 0 to make this file longer
# filler line 1 to make this file longer
# filler line 2 to make this file longer
# filler line 3 to make this file longer
# filler line 4 to make this file longer
# filler line 5 to make this file longer
# filler line 6 to make this file longer
# filler line 7 to make this file longer
# filler line 8 to make this file longer
# filler line 9 to make this file longer
# filler line 10 to make this file longer
# filler line 11 to make this file longer
# filler line 12 to make this file longer
# filler line 13 to make this file longer
# filler line 14 to make this file longer
# filler line 15 to make this file longer
# filler line 16 to make this file longer
# filler line 17 to make this file longer
# filler line 18 to make this file longer
# filler line 19 to make this file longer
# filler line 20 to make this file longer
# filler line 21 to make this file longer
# filler line 22 to make this file longer
# filler line 23 to make this file longer
# filler line 24 to make this file longer
# filler line 25 to make this file longer
# filler line 26 to make this file longer
# filler line 27 to make this file longer
# filler line 28 to make this file longer
# filler line 29 to make this file longer
# filler line 30 to make this file longer
# filler line 31 to make this file longer
# filler line 32 to make this file longer
# filler line 33 to make this file longer
# filler line 34 to make this file longer
# filler line 35 to make this file longer
# filler line 36 to make this file longer
# filler line 37 to make this file longer
# filler line 38 to make this file longer
# filler line 39 to make this file longer
# filler line 40 to make this file longer
# filler line 41 to make this file longer
# filler line 42 to make this file longer
# filler line 43 to make this file longer
# filler line 44 to make this file longer
# filler line 45 to make this file longer
# filler line 46 to make this file longer
# filler line 47 to make this file longer
# filler line 48 to make this file longer
# filler line 49 to make this file longer
# filler line 50 to make this file longer
# filler line 51 to make this file longer
# filler line 52 to make this file longer
# filler line 53 to make this file longer
# filler line 54 to make this file longer
# filler line 55 to make this file longer
# filler line 56 to make this file longer
# filler line 57 to make this file longer
# filler line 58 to make this file longer
# filler line 59 to make this file longer
# filler line 60 to make this file longer
# filler line 61 to make this file longer
# filler line 62 to make this file longer
# filler line 63 to make this file longer
# filler line 64 to make this file longer
# filler line 65 to make this file longer
# filler line 66 to make this file longer
# filler line 67 to make this file longer
# filler line 68 to make this file longer
# filler line 69 to make this file longer
# filler line 70 to make this file longer
# filler line 71 to make this file longer
# filler line 72 to make this file longer
# filler line 73 to make this file longer
# filler line 74 to make this file longer
# filler line 75 to make this file longer
# filler line 76 to make this file longer
# filler line 77 to make this file longer
# filler line 78 to make this file longer
# filler line 79 to make this file longer
# filler line 80 to make this file longer
# filler line 81 to make this file longer
# filler line 82 to make this file longer
# filler line 83 to make this file longer
# filler line 84 to make this file longer
# filler line 85 to make this file longer
# filler line 86 to make this file longer
# filler line 87 to make this file longer
# filler line 88 to make this file longer
# filler line 89 to make this file longer
# filler line 90 to make this file longer
# filler line 91 to make this file longer
# filler line 92 to make this file longer
# filler line 93 to make this file longer
# filler line 94 to make this file longer
# filler line 95 to make this file longer
# filler line 96 to make this file longer
# filler line 97 to make this file longer
# filler line 98 to make this file longer
# filler line 99 to make this file longer
# filler line 100 to make this file longer
# filler line 101 to make this file longer
# filler line 102 to make this file longer
# filler line 103 to make this file longer
# filler line 104 to make this file longer
# filler line 105 to make this file longer
# filler line 106 to make this file longer
# filler line 107 to make this file longer
# filler line 108 to make this file longer
# filler line 109 to make this file longer
# filler line 110 to make this file longer
# filler line 111 to make this file longer
# filler line 112 to make this file longer
# filler line 113 to make this file longer
# filler line 114 to make this file longer
# filler line 115 to make this file longer
# filler line 116 to make this file longer
# filler line 117 to make this file longer
# filler line 118 to make this file longer
# filler line 119 to make this file longer
# filler line 120 to make this file longer
# filler line 121 to make this file longer
# filler line 122 to make this file longer
# filler line 123 to make this file longer
# filler line 124 to make this file longer
# filler line 125 to make this file longer
# filler line 126 to make this file longer
# filler line 127 to make this file longer
# filler line 128 to make this file longer
# filler line 129 to make this file longer
# filler line 130 to make this file longer
# filler line 131 to make this file longer
# filler line 132 to make this file longer
# filler line 133 to make this file longer
# filler line 134 to make this file longer
# filler line 135 to make this file longer
# filler line 136 to make this file longer
# filler line 137 to make this file longer
# filler line 138 to make this file longer
# filler line 139 to make this file longer
# filler line 140 to make this file longer
# filler line 141 to make this file longer
# filler line 142 to make this file longer
# filler line 143 to make this file longer
# filler line 144 to make this file longer
# filler line 145 to make this file longer
# filler line 146 to make this file longer
# filler line 147 to make this file longer
# filler line 148 to make this file longer
# filler line 149 to make this file longer
# filler line 150 to make this file longer
# filler line 151 to make this file longer
# filler line 152 to make this file longer
# filler line 153 to make this file longer
# filler line 154 to make this file longer
# filler line 155 to make this file longer
# filler line 156 to make this file longer
# filler line 157 to make this file longer
# filler line 158 to make this file longer
# filler line 159 to make this file longer
# filler line 160 to make this file longer
# filler line 161 to make this file longer
# filler line 162 to make this file longer
# filler line 163 to make this file longer
# filler line 164 to make this file longer
# filler line 165 to make this file longer
# filler line 166 to make this file longer
# filler line 167 to make this file longer
# filler line 168 to make this file longer
# filler line 169 to make this file longer
# filler line 170 to make this file longer
# filler line 171 to make this file longer
# filler line 172 to make this file longer
# filler line 173 to make this file longer
# filler line 174 to make this file longer
# filler line 175 to make this file longer
# filler line 176 to make this file longer
# filler line 177 to make this file longer
# filler line 178 to make this file longer
# filler line 179 to make this file longer
# filler line 180 to make this file longer
# filler line 181 to make this file longer
# filler line 182 to make this file longer
# filler line 183 to make this file longer
# filler line 184 to make this file longer
# filler line 185 to make this file longer
# filler line 186 to make this file longer
# filler line 187 to make this file longer
# filler line 188 to make this file longer
# filler line 189 to make this file longer
# filler line 190 to make this file longer
# filler line 191 to make this file longer
# filler line 192 to make this file longer
# filler line 193 to make this file longer
# filler line 194 to make this file longer
# filler line 195 to make this file longer
# filler line 196 to make this file longer
# filler line 197 to make this file longer
# filler line 198 to make this file longer
# filler line 199 to make this file longer