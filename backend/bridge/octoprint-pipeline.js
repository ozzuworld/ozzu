// octoprint-pipeline.js — STL → slice → print orchestration
// Directive: dir_1778272304525
//
// Slicing happens on dev-01 (PrusaSlicer 2.9.4 installed there).
// Bridge SCPs the STL to dev-01, runs prusa-slicer with sane Ender V3 SE
// defaults (Marlin2, 0.4mm nozzle, 0.2mm layer, PETG 230/80°C, 99%
// rectilinear infill), SCPs the .gcode back, then uploads and starts the
// print via octoprint-client.
"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const octoprint = require("./octoprint-client");

const SSH_HOST = process.env.OCTOPRINT_SLICE_HOST || "dev-01";
const SSH_KEY = process.env.OCTOPRINT_SLICE_SSH_KEY || "/root/.ssh/dev01_key";
const REMOTE_DIR = process.env.OCTOPRINT_SLICE_REMOTE_DIR || "/tmp/ozzu-slice";
const LOCAL_DIR = process.env.OCTOPRINT_SLICE_LOCAL_DIR || "/tmp/ozzu-bridge/slice";

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

function ssh(cmd) {
  return execSync(
    `ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes hadmin@${SSH_HOST.replace(/^.*@/, "")} '${cmd.replace(/'/g, "'\\''")}'`,
    { encoding: "utf8" },
  );
}

function scp(src, dst) {
  return execSync(
    `scp -i ${SSH_KEY} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes ${src} ${dst}`,
    { encoding: "utf8" },
  );
}

function buildSlicerArgs(profile, inputPath, outputPath) {
  const flagOf = (k) => "--" + k.replace(/_/g, "-");
  const args = [];
  for (const [k, v] of Object.entries(profile)) {
    args.push(`${flagOf(k)} '${String(v).replace(/'/g, "'\\''")}'`);
  }
  return `prusa-slicer --slice -o ${outputPath} ${args.join(" ")} ${inputPath}`;
}

async function sliceOnDev01(stlPath, optionsProfile = {}) {
  const profile = { ...DEFAULT_PROFILE, ...optionsProfile };
  const stlName = path.basename(stlPath);
  const baseName = stlName.replace(/\.stl$/i, "");
  const remoteStl = `${REMOTE_DIR}/${stlName}`;
  const remoteGcode = `${REMOTE_DIR}/${baseName}.gcode`;

  // Ensure dirs
  ssh(`mkdir -p ${REMOTE_DIR}`);
  fs.mkdirSync(LOCAL_DIR, { recursive: true });

  // Push STL
  scp(stlPath, `dev-01:${remoteStl}`);

  // Slice
  const cmd = buildSlicerArgs(profile, remoteStl, remoteGcode);
  const out = ssh(`${cmd} 2>&1 | tail -10`);

  // Pull G-code
  const localGcode = path.join(LOCAL_DIR, `${baseName}.gcode`);
  scp(`dev-01:${remoteGcode}`, localGcode);

  // Cleanup remote
  try { ssh(`rm -f ${remoteStl} ${remoteGcode}`); } catch (_) {}

  return { localGcode, slicerOutput: out, baseName };
}

async function printSTL(stlPath, options = {}) {
  if (!fs.existsSync(stlPath)) throw new Error(`STL not found: ${stlPath}`);

  const startedAt = new Date().toISOString();

  // Step 1: slice on dev-01
  const sliceResult = await sliceOnDev01(stlPath, options.slicer || {});

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

module.exports = { printSTL, sliceOnDev01 };
