#!/usr/bin/env python3
"""
Visualize COCO bounding boxes for images in a folder.

Usage:
  python visualize_coco_bboxes.py /path/to/folder --show
  python visualize_coco_bboxes.py /path/to/folder --save /path/to/outdir
  python visualize_coco_bboxes.py /path/to/folder --show --save /tmp/overlays
"""

import argparse
import json
import sys
from pathlib import Path
from collections import defaultdict

import matplotlib.pyplot as plt
import matplotlib.patches as patches
from PIL import Image

def find_coco_json(folder: Path) -> Path:
    """Find exactly one JSON file in folder."""
    jsons = list(folder.glob("*.json"))
    if len(jsons) == 0:
        raise FileNotFoundError(f"No .json file found in {folder}")
    if len(jsons) > 1:
        # If multiple, prefer common COCO names; otherwise error.
        preferred = [p for p in jsons if p.name in ("annotations.json", "coco.json")]
        if len(preferred) == 1:
            return preferred[0]
        raise RuntimeError(
            f"Multiple .json files found: {', '.join(p.name for p in jsons)}. "
            "Keep only one or rename the desired file to 'annotations.json'."
        )
    return jsons[0]

def load_coco(coco_path: Path) -> dict:
    with coco_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    # Basic validation
    for key in ("images", "annotations", "categories"):
        if key not in data:
            raise ValueError(f"COCO file missing '{key}' section")
    return data

def build_indices(coco: dict):
    """Build lookups for quick joins."""
    images_by_id = {img["id"]: img for img in coco["images"]}
    anns_by_image = defaultdict(list)
    for ann in coco["annotations"]:
        anns_by_image[ann["image_id"]].append(ann)
    categories_by_id = {cat["id"]: cat for cat in coco["categories"]}
    return images_by_id, anns_by_image, categories_by_id

def category_color_map(categories_by_id: dict):
    """Map category_id -> a stable color from matplotlib's tab20 cycle."""
    import itertools
    colors = plt.rcParams['axes.prop_cycle'].by_key().get('color', None)
    if not colors:
        # Fallback palette
        colors = [f"C{i}" for i in range(10)]
    cyc = itertools.cycle(colors)
    mapping = {}
    for cid in sorted(categories_by_id.keys()):
        mapping[cid] = next(cyc)
    return mapping

def draw_image_with_bboxes(img_path: Path, anns: list, categories_by_id: dict, color_map: dict, dpi=120):
    """Return a matplotlib Figure with the image and its bboxes drawn."""
    # Load image
    try:
        im = Image.open(img_path).convert("RGB")
    except Exception as e:
        raise RuntimeError(f"Failed to open image '{img_path}': {e}")

    fig = plt.figure(figsize=(im.width / dpi, im.height / dpi), dpi=dpi)
    ax = plt.axes([0, 0, 1, 1])  # full-bleed axes
    ax.imshow(im)
    ax.axis("off")

    for ann in anns:
        # COCO bbox format: [x, y, width, height]
        x, y, w, h = ann["bbox"]
        cat_id = ann.get("category_id")
        color = color_map.get(cat_id, "white")
        rect = patches.Rectangle(
            (x, y), w, h,
            linewidth=max(1.5, min(im.width, im.height) * 0.002),
            edgecolor=color,
            facecolor="none"
        )
        ax.add_patch(rect)

        # Label (category name + annotation id)
        cat_name = categories_by_id.get(cat_id, {}).get("name", str(cat_id))
        label = f"{cat_name}#{ann.get('id', '')}".strip("#")
        # Draw a small filled box behind text for legibility
        txt_bg = patches.FancyBboxPatch(
            (x, max(0, y - 18)),
            max(40, len(label) * 7), 18,
            boxstyle="round,pad=0.2,rounding_size=2",
            linewidth=0,
            facecolor=color,
            alpha=0.8
        )
        ax.add_patch(txt_bg)
        ax.text(
            x + 4, max(12, y - 4),
            label,
            fontsize=9,
            color="black",
            va="center",
            ha="left",
            fontweight="bold"
        )

    return fig

def main():
    parser = argparse.ArgumentParser(description="Visualize COCO bboxes in a folder.")
    parser.add_argument("folder", type=Path, help="Folder containing 1 COCO JSON and the images")
    parser.add_argument("--show", action="store_true", help="Show images interactively")
    parser.add_argument("--save", type=Path, default=None, help="Directory to save overlay images (PNG)")
    parser.add_argument("--subset", type=str, default=None,
                        help="Optional comma-separated image file names to limit visualization (e.g., 'img1.png,img2.jpg')")
    parser.add_argument("--dpi", type=int, default=120, help="Figure DPI for rendering")
    args = parser.parse_args()

    folder: Path = args.folder
    if not folder.exists() or not folder.is_dir():
        print(f"Error: folder '{folder}' does not exist or is not a directory.", file=sys.stderr)
        sys.exit(1)

    coco_path = find_coco_json(folder)
    coco = load_coco(coco_path)
    images_by_id, anns_by_image, categories_by_id = build_indices(coco)
    color_map = category_color_map(categories_by_id)

    # Optional subset filter by file_name
    allowed_names = None
    if args.subset:
        allowed_names = {name.strip() for name in args.subset.split(",") if name.strip()}

    # Set up save directory
    if args.save:
        args.save.mkdir(parents=True, exist_ok=True)

    processed = 0
    missing_images = []
    for img_id, img in images_by_id.items():
        file_name = img["file_name"]
        if allowed_names and file_name not in allowed_names:
            continue

        img_path = (folder / file_name)
        if not img_path.exists():
            missing_images.append(file_name)
            continue

        anns = anns_by_image.get(img_id, [])
        fig = draw_image_with_bboxes(img_path, anns, categories_by_id, color_map, dpi=args.dpi)

        title = f"{file_name}  |  {len(anns)} bbox{'es' if len(anns)!=1 else ''}"
        fig.suptitle(title, fontsize=10)

        if args.save:
            out_path = args.save / f"{Path(file_name).stem}__overlay.png"
            fig.savefig(out_path, bbox_inches="tight", pad_inches=0.0)
            print(f"Saved: {out_path}")

        if args.show:
            plt.show()
        else:
            plt.close(fig)

        processed += 1

    if missing_images:
        print("Warning: the following image files listed in COCO were not found in the folder:", file=sys.stderr)
        for nm in missing_images:
            print(f"  - {nm}", file=sys.stderr)

    if processed == 0:
        print("No images were processed. Check your --subset filter or that image files exist.", file=sys.stderr)

if __name__ == "__main__":
    main()
