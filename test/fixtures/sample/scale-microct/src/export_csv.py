"""Per-slice CSV export (FAKE TEST DATA)."""
import csv


def export_per_slice_csv(mask, volume, path, voxel_um):
    """Write slice index, area (mm^2), porosity and mean intensity."""
    with open(path, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["slice", "area_mm2", "porosity", "mean_intensity"])
        for z in range(mask.shape[0]):
            area = mask[z].sum() * (voxel_um / 1000) ** 2
            wr.writerow([z, round(area, 4), round(1 - mask[z].mean(), 4), float(volume[z][mask[z]].mean())])
