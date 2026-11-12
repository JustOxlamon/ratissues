import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = path.join(REPO_ROOT, 'web', 'tailwind.src.css');
const OUTPUT = path.join(REPO_ROOT, 'web', 'app.css');
const CLI_PATH = path.join(REPO_ROOT, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs');

if (!existsSync(path.join(REPO_ROOT, 'node_modules'))) {
  console.error('node_modules не найден. Выполните: npm install');
  process.exit(1);
}

if (!existsSync(CLI_PATH)) {
  console.error(`CLI Tailwind не найден: ${CLI_PATH}\nВыполните: npm install`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [CLI_PATH, '--input', INPUT, '--output', OUTPUT],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  console.error(`Ошибка запуска Tailwind: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`Tailwind завершился с кодом ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log(`Собрано: ${path.relative(REPO_ROOT, OUTPUT)}`);
