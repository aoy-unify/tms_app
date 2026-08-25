#!/usr/bin/env node
/**
 * Build iOS IPA into releases/ (mirrors scripts/build-apk.mjs).
 * Requires macOS + Xcode + Apple signing (local Team or CI secrets).
 *
 * Usage:
 *   npm run ios:ipa
 *   CI=1 APPLE_TEAM_ID=XXXX npm run ios:ipa
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
const isCi = process.env.CI === 'true' || process.env.CI === '1';
const skipBump = isCi || process.env.IOS_SKIP_VERSION_BUMP === '1';
const teamId = (process.env.APPLE_TEAM_ID || '').trim();
const exportMethod = (process.env.IOS_EXPORT_METHOD || 'development').trim();

const pkgPath = join(root, 'package.json');
const pbxPath = join(root, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const exportOptionsTemplate = join(root, 'scripts', 'ios', 'ExportOptions.plist');
const releasesDir = join(root, 'releases');
const buildDir = join(root, 'ios', 'build');
const exportOptionsPath = join(buildDir, 'ExportOptions.plist');

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

function writeExportOptions() {
  let plist = readFileSync(exportOptionsTemplate, 'utf8');
  plist = plist.replace(
    /<key>method<\/key>\s*<string>[^<]+<\/string>/,
    `<key>method</key>\n\t<string>${exportMethod}</string>`
  );
  if (teamId) {
    if (plist.includes('<key>teamID</key>')) {
      plist = plist.replace(
        /<key>teamID<\/key>\s*<string>[^<]*<\/string>/,
        `<key>teamID</key>\n\t<string>${teamId}</string>`
      );
    } else {
      plist = plist.replace(
        '</dict>\n</plist>',
        `\t<key>teamID</key>\n\t<string>${teamId}</string>\n</dict>\n</plist>`
      );
    }
  }
  mkdirSync(buildDir, { recursive: true });
  writeFileSync(exportOptionsPath, plist);
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
  console.error('Use a Mac, or GitHub Actions: Actions → Build iOS IPA → Run workflow');
  console.error('Prepare locally with: npm run ios:prepare');
  process.exit(1);
}

if (!existsSync(join(root, 'ios'))) {
  console.error('iOS platform missing. Run: npm run ios:prepare');
  process.exit(1);
}

if (!existsSync(exportOptionsTemplate)) {
  console.error(`Missing ${exportOptionsTemplate}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
let version = pkg.version;
if (!skipBump) {
  version = bumpVersion(pkg);
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

const buildNumberMatch = existsSync(pbxPath)
  ? readFileSync(pbxPath, 'utf8').match(/CURRENT_PROJECT_VERSION = (\d+);/)
  : null;
const localBuild = buildNumberMatch ? parseInt(buildNumberMatch[1], 10) + 1 : 1;
const buildNumber = process.env.GITHUB_RUN_NUMBER
  ? parseInt(process.env.GITHUB_RUN_NUMBER, 10)
  : localBuild;
updatePbxproj(version, buildNumber);
writeExportOptions();

const ipaName = `Odoo-TMS-Driver-V${version}.ipa`;
const archivePath = join(buildDir, 'App.xcarchive');
const exportDir = join(buildDir, 'export');

console.log(`Building ${ipaName} (build ${buildNumber}, method=${exportMethod})...\n`);
if (teamId) {
  console.log(`Using APPLE_TEAM_ID=${teamId}`);
}

mkdirSync(buildDir, { recursive: true });
rmSync(archivePath, { recursive: true, force: true });
rmSync(exportDir, { recursive: true, force: true });
mkdirSync(exportDir, { recursive: true });

execSync('npm run build', { cwd: root, stdio: 'inherit' });
execSync('npx cap sync ios', { cwd: root, stdio: 'inherit' });

const projectPath = join(root, 'ios', 'App', 'App.xcodeproj');
const teamFlag = teamId ? `DEVELOPMENT_TEAM=${teamId}` : '';
const signFlags = [
  'CODE_SIGN_STYLE=Automatic',
  '-allowProvisioningUpdates',
  teamFlag,
].filter(Boolean);

execSync(
  [
    'xcodebuild',
    '-project', `"${projectPath}"`,
    '-scheme', 'App',
    '-configuration', 'Release',
    '-destination', 'generic/platform=iOS',
    '-archivePath', `"${archivePath}"`,
    ...signFlags,
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
    '-exportOptionsPlist', `"${exportOptionsPath}"`,
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
console.log('Install via Xcode Devices, Apple Configurator, or TestFlight.');
