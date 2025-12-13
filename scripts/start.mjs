import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const backendDir = join(rootDir, 'backend');
const frontendDir = join(rootDir, 'frontend');
const startedAt = Date.now();

function log(msg) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[start +${seconds}s] ${msg}`);
}

function parseDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  const raw = readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function runNpm(args, opts) {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const command = ['npm', ...args].join(' ');
    return run(comspec, ['/d', '/s', '/c', command], { ...opts, windowsHide: true });
  }
  return run('npm', args, opts);
}

async function ensureDeps(baseEnv) {
  const npmEnv = {
    ...baseEnv,
    // 在受限环境中避免写入 ~/.npm
    npm_config_cache: join(rootDir, '.npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    ...(baseEnv.NPM_REGISTRY ? { npm_config_registry: baseEnv.NPM_REGISTRY } : {})
  };
  const npmInstallArgs = ['install', '--no-audit', '--no-fund', '--progress=false'];

  if (baseEnv.AGP_SKIP_INSTALL === '1' || baseEnv.AGP_SKIP_INSTALL === 'true') {
    log('Skip deps install (AGP_SKIP_INSTALL set)');
    return;
  }

  if (existsSync(join(rootDir, 'node_modules'))) {
    log('Deps OK');
    return;
  }

  log('Installing deps once (npm workspaces: frontend + backend; first run may take a few minutes)');
  await runNpm(npmInstallArgs, { cwd: rootDir, env: npmEnv });
}

async function ensureFrontendBuild(baseEnv) {
  const distIndex = join(frontendDir, 'dist', 'index.html');
  if (baseEnv.AGP_SKIP_BUILD === '1' || baseEnv.AGP_SKIP_BUILD === 'true') {
    log('Skip frontend build (AGP_SKIP_BUILD set)');
    return;
  }
  if (!existsSync(distIndex)) {
    log('Building frontend (vite build)');
    await runNpm(['--workspace', 'frontend', 'run', 'build'], {
      cwd: rootDir,
      env: {
        ...baseEnv,
        npm_config_cache: join(rootDir, '.npm-cache'),
        npm_config_update_notifier: 'false',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        ...(baseEnv.NPM_REGISTRY ? { npm_config_registry: baseEnv.NPM_REGISTRY } : {})
      }
    });
  } else {
    log('Frontend build OK');
  }
}

async function main() {
  const envFromFile = parseDotEnv(join(rootDir, '.env'));
  const env = { ...process.env, ...envFromFile };
  env.DB_PATH ??= '../data/database.sqlite';
  env.PORT ??= '8088';

  log('Preparing...');
  await ensureDeps(env);
  await ensureFrontendBuild(env);

  log(`Starting backend on PORT=${env.PORT} ...`);
  const backend = spawn('node', ['src/index.js'], {
    cwd: backendDir,
    stdio: 'inherit',
    env
  });

  const shutdown = (signal) => {
    if (backend.exitCode !== null) return;
    backend.kill(signal);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  backend.on('exit', (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
