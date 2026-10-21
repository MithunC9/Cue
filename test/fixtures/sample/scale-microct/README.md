# scale-microct (FAKE TEST DATA)

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
