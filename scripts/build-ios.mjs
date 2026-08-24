#!/usr/bin/env node
/**
 * Build iOS IPA into releases/ (mirrors scripts/build-apk.mjs).
 * Requires macOS + Xcode + Apple signing team configured in Xcode.
 *
 * Usage: npm run ios:ipa
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isMac = process.platform === 'darwin';
const pkgPath = join(root, 'package.json');
const pbxPath = join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const exportOptions = join(root, 'scripts', 'ios', 'ExportOptions.plist');
const releasesDir = join(root, 'releases');
const buildDir = join(root, 'ios', 'build');

function bumpVersion(pkg) {
  const parts = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) {
    parts.push(0);
  }
  parts[2] += 1;
  return parts.join('.');
}

function updatePbxproj(marketingVersion, buildNumber) {
  if (!existsSync(pbxPath)) {
    console.error('iOS project missing. Run: npm run ios:prepare');
    process.exit(1);
  }
  let pbx = readFileSync(pbxPath, 'utf8');
  pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${marketingVersion};`);
  pbx = pbx.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${buildNumber};`);
  writeFileSync(pbxPath, pbx);
}

function findBuiltIpa(exportDir) {
  const files = readdirSync(exportDir).filter((f) => f.endsWith('.ipa'));
  if (!files.length) {
    return null;
  }
  return join(exportDir, files[0]);
}

if (!isMac) {
  console.error('Cannot build IPA on Windows.');
  console.error('iOS releases must be built on a Mac with Xcode:');
  console.error('  1. Open this project on Mac');
  console.error('  2. npm install');
  console.error('  3. In Xcode → Signing & Capabilities → select Team');
  console.error('  4. npm run ios:ipa');
  console.error('  5. File appears in releases/Odoo-TMS-Driver-V{version}.ipa');
  console.error('');
  console.error('On this Windows machine you can still prepare the project:');
  console.error('  npm run ios:prepare');
  process.exit(1);
}

if (!existsSync(join(root, 'ios'))) {
  console.error('iOS platform missing. Run: npm run ios:prepare');
  process.exit(1);
}

if (!existsSync(exportOptions)) {
  console.error(`Missing ${exportOptions}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const newVersion = bumpVersion(pkg);
pkg.version = newVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const buildNumberMatch = existsSync(pbxPath)
  ? readFileSync(pbxPath, 'utf8').match(/CURRENT_PROJECT_VERSION = (\d+);/)
  : null;
const buildNumber = buildNumberMatch ? parseInt(buildNumberMatch[1], 10) + 1 : 1;
updatePbxproj(newVersion, buildNumber);

const ipaName = `Odoo-TMS-Driver-V${newVersion}.ipa`;
const archivePath = join(buildDir, 'App.xcarchive');
const exportDir = join(buildDir, 'export');

console.log(`Building ${ipaName} (build ${buildNumber})...\n`);

mkdirSync(buildDir, { recursive: true });
rmSync(archivePath, { recursive: true, force: true });
rmSync(exportDir, { recursive: true, force: true });
mkdirSync(exportDir, { recursive: true });

execSync('npm run build', { cwd: root, stdio: 'inherit' });
execSync('npx cap sync ios', { cwd: root, stdio: 'inherit' });

const projectPath = join(root, 'ios', 'App', 'App.xcodeproj');
execSync(
  [
    'xcodebuild',
    '-project', `"${projectPath}"`,
    '-scheme', 'App',
    '-configuration', 'Release',
    '-archivePath', `"${archivePath}"`,
    '-allowProvisioningUpdates',
    'archive',
  ].join(' '),
  { cwd: root, stdio: 'inherit', shell: true }
);

execSync(
  [
    'xcodebuild',
    '-exportArchive',
    '-archivePath', `"${archivePath}"`,
    '-exportPath', `"${exportDir}"`,
    '-exportOptionsPlist', `"${exportOptions}"`,
    '-allowProvisioningUpdates',
  ].join(' '),
  { cwd: root, stdio: 'inherit', shell: true }
);

const ipaSrc = findBuiltIpa(exportDir);
if (!ipaSrc) {
  console.error('xcodebuild finished but no .ipa was found in export folder.');
  process.exit(1);
}

mkdirSync(releasesDir, { recursive: true });
const ipaDest = join(releasesDir, ipaName);
copyFileSync(ipaSrc, ipaDest);

console.log(`\nDone: ${ipaDest}`);
console.log('Install via Xcode / Apple Configurator / TestFlight (if distributed).');
