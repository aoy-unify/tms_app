#!/usr/bin/env node
/**
 * Prepare iOS project for Mac/Xcode build + device install.
 * Run on Windows or Mac: node scripts/prepare-ios.mjs
 * Then on Mac: npm run ios:open  (requires Xcode)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iosDir = join(root, 'ios');
const isMac = process.platform === 'darwin';

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(join(root, 'node_modules', '@capacitor', 'ios'))) {
  console.error('Missing @capacitor/ios. Run: npm install');
  process.exit(1);
}

run('npm', ['run', 'build']);

if (!existsSync(iosDir)) {
  run('npx', ['cap', 'add', 'ios']);
} else {
  run('npx', ['cap', 'sync', 'ios']);
}

console.log('');
console.log('iOS project ready at: ios/App/App.xcodeproj');
console.log('Bundle ID: com.unify.odoo.tmsdriver');
console.log('');

if (!isMac) {
  console.log('This machine is Windows — cannot build/install IPA here.');
  console.log('Next steps on a Mac:');
  console.log('  1. Copy this project (or git pull)');
  console.log('  2. npm install');
  console.log('  3. npm run ios:sync');
  console.log('  4. npm run ios:open');
  console.log('  5. In Xcode: select your Team (Signing & Capabilities)');
  console.log('  6. Connect iPhone → Run (▶) to install');
  console.log('');
  console.log('Note: Background GPS (Android Foreground Service) is NOT ported to iOS yet.');
  console.log('Foreground features work: open Odoo, barcode scan, GPS while app is open.');
  process.exit(0);
}

console.log('Mac detected. Opening Xcode...');
run('npx', ['cap', 'open', 'ios']);
