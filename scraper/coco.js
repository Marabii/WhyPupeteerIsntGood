// coco.js
// Minimal COCO writer that accumulates images and annotations and writes a valid dataset.

const path = require("path");
const fs = require("fs");

class CocoWriter {
  constructor({ outputPath, categories, info = {} }) {
    this.outputPath = outputPath;
    this.info = {
      description: info.description || "",
      url: info.url || "",
      version: info.version || "1.0",
      year: info.year || new Date().getFullYear(),
      contributor: info.contributor || "",
      date_created: info.date_created || new Date().toISOString().slice(0, 10),
    };

    // Map category name -> id
    this.categories = [];
    this.catNameToId = new Map();
    let id = 1;
    for (const name of categories) {
      this.categories.push({
        id,
        name,
        supercategory: "annotation",
      });
      this.catNameToId.set(name, id);
      id += 1;
    }

    this.images = [];
    this.annotations = [];
    this.lastImageId = 0;
    this.lastAnnId = 0;
  }

  addImage({ fileName, width, height }) {
    const id = ++this.lastImageId;
    this.images.push({
      id,
      file_name: fileName,
      width,
      height,
    });
    return id;
  }

  addAnnotation({ imageId, categoryName, bbox, area = null, iscrowd = 0 }) {
    const category_id = this.catNameToId.get(categoryName);
    if (!category_id) return; // unknown category: ignore

    const [x, y, w, h] = bbox.map((v) => Math.max(0, Math.round(v)));
    if (w <= 0 || h <= 0) return;

    const id = ++this.lastAnnId;
    this.annotations.push({
      id,
      image_id: imageId,
      category_id,
      bbox: [x, y, w, h],
      area: area != null ? Math.round(area) : Math.round(w * h),
      iscrowd,
      segmentation: [],
    });
  }

  toJSON() {
    return {
      info: this.info,
      images: this.images,
      annotations: this.annotations,
      categories: this.categories,
      licenses: [],
    };
  }

  writeSync() {
    const outDir = path.dirname(this.outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      this.outputPath,
      JSON.stringify(this.toJSON(), null, 2),
      "utf8"
    );
  }
}

module.exports = { CocoWriter };
