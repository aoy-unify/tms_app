import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveJavaHome() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) {
    return process.env.JAVA_HOME;
  }
  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Android Studio', 'jbr'),
    'C:/Program Files/Android/Android Studio/jbr',
    'C:/Program Files (x86)/Android/Android Studio/jbr',
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'bin', 'java.exe')) || existsSync(join(candidate, 'bin', 'java'))) {
      return candidate;
    }
  }
  return null;
}

const javaHome = resolveJavaHome();
if (!javaHome) {
  console.error('JAVA_HOME is not set and Android Studio JBR was not found.');
  process.exit(1);
}

const buildEnv = { ...process.env, JAVA_HOME: javaHome };
const pkgPath = join(root, 'package.json');
const gradlePath = join(root, 'android', 'app', 'build.gradle');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const parts = pkg.version.split('.').map((n) => parseInt(n, 10) || 0);
while (parts.length < 3) {
  parts.push(0);
}
parts[2] += 1;
const newVersion = parts.join('.');

pkg.version = newVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

let gradle = readFileSync(gradlePath, 'utf8');
const codeMatch = gradle.match(/versionCode\s+(\d+)/);
const versionCode = codeMatch ? parseInt(codeMatch[1], 10) + 1 : 1;
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${newVersion}"`);
writeFileSync(gradlePath, gradle);

const apkName = `Odoo-TMS-Driver-V${newVersion}.apk`;
console.log(`Building ${apkName} (versionCode ${versionCode})...\n`);

execSync('npm run build', { cwd: root, stdio: 'inherit', env: buildEnv });
execSync('npx cap sync android', { cwd: root, stdio: 'inherit', env: buildEnv });

const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
execSync(`${gradlew} assembleDebug`, {
  cwd: join(root, 'android'),
  stdio: 'inherit',
  shell: true,
  env: buildEnv,
});

const apkSrc = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const releasesDir = join(root, 'releases');
mkdirSync(releasesDir, { recursive: true });
const apkDest = join(releasesDir, apkName);
copyFileSync(apkSrc, apkDest);

console.log(`\nDone: ${apkDest}`);
