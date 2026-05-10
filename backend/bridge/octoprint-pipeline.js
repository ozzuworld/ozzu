// octoprint-pipeline.js — STL → slice → print orchestration
// Directive: dir_1778272304525, updated dir_1778425211161
//
// Slicing happens LOCALLY on the bridge VM (PrusaSlicer 2.7.2 from apt).
// dev-01 is no longer in the slice path — that introduced a single point of
// failure (dev-01 dropped off WG twice in 24h, blocking all prints).
// Bridge runs prusa-slicer in-process with Ender V3 SE defaults (Marlin2,
// 0.4mm nozzle, 0.2mm layer, PETG 230/80°C, 99% rectilinear infill), then
// uploads and starts the print via octoprint-client.
"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const octoprint = require("./octoprint-client");

const LOCAL_DIR = process.env.OCTOPRINT_SLICE_LOCAL_DIR || "/tmp/ozzu-bridge/slice";
const PRUSA_SLICER_BIN = process.env.PRUSA_SLICER_BIN || "prusa-slicer";

// Default profile is Ender V3 SE-compatible (220x220x250 bed, Marlin2).
// Override per-call via options.
const DEFAULT_PROFILE = {
  bed_shape: "0x0,220x0,220x220,0x220",
  layer_height: 0.2,
  first_layer_height: 0.2,
  nozzle_diameter: 0.4,
  filament_diameter: 1.75,
  temperature: 230,
  bed_temperature: 80,
  first_layer_temperature: 235,
  first_layer_bed_temperature: 80,
  fill_density: "99%",
  fill_pattern: "rectilinear",
  perimeters: 3,
  top_solid_layers: 5,
  bottom_solid_layers: 5,
  gcode_flavor: "marlin2",
  filament_type: "PETG",
};

function buildSlicerArgs(profile, inputPath, outputPath) {
  const flagOf = (k) => "--" + k.replace(/_/g, "-");
  const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const args = [];
  for (const [k, v] of Object.entries(profile)) {
    args.push(`${flagOf(k)} ${sq(v)}`);
  }
  // Quote the file paths so spaces (and other shell-special chars) survive.
  return `${PRUSA_SLICER_BIN} --slice -o ${sq(outputPath)} ${args.join(" ")} ${sq(inputPath)}`;
}

async function sliceLocal(stlPath, optionsProfile = {}) {
  const profile = { ...DEFAULT_PROFILE, ...optionsProfile };
  const stlName = path.basename(stlPath);
  const baseName = stlName.replace(/\.stl$/i, "");
  const localGcode = path.join(LOCAL_DIR, `${baseName}.gcode`);

  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const cmd = buildSlicerArgs(profile, stlPath, localGcode);
  const out = execSync(`${cmd} 2>&1 | tail -10`, { encoding: "utf8" });

  if (!fs.existsSync(localGcode)) {
    throw new Error(`Slicer ran but produced no gcode: ${out}`);
  }
  return { localGcode, slicerOutput: out, baseName };
}

async function printSTL(stlPath, options = {}) {
  if (!fs.existsSync(stlPath)) throw new Error(`STL not found: ${stlPath}`);

  const startedAt = new Date().toISOString();

  // Step 1: slice on dev-01
  const sliceResult = await sliceLocal(stlPath, options.slicer || {});

  // Step 2: ensure printer connection
  const status = await octoprint.getStatus().catch(e => ({ error: e.message }));
  if (!status.connection || status.connection.current?.state !== "Operational") {
    if (options.connectIfNeeded !== false) {
      await octoprint.connectPrinter();
    }
  }

  // Step 3: upload + select
  const upload = await octoprint.uploadGcode(sliceResult.localGcode, {
    filename: `${sliceResult.baseName}.gcode`,
    select: true,
    startPrint: false,
  });

  // Step 4: start print (unless dry-run)
  let printRes = null;
  if (options.dryRun !== true) {
    printRes = await octoprint.startPrint(`${sliceResult.baseName}.gcode`);
  }

  return {
    startedAt,
    stl: stlPath,
    gcode: sliceResult.localGcode,
    slicer: sliceResult.slicerOutput,
    upload,
    print: printRes,
    directiveId: options.directiveId || null,
  };
}

module.exports = { printSTL, sliceLocal };
