#!/usr/bin/env node
/** Compare two reports produced by verify-booklet-camera.cjs for different displayed steps. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [singleFile, multipleFile, selected = '5'] = process.argv.slice(2);
if (!singleFile || !multipleFile) throw new Error('Usage: node scripts/check-booklet-camera-selection.cjs single.json multiple.json [step]');
const a = JSON.parse(fs.readFileSync(singleFile, 'utf8'));
const b = JSON.parse(fs.readFileSync(multipleFile, 'utf8'));
assert.deepEqual(a.calibrationSteps, b.calibrationSteps, 'Displayed steps changed calibration references');
assert.equal(a.anchor, b.anchor, 'Displayed steps changed calibration anchor');
assert.deepEqual(a.shared, b.shared, 'Displayed steps changed shared camera');
const step = Number(selected);
const singleStep = a.steps.find((s) => s.step === step), multipleStep = b.steps.find((s) => s.step === step);
assert.ok(singleStep && multipleStep, `Step ${step} must be present in both reports`);
assert.deepEqual(singleStep, multipleStep, `Displayed steps changed step ${step}'s fit`);
const image = (file) => path.join(path.dirname(file), `${path.basename(file, '.json')}-step-${step}.png`);
assert.deepEqual(fs.readFileSync(image(singleFile)), fs.readFileSync(image(multipleFile)), `Displayed steps changed step ${step}'s rendered pixels`);
console.log(`PASS: shared calibration, anchor, step ${step} camera, offsets, metrics and rendered PNG are identical.`);
