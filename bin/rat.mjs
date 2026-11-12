#!/usr/bin/env node
import { main } from '../src/cli/index.mjs';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  // main() ловит штатные ошибки сам; сюда попадаем только при внутреннем сбое.
  console.error(`Внутренняя ошибка: ${err?.stack ?? err}`);
  process.exitCode = 4;
}
